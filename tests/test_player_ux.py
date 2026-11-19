import json
import io
from email.message import Message
import queue
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge import Bridge, BridgeError, ControlHandler, PreparationCancelled
from backend_fixtures import install_media, seed_plan, start_data, apply_data, demo_start, demo_apply


class PlayerControlsTest(unittest.TestCase):
    def fixture(self):
        b = Bridge.__new__(Bridge)
        b.state_lock = threading.Lock()
        b.state = {'phase': 'playing', 'sources': [], 'selected_device':{'id':'fixture-device','available':True}, 'device_revision':1}
        b.selected_device_id = 'fixture-device'
        b.jobs = queue.Queue(maxsize=16)
        b.loaded = True
        b.selected = None
        b.media_url = 'owned-session'
        b.cast = Mock()
        b.cast.media_controller.status = SimpleNamespace(content_id='owned-session',
            player_state='PLAYING', subtitle_tracks=[{'type': 'TEXT', 'trackId': 7}])
        b.cast.status = SimpleNamespace(volume_level=0.3, volume_muted=False)
        install_media(b)
        b.origin = 0
        return b

    def test_volume_mute_and_subtitles_control_only_owned_loaded_content(self):
        b = self.fixture()
        b.mutate('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': 0.25})
        b.cast.set_volume.assert_called_once_with(0.25)
        b.mutate('mute', {'device_id':'fixture-device', 'device_revision':1, 'muted': True})
        b.cast.set_volume_muted.assert_called_once_with(True)
        b.mutate('subtitles', apply_data(b, enabled=False))
        b.cast.media_controller.disable_subtitle.assert_called_once_with()
        self.assertFalse(b.status()['subtitle_choice']['enabled'])
        b.mutate('subtitles', apply_data(b, enabled=True))
        b.cast.media_controller.enable_subtitle.assert_called_once_with(7)
        for owned, loaded in ((False, True), (True, False)):
            b.cast.media_controller.status.content_id = 'owned-session' if owned else 'foreign'
            b.loaded = loaded
            for action, data in [('volume', {'level': .5}), ('mute', {'muted': False}),
                                 ('subtitles', apply_data(b, enabled=False))]:
                with self.assertRaises(BridgeError):
                    b.mutate(action, {'device_id':'fixture-device', 'device_revision':1, **(data)})
        b.cast.connect.assert_not_called()

    def test_control_types_are_strict_and_queue_conflicts_are_rejected(self):
        b = self.fixture()
        for level in (True, False, '0.5', None, float('nan'), float('inf'), -0.1, 1.1):
            with self.subTest(level=level), self.assertRaises(BridgeError):
                b.mutate('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': level})
        for value in (0, 1, 'false', None):
            for action, key in [('mute', 'muted'), ('subtitles', 'enabled')]:
                with self.assertRaises(BridgeError):
                    b.mutate(action, {'device_id':'fixture-device', 'device_revision':1, key: value})
        b.submit('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': .4})
        with self.assertRaises(BridgeError):
            b.submit('mute', {'device_id':'fixture-device', 'device_revision':1, 'muted': True})
        b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, 'playback_id':b.state['playback_id']})

    def test_disconnected_receiver_rejects_stale_owned_status(self):
        b = self.fixture()
        b.cast.socket_client.is_connected = False
        with self.assertRaises(BridgeError):
            b.mutate('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': .5})
        b.cast.set_volume.assert_not_called()

    def test_same_worker_failure_publishes_a_new_revision_each_retry(self):
        b = self.fixture()
        b.quit = threading.Event()
        b.args = SimpleNamespace(state_file=None)
        b.session = None
        b.stop = Mock()
        b.tick = Mock(side_effect=b.quit.set)
        b.cast.set_volume_muted.side_effect = RuntimeError('private receiver diagnostics')
        revisions = []
        for _ in range(2):
            b.quit.clear()
            b.submit('mute', {'device_id':'fixture-device', 'device_revision':1, 'muted': True})
            b._work()
            status = b.status()
            revisions.append(status.get('action_error_revision'))
            self.assertEqual(status['action_error'], 'No se pudo ejecutar la acción. Revisá la fuente y el receptor.')
            self.assertNotIn('private receiver', json.dumps(status))
        self.assertEqual(revisions, [1, 2])

    def test_subtitle_off_survives_tick_seek_and_receiver_readback(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.cast.media_controller.status.content_id = b.media_url
            b.cast.media_controller.status.subtitle_tracks = [{'type': 'TEXT', 'trackId': 7}]
            b.cast.media_controller.status.player_state = 'PAUSED'
            b.cast.status = SimpleNamespace(volume_level=.2, volume_muted=True)
            b.process = Mock(pid=123)
            b.process.poll.return_value = None
            b.last_playing_segments = None
            b.mutate('subtitles', apply_data(b, enabled=False))
            b.tick()
            b.cast.media_controller.enable_subtitle.assert_not_called()
            self.assertEqual(b.status()['volume'], .2)
            self.assertTrue(b.status()['muted'])
            with patch('bridge.subprocess.Popen', return_value=b.process), \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                b.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 60})
            self.assertFalse(b.status()['subtitle_choice']['enabled'])
            self.assertTrue(b.paused)
            b.cast.media_controller.enable_subtitle.assert_not_called()
            (b.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
            (b.session / 'video_vtt.m3u8').write_text('#EXTM3U\n#EXTINF:6.0,\nvideo0.vtt\n')
            (b.session / 'master.m3u8').touch()
            b.tick()
            b.cast.media_controller.status.content_id = b.media_url
            b.tick()
            b.cast.media_controller.enable_subtitle.assert_not_called()


class CancellationTest(unittest.TestCase):
    def test_automatic_tick_failure_keeps_cleanup_busy_until_completion(self):
        b = PlayerControlsTest().fixture()
        b.quit = threading.Event()
        b.args = SimpleNamespace(state_file=None, autostart=True)
        b.session = None
        b.tick = Mock(side_effect=BridgeError('synthetic tick failure'))
        observed = []
        def cleanup(*args, **kwargs):
            if b.quit.is_set():
                return
            observed.append(b.status().get('command_pending'))
            try:
                for action, data in [('start', {}), ('volume', {'level': .2}),
                                     ('start', {'autostart': True})]:
                    with self.assertRaises(BridgeError):
                        b.submit(action, {'device_id':'fixture-device', 'device_revision':1, **(data)})
            finally:
                b.quit.set()
        b.stop = cleanup
        b.submit('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': .4})
        b._work()
        self.assertEqual(observed, [True])
        self.assertFalse(b.status()['command_pending'])
        self.assertEqual(b.status()['phase'], 'error')

    def test_stop_at_connect_invocation_fences_uncommitted_discovery(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.cast = None
            b.jobs = queue.Queue()
            b.args.device_name, b.args.device_host = 'Fixture', None
            b.devices = {'fixture-device': SimpleNamespace(uuid='fixture-device', cast_type='cast', friendly_name='Fixture', host='192.0.2.2', model_name='Chromecast')}
            b.device_revision = 1
            connect = Bridge.connect
            def stop_then_connect(bridge, *args, **kwargs):
                b.submit('stop', {'device_id':'fixture-device', 'device_revision':1})
                return connect(bridge, *args, **kwargs)
            with patch.object(Bridge, 'connect', autospec=True, side_effect=stop_then_connect) as connecting, \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)), \
                 patch('bridge.discover_receivers', side_effect=AssertionError('cancelled scan forbidden')) as discovery, \
                 patch('pychromecast.dial.get_device_info', side_effect=AssertionError('cancelled connection forbidden')), \
                 patch('bridge.subprocess.Popen') as launch:
                with self.assertRaises(PreparationCancelled):
                    b.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 30})
                connecting.assert_called_once()
                discovery.assert_not_called()
                launch.assert_not_called()

    def test_stop_acceptance_and_status_remain_responsive_during_committed_connection(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.cast = None
            b.jobs = queue.Queue()
            b.args.device_name, b.args.device_host = 'Fixture', None
            b.devices = {'fixture-device': SimpleNamespace(uuid='fixture-device', cast_type='cast', friendly_name='Fixture', host='192.0.2.2', model_name='Chromecast')}
            b.device_revision = 1
            entered, release, accepted = threading.Event(), threading.Event(), threading.Event()
            receiver = Mock()
            receiver.cast_info = SimpleNamespace(friendly_name='Fixture')
            errors = []
            def endpoint(*args, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                return SimpleNamespace(uuid='fixture-device', cast_type='cast')
            def prepare():
                try:
                    b.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 30})
                except BridgeError as error:
                    errors.append(error)
            def cancel():
                b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, })
                self.assertTrue(b.status()['command_pending'])
                accepted.set()
            with patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)), \
                  patch('bridge.discover_receivers', side_effect=AssertionError('no scan on connect')), \
                  patch('pychromecast.dial.get_device_info', side_effect=endpoint), \
                 patch('bridge.subprocess.Popen') as launch:
                worker = threading.Thread(target=prepare)
                worker.start()
                stopper = threading.Thread(target=cancel)
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertEqual(b.connection_generation, 0)
                    stopper.start()
                    self.assertTrue(accepted.wait(1))
                finally:
                    release.set()
                    worker.join(3)
                    if stopper.ident is not None:
                        stopper.join(3)
                self.assertFalse(worker.is_alive())
                self.assertTrue(errors)
                from bridge import PreparationCancelled
                self.assertIsInstance(errors[0], PreparationCancelled)
                self.assertIsNone(b.connection_generation)
                launch.assert_not_called()
                receiver.media_controller.play_media.assert_not_called()
                b.stop()
                receiver.disconnect.assert_not_called()

    def test_stop_submission_interleaves_with_worker_completion_without_losing_busy(self):
        b = PlayerControlsTest().fixture()
        b.quit = threading.Event()
        b.args = SimpleNamespace(state_file=None)
        b.session = None
        completing, stop_accepted = threading.Event(), threading.Event()
        stop_threads = []
        class InterleavedQueue(queue.Queue):
            injected = False
            def empty(self):
                snapshot = super().empty()
                if completing.is_set() and not self.injected:
                    self.injected = True
                    def submit_stop():
                        b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, 'playback_id':b.state['playback_id']})
                        stop_accepted.set()
                    thread = threading.Thread(target=submit_stop)
                    stop_threads.append(thread)
                    thread.start()
                    # If publication is unlocked, force Stop into that exact gap.
                    # Under the fixed lock it must wait until publication completes.
                    if not b.state_lock.locked():
                        stop_accepted.wait(1)
                return snapshot
        b.jobs = InterleavedQueue()
        b.cast.set_volume.side_effect = lambda _: completing.set()
        b.tick = lambda: stop_accepted.wait(1)
        observed = []
        def cleanup(*args, **kwargs):
            if not b.quit.is_set():
                observed.append(b.status()['command_pending'])
                with self.assertRaises(BridgeError):
                    b.submit('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': .5})
                b.quit.set()
        b.stop = cleanup
        b.submit('volume', {'device_id':'fixture-device', 'device_revision':1, 'level': .4})
        b._work()
        for thread in stop_threads:
            thread.join(1)
        self.assertEqual(observed, [True])

    def test_stop_is_accepted_while_preparation_blocks_and_cleanup_stays_busy(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.jobs = queue.Queue()
            b.args.state_file = None
            entered, release, cleaning, finish = [threading.Event() for _ in range(4)]
            b.connect = Mock()
            def blocked_preparation(*args):
                entered.set()
                if not release.wait(2):
                    raise AssertionError('probe release timed out')
                return None
            original_stop = b.stop
            def cleanup(*args, **kwargs):
                if not b.quit.is_set():
                    cleaning.set()
                    finish.wait(2)
                    b.quit.set()
                original_stop()
            b.stop = cleanup
            with patch.object(b, 'stop_process', side_effect=blocked_preparation), patch('bridge.subprocess.Popen') as launch:
                b.submit('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 30})
                worker = threading.Thread(target=b._work)
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, })
                    release.set()
                    self.assertTrue(cleaning.wait(1))
                    self.assertTrue(b.status()['command_pending'])
                    with self.assertRaises(BridgeError):
                        b.submit('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 40})
                finally:
                    release.set()
                    finish.set()
                    worker.join(3)
                self.assertFalse(worker.is_alive())
                b.connect.assert_not_called()
                launch.assert_not_called()

    def test_cancel_after_preparation_prevents_ready_media_load(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.loaded = False
            b.jobs = queue.Queue()
            b.process = Mock()
            b.process.poll.return_value = None
            b.last_playing_segments = None
            b.started_at = time.monotonic()
            (b.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
            (b.session / 'video_vtt.m3u8').write_text('#EXTM3U\n#EXTINF:6.0,\nvideo0.vtt\n')
            (b.session / 'master.m3u8').touch()
            b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, })
            b.tick()
            b.cast.media_controller.play_media.assert_not_called()

    def test_stop_during_probe_or_connection_fences_producer_and_load(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        for stage in ('preparation', 'connect', 'queued-seek', 'queued-start'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
                b = RestartPolicyTest().fixture(Path(folder))
                b.jobs = queue.Queue()
                b.args.state_file = None
                b.connect = Mock()
                def cancel(*args):
                    b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, })
                    return ([0, 1, 2], 120)
                with patch.object(b, 'stop_process', side_effect=cancel if stage == 'preparation' else None), \
                     patch('bridge.subprocess.Popen') as launch, \
                     patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                    if stage == 'connect':
                        b.connect.side_effect = cancel
                    if stage.startswith('queued-'):
                        b.sources = [b.selected]
                        b.args.autostart = False
                        b.args.subtitle_delay_ms = 0
                        payload = start_data(b) if stage == 'queued-start' else {'device_id':'fixture-device', 'device_revision':1, 'position':30}
                        b.submit(stage.removeprefix('queued-'), payload)
                        b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, })
                        b.stop = Mock(side_effect=b.quit.set)
                        b.tick = Mock()
                        b._work()
                        b.connect.assert_not_called()
                        b.tick.assert_not_called()
                    else:
                        with self.assertRaises(BridgeError):
                            b.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 30})
                        if stage == 'preparation':
                            b.connect.assert_not_called()
                    launch.assert_not_called()
                    b.cast.media_controller.play_media.assert_not_called()

    def test_stop_cleanup_keeps_conflicting_commands_blocked(self):
        b = PlayerControlsTest().fixture()
        b.quit = threading.Event()
        b.args = SimpleNamespace(state_file=None)
        b.session = None
        b.tick = Mock()
        accepted = []
        def cleanup(*args, **kwargs):
            if b.quit.is_set():
                return
            self.assertTrue(b.status()['command_pending'])
            with self.assertRaises(BridgeError):
                b.submit('start', {'device_id':'fixture-device', 'device_revision':1, })
            accepted.append(True)
            b.quit.set()
        b.stop = Mock(side_effect=cleanup)
        b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, 'playback_id':b.state['playback_id']})
        b._work()
        self.assertTrue(accepted)


class SourceSelectionTest(unittest.TestCase):
    def test_same_owned_start_preserves_pipeline_pause_position_and_delay(self):
        b = PlayerControlsTest().fixture()
        a = {'id': 'a', 'url': 'synthetic-a', 'title': 'Example'}
        b.sources = [a]
        b.selected = a
        b.active_plan = seed_plan(b, a, delay=1200)
        b.update(subtitle_choice=b.active_plan.choice())
        b.args = SimpleNamespace(subtitle_delay_ms=0, autostart=False)
        b.begin = Mock()
        b.paused = True
        b.update(phase='paused', absolute_time=600, subtitle_delay_ms=1200)
        b.cast.media_controller.status.player_state = 'PAUSED'
        before = b.status()
        b.mutate('start', start_data(b, delay=1200))
        b.begin.assert_not_called()
        self.assertTrue(b.paused)
        self.assertEqual(b.status(), before)
        for phase, content in [('ended', 'owned-session'), ('error', 'owned-session'),
                               ('playing', 'foreign')]:
            b.update(phase=phase)
            b.cast.media_controller.status.content_id = content
            b.mutate('start', start_data(b, delay=1200))
        self.assertEqual(b.begin.call_count, 3)

    def test_saved_url_is_deduplicated_and_missing_name_warns(self):
        b = PlayerControlsTest().fixture()
        b.args = SimpleNamespace(source_file='synthetic-source-file')
        torrent = 'a' * 40
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({torrent:{'files':[{'name':'Movie.mkv'}]}}).encode()
        with patch('bridge.Path.read_text', return_value=json.dumps({'source':f'http://127.0.0.1:11470/{torrent}/0'})), \
             patch('bridge.urlopen', return_value=response), \
             patch('bridge.json.load', return_value={torrent:{'files':[{'name':'Movie.mkv'}]}}):
            b.mutate('discover', {'device_id':'fixture-device', 'device_revision':1, })
        sources = b.status()['sources']
        self.assertEqual(len(sources), 1)
        self.assertTrue(sources[0]['saved'])
        self.assertEqual(sources[0]['filename'], 'Movie.mkv')
        self.assertNotIn('127.0.0.1', json.dumps(sources))
        with patch('bridge.Path.read_text', return_value=json.dumps({'source':'http://private/saved'})), \
             patch('bridge.urlopen', side_effect=OSError('offline')):
            b.mutate('discover', {'device_id':'fixture-device', 'device_revision':1, })
        self.assertIn('sin nombre', b.status()['sources'][0]['title'])

    def test_reordering_deduplication_and_removal_never_retargets_selection(self):
        b = PlayerControlsTest().fixture()
        b.args = SimpleNamespace(source_file=None, subtitle_delay_ms=0)
        b.begin = Mock()
        torrent = 'a' * 40
        def discover(files):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = json.dumps({torrent: {'files': files}}).encode()
            with patch('bridge.urlopen', return_value=response), patch('bridge.json.load', return_value={torrent: {'files': files}}):
                b.mutate('discover', {'device_id':'fixture-device', 'device_revision':1, })
        discover({'0': {'name': 'Movie.One.mkv'}, '1': {'name': 'Movie.Two.mkv'}})
        chosen = b.status()['sources'][0]['id']
        self.assertEqual(b.status()['sources'][0]['filename'], 'Movie.One.mkv')
        discover({'1': {'name': 'Movie.Two.mkv'}, '0': {'name': 'Movie.One.mkv'}})
        chosen_source = next(s for s in b.sources if s['id'] == chosen)
        b.mutate('start', start_data(b, chosen_source))
        self.assertTrue(b.begin.call_args.kwargs['plan'].catalogue.source['url'].endswith('/0'))
        discover({'1': {'name': 'Movie.Two.mkv'}})
        with self.assertRaises(BridgeError):
            b.mutate('start', {'device_id':'fixture-device', 'device_revision':1, 'source_id': chosen})
        with self.assertRaises(BridgeError):
            b.mutate('start', {'device_id':'fixture-device', 'device_revision':1, })
        self.assertNotIn('http', json.dumps(b.status()))

    def test_legacy_autostart_payload_cannot_bypass_explicit_catalogue_choice(self):
        b = PlayerControlsTest().fixture()
        b.args = SimpleNamespace(subtitle_delay_ms=0, autostart=True)
        b.sources = [{'id': 'stable', 'url': 'private', 'title': 'Example'}]
        b.begin = Mock()
        with self.assertRaises(BridgeError):
            b.mutate('start', {'device_id':'fixture-device', 'device_revision':1, 'autostart': True})
        b.begin.assert_not_called()

    def test_prepared_start_is_fenced_by_stop_before_worker_execution(self):
        b = PlayerControlsTest().fixture()
        b.args = SimpleNamespace(autostart=True, state_file=None)
        b.quit = threading.Event()
        b.session = None
        b.discover = Mock()
        b.begin = Mock()
        b.stop = Mock(side_effect=b.quit.set)
        b.tick = Mock()
        b.submit('start', start_data(b))
        b.submit('stop', {'device_id':'fixture-device', 'device_revision':1, 'playback_id':b.state['playback_id']})
        b._work()
        b.begin.assert_not_called()
        b.discover.assert_not_called()
        b.tick.assert_not_called()


class BufferStatusTest(unittest.TestCase):
    def test_switching_source_clears_previous_interval_while_connection_blocks(self):
        import tempfile
        from pathlib import Path
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            b = RestartPolicyTest().fixture(Path(folder))
            b.update(phase='playing', origin=0, duration=90, absolute_time=30, source_id='a')
            b.sources = [{'id':'b', 'url':'synthetic-b', 'title':'Beta'}]
            b.args.subtitle_delay_ms = 0
            def inspect_new_source(*args):
                status = b.status()
                self.assertEqual(status['source_id'], 'b')
                self.assertIsNone(status['buffered_end'])
                self.assertIsNone(status['buffer_ahead_seconds'])
                raise BridgeError('synthetic probe failure')
            with patch.object(b, 'connect', side_effect=inspect_new_source):
                with self.assertRaises(BridgeError):
                    b.mutate('start', start_data(b))

    def test_actual_hls_interval_is_absolute_clamped_and_cleared_when_inactive(self):
        b = PlayerControlsTest().fixture()
        b.update(origin=600, playlist_duration=90, absolute_time=630, duration=660, source_id='a')
        s = b.status()
        self.assertEqual((s.get('buffered_start'), s.get('buffered_end'), s.get('buffer_ahead_seconds')), (600, 660, 30))
        self.assertEqual(s.get('source_id'), 'a')
        for changes in ({'phase': 'stopped'}, {'playlist_duration': float('nan')},
                        {'origin': None}, {'duration': 0}):
            b.update(phase='playing', origin=600, duration=660, playlist_duration=90)
            b.update(**changes)
            self.assertIsNone(b.status().get('buffer_ahead_seconds'))
        b.update(phase='playing', origin=600, duration=660, playlist_duration=12, absolute_time=650)
        self.assertEqual(b.status()['buffer_ahead_seconds'], 0)


class DemoTest(unittest.TestCase):
    def test_same_source_start_and_source_switch_preserve_the_demo_contract(self):
        from demo import DemoBridge
        d = DemoBridge()
        d.submit('discover_devices', {'device_id':'demo-tv-a', 'device_revision':1, })
        d.submit('select_device', {'device_id':'demo-tv-a', 'device_revision':0})
        d.submit('scenario', {'device_id':'demo-tv-a', 'device_revision':1, 'state': 'empty'})
        d.submit('discover', {'device_id':'demo-tv-a', 'device_revision':1, })
        self.assertEqual(d.status().get('scenario'), 'ready')
        d.submit('start', demo_start(d))
        d.submit('pause', {'device_id':'demo-tv-a', 'device_revision':1, })
        d.submit('seek', {'device_id':'demo-tv-a', 'device_revision':1, 'position': 600})
        d.submit('subtitles', demo_apply(d, delay=1200))
        before = d.status()
        d.submit('start', demo_start(d, delay=1200))
        self.assertEqual(d.status(), before)
        self.assertEqual(d.status().get('source_id'), 'demo-a')
        self.assertEqual(d.status().get('buffer_ahead_seconds'), 60)
        self.assertEqual(d.status().get('buffered_start'), 600)
        d.submit('start', demo_start(d, 'demo-b'))
        self.assertEqual(d.status()['subtitle_delay_ms'], 0)
        self.assertEqual(d.status()['buffered_start'], 0)
        d.submit('scenario', {'device_id':'demo-tv-a', 'device_revision':1, 'state': 'error'})
        first = d.status()['action_error_revision']
        d.submit('scenario', {'device_id':'demo-tv-a', 'device_revision':1, 'state': 'error'})
        self.assertGreater(d.status()['action_error_revision'], first)
        d.submit('stop', {'device_id':'demo-tv-a', 'device_revision':1, })
        self.assertIsNone(d.status()['buffer_ahead_seconds'])

    def test_memory_demo_never_touches_hardware_files_or_processes(self):
        import demo
        with patch('bridge.Bridge', side_effect=AssertionError('real bridge forbidden')), \
             patch('socket.socket', side_effect=AssertionError('socket forbidden')), \
             patch('subprocess.Popen', side_effect=AssertionError('process forbidden')), \
             patch('pathlib.Path.read_text', side_effect=AssertionError('file read forbidden')), \
             patch('bridge.urlopen', side_effect=AssertionError('network forbidden')):
            d = demo.DemoBridge()
            self.assertEqual(d.status()['scenario'], 'ready')
            d.submit('discover_devices', {'device_id':'demo-tv-a', 'device_revision':1, })
            d.submit('select_device', {'device_id':'demo-tv-a', 'device_revision':0})
            self.assertTrue(d.status()['demo'])
            d.submit('discover', {'device_id':'demo-tv-a', 'device_revision':1, })
            source = d.status()['sources'][0]['id']
            d.submit('start', demo_start(d, source))
            self.assertEqual(d.status()['phase'], 'playing')
            for action, data in [('pause', {}), ('seek', {'position': 75}), ('volume', {'level': .2}),
                                 ('mute', {'muted': True}), ('subtitles', demo_apply(d, enabled=False, delay=-100))]:
                d.submit(action, {'device_id':'demo-tv-a', 'device_revision':1, **(data)})
            self.assertEqual(d.status()['phase'], 'paused')
            self.assertEqual(d.status()['absolute_time'], 75)
            self.assertFalse(d.status()['subtitles_enabled'])
            d.submit('scenario', {'device_id':'demo-tv-a', 'device_revision':1, 'state': 'foreign'})
            with self.assertRaises(BridgeError):
                d.submit('volume', {'device_id':'demo-tv-a', 'device_revision':1, 'level': .5})
            d.submit('stop', {'device_id':'demo-tv-a', 'device_revision':1, })
            self.assertEqual(d.status()['phase'], 'stopped')
        for args in (['--port', '18766'], ['--port', '18767'], ['--host', '0.0.0.0']):
            with self.assertRaises(SystemExit):
                demo.arguments(args)


class ControlHTTPTest(unittest.TestCase):
    def test_api_keeps_readable_action_errors(self):
        h = self.handler(data={'level': .3})
        h.server.bridge.submit.side_effect = BridgeError('Esperá a que termine la acción anterior.')
        h.do_POST()
        self.assertEqual(h.reply.call_args.args, (400, {'code':'invalid_request', 'message': 'Esperá a que termine la acción anterior.'}))

    def handler(self, origin='http://127.0.0.1:18777', host='127.0.0.1:18777', token='secret', data=None):
        h = ControlHandler.__new__(ControlHandler)
        h.server = SimpleNamespace(server_port=18777, token='secret', bridge=Mock())
        h.headers = Message()
        for key, value in [('Host', host), ('Origin', origin), ('X-Bridge-Token', token), ('Content-Type', 'application/json')]:
            if value is not None:
                h.headers[key] = value
        body = json.dumps({} if data is None else data).encode()
        h.headers['Content-Length'] = str(len(body))
        h.rfile = io.BytesIO(body)
        h.path = '/api/volume'
        h.reply = Mock()
        return h

    def test_http_requires_exact_host_origin_token_and_blocks_autostart(self):
        for values in ({'host':'localhost:18777'}, {'origin':None}, {'origin':'http://evil.test'},
                       {'token':'wrong'}, {'data':{'autostart':True}}):
            h = self.handler(**values)
            h.do_POST()
            h.server.bridge.submit.assert_not_called()
            self.assertIn(h.reply.call_args.args[0], (400, 403))
        h = self.handler(data={'level':.3})
        h.do_POST()
        h.server.bridge.submit.assert_called_once_with('volume', {'level':.3})
        self.assertEqual(h.reply.call_args.args[0], 202)

    def test_demo_and_production_render_the_same_panel(self):
        from demo import DemoBridge
        h = self.handler()
        h.server.bridge = DemoBridge()
        h.path = '/'
        h.do_GET()
        body = h.reply.call_args.args[1]
        self.assertIn('id="timeline"', body)
        self.assertIn('Modo de prueba', body)
        self.assertIn("const token='secret'", body)
        self.assertNotIn('__SCRIPT__', body)
        from html.parser import HTMLParser
        class Panel(HTMLParser):
            def __init__(self):
                super().__init__()
                self.in_dialog = False
                self.dialogs = 0
                self.dialog_ids = set()
                self.page_ids = set()
            def handle_starttag(self, tag, attrs):
                if tag == 'dialog':
                    self.in_dialog = True
                    self.dialogs += 1
                if self.in_dialog:
                    self.dialog_ids.add(dict(attrs).get('id'))
                else:
                    self.page_ids.add(dict(attrs).get('id'))
            def handle_endtag(self, tag):
                if tag == 'dialog':
                    self.in_dialog = False
        panel = Panel()
        panel.feed(body)
        self.assertEqual(panel.dialogs, 1)
        self.assertTrue({'more-panel', 'confirm-panel', 'mini-transport', 'mini-play',
                         'mini-cancel', 'sheet-demo'} <= panel.dialog_ids)
        self.assertTrue({'setup', 'source-panel', 'subtitles-panel', 'device-panel'} <= panel.page_ids)
        self.assertTrue({'source-panel', 'subtitles-panel', 'device-panel'}.isdisjoint(panel.dialog_ids))
        self.assertIn('id="seek-apply"', body)
        self.assertIn('id="seek-cancel"', body)
        self.assertIn('inputmode="text"', body)
        self.assertNotIn('La noche del faro', body)
        self.assertNotIn('connect-src \'none\'', body)

    def test_panel_escapes_device_name_without_external_resources(self):
        from demo import DemoBridge
        h = self.handler()
        h.server.bridge = DemoBridge()
        h.server.bridge.args.device_name = '<TV & "sala">'
        h.path = '/'
        h.do_GET()
        body = h.reply.call_args.args[1]
        self.assertIn('Sin dispositivo elegido', body)
        self.assertNotIn('<TV &', body)
        self.assertNotIn('<img', body)
        self.assertNotIn('<video', body)
        self.assertNotIn('<canvas', body)
