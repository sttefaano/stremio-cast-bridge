import tempfile
import io
import json
import unittest
from pathlib import Path
import subprocess
import time
import re
import threading
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from uuid import UUID

from pychromecast import Chromecast
from pychromecast.models import CastInfo

from bridge import (main, Bridge, safe_media_path, DROP_SEEK_PREROLL, FFMPEG, playback_position, public_status,
                    ffmpeg_command, probe, parse_cues, subtitle_windows, BridgeError)
from media import Catalogue, PlaybackPlan, Subtitle
from backend_fixtures import install_media, apply_data, media_server, served_cues


class RestartPolicyTest(unittest.TestCase):
    def subtitle_playlist(self, bridge, segments=15, ended=True):
        (bridge.session / 'video_vtt.m3u8').write_text('#EXTM3U\n' + ''.join(
            f'#EXTINF:6.000000,\nvideo{index}.vtt\n' for index in range(segments)) + ('#EXT-X-ENDLIST\n' if ended else ''))

    def fixture(self, root):
        bridge = Bridge.__new__(Bridge)  # No worker, sockets or discovery.
        bridge.args = SimpleNamespace(max_duration=90, readrate=1.1, media_port=18766)
        bridge.lan_ip = '192.0.2.1'
        bridge.sessions = root
        bridge.state_lock = threading.Lock()
        bridge.state = dict(subtitle_delay_ms=500, absolute_time=65, playlist_duration=80, selected_device={'id':'fixture-device','available':True}, device_revision=1)
        bridge.selected_device_id = 'fixture-device'
        bridge.media_server = None
        bridge.selected = dict(url='offline-fixture', title='Fixture')
        install_media(bridge)
        bridge.selected = bridge.active_plan.catalogue.source
        bridge.quit = threading.Event()
        bridge.browser = bridge.process = None
        bridge.session = root / 'old'
        bridge.session.mkdir()
        bridge.media_url = 'http://old/master.m3u8'
        bridge.loaded = True
        bridge.receiver_confirmed = False
        bridge.paused = True
        bridge.suspended = False
        bridge.origin, bridge.duration = 0, 90
        bridge.cast = Mock()
        bridge.cast.media_controller.status = SimpleNamespace(
            content_id='http://unrelated/movie', player_state='PLAYING',
            adjusted_current_time=5, current_subtitle_tracks=[], subtitle_tracks=[])
        return bridge

    def test_a_seek_keeps_file_cues_from_before_the_seek_point_for_a_positive_delay(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            bridge = self.fixture(root)
            upload = root / 'upload.vtt'
            upload.write_text('WEBVTT\n\n00:00:55.000 --> 00:00:57.000\nGone\n\n'
                              '00:00:57.000 --> 00:00:59.000\nBefore\n\n00:00:59.000 --> 00:01:02.000\nCrossing\n\n'
                              '00:01:01.000 --> 00:01:02.000\nAfter\n')
            bridge.active_plan = replace(bridge.active_plan, subtitle=Subtitle('file', 'upload', 'File', path=upload))
            with patch('bridge.subprocess.Popen', return_value=Mock(pid=123)), \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                bridge.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 60})
            self.subtitle_playlist(bridge, segments=2)
            for index in range(2):
                (bridge.session / f'video{index}.vtt').write_text('WEBVTT\n')
            with media_server(root) as fetch:
                self.assertEqual(served_cues(fetch, bridge.session.name, 0), {'Crossing': (0, 2), 'After': (1, 2)})
                self.assertEqual(served_cues(fetch, bridge.session.name, 3000),
                                 {'Before': (0, 2), 'Crossing': (2, 5), 'After': (4, 5)})

    def test_buffered_seek_restarts_and_waits_for_matching_receiver(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            producer = Mock(pid=123)
            producer.poll.return_value = None
            with patch('bridge.probe', return_value=([0, 1, 2], 120)), \
                 patch('bridge.subprocess.Popen', return_value=producer) as launch, \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                bridge.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 60})
                bridge.cast.media_controller.stop.assert_not_called()
                bridge.cast.media_controller.seek.assert_not_called()
                command = launch.call_args.args[0]
                self.assertLess(command.index('-ss'), command.index('-i'))
                self.assertEqual(command[command.index('-ss') + 1], '60.0')
                self.assertEqual(command[command.index('-t') + 1], '30.0')
                self.assertTrue(bridge.status()['pending'])
                self.assertEqual(bridge.active_plan.delay_ms, 500)
                (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
                (bridge.session / 'video_vtt.m3u8').write_text('#EXTM3U\n#EXTINF:6.0,\nvideo0.vtt\n')
                (bridge.session / 'master.m3u8').touch()
                bridge.tick()
                call = bridge.cast.media_controller.play_media.call_args
                self.assertEqual(call.args[0], f'http://192.0.2.1:18766/{bridge.session.name}/d500/master.m3u8')
                self.assertFalse(call.kwargs['autoplay'])
                self.assertEqual(call.kwargs['media_info']['duration'], 30)
                self.assertTrue(bridge.status()['pending'])
                receiver = bridge.cast.media_controller.status
                receiver.content_id = bridge.media_url
                receiver.player_state = 'BUFFERING'
                bridge.tick()
                self.assertTrue(bridge.status()['pending'])
                receiver.player_state = 'PAUSED'
                bridge.tick()
                self.assertFalse(bridge.status()['pending'])
                self.assertEqual(bridge.status()['absolute_time'], 65)

    def test_stop_only_stops_owned_media_even_with_stale_loaded_flag(self):
        for owned, loaded in ((False, True), (False, False), (True, False), (True, True)):
            with self.subTest(owned=owned, loaded=loaded), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                bridge.loaded = loaded
                cast = bridge.cast
                if owned:
                    cast.media_controller.status.content_id = bridge.media_url
                bridge.stop()
                self.assertEqual(cast.media_controller.stop.call_count, int(owned))
                cast.disconnect.assert_called_once()

    def test_restarts_clamp_to_absolute_end(self):
        for limit, expected in ((90, 89.9), (None, 119.9), (200, 119.9)):
            with self.subTest(limit=limit), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                bridge.args.max_duration = limit
                bridge.duration = min(120, limit or 120)
                bridge.cast.media_controller.status.content_id = bridge.media_url
                producer = Mock(pid=123)
                producer.poll.return_value = None
                with patch('bridge.probe', return_value=([0, 1, 2], 120)), \
                     patch('bridge.subprocess.Popen', return_value=producer), \
                     patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                    bridge.mutate('seek', {'device_id':'fixture-device', 'device_revision':1, 'position': 999})
                    self.assertAlmostEqual(bridge.status()['origin'], expected)
                    bridge.cast.media_controller.stop.assert_called_once()

    def test_delay_change_reloads_the_running_session_at_the_receiver_position(self):
        for player_state in ('PLAYING', 'PAUSED'):
            with self.subTest(player_state=player_state), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                self.subtitle_playlist(bridge)
                bridge.origin = 40
                bridge.state['playback_id'] = 'playback'
                bridge.receiver_confirmed = True
                bridge.process = producer = Mock()
                producer.poll.return_value = None
                bridge.last_playing_segments = None
                bridge.started_at = time.monotonic()
                receiver = bridge.cast.media_controller.status
                receiver.content_id = bridge.media_url
                receiver.player_state = player_state
                receiver.adjusted_current_time = 25.5
                with patch.object(bridge, 'begin', side_effect=AssertionError('no rebuild')):
                    bridge.mutate('subtitles', apply_data(bridge, delay=-1500))
                call = bridge.cast.media_controller.play_media.call_args
                self.assertEqual(call.args[0], 'http://192.0.2.1:18766/old/d-1500/master.m3u8')
                self.assertEqual(call.kwargs['current_time'], 25.5)
                self.assertEqual(call.kwargs['autoplay'], player_state == 'PLAYING')
                self.assertEqual(call.kwargs['media_info']['duration'], 50)
                self.assertEqual(bridge.media_url, call.args[0])
                self.assertEqual(bridge.session, Path(folder) / 'old')
                producer.terminate.assert_not_called()
                bridge.cast.media_controller.stop.assert_not_called()
                self.assertEqual(bridge.status()['subtitle_delay_ms'], -1500)
                (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 8)
                bridge.tick()
                self.assertEqual(bridge.status()['phase'], 'loading')
                self.assertTrue(bridge.status()['pending'])
                receiver.content_id = bridge.media_url
                bridge.tick()
                self.assertEqual(bridge.status()['phase'], player_state.lower())
                self.assertEqual(bridge.status()['absolute_time'], 65.5)
                bridge.cast.media_controller.play_media.assert_called_once()

    def test_stop_before_the_tv_confirms_a_delay_change_stops_the_tv(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            self.subtitle_playlist(bridge)
            bridge.state['playback_id'] = 'playback'
            bridge.receiver_confirmed = True
            bridge.process = producer = Mock()
            producer.poll.return_value = None
            bridge.media_url = 'http://192.0.2.1:18766/old/d500/master.m3u8'
            receiver = bridge.cast.media_controller.status
            receiver.content_id = bridge.media_url
            with patch.object(bridge, 'begin', side_effect=AssertionError('no rebuild')):
                bridge.mutate('subtitles', apply_data(bridge, delay=-1500))
            self.assertNotEqual(bridge.media_url, receiver.content_id)
            controller = bridge.cast.media_controller
            bridge.mutate('stop', {'device_id': 'fixture-device', 'device_revision': 1,
                                   'playback_id': 'playback'})
            controller.stop.assert_called_once()

    def test_delay_change_without_served_subtitle_windows_is_refused_before_touching_the_tv(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.state['playback_id'] = 'playback'
            bridge.receiver_confirmed = True
            bridge.cast.media_controller.status.content_id = bridge.media_url
            self.subtitle_playlist(bridge, segments=3, ended=False)
            before = bridge.active_plan
            with self.assertRaises(BridgeError) as refused:
                bridge.mutate('subtitles', apply_data(bridge, delay=-30000))
            self.assertEqual(refused.exception.code, 'subtitle_not_ready')
            self.assertIs(bridge.active_plan, before)
            bridge.cast.media_controller.play_media.assert_not_called()

    def delay_reload(self, folder, delay, file_track):
        bridge = self.fixture(Path(folder))
        bridge.state['playback_id'] = 'playback'
        bridge.receiver_confirmed = True
        receiver = bridge.cast.media_controller.status
        receiver.content_id, receiver.adjusted_current_time = bridge.media_url, 10
        self.subtitle_playlist(bridge, segments=5, ended=False)
        if file_track:
            (bridge.session / 'cues.json').write_text('[]')
        bridge.mutate('subtitles', apply_data(bridge, delay=delay))
        return bridge

    def test_file_track_delay_change_is_not_held_back_by_unwritten_segments(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.delay_reload(folder, -30000, file_track=True)
            self.assertEqual(bridge.cast.media_controller.play_media.call_args.kwargs['current_time'], 10)

    def test_embedded_delay_change_is_refused_until_listed_windows_reach_the_playhead(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            with self.assertRaises(BridgeError) as refused:
                self.delay_reload(folder, -20000, file_track=False)
            self.assertEqual(refused.exception.code, 'subtitle_not_ready')
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.delay_reload(folder, -12000, file_track=False)
            bridge.cast.media_controller.play_media.assert_called_once()

    def test_failed_delay_reload_keeps_the_previous_plan_and_url(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            self.subtitle_playlist(bridge)
            bridge.state['playback_id'] = 'playback'
            bridge.receiver_confirmed = True
            bridge.cast.media_controller.status.content_id = url = bridge.media_url
            bridge.cast.media_controller.play_media.side_effect = OSError('receiver gone')
            before = bridge.active_plan
            with self.assertRaises(BridgeError):
                bridge.mutate('subtitles', apply_data(bridge, delay=-1500))
            self.assertEqual((bridge.active_plan, bridge.media_url, bridge.receiver_confirmed), (before, url, True))
            self.assertTrue(bridge._owns_playback())

    def test_track_change_still_rebuilds_from_the_current_position(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.state['playback_id'] = 'playback'
            bridge.cast.media_controller.status.content_id = bridge.media_url
            with patch.object(bridge, 'begin') as begin:
                bridge.mutate('subtitles', apply_data(bridge, enabled=False, subtitle_id=None, delay=0))
            self.assertEqual(begin.call_args.args[0], 65)
            bridge.cast.media_controller.play_media.assert_not_called()


class ReceiverOwnershipTest(unittest.TestCase):
    fixture = RestartPolicyTest.fixture

    def test_delayed_first_status_remains_loading_then_confirms(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.loaded = False
            bridge.process = Mock()
            bridge.process.poll.return_value = None
            bridge.last_playing_segments = None
            bridge.started_at = time.monotonic()
            bridge.update(phase='buffering', pending=True)
            (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
            (bridge.session / 'video_vtt.m3u8').write_text('#EXTM3U\n#EXTINF:6.0,\nvideo0.vtt\n')
            (bridge.session / 'master.m3u8').touch()
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'loading')
            self.assertTrue(bridge.status()['pending'])
            bridge.cast.media_controller.status.content_id = bridge.media_url
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'playing')
            self.assertFalse(bridge.status()['pending'])

    def test_negative_delay_waits_until_the_served_subtitle_playlist_has_a_window(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.active_plan = replace(bridge.active_plan, delay_ms=-20000)
            bridge.loaded = False
            bridge.process = Mock()
            bridge.process.poll.return_value = None
            bridge.last_playing_segments = None
            bridge.started_at = time.monotonic()
            (bridge.session / 'master.m3u8').touch()
            for windows in (3, 4, 5):
                (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * windows)
                (bridge.session / 'video_vtt.m3u8').write_text('#EXTM3U\n' + ''.join(
                    f'#EXTINF:6.0,\nvideo{index}.vtt\n' for index in range(windows)))
                bridge.tick()
                self.assertEqual(bridge.cast.media_controller.play_media.called, windows == 5, windows)
            self.assertTrue(bridge.media_url.endswith('/old/d-20000/master.m3u8'))

    def test_negative_delay_on_a_file_track_loads_once_three_segments_exist(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.active_plan = replace(bridge.active_plan, delay_ms=-30000)
            bridge.loaded = False
            bridge.process = Mock()
            bridge.process.poll.return_value = None
            bridge.last_playing_segments = None
            bridge.started_at = time.monotonic()
            (bridge.session / 'master.m3u8').touch()
            (bridge.session / 'cues.json').write_text('[]')
            (bridge.session / 'video.m3u8').write_text('#EXTM3U\n' + '#EXTINF:6,\nx.ts\n' * 3)
            (bridge.session / 'video_vtt.m3u8').write_text('#EXTM3U\n' + ''.join(
                f'#EXTINF:6.0,\nvideo{index}.vtt\n' for index in range(3)))
            bridge.tick()
            bridge.cast.media_controller.play_media.assert_called_once()

    def test_ownership_loss_preserves_position_and_stop_leaves_foreign_media(self):
        for player_state in ('PLAYING', 'PAUSED'):
            with self.subTest(player_state=player_state), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                bridge.origin = 30
                bridge.process = Mock()
                bridge.process.poll.return_value = None
                bridge.last_playing_segments = None
                receiver = bridge.cast.media_controller.status
                receiver.content_id = bridge.media_url
                receiver.player_state = player_state
                receiver.adjusted_current_time = 35
                bridge.tick()
                self.assertEqual(bridge.status()['absolute_time'], 65)
                receiver.content_id = 'http://unrelated/movie'
                receiver.adjusted_current_time = 0
                bridge.tick()
                status = bridge.status()
                self.assertEqual(status['phase'], 'receiver_changed')
                self.assertTrue(status['pending'])
                self.assertEqual(status['absolute_time'], 65)
                cast = bridge.cast
                bridge.stop()
                cast.media_controller.stop.assert_not_called()
                cast.disconnect.assert_called_once()

    def test_close_worker_leaves_unrelated_cast_playing(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            cast = bridge.cast
            bridge.quit.set()
            bridge.worker = threading.Thread(target=bridge._work)
            bridge.worker.start()
            bridge.close()
            self.assertFalse(bridge.worker.is_alive())
            cast.media_controller.stop.assert_not_called()
            cast.disconnect.assert_called_once()


class StartupCleanupTest(unittest.TestCase):
    def test_discovery_lifecycle_always_releases_metadata_resources(self):
        from bridge import arguments
        for failure in (None, 'service', 'wait'):
            with self.subTest(failure=failure):
                service, zconf = Mock(), Mock()
                with patch('bridge.threading.Thread'), patch('bridge.Path.mkdir'):
                    b = Bridge(arguments([]))
                with patch('zeroconf.ServiceBrowser', side_effect=RuntimeError('synthetic failure') if failure == 'service' else None, return_value=service), \
                     patch('zeroconf.Zeroconf', return_value=zconf), \
                     patch('bridge.time.sleep', side_effect=RuntimeError('synthetic failure') if failure == 'wait' else None), \
                     patch('socket.socket', side_effect=AssertionError('network forbidden')):
                    if failure:
                        from bridge import BridgeError
                        with self.assertRaises(BridgeError):
                            b.mutate('discover_devices', {})
                        self.assertEqual(b.status()['device_discovery'], 'error')
                    else:
                        b.mutate('discover_devices', {})
                        self.assertEqual(b.status()['devices'], [])
                zconf.close.assert_called_once()
                self.assertEqual(service.cancel.call_count, int(failure != 'service'))

    def test_control_bind_and_thread_failures_close_only_owned_servers(self):
        for failure in ('bind', 'thread', None):
            with self.subTest(failure=failure):
                b, server, thread = Mock(), Mock(), Mock()
                b.quit.wait.return_value = True
                if failure == 'thread':
                    thread.start.side_effect = RuntimeError('synthetic failure')
                with patch('bridge.Bridge', return_value=b), \
                     patch('bridge.ThreadingHTTPServer', side_effect=OSError('occupied') if failure == 'bind' else None, return_value=server), \
                     patch('bridge.threading.Thread', return_value=thread), patch('bridge.signal.signal'), \
                     patch('builtins.print'), patch('socket.socket', side_effect=AssertionError('network forbidden')):
                    self.assertEqual(main([]), 0 if failure is None else 1)
                b.close.assert_called_once()
                self.assertEqual(server.shutdown.call_count, int(failure is None))
                self.assertEqual(server.server_close.call_count, int(failure != 'bind'))


class MediaPathsTest(unittest.TestCase):
    def test_only_regular_hls_files_inside_session_are_readable(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            session = root / 'session-123'
            session.mkdir()
            good = session / 'video.m3u8'
            good.write_text('#EXTM3U\n')
            (session / 'secret.json').write_text('{}')
            (session / 'link.vtt').symlink_to(good)
            self.assertEqual(safe_media_path(root, '/session-123/d0/video.m3u8'), (good, 0))
            self.assertEqual(safe_media_path(root, '/session-123/d-1500/video.m3u8'), (good, -1500))
            self.assertEqual(safe_media_path(root, '/session-123/d30000/video.m3u8'), (good, 30000))
            (root / 'linked').symlink_to(session)
            for path in ('/session-123/video.m3u8', '/session-123/d0/', '/session-123/d0/secret.json',
                         '/../d0/video.m3u8', '/session-123/d0/%2e%2e/session-123/video.m3u8',
                         '/session-123/%2e%2e/video.m3u8', '/session-123/d0/link.vtt', '/linked/d0/video.m3u8',
                         '/session-123/d0/file%00.vtt',
                         '/session-123/d-0/video.m3u8', '/session-123/d+5/video.m3u8', '/session-123/d05/video.m3u8',
                         '/session-123/d30001/video.m3u8', '/session-123/dx/video.m3u8', '/session-123/500/video.m3u8',
                         '/session-123/d1%D9%A5%D9%A0%D9%A0/video.m3u8', '/session-123/d5%EF%BC%90/video.m3u8'):
                with self.subTest(path=path):
                    self.assertIsNone(safe_media_path(root, path))


class SubtitleTimingTest(unittest.TestCase):
    def test_embedded_seek_drops_cues_that_start_before_it_and_served_views_shift_the_rest(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            srt = root / 'boundary.srt'
            srt.write_text(
                '1\n00:00:05,000 --> 00:00:09,000\nPast\n\n'
                '2\n00:00:09,000 --> 00:00:13,000\nCrossing\n\n'
                '3\n00:00:10,200 --> 00:00:10,400\nEarly\n\n'
                '4\n00:00:11,000 --> 00:00:15,000\nFuture\n\n'
                '5\n00:00:17,000 --> 00:00:21,000\nLater\n')
            source = root / 'boundary.mkv'
            fixture = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=black:s=160x90:r=24:d=24', '-f', 'lavfi', '-i',
                'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v',
                '-map', '1:a', '-map', '2:s', '-t', '24', '-c:v', 'libx264',
                '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
                '-metadata:s:s:0', 'language=spa', str(source)],
                capture_output=True, timeout=15)
            self.assertEqual(fixture.returncode, 0, fixture.stderr.decode())
            analysis = probe(str(source))
            catalogue = Catalogue('synthetic', dict(id='synthetic', url=str(source)), analysis)

            sessions = root / 'sessions'
            sessions.mkdir()
            session = sessions / 'session-seek'
            session.mkdir()
            result = subprocess.run(ffmpeg_command(str(source), session,
                PlaybackPlan(catalogue, analysis.entries[0], 0, True), origin=10, duration=12, readrate=1000),
                capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertNotIn('X-TIMESTAMP-MAP', ''.join(p.read_text() for p in session.glob('*.vtt')))
            # Literal times relative to seek=10; allow only the small AAC offset.
            cases = (
                (500, {'Early': (0.7, 0.9), 'Future': (1.5, 5.5), 'Later': (7.5, 11.5)}),
                (0, {'Early': (0.2, 0.4), 'Future': (1, 5), 'Later': (7, 11)}),
                (-500, {'Future': (0.5, 4.5), 'Later': (6.5, 10.5)}),
            )
            with media_server(sessions) as fetch:
                for delay, expected in cases:
                    with self.subTest(delay_ms=delay):
                        cues = served_cues(fetch, session.name, delay)
                        for label, (start, end) in expected.items():
                            with self.subTest(cue=label):
                                self.assertIn(label, cues)
                                self.assertAlmostEqual(cues[label][0], start, delta=0.1)
                                self.assertAlmostEqual(cues[label][1], end, delta=0.1)
                        self.assertEqual(set(cues), set(expected))

    def test_sparse_embedded_cues_are_written_into_their_own_segment(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            srt = root / 'sparse.srt'
            srt.write_text('1\n00:00:01,040 --> 00:00:02,500\nOpening\n\n'
                           '2\n00:00:20,000 --> 00:00:21,500\nAfterSilence\n\n'
                           '3\n00:00:47,500 --> 00:00:49,000\nLast\n')
            source = root / 'sparse.mkv'
            fixture = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=black:s=160x90:r=24:d=54', '-f', 'lavfi', '-i',
                'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v',
                '-map', '1:a', '-map', '2:s', '-t', '54', '-c:v', 'libx264',
                '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt', str(source)],
                capture_output=True, timeout=30)
            self.assertEqual(fixture.returncode, 0, fixture.stderr.decode())
            analysis = probe(str(source))
            session = root / 'session-sparse'
            session.mkdir()
            result = subprocess.run(ffmpeg_command(str(source), session, PlaybackPlan(
                Catalogue('sparse', dict(id='sparse', url=str(source)), analysis), analysis.entries[0], 0, True),
                readrate=1000), capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            placed = {}
            for name, start, end, _ in subtitle_windows((session / 'video_vtt.m3u8').read_text()):
                for cue_start, _, _, text in parse_cues((session / name).read_text()):
                    placed[text] = (cue_start, start, end)
            self.assertEqual(set(placed), {'Opening', 'AfterSilence', 'Last'})
            for text, (cue_start, start, end) in placed.items():
                with self.subTest(cue=text):
                    self.assertTrue(start <= cue_start < end, (cue_start, start, end))

    def test_input_seek_normalizes_source_cue_to_the_seek_point(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            source = Path(folder) / 'seek.srt'
            source.write_text('1\n00:01:02,355 --> 00:01:04,000\nHola\n')
            result = subprocess.run([FFMPEG, '-v', 'error', '-ss', '60', '-i', str(source),
                '-c:s', 'webvtt', '-bsf:s', DROP_SEEK_PREROLL, '-f', 'webvtt', '-'],
                capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'00:02.355 --> 00:04.000', result.stdout)


class DelayedSubtitleViewTest(unittest.TestCase):
    PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n' + ''.join(
        f'#EXTINF:6.000000,\nvideo{index}.vtt\n' for index in range(3))

    def session(self, root, ended=False):
        session = root / 'session-view'
        session.mkdir()
        (session / 'video_vtt.m3u8').write_text(self.PLAYLIST + ('#EXT-X-ENDLIST\n' if ended else ''))
        (session / 'video0.vtt').write_text('WEBVTT\n\n00:00.100 --> 00:00.900\nGone\n\n'
                                            '00:00.200 --> 00:01.500 align:start\nFirst\nline two\n\n'
                                            '00:04.800 --> 00:05.900\nEdge\n')
        (session / 'video1.vtt').write_text('WEBVTT\n\n00:06.500 --> 00:08.000\nPulled\n')
        (session / 'video2.vtt').write_text('WEBVTT\n\n00:12.500 --> 00:17.000\nLate\n')
        (session / 'video3.vtt').write_text('')
        (session / 'video.m3u8').write_text('#EXTM3U\n#EXTINF:6,\nsegment-0000.ts\n')
        (session / 'segment-0000.ts').write_bytes(bytes(range(256)) * 4)
        return session

    def test_positive_delay_shifts_cues_and_repeats_a_cue_that_crosses_into_the_next_window(self):
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            self.session(Path(folder))
            self.assertEqual(fetch('/session-view/d1000/video0.vtt').read().decode(),
                             'WEBVTT\n\n00:00:01.100 --> 00:00:01.900\nGone\n\n'
                             '00:00:01.200 --> 00:00:02.500 align:start\nFirst\nline two\n\n'
                             '00:00:05.800 --> 00:00:06.900\nEdge\n')
            self.assertEqual(fetch('/session-view/d1000/video1.vtt').read().decode(),
                             'WEBVTT\n\n00:00:05.800 --> 00:00:06.900\nEdge\n\n00:00:07.500 --> 00:00:09.000\nPulled\n')
            self.assertEqual(served_cues(fetch, 'session-view', 1000), {
                'Gone': (1.1, 1.9), 'First': (1.2, 2.5), 'Edge': (5.8, 6.9), 'Pulled': (7.5, 9), 'Late': (13.5, 18)})

    def test_negative_delay_drops_expired_cues_clips_at_zero_and_pulls_later_cues_forward(self):
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            self.session(Path(folder))
            self.assertEqual(fetch('/session-view/d-1000/video0.vtt').read().decode(),
                             'WEBVTT\n\n00:00:00.000 --> 00:00:00.500 align:start\nFirst\nline two\n\n'
                             '00:00:03.800 --> 00:00:04.900\nEdge\n\n00:00:05.500 --> 00:00:07.000\nPulled\n')
            self.assertEqual(served_cues(fetch, 'session-view', -1000), {
                'First': (0, 0.5), 'Edge': (3.8, 4.9), 'Pulled': (5.5, 7), 'Late': (11.5, 16)})

    def test_negative_delay_hides_windows_that_could_still_receive_unwritten_cues(self):
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            self.session(Path(folder))
            listed = lambda delay: re.findall(r'video\d\.vtt', fetch(f'/session-view/d{delay}/video_vtt.m3u8').read().decode())
            self.assertEqual(listed(0), ['video0.vtt', 'video1.vtt', 'video2.vtt'])
            self.assertEqual(listed(4000), ['video0.vtt', 'video1.vtt', 'video2.vtt'])
            self.assertEqual(listed(-1000), ['video0.vtt', 'video1.vtt'])
            self.assertEqual(listed(-6000), ['video0.vtt', 'video1.vtt'])
            self.assertEqual(listed(-6001), ['video0.vtt'])
            self.assertTrue(fetch('/session-view/d-1000/video_vtt.m3u8').read().decode().startswith(
                '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.000000,\nvideo0.vtt\n'))
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            self.session(Path(folder), ended=True)
            self.assertEqual(fetch('/session-view/d-6001/video_vtt.m3u8').read().decode(),
                             self.PLAYLIST + '#EXT-X-ENDLIST\n')

    def test_negative_delay_lists_every_window_when_the_file_track_cues_are_known(self):
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            (self.session(Path(folder)) / 'cues.json').write_text('[]')
            self.assertEqual(fetch('/session-view/d-6001/video_vtt.m3u8').read().decode(), self.PLAYLIST)

    def test_video_passes_through_and_unknown_or_escaping_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as folder, media_server(Path(folder)) as fetch:
            session = self.session(Path(folder))
            for delay in (0, 1500, -1500):
                self.assertEqual(fetch(f'/session-view/d{delay}/segment-0000.ts').read(),
                                 (session / 'segment-0000.ts').read_bytes())
                self.assertEqual(fetch(f'/session-view/d{delay}/video.m3u8').read(),
                                 (session / 'video.m3u8').read_bytes())
            partial = fetch('/session-view/d1500/segment-0000.ts', Range='bytes=10-19')
            self.assertEqual((partial.status, partial.read()), (206, bytes(range(10, 20))))
            whole = fetch('/session-view/d1500/video1.vtt').read()
            partial = fetch('/session-view/d1500/video1.vtt', Range='bytes=0-5')
            self.assertEqual((partial.status, partial.headers['Content-Range'], partial.read()),
                             (206, f'bytes 0-5/{len(whole)}', whole[:6]))
            for path in ('/session-view/video0.vtt', '/session-view/d1500/video3.vtt',
                         '/session-view/d1500/missing.vtt', '/session-view/d1500/%2e%2e/session-view/video0.vtt',
                         '/session-view/d1500/..%2fsession-view%2fvideo0.vtt', '/session-view/d01500/video0.vtt',
                         '/..%2fsession-view/d0/video0.vtt'):
                with self.subTest(path=path), self.assertRaises(HTTPError) as refused:
                    fetch(path)
                self.assertEqual(refused.exception.code, 404)
            (session / 'video_vtt.m3u8').unlink()
            with self.assertRaises(HTTPError) as refused:
                fetch('/session-view/d0/video0.vtt')
            self.assertEqual(refused.exception.code, 404)


class StatusTest(unittest.TestCase):
    def test_absolute_position_clamps_and_status_excludes_private_values(self):
        self.assertEqual(playback_position(120, 15, 200), 135)
        self.assertEqual(playback_position(120, -5, 200), 120)
        self.assertEqual(playback_position(120, 150, 200), 200)
        result = public_status({'source': 'http://private/movie', 'error': 'private URL',
                                'phase': 'playing', 'absolute_time': 135,
                                'active_subtitle_track_ids': [1]})
        self.assertNotIn('private', str(result))
        self.assertEqual(result['absolute_time'], 135)


class GrowingHLSTest(unittest.TestCase):
    def test_actual_pipeline_publishes_playlists_before_producer_finishes(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            srt = root / 'input.srt'
            srt.write_text('1\n00:00:01,000 --> 00:00:02,000\nHola\n\n2\n00:00:25,000 --> 00:00:26,000\nFinal\n')
            source = root / 'input.mkv'
            fixture = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=black:s=160x90:r=24:d=60', '-f', 'lavfi', '-i',
                'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v', '-map', '1:a',
                '-map', '2:s', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast',
                '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:s:0', 'language=spa', str(source)],
                capture_output=True, timeout=15)
            self.assertEqual(fixture.returncode, 0)
            analysis = probe(str(source))
            self.assertGreaterEqual(analysis.duration, 60)
            catalogue = Catalogue('synthetic', dict(id='synthetic', url=str(source)), analysis)
            session = root / 'session-test'
            session.mkdir()
            process = subprocess.Popen(ffmpeg_command(str(source), session,
                PlaybackPlan(catalogue, analysis.entries[0], 0, True), duration=60, readrate=4), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 15
                seen_growing = False
                while time.monotonic() < deadline:
                    playlist = session / 'video.m3u8'
                    if playlist.exists() and (session / 'video_vtt.m3u8').exists():
                        text = playlist.read_text()
                        segments = [line for line in text.splitlines() if line.endswith('.ts')]
                        if len(segments) >= 3 and process.poll() is None:
                            seen_growing = True
                            self.assertNotIn('#EXT-X-ENDLIST', text)
                            for segment in segments:
                                self.assertIsNotNone(safe_media_path(root, '/session-test/d500/' + segment))
                            break
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                self.assertTrue(seen_growing, 'HLS must be readable with three segments while FFmpeg is alive')
                _, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr.decode())
                self.assertIn('#EXT-X-ENDLIST', (session / 'video.m3u8').read_text())
                with media_server(root) as fetch:
                    cue = served_cues(fetch, session.name, 500)['Hola']
                # AAC in the MKV fixture adds ~43 ms; the direct SRT test is exact.
                self.assertAlmostEqual(cue[0], 1.5, delta=0.1)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
