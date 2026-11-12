import tempfile
import unittest
import time
import threading
from pathlib import Path
from unittest.mock import Mock, patch

from bridge import BridgeError
from demo import DemoBridge
import test_bridge
from backend_fixtures import apply_data, demo_start, start_data
from media import Analysis, MediaError, SetupCatalogue, normalize_subtitles


def ready(store, source):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        snapshot = store.snapshot().get(source, {})
        if snapshot.get('state') == 'ready':
            return snapshot['catalogue']
        time.sleep(.01)
    raise AssertionError(store.snapshot())


class StopIdentityTest(unittest.TestCase):
    def test_stop_identity_is_checked_before_cancellation_and_again_at_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = test_bridge.RestartPolicyTest().fixture(Path(folder))
            bridge.state['phase'] = 'playing'
            destination = dict(device_id='fixture-device', device_revision=1)
            for identity in (..., None, '', False, 1, [], {}, 'old-playback'):
                payload = dict(destination)
                if identity is not ...:
                    payload['playback_id'] = identity
                with self.subTest(identity=identity), self.assertRaises(BridgeError):
                    bridge.submit('stop', payload)
                self.assertEqual(getattr(bridge, 'cancel_generation', 0), 0)
                self.assertTrue(bridge.jobs.empty())
            payload = dict(destination, playback_id=bridge.state['playback_id'])
            bridge.submit('stop', payload)
            self.assertEqual(bridge.cancel_generation, 1)
            action, queued, _ = bridge.jobs.get_nowait()
            bridge.state['playback_id'] = 'replacement'
            with patch.object(bridge, 'stop') as stop:
                with self.assertRaises(BridgeError):
                    bridge.mutate(action, queued)
                stop.assert_not_called()

    def test_no_id_stop_only_cancels_preparation_or_cleans_terminal_resources(self):
        with tempfile.TemporaryDirectory() as folder:
            for phase in ('preparing', 'buffering', 'loading', 'error', 'ended', 'stopped'):
                root = Path(folder) / phase
                root.mkdir()
                bridge = test_bridge.RestartPolicyTest().fixture(root)
                bridge.state['phase'] = phase
                payload = dict(device_id='fixture-device', device_revision=1)
                bridge.submit('stop', payload)
                action, queued, _ = bridge.jobs.get_nowait()
                with patch.object(bridge, 'stop') as stop:
                    bridge.mutate(action, queued)
                    stop.assert_called_once()
            bridge.state['phase'] = 'preparing'
            bridge.submit('stop', payload)
            action, queued, _ = bridge.jobs.get_nowait()
            bridge.state['phase'] = 'paused'
            with patch.object(bridge, 'stop') as stop:
                with self.assertRaises(BridgeError):
                    bridge.mutate(action, queued)
                stop.assert_not_called()

    def test_demo_stop_has_the_same_instance_and_missing_identity_rules(self):
        demo = DemoBridge()
        demo.submit('select_device', dict(device_id='demo-tv-a', device_revision=0))
        demo.submit('start', demo_start(demo))
        payload = dict(device_id='demo-tv-a', device_revision=1)
        for identity in (..., None, '', False, 1, [], {}, 'stale'):
            candidate = dict(payload)
            if identity is not ...:
                candidate['playback_id'] = identity
            with self.subTest(identity=identity), self.assertRaises(BridgeError):
                demo.submit('stop', candidate)
            self.assertEqual(demo.status()['phase'], 'playing')
        demo.submit('stop', dict(payload, playback_id=demo.status()['playback_id']))
        demo.submit('stop', payload)
        demo.submit('scenario', dict(state='loading'))
        demo.submit('stop', payload)


class ProducerAssociationTest(unittest.TestCase):
    def test_confirmed_stop_during_teardown_cannot_be_invalidated_by_late_start_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = test_bridge.RestartPolicyTest().fixture(Path(folder))
            bridge.state['phase'] = 'playing'
            identity = bridge.state['playback_id']
            old_plan = bridge.active_plan
            payload = start_data(bridge, subtitle=False)
            bridge.cast.media_controller.status.content_id = bridge.media_url
            def cancel():
                bridge.submit('stop', dict(device_id='fixture-device', device_revision=1, playback_id=identity))
            with patch.object(bridge, 'stop_process', side_effect=cancel), patch('bridge.subprocess.Popen') as launch:
                with self.assertRaises(BridgeError):
                    bridge.mutate('start', payload)
                launch.assert_not_called()
            self.assertEqual(bridge.state['playback_id'], identity)
            self.assertIs(bridge.active_plan, old_plan)
            action, queued, _ = bridge.jobs.get_nowait()
            with patch.object(bridge, 'stop') as stop:
                bridge.mutate(action, queued)
                stop.assert_called_once()

    def test_first_cleanup_failure_retains_the_loaded_plan_and_playback_identity(self):
        for action in ('subtitles', 'start'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as folder:
                bridge = test_bridge.RestartPolicyTest().fixture(Path(folder))
                bridge.cast.media_controller.status.content_id = bridge.media_url
                bridge.cast.media_controller.status.player_state = 'PAUSED'
                bridge.state['phase'] = 'paused'
                bridge.process = Mock(pid=123)
                old_plan, old_session, old_process = bridge.active_plan, bridge.session, bridge.process
                old_identity, old_url = bridge.state['playback_id'], bridge.media_url
                old_choice = bridge.status()['subtitle_choice']
                payload = (apply_data(bridge, enabled=False, subtitle_id=None, delay=0)
                           if action == 'subtitles' else start_data(bridge, subtitle=False))
                with patch.object(bridge, 'stop_process', side_effect=OSError('synthetic teardown failure')):
                    with self.assertRaises(OSError):
                        bridge.mutate(action, payload)
                self.assertIs(bridge.active_plan, old_plan)
                self.assertEqual(bridge.status()['subtitle_choice'], old_choice)
                self.assertEqual(bridge.state['playback_id'], old_identity)
                self.assertEqual(bridge.session, old_session)
                self.assertIs(bridge.process, old_process)
                self.assertEqual(bridge.media_url, old_url)
                self.assertTrue(bridge.loaded)
                self.assertTrue(bridge._destination_busy())
                bridge.last_playing_segments = None
                old_process.poll.return_value = None
                with patch.object(bridge, 'record_session'):
                    bridge.tick()
                self.assertIs(bridge.active_plan, old_plan)
                self.assertEqual(bridge.status()['subtitle_choice'], old_choice)


class ReceiverObservationTest(unittest.TestCase):
    def test_unknown_tracks_stay_unknown_and_observed_empty_tracks_are_hidden(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = test_bridge.RestartPolicyTest().fixture(Path(folder))
            bridge.process = Mock()
            bridge.process.poll.return_value = None
            bridge.last_playing_segments = None
            receiver = bridge.cast.media_controller.status
            receiver.content_id = bridge.media_url
            receiver.subtitle_tracks = [dict(type='TEXT', trackId=7)]
            for tracks, expected in ((None, None), ([], False), ([7], True), (None, None)):
                with self.subTest(tracks=tracks):
                    receiver.current_subtitle_tracks = tracks
                    bridge.tick()
                    self.assertIs(bridge.status()['subtitles_enabled'], expected)
                    self.assertTrue(bridge.status()['subtitle_choice']['enabled'])


class SubtitleCreditTest(unittest.TestCase):
    def test_literal_urls_in_cue_text_are_never_external_resources(self):
        credit = 'Downloaded from https://www.opensubtitles.org'
        for format, text in (('srt', '1\n00:00:01,000 --> 00:00:03,000\n' + credit),
                             ('vtt', 'WEBVTT\n\n00:01.000 --> 00:03.000\n' + credit)):
            with self.subTest(format=format):
                self.assertIn(credit.encode(), normalize_subtitles(format, text))
        for text in ('WEBVTT https://external.test\n\n00:01.000 --> 00:03.000\nHello',
                     'WEBVTT\n\n00:01.000 --> 00:03.000 region:https://external.test\nHello',
                     'WEBVTT\n\n00:01.000 --> 00:03.000\n<img src="https://external.test">',
                     'WEBVTT\n\nSTYLE\n::cue { background: url(https://external.test) }'):
            with self.subTest(text=text), self.assertRaises(MediaError):
                normalize_subtitles('vtt', text)


class CatalogueReuseTest(unittest.TestCase):
    def test_catalogue_limit_rejects_only_while_every_slot_is_active_queued_or_loading(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bridge = test_bridge.RestartPolicyTest().fixture(root)
            old = bridge.catalogue
            release = threading.Event()
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), root / 'private')
            bridge.catalogue = store
            store.records.update(old.records)
            store.snapshots.update(old.snapshots)
            store.pin(bridge.active_plan.catalogue.id)
            try:
                source = dict(id='next', title='Next', url='synthetic')
                store.request(source)
                catalogue = ready(store, 'next')
                bridge.sources.append(source)
                bridge.submit('start', dict(device_id='fixture-device', device_revision=1,
                    source_id='next', catalogue_id=catalogue['id'], subtitle_id=None, delay_ms=0))
                def blocked(*_):
                    self.assertTrue(release.wait(4))
                    return Analysis(0, 1, 90)
                store.probe = blocked
                for index in range(6):
                    store.request(dict(id=str(index), url='synthetic'))
                with self.assertRaises(MediaError) as error:
                    store.request(dict(id='ninth', url='synthetic'))
                self.assertEqual(error.exception.code, 'catalogue_limit')
                self.assertIn(bridge.active_plan.catalogue.id, store.records)
                self.assertIn(catalogue['id'], store.records)
                release.set()
                ready(store, '5')
                store.request(dict(id='ninth', url='synthetic'))
                ready(store, 'ninth')
                self.assertIn(bridge.active_plan.catalogue.id, store.records)
                self.assertIn(catalogue['id'], store.records)
            finally:
                release.set()
                store.close()

    def test_active_and_queued_private_plans_survive_refresh_and_failed_worker_cleanup(self):
        for action in ('start', 'subtitles'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                bridge = test_bridge.RestartPolicyTest().fixture(root)
                previous_store = bridge.catalogue
                store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), root / 'private')
                bridge.catalogue = store
                store.records.update(previous_store.records)
                store.snapshots.update(previous_store.snapshots)
                store.pin(bridge.active_plan.catalogue.id)
                try:
                    old_id = bridge.active_plan.catalogue.id
                    old_source = dict(bridge.active_plan.catalogue.source)
                    uploaded = store.upload(old_source['id'], old_id, 'active.srt', 'srt',
                        '1\n00:00:01,000 --> 00:00:03,000\nActive private')
                    bridge.active_plan = store.resolve(old_source['id'], old_id, uploaded['entry']['id'], 0, True)
                    bridge.state.update(subtitle_choice=bridge.active_plan.choice(), phase='paused')
                    active_path = bridge.active_plan.subtitle.path
                    bridge.cast.media_controller.status.content_id = bridge.media_url
                    bridge.cast.media_controller.status.player_state = 'PAUSED'
                    if action == 'start':
                        source = dict(id='next', url='synthetic', title='Next')
                        bridge.sources.append(source)
                        store.request(source)
                        catalogue = ready(store, 'next')
                        uploaded = store.upload('next', catalogue['id'], 'queued.srt', 'srt',
                            '1\n00:00:01,000 --> 00:00:03,000\nQueued private')
                        queued_plan = store.resolve('next', catalogue['id'], uploaded['entry']['id'], 0, True)
                        payload = dict(device_id='fixture-device', device_revision=1, source_id='next',
                                       catalogue_id=catalogue['id'], subtitle_id=uploaded['entry']['id'], delay_ms=0)
                    else:
                        source = old_source
                        queued_plan = bridge.active_plan
                        payload = apply_data(bridge, delay=750)
                    bridge.submit(action, payload)
                    for index in range(12):
                        store.request(source, refresh=True)
                        ready(store, source['id'])
                    self.assertTrue(active_path.exists())
                    self.assertTrue(queued_plan.subtitle.path.exists())
                    self.assertIn(old_id, store.records)
                    self.assertIn(queued_plan.catalogue.id, store.records)
                    bridge.args.state_file = None
                    bridge.tick = Mock(side_effect=bridge.quit.set)
                    with patch.object(bridge, 'stop_process', side_effect=OSError('synthetic cleanup failure')):
                        bridge._work()
                    self.assertEqual(bridge.active_plan.catalogue.id, old_id)
                    self.assertEqual(store.pins, {old_id: 1})
                    self.assertTrue(active_path.exists())
                    self.assertTrue(bridge._destination_busy())
                    for index in range(10):
                        store.request(source, refresh=True)
                        ready(store, source['id'])
                    self.assertTrue(active_path.exists())
                    if action == 'start':
                        self.assertFalse(queued_plan.subtitle.path.exists())
                    bridge.stop()
                    for index in range(10):
                        store.request(dict(id=f'after-stop-{index}', url='synthetic'))
                        ready(store, f'after-stop-{index}')
                    self.assertFalse(active_path.exists())
                finally:
                    store.close()

    def test_demo_reuses_capacity_without_evicting_active_uploads(self):
        demo = DemoBridge()
        demo.submit('select_device', dict(device_id='demo-tv-a', device_revision=0))
        payload = demo_start(demo)
        uploaded = demo.subtitle_upload(dict(source_id='demo-a', catalogue_id=payload['catalogue_id'],
            filename='active.srt', format='srt', text='1\n00:00:01,000 --> 00:00:03,000\nActive'))
        payload['subtitle_id'] = uploaded['entry']['id']
        demo.submit('start', payload)
        active_id = payload['catalogue_id']
        for index in range(20):
            demo.request_catalogue(dict(source_id='demo-a' if index % 2 else 'demo-b', refresh=True))
        self.assertIn(active_id, demo.catalogues)
        self.assertLessEqual(len(demo.catalogues), 8)
        self.assertEqual(demo.status()['subtitle_choice']['subtitle_id'], uploaded['entry']['id'])
        self.assertEqual(len(demo.uploads), 1)
        demo.submit('stop', dict(device_id='demo-tv-a', device_revision=1, playback_id=demo.status()['playback_id']))
        for _ in range(10):
            demo.request_catalogue(dict(source_id='demo-b', refresh=True))
        self.assertNotIn(active_id, demo.catalogues)
        self.assertEqual(demo.upload_storage, 0)
        self.assertFalse(demo.uploads)

    def test_ready_and_failed_analyses_reuse_eight_slots(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            try:
                for index in range(20):
                    source = dict(id='source' if index < 12 else str(index), url='synthetic')
                    store.request(source, refresh=True)
                    ready(store, source['id'])
                    self.assertLessEqual(len(store.records), 8)
                    self.assertLessEqual(len(store.snapshot()), 8)
            finally:
                store.close()
            def fail(*_):
                raise OSError('synthetic')
            store = SetupCatalogue(fail, Path(folder))
            try:
                for index in range(12):
                    store.request(dict(id=str(index), url='synthetic'))
                    deadline = time.monotonic() + 2
                    while store.snapshot()[str(index)]['state'] == 'loading' and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertEqual(store.snapshot()[str(index)]['state'], 'error')
                    self.assertLessEqual(len(store.snapshot()), 8)
            finally:
                store.close()

    def test_inactive_private_files_are_reclaimed(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(folder))
            try:
                store.request(dict(id='source', url='synthetic'))
                catalogue = ready(store, 'source')
                uploaded = store.upload('source', catalogue['id'], 'credit.srt', 'srt',
                    '1\n00:00:01,000 --> 00:00:03,000\nPrivate credit')
                plan = store.resolve('source', catalogue['id'], uploaded['entry']['id'], 0, True)
                self.assertTrue(plan.subtitle.path.exists())
                for index in range(10):
                    store.request(dict(id='source', url='synthetic'), refresh=True)
                    ready(store, 'source')
                self.assertFalse(plan.subtitle.path.exists())
                self.assertEqual(store.storage, 0)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
