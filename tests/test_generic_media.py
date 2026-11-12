import json
import subprocess
import tempfile
import unittest
import threading
import time
from unittest.mock import patch
from pathlib import Path

from bridge import FFMPEG, probe, ffmpeg_command
from bridge import Bridge, arguments
from media import Analysis, Catalogue, PlaybackPlan, Subtitle, SetupCatalogue, MediaError, normalize_subtitles
import re
import os
import sys


def wait_ready(store, source_id='source'):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = store.snapshot().get(source_id, {})
        if snapshot.get('state') == 'ready':
            return snapshot['catalogue']
        time.sleep(.01)
    raise AssertionError(store.snapshot())


class CatalogueTest(unittest.TestCase):
    def test_explicit_cli_startup_uses_metadata_plans_and_stop_fences_admission(self):
        from test_device_selector import DeviceSelectorTest
        from backend_fixtures import seed_plan
        from unittest.mock import Mock
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                bridge = DeviceSelectorTest().fixture()
                bridge.args = arguments(['--device-name', 'Sala', '--autostart'])
                info = DeviceSelectorTest().info()
                with patch('bridge.discover_receivers', return_value=[info]):
                    bridge.scan_devices()
                source = dict(id='source', url='synthetic', title='Synthetic')
                bridge.sources = [source]
                bridge.source_snapshot['source_discovery'] = 'ready'
                seed_plan(bridge, source)
                original = bridge.submit
                def submit(action, data, expected_generation=None):
                    if action == 'start' and cancelled:
                        original('stop', dict(device_id=str(info.uuid), device_revision=1))
                    original(action, data, expected_generation)
                    if action == 'configure_device':
                        action, payload, _ = bridge.jobs.get_nowait()
                        bridge.mutate(action, payload)
                        bridge.update(command_pending=False)
                with patch.object(bridge, 'submit', side_effect=submit), \
                     patch('bridge.probe', side_effect=AssertionError('no probe on playback lane')), \
                     patch('bridge.discover_receivers', side_effect=AssertionError('no scan on playback lane')):
                    bridge._configured_startup()
                action, payload, _ = bridge.jobs.get_nowait()
                self.assertEqual(action, 'stop' if cancelled else 'start')
                if not cancelled:
                    self.assertIsNone(payload['_plan'].subtitle)
                    self.assertEqual(payload['_plan'].delay_ms, 0)
                self.assertTrue(bridge.jobs.empty())
                self.assertIsNone(bridge.cast)
        bridge = DeviceSelectorTest().fixture()
        scans, wake = Mock(), Mock()
        waits = []
        def wait(timeout):
            waits.append(timeout)
            if len(waits) == 2:
                bridge.quit.set()
        wake.wait.side_effect = wait
        bridge._scan_loop(scans, wake)
        self.assertEqual(scans.call_count, 2)
        self.assertEqual(waits, [30, 30])

    def test_upload_plain_vtt_preserves_text_and_validates_cue_settings(self):
        from demo import DemoBridge
        bridge = DemoBridge()
        _, response = bridge.request_catalogue(dict(source_id='demo-a', refresh=False))
        catalogue_id = response['catalogue']['id']
        uploaded = bridge.subtitle_upload(dict(source_id='demo-a', catalogue_id=catalogue_id,
            filename='captions.vtt', format='vtt', text='WEBVTT Synthetic captions\n\ncue-1\n'
            '00:01.000 --> 00:03.000 line:90% position:50%,center align:center size:80%\n<b>Hello</b>'))
        self.assertEqual(uploaded['entry']['kind'], 'upload')
        for suffix in ('size:101%', 'align:wrong', 'region:remote', 'line:1 line:2'):
            with self.subTest(suffix=suffix), self.assertRaises(MediaError):
                bridge.subtitle_upload(dict(source_id='demo-a', catalogue_id=catalogue_id,
                    filename='invalid.vtt', format='vtt',
                    text=f'WEBVTT\n\n00:01.000 --> 00:03.000 {suffix}\nHello'))
        uploaded = bridge.subtitle_upload(dict(source_id='demo-a', catalogue_id=catalogue_id,
            filename='credit.vtt', format='vtt', text='WEBVTT\n\n00:01.000 --> 00:03.000\nftp://external.test'))
        self.assertEqual(uploaded['entry']['kind'], 'upload')

    def test_failed_analysis_snapshots_are_bounded_and_stale_inactive_uploads_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            def fail(*_):
                raise OSError('PRIVATE')
            store = SetupCatalogue(fail, Path(folder))
            try:
                for index in range(8):
                    store.request(dict(id=str(index), url='synthetic'))
                    deadline = time.monotonic() + 2
                    while store.snapshot()[str(index)]['state'] == 'loading' and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertEqual(store.snapshot()[str(index)]['state'], 'error')
                store.request(dict(id='ninth', url='synthetic'))
                self.assertLessEqual(len(store.snapshot()), 8)
                store.request(dict(id='0', url='synthetic'), refresh=True)
            finally:
                store.close()
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            try:
                source = dict(id='source', url='synthetic')
                store.request(source)
                old = wait_ready(store)
                store.request(source, refresh=True)
                wait_ready(store)
                with self.assertRaises(MediaError) as error:
                    store.upload('source', old['id'], 'stale.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nStale')
                self.assertEqual(error.exception.status, 409)
            finally:
                store.close()

    def test_production_probe_cancels_and_bounds_subprocess_output_without_leaking_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for oversized in (False, True):
                with self.subTest(oversized=oversized):
                    marker = root / f'{oversized}.pid'
                    executable = root / f'probe-{oversized}'
                    executable.write_text(f'#!{sys.executable}\nimport os, pathlib, sys, time\n'
                        + ("sys.stdout.write('x' * (2 * 1024**2 + 1)); sys.stdout.flush()\n" if oversized else '')
                        + f'pathlib.Path({str(marker)!r}).write_text(str(os.getpid()))\n'
                        + "sys.stderr.write('PRIVATE-DIAGNOSTIC'); sys.stderr.flush()\ntime.sleep(30)\n")
                    executable.chmod(0o700)
                    cancelled = threading.Event()
                    errors = []
                    def run():
                        try:
                            probe('PRIVATE-SOURCE', cancelled)
                        except MediaError as error:
                            errors.append(str(error))
                    with patch('bridge.FFPROBE', str(executable)):
                        thread = threading.Thread(target=run)
                        thread.start()
                        try:
                            if not oversized:
                                deadline = time.monotonic() + 2
                                while not marker.exists() and time.monotonic() < deadline:
                                    time.sleep(.01)
                                self.assertTrue(marker.exists())
                                cancelled.set()
                            thread.join(3)
                            self.assertFalse(thread.is_alive())
                            self.assertEqual(len(errors), 1)
                            self.assertNotIn('PRIVATE', errors[0])
                            if marker.exists():
                                with self.assertRaises(ProcessLookupError):
                                    os.kill(int(marker.read_text()), 0)
                        finally:
                            cancelled.set()
                            thread.join(3)

    def test_upload_during_paused_playback_then_refresh_and_seek_retains_private_plan(self):
        from test_bridge import RestartPolicyTest
        from backend_fixtures import apply_data
        from types import SimpleNamespace
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bridge = RestartPolicyTest().fixture(root)
            bridge.catalogue.parent = root / 'private'
            bridge.cast.media_controller.status.content_id = bridge.media_url
            bridge.cast.media_controller.status.player_state = 'PAUSED'
            identity = bridge.state['playback_id']
            catalogue_id = bridge.active_plan.catalogue.id
            source_id = bridge.active_plan.catalogue.source['id']
            uploaded = bridge.catalogue.upload(source_id, catalogue_id, 'paused.srt', 'srt',
                                               '1\n00:01:04,000 --> 00:01:08,000\nCrossing')
            producer = Mock(pid=123)
            producer.poll.return_value = None
            with patch('bridge.probe', side_effect=AssertionError('playback must use pinned analysis')), \
                 patch('bridge.subprocess.Popen', return_value=producer) as launch, \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                bridge.mutate('subtitles', apply_data(bridge, subtitle_id=uploaded['entry']['id'], delay=250))
                path = bridge.active_plan.subtitle.path
                self.assertIn(str(path), launch.call_args.args[0])
                self.assertEqual(bridge.origin, 65)
                self.assertTrue(bridge.paused)
                bridge.catalogue.request(dict(bridge.active_plan.catalogue.source), refresh=True)
                self.assertEqual(bridge.catalogue.snapshot()[source_id]['state'], 'loading')
                bridge.mutate('seek', dict(device_id='fixture-device', device_revision=1, position=75))
                self.assertEqual(bridge.origin, 75)
                self.assertTrue(bridge.paused)
                self.assertTrue(path.exists())
                self.assertEqual(bridge.state['playback_id'], identity)
                self.assertEqual(bridge.active_plan.catalogue.id, catalogue_id)
                bridge.stop()
            bridge.catalogue.close()
            self.assertFalse(path.exists())

    def test_real_handler_coalesces_catalogue_jobs_and_enforces_bounded_admission(self):
        from test_device_selector import DeviceSelectorTest
        from test_player_ux import ControlHTTPTest
        bridge = DeviceSelectorTest().fixture()
        bridge.sources = [dict(id='source', url='synthetic', title='Synthetic')]
        def post(source_id, refresh=False):
            handler = ControlHTTPTest().handler(data=dict(source_id=source_id, refresh=refresh))
            handler.server.bridge, handler.path = bridge, '/api/catalogue'
            handler.do_POST()
            return handler.reply.call_args.args
        code, body = post('source')
        self.assertEqual(code, 202)
        self.assertEqual(post('source', True)[1]['analysis_id'], body['analysis_id'])
        self.assertTrue(bridge.jobs.empty())
        self.assertFalse(bridge.status().get('command_pending', False))
        self.assertEqual(post('unknown')[0], 404)
        for index in range(7):
            source = dict(id=str(index), url='synthetic', title='Synthetic')
            bridge.sources.append(source)
            self.assertEqual(post(source['id'])[0], 202)
        bridge.sources.append(dict(id='ninth', url='synthetic', title='Synthetic'))
        self.assertEqual(post('ninth')[0], 409)
        bridge.catalogue.cancel()
        self.assertEqual(post('source')[0], 503)

    def test_device_refresh_retains_last_usable_target_and_no_text_readiness_needs_no_vtt(self):
        from test_device_selector import DeviceSelectorTest
        from test_bridge import RestartPolicyTest
        from backend_fixtures import start_data
        from dataclasses import replace
        bridge = DeviceSelectorTest().fixture()
        info = DeviceSelectorTest().info()
        with patch('bridge.discover_receivers', return_value=[info]):
            bridge.scan_devices()
        bridge.select_device(str(info.uuid), 0)
        bridge.sources = [dict(id='source', url='synthetic', title='Synthetic')]
        payload = start_data(bridge, subtitle=False)
        entered, release = threading.Event(), threading.Event()
        def scan(*_):
            entered.set()
            self.assertTrue(release.wait(2))
            return [info]
        with patch('bridge.discover_receivers', side_effect=scan):
            worker = threading.Thread(target=bridge.scan_devices)
            worker.start()
            try:
                self.assertTrue(entered.wait(1))
                status = bridge.status()
                self.assertEqual(status['device_discovery'], 'loading')
                self.assertTrue(status['selected_device']['available'])
                self.assertEqual(status['device_revision'], 1)
                self.assertFalse(status.get('command_pending', False))
                bridge.submit('start', payload)
            finally:
                release.set()
                worker.join(2)
        with tempfile.TemporaryDirectory() as folder:
            bridge = RestartPolicyTest().fixture(Path(folder))
            bridge.active_plan = replace(bridge.active_plan, subtitle=None, delay_ms=0, enabled=False)
            bridge.loaded = False
            bridge.started_at = time.monotonic()
            bridge.process = unittest.mock.Mock()
            bridge.process.poll.return_value = None
            bridge.last_playing_segments = None
            (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
            (bridge.session / 'master.m3u8').write_text('#EXTM3U')
            bridge.tick()
            bridge.cast.media_controller.play_media.assert_called_once()
            self.assertFalse((bridge.session / 'video_vtt.m3u8').exists())

    def test_blocked_device_source_and_probe_lanes_do_not_block_transport_or_tick(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        device_entered, source_entered, probe_entered, release = [threading.Event() for _ in range(4)]
        def devices(*_):
            device_entered.set()
            self.assertTrue(release.wait(4))
            return []
        def sources(*_, **__):
            source_entered.set()
            self.assertTrue(release.wait(4))
            raise OSError('synthetic offline')
        def analysis(*_):
            probe_entered.set()
            self.assertTrue(release.wait(4))
            return Analysis(0, 1, 90)
        with patch('bridge.discover_receivers', side_effect=devices), patch('bridge.urlopen', side_effect=sources), patch('bridge.probe', side_effect=analysis):
            bridge = Bridge(arguments([]))
            try:
                self.assertTrue(device_entered.wait(1))
                self.assertTrue(source_entered.wait(1))
                with bridge.source_lock:
                    bridge.sources = [dict(id='source', url='synthetic', title='Synthetic')]
                bridge.request_catalogue(dict(source_id='source', refresh=False))
                self.assertTrue(probe_entered.wait(1))
                paused, ticked = threading.Event(), threading.Event()
                bridge.tick = ticked.set
                bridge.cast = Mock()
                bridge.cast.media_controller.status = SimpleNamespace(content_id='owned', player_state='PLAYING')
                bridge.cast.media_controller.pause.side_effect = paused.set
                bridge.media_url, bridge.loaded = 'owned', True
                bridge.update(selected_device=dict(id='receiver', available=True), device_revision=1)
                bridge.submit('pause', dict(device_id='receiver', device_revision=1))
                self.assertTrue(paused.wait(1))
                self.assertTrue(ticked.wait(1))
                self.assertEqual(bridge.status()['catalogues']['source']['state'], 'loading')
                self.assertFalse(release.is_set())
            finally:
                release.set()
                bridge.close()

    def test_shutdown_waits_for_upload_writer_and_discards_late_probe_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            store.request(dict(id='source', url='synthetic'))
            catalogue = wait_ready(store)
            store.upload('source', catalogue['id'], 'existing.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nExisting')
            directory = store.upload_dir
            entered, release, closed = threading.Event(), threading.Event(), threading.Event()
            original = normalize_subtitles
            errors = []
            def parse(*args):
                entered.set()
                self.assertTrue(release.wait(3))
                return original(*args)
            def upload():
                try:
                    store.upload('source', catalogue['id'], 'late.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nLate')
                except MediaError as error:
                    errors.append(error.status)
            def close():
                store.close()
                closed.set()
            with patch('media.normalize_subtitles', side_effect=parse):
                writer = threading.Thread(target=upload)
                writer.start()
                self.assertTrue(entered.wait(1))
                closer = threading.Thread(target=close)
                closer.start()
                try:
                    self.assertTrue(store.cancelled.wait(1))
                    self.assertTrue(directory.exists())
                    self.assertFalse(closed.is_set())
                finally:
                    release.set()
                    writer.join(3)
                    closer.join(3)
            self.assertEqual(errors, [503])
            self.assertTrue(closed.is_set())
            self.assertFalse(directory.exists())
            probe_entered, probe_release = threading.Event(), threading.Event()
            def probe(*_):
                probe_entered.set()
                self.assertTrue(probe_release.wait(2))
                return Analysis(0, 1, 90)
            store = SetupCatalogue(probe, Path(folder))
            store.request(dict(id='source', url='synthetic'))
            self.assertTrue(probe_entered.wait(1))
            store.cancel()
            probe_release.set()
            store.close()
            self.assertEqual(store.snapshot()['source']['state'], 'loading')
            self.assertEqual(store.records, {})
            with self.assertRaises(MediaError) as error:
                store.request(dict(id='source', url='synthetic'))
            self.assertEqual(error.exception.status, 503)

    def test_upload_file_count_byte_and_total_capacity_are_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            try:
                store.request(dict(id='source', url='synthetic'))
                catalogue = wait_ready(store)
                for index in range(8):
                    store.upload('source', catalogue['id'], f'{index}.srt', 'srt',
                                 f'1\n00:00:01,000 --> 00:00:03,000\nCue {index}')
                duplicate = store.upload('source', catalogue['id'], 'duplicate.srt', 'srt',
                                        '1\n00:00:01,000 --> 00:00:03,000\nCue 0')
                self.assertEqual(len(duplicate['catalogue']['entries']), 8)
                for text in ('1\n00:00:01,000 --> 00:00:03,000\nNinth', 'x' * (1024**2 + 1)):
                    with self.assertRaises(MediaError) as error:
                        store.upload('source', catalogue['id'], 'bad.srt', 'srt', text)
                    self.assertEqual(error.exception.status, 413)
                store.request(dict(id='other', url='synthetic'))
                other = wait_ready(store, 'other')
                with patch('media.MAX_STORAGE', store.storage):
                    with self.assertRaises(MediaError) as error:
                        store.upload('other', other['id'], 'capacity.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nCapacity')
                    self.assertEqual(error.exception.status, 413)
            finally:
                store.close()

    def test_atomic_apply_fences_instances_retains_pause_and_rejects_invalid_plan_before_stop(self):
        from test_bridge import RestartPolicyTest
        from backend_fixtures import apply_data, start_data
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as folder:
            bridge = RestartPolicyTest().fixture(Path(folder))
            bridge.cast.media_controller.status.content_id = bridge.media_url
            bridge.cast.media_controller.status.player_state = 'PAUSED'
            bridge.cast.media_controller.status.subtitle_tracks = [dict(type='TEXT', trackId=7)]
            bridge.begin = Mock(wraps=bridge.begin)
            producer = bridge.process
            identity = bridge.state['playback_id']
            session = bridge.session
            bridge.mutate('subtitles', apply_data(bridge, enabled=False))
            bridge.begin.assert_not_called()
            self.assertIs(bridge.process, producer)
            self.assertEqual(bridge.session, session)
            self.assertFalse(bridge.state['subtitle_choice']['enabled'])
            self.assertTrue(bridge.paused)
            bridge.submit('subtitles', apply_data(bridge, enabled=False, delay=-250))
            action, payload, _ = bridge.jobs.get_nowait()
            bridge.state['playback_id'] = 'new-playback'
            with self.assertRaises(MediaError):
                bridge.mutate(action, payload)
            bridge.begin.assert_not_called()
            bridge.state['playback_id'] = identity
            bridge.update(command_pending=False)
            malformed = apply_data(bridge)
            malformed['subtitle_id'] = 'foreign'
            with self.assertRaises(MediaError):
                bridge.submit('subtitles', malformed)
            self.assertTrue(bridge.jobs.empty())
            with patch('bridge.subprocess.Popen', return_value=Mock(pid=123)):
                bridge.mutate('subtitles', apply_data(bridge, enabled=True, delay=750))
            bridge.begin.assert_called_once_with(65, plan=bridge.active_plan)
            self.assertTrue(bridge.paused)
            self.assertEqual(bridge.state['playback_id'], identity)
            bridge.begin.reset_mock()
            with patch('bridge.subprocess.Popen', return_value=Mock(pid=124)):
                bridge.mutate('start', start_data(bridge, subtitle=False))
            self.assertNotEqual(bridge.state['playback_id'], identity)
            self.assertIsNone(bridge.active_plan.subtitle)
            self.assertFalse(bridge.active_plan.enabled)

    def test_real_handler_catalogue_upload_start_apply_and_limits(self):
        from test_player_ux import ControlHTTPTest
        from demo import DemoBridge
        from backend_fixtures import demo_start, demo_apply
        bridge = DemoBridge()
        bridge.submit('select_device', dict(device_id='demo-tv-a', device_revision=0))
        def post(route, data):
            handler = ControlHTTPTest().handler(data=data)
            handler.server.bridge, handler.path = bridge, '/api/' + route
            handler.do_POST()
            return handler.reply.call_args.args
        code, body = post('catalogue', dict(source_id='demo-a', refresh=False))
        self.assertEqual(code, 200)
        catalogue = body['catalogue']
        code, body = post('subtitle_upload', dict(source_id='demo-a', catalogue_id=catalogue['id'],
                                                filename='hello.srt', format='srt',
                                                text='1\n00:00:01,000 --> 00:00:03,000\nHello'))
        self.assertEqual(code, 201)
        code, large = post('subtitle_upload', dict(source_id='demo-a', catalogue_id=catalogue['id'],
                                                filename='large.srt', format='srt',
                                                text='1\n00:00:01,000 --> 00:00:03,000\n' + 'x' * 6000))
        self.assertEqual(code, 201)
        payload = demo_start(bridge)
        payload['subtitle_id'] = body['entry']['id']
        self.assertEqual(post('start', payload)[0], 202)
        bridge.submit('pause', dict(device_id='demo-tv-a', device_revision=1))
        bridge.submit('seek', dict(device_id='demo-tv-a', device_revision=1, position=12))
        self.assertEqual(post('subtitles', demo_apply(bridge, enabled=False, delay=250))[0], 202)
        self.assertEqual(bridge.status()['phase'], 'paused')
        self.assertEqual(bridge.status()['absolute_time'], 12)
        self.assertEqual(post('subtitles', dict(device_id='demo-tv-a', device_revision=1, enabled=True))[0], 400)
        self.assertEqual(post('delay', dict(device_id='demo-tv-a', device_revision=1, delay_ms=0))[0], 400)
        for delay in (True, 0.5, '0', 30001, None):
            invalid = demo_apply(bridge)
            invalid['delay_ms'] = delay
            self.assertEqual(post('subtitles', invalid)[0], 400)
        invalid = demo_apply(bridge)
        invalid.update(subtitle_id=None, enabled=True, delay_ms=0)
        self.assertEqual(post('subtitles', invalid)[0], 400)
        handler = ControlHTTPTest().handler()
        handler.path = '/api/start'
        handler.headers.replace_header('Content-Length', '4097')
        handler.do_POST()
        self.assertEqual(handler.reply.call_args.args[0], 413)
        with patch.object(bridge, 'subtitle_upload', side_effect=OSError('PRIVATE-UPLOAD-PATH')):
            code, error = post('subtitle_upload', {})
            self.assertEqual(code, 503)
            self.assertNotIn('PRIVATE', json.dumps(error))
        handler.path = '/api/subtitle_upload'
        handler.headers.replace_header('Content-Length', str(6 * 1024**2 + 4097))
        handler.do_POST()
        self.assertEqual(handler.reply.call_args.args[0], 413)

    def test_upload_validation_capacity_and_shutdown_writer_barrier(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            try:
                store.request(dict(id='source', url='synthetic'))
                catalogue = wait_ready(store)
                def upload(text, format='vtt'):
                    return store.upload('source', catalogue['id'], 'synthetic.' + format, format, text)
                for text in ('', 'WEBVTT\n\nNOTE hi\n', 'WEBVTT\n\nSTYLE\n::cue {}',
                             'WEBVTT\n\n00:00:03.000 --> 00:00:01.000\nBackwards',
                             'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<img src="http://external.test">',
                             'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n&#0;',
                             'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\x00'):
                    with self.subTest(text=text), self.assertRaises(MediaError):
                        upload(text)
                self.assertIsNone(store.upload_dir)
                entered, release = threading.Event(), threading.Event()
                original = normalize_subtitles
                def blocked(*args):
                    entered.set()
                    self.assertTrue(release.wait(2))
                    return original(*args)
                errors = []
                def writer():
                    try:
                        upload('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello')
                    except MediaError as error:
                        errors.append(error.status)
                with patch('media.normalize_subtitles', side_effect=blocked):
                    thread = threading.Thread(target=writer)
                    thread.start()
                    self.assertTrue(entered.wait(1))
                    store.cancel()
                    release.set()
                    thread.join(2)
                self.assertEqual(errors, [503])
                self.assertIsNone(store.upload_dir)
            finally:
                store.close()

    def test_same_plan_start_deduplicates_after_upload_append(self):
        from test_player_ux import PlayerControlsTest
        from backend_fixtures import start_data
        bridge = PlayerControlsTest().fixture()
        bridge.state.update(subtitle_choice=bridge.active_plan.choice())
        bridge.selected = bridge.active_plan.catalogue.source
        bridge.begin = unittest.mock.Mock()
        with tempfile.TemporaryDirectory() as folder:
            bridge.catalogue.parent = Path(folder)
            try:
                bridge.catalogue.upload(bridge.selected['id'], bridge.active_plan.catalogue.id, 'new.srt', 'srt',
                                        '1\n00:00:01,000 --> 00:00:03,000\nNew')
                bridge.mutate('start', start_data(bridge, delay=500))
                bridge.begin.assert_not_called()
            finally:
                bridge.catalogue.close()

    def test_source_bound_any_language_upload_and_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90, (
                Subtitle('english', 'embedded', 'English', 'eng', index=2),
                Subtitle('image', 'embedded', 'PGS', 'jpn', False, index=3))), Path(folder))
            self.addCleanup(store.close)
            store.request(dict(id='source', url='synthetic'))
            catalogue = wait_ready(store)
            self.assertEqual([e['language'] for e in catalogue['entries']], ['eng', 'jpn'])
            self.assertFalse(catalogue['entries'][1]['supported'])
            self.assertIsNone(store.resolve('source', catalogue['id'], None, 0, False).subtitle)
            with self.assertRaises(MediaError):
                store.resolve('other', catalogue['id'], 'english', 0, True)
            with self.assertRaises(MediaError):
                store.resolve('source', catalogue['id'], 'image', 0, True)
            uploaded = store.upload('source', catalogue['id'], '../sample.srt', 'srt',
                                    '1\n00:00:01,000 --> 00:00:03,000\n<b>Hello</b>\n')
            again = store.upload('source', catalogue['id'], 'other.vtt', 'vtt',
                                 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n')
            self.assertEqual(uploaded['entry']['id'], again['entry']['id'])
            plan = store.resolve('source', catalogue['id'], uploaded['entry']['id'], 500, True)
            self.assertEqual(plan.subtitle.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(plan.subtitle.path.parent.stat().st_mode & 0o777, 0o700)
            self.assertNotIn(str(plan.subtitle.path), json.dumps(uploaded))
            store.request(dict(id='source', url='synthetic'), refresh=True)
            refreshed = wait_ready(store)
            self.assertNotEqual(refreshed['id'], catalogue['id'])
            self.assertEqual(store.resolve('source', catalogue['id'], plan.subtitle.id, 0, True).subtitle, plan.subtitle)
            store.close()

    def test_metadata_submission_never_occupies_playback_queue_and_close_fences_publication(self):
        entered, release = threading.Event(), threading.Event()
        def blocked(*_):
            entered.set()
            self.assertTrue(release.wait(3))
            return []
        with patch('bridge.discover_receivers', side_effect=blocked), patch('bridge.urlopen', side_effect=OSError('synthetic offline')):
            bridge = Bridge(arguments([]))
            self.assertTrue(entered.wait(1))
            bridge.submit('discover_devices', {})
            self.assertFalse(bridge.status().get('command_pending', False))
            self.assertTrue(bridge.jobs.empty())
            bridge.submit('stop', {})
            bridge.quit.set()
            release.set()
            bridge.close()
            self.assertEqual(bridge.status()['device_discovery'], 'loading')
            self.assertIsNone(bridge.status()['selected_device'])


class GenericProducerTest(unittest.TestCase):
    def synthetic(self, root):
        srt = root / 'boundary.srt'
        srt.write_text('1\n00:00:05,000 --> 00:00:09,000\nPast\n\n'
                       '2\n00:00:09,000 --> 00:00:13,000\nCrossing\n\n'
                       '3\n00:00:10,200 --> 00:00:10,400\nEarly\n\n'
                       '4\n00:00:11,000 --> 00:00:15,000\nFuture\n\n'
                       '5\n00:00:27,000 --> 00:00:31,000\nLater\n')
        source = root / 'english.mkv'
        fixture = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=black:s=160x90:r=24:d=40', '-f', 'lavfi', '-i',
            'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v', '-map', '1:a',
            '-map', '2:s', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', str(source)],
            capture_output=True, timeout=15)
        self.assertEqual(fixture.returncode, 0, fixture.stderr.decode())
        return source, srt

    def cues(self, session):
        cues = {}
        for path in session.glob('*.vtt'):
            for start, end, label in re.findall(r'(\d+(?::\d+){1,2}\.\d+) --> (\d+(?::\d+){1,2}\.\d+)[^\n]*\n([^\n]+)', path.read_text()):
                def seconds(stamp):
                    value = 0
                    for part in stamp.split(':'):
                        value = value * 60 + float(part)
                    return value
                times = seconds(start), seconds(end)
                self.assertGreater(times[1], times[0])
                if label in cues:
                    self.assertEqual(cues[label], times)
                cues[label] = times
        return cues

    def test_uploaded_srt_and_vtt_crossing_seek_cues_apply_delay_once(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, srt = self.synthetic(root)
            analysis = probe(str(source))
            self.assertEqual(analysis.entries[0].language, 'eng')
            store = SetupCatalogue(lambda *_: analysis, root / 'private')
            try:
                store.request(dict(id='source', url=str(source)))
                catalogue = wait_ready(store)
                for format, text in [('srt', srt.read_text()), ('vtt', normalize_subtitles('srt', srt.read_text()).decode())]:
                    upload = store.upload('source', catalogue['id'], 'synthetic.' + format, format, text)
                    for delay, expected in [(500, {'Crossing': (0, 3.5), 'Early': (.7, .9), 'Future': (1.5, 5.5)}),
                                            (-500, {'Crossing': (0, 2.5), 'Future': (.5, 4.5)})]:
                        with self.subTest(format=format, delay=delay):
                            plan = store.resolve('source', catalogue['id'], upload['entry']['id'], delay, True)
                            session = root / f'{format}-{delay}'
                            session.mkdir()
                            result = subprocess.run(ffmpeg_command(str(source), session, plan,
                                origin=10, duration=12, readrate=1000), capture_output=True, timeout=15)
                            self.assertEqual(result.returncode, 0, result.stderr.decode())
                            cues = self.cues(session)
                            self.assertEqual(set(cues), set(expected))
                            for label, (start, end) in expected.items():
                                self.assertAlmostEqual(cues[label][0], start, delta=.1)
                                self.assertAlmostEqual(cues[label][1], end, delta=.1)
            finally:
                store.close()

    def test_all_four_plans_grow_before_producer_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, srt = self.synthetic(root)
            analysis = probe(str(source))
            catalogue = Catalogue('synthetic', dict(id='source', url=str(source)), analysis)
            processes = []
            upload = root / 'normalized.vtt'
            upload.write_bytes(normalize_subtitles('srt', srt.read_text()))
            vtt = root / 'normalized-again.vtt'
            vtt.write_bytes(normalize_subtitles('vtt', upload.read_text()))
            entries = [None, analysis.entries[0], Subtitle('srt', 'upload', 'SRT', path=upload),
                       Subtitle('vtt', 'upload', 'VTT', path=vtt)]
            try:
                for index, entry in enumerate(entries):
                    session = root / str(index)
                    session.mkdir()
                    process = subprocess.Popen(ffmpeg_command(str(source), session,
                        PlaybackPlan(catalogue, entry, 500 if entry else 0, bool(entry)), duration=40, readrate=4),
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    processes.append((process, session, entry))
                seen = set()
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and len(seen) < 4:
                    for index, (process, session, entry) in enumerate(processes):
                        playlist = session / 'video.m3u8'
                        if playlist.exists():
                            text = playlist.read_text()
                            if text.count('#EXTINF:') >= 3 and process.poll() is None and '#EXT-X-ENDLIST' not in text:
                                self.assertTrue((session / 'master.m3u8').exists())
                                self.assertEqual((session / 'video_vtt.m3u8').exists(), entry is not None)
                                seen.add(index)
                    time.sleep(.05)
                self.assertEqual(seen, {0, 1, 2, 3})
                for process, session, entry in processes:
                    _, stderr = process.communicate(timeout=15)
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    self.assertEqual('SUBTITLES' in (session / 'master.m3u8').read_text(), entry is not None)
            finally:
                for process, _, _ in processes:
                    if process.poll() is None:
                        process.terminate()
                        process.communicate(timeout=5)

    def test_no_subtitle_movie_probes_and_produces_without_text_rendition(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'synthetic.mkv'
            result = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=black:s=160x90:r=24:d=2', '-f', 'lavfi', '-i',
                'anullsrc=r=48000:cl=stereo', '-t', '2', '-c:v', 'libx264',
                '-preset', 'ultrafast', '-c:a', 'aac', str(source)], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            analysis = probe(str(source))
            self.assertEqual(analysis.entries, ())
            from media import Catalogue, PlaybackPlan
            catalogue = Catalogue('catalogue', {'id': 'source', 'url': str(source)}, analysis)
            session = root / 'session'
            session.mkdir()
            command = ffmpeg_command(str(source), session, PlaybackPlan(catalogue, None, 0, False),
                                     duration=2, readrate=1000)
            result = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertNotIn('SUBTITLES', (session / 'master.m3u8').read_text())
            self.assertFalse(list(session.glob('*.vtt')))
            self.assertNotIn('-c:s', command)

    def test_initially_empty_uploaded_subtitles_do_not_delay_video_readiness(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, _ = self.synthetic(root)
            analysis = probe(str(source))
            catalogue = Catalogue('sparse', dict(id='source', url=str(source)), analysis)
            upload = root / 'sparse.vtt'
            upload.write_text('WEBVTT\n\n00:01:10.000 --> 00:01:15.000\nLater subtitle\n')
            session = root / 'session'
            session.mkdir()
            plan = PlaybackPlan(catalogue, Subtitle('sparse', 'upload', 'Sparse', path=upload), 0, True)
            process = subprocess.Popen(ffmpeg_command(str(source), session, plan, duration=40, readrate=4),
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                ready_while_alive = False
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and process.poll() is None:
                    playlist = session / 'video.m3u8'
                    if playlist.exists() and playlist.read_text().count('#EXTINF:') >= 3:
                        ready_while_alive = ((session / 'master.m3u8').exists()
                                             and (session / 'video_vtt.m3u8').exists())
                        break
                    time.sleep(.05)
                self.assertTrue(ready_while_alive, 'A future first cue must not block a ready video.')
            finally:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=5)
