import tempfile
import io
import json
import unittest
from pathlib import Path
import subprocess
import time
import re
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

from pychromecast import Chromecast
from pychromecast.models import CastInfo

from bridge import main, Bridge, safe_media_path, subtitle_filter, FFMPEG, playback_position, public_status, ffmpeg_command, probe
from media import Catalogue, PlaybackPlan
from backend_fixtures import install_media, apply_data


class RestartPolicyTest(unittest.TestCase):
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
                (bridge.session / 'video_vtt.m3u8').touch()
                (bridge.session / 'master.m3u8').touch()
                bridge.tick()
                call = bridge.cast.media_controller.play_media.call_args
                self.assertNotEqual(call.args[0], 'http://old/master.m3u8')
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

    def test_restarts_clamp_to_absolute_end_and_delay_uses_current_position(self):
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
                    bridge.update(absolute_time=65)
                    bridge.loaded = True
                    bridge.media_url = 'http://synthetic-rebuilt/master.m3u8'
                    bridge.cast.media_controller.status.content_id = bridge.media_url
                    bridge.cast.media_controller.status.player_state = 'PAUSED'
                    bridge.mutate('subtitles', apply_data(bridge, delay=1000))
                    self.assertEqual(bridge.status()['origin'], 65)
                    self.assertTrue(bridge.paused)
                    self.assertEqual(bridge.active_plan.delay_ms, 1000)


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
            (bridge.session / 'video_vtt.m3u8').touch()
            (bridge.session / 'master.m3u8').touch()
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'loading')
            self.assertTrue(bridge.status()['pending'])
            bridge.cast.media_controller.status.content_id = bridge.media_url
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'playing')
            self.assertFalse(bridge.status()['pending'])

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
            self.assertEqual(safe_media_path(root, '/session-123/video.m3u8'), good)
            for path in ('/session-123/', '/session-123/secret.json', '/../video.m3u8',
                         '/session-123/%2e%2e/video.m3u8', '/session-123/link.vtt',
                         '/session-123/file%00.vtt'):
                with self.subTest(path=path):
                    self.assertIsNone(safe_media_path(root, path))


class SubtitleTimingTest(unittest.TestCase):
    def test_mkv_input_seek_clips_preroll_and_preserves_shifted_cue_ends(self):
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

            # Literal times relative to seek=10; allow only the small AAC offset.
            cases = (
                (500, {'Crossing': (0, 3.5), 'Early': (0.7, 0.9),
                       'Future': (1.5, 5.5), 'Later': (7.5, 11.5)}),
                (0, {'Crossing': (0, 3), 'Early': (0.2, 0.4),
                     'Future': (1, 5), 'Later': (7, 11)}),
                (-500, {'Crossing': (0, 2.5), 'Future': (0.5, 4.5),
                        'Later': (6.5, 10.5)}),
            )
            for delay, expected in cases:
                with self.subTest(delay_ms=delay):
                    session = root / str(delay)
                    session.mkdir()
                    result = subprocess.run(ffmpeg_command(str(source), session,
                        PlaybackPlan(catalogue, analysis.entries[0], delay, True), origin=10, duration=12, readrate=1000),
                        capture_output=True, timeout=20)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    cues = {}
                    for path in sorted(session.glob('*.vtt')):
                        for start, end, label in re.findall(
                                r'(\d+(?::\d+){1,2}\.\d+)\s+-->\s+'
                                r'(\d+(?::\d+){1,2}\.\d+)[^\n]*\n([^\n]+)',
                                path.read_text()):
                            times = []
                            for stamp in (start, end):
                                seconds = 0
                                for part in stamp.split(':'):
                                    seconds = seconds * 60 + float(part)
                                times.append(seconds)
                            self.assertGreater(times[1], times[0], (label, times))
                            if label in cues:
                                self.assertEqual(cues[label], times)
                            cues[label] = times
                    for label, (start, end) in expected.items():
                        with self.subTest(cue=label):
                            self.assertIn(label, cues)
                            self.assertAlmostEqual(cues[label][0], start, delta=0.1)
                            self.assertAlmostEqual(cues[label][1], end, delta=0.1)
                    self.assertEqual(set(cues), set(expected))

    def test_input_seek_normalizes_source_cue_before_500ms_delay(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            source = Path(folder) / 'seek.srt'
            source.write_text('1\n00:01:02,355 --> 00:01:04,000\nHola\n')
            result = subprocess.run([FFMPEG, '-v', 'error', '-ss', '60', '-i', str(source),
                '-c:s', 'webvtt', '-bsf:s', subtitle_filter(500), '-f', 'webvtt', '-'],
                capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'00:02.855 --> 00:04.500', result.stdout)

    def test_delay_is_applied_to_encoded_webvtt(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            source = Path(folder) / 'sub.srt'
            source.write_text('1\n00:00:21,898 --> 00:00:24,000\nHola\n')
            result = subprocess.run([FFMPEG, '-v', 'error', '-i', str(source),
                                     '-c:s', 'webvtt', '-bsf:s', subtitle_filter(500),
                                     '-f', 'webvtt', '-'], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertIn(b'00:22.398 --> 00:24.500', result.stdout)


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
                'color=c=black:s=160x90:r=24:d=30', '-f', 'lavfi', '-i',
                'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v', '-map', '1:a',
                '-map', '2:s', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast',
                '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:s:0', 'language=spa', str(source)],
                capture_output=True, timeout=15)
            self.assertEqual(fixture.returncode, 0)
            analysis = probe(str(source))
            self.assertGreaterEqual(analysis.duration, 30)
            catalogue = Catalogue('synthetic', dict(id='synthetic', url=str(source)), analysis)
            session = root / 'session-test'
            session.mkdir()
            process = subprocess.Popen(ffmpeg_command(str(source), session,
                PlaybackPlan(catalogue, analysis.entries[0], 500, True), duration=30, readrate=4), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
                                self.assertIsNotNone(safe_media_path(root, '/session-test/' + segment))
                            break
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                self.assertTrue(seen_growing, 'HLS must be readable with three segments while FFmpeg is alive')
                _, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr.decode())
                self.assertIn('#EXT-X-ENDLIST', (session / 'video.m3u8').read_text())
                vtt = ''.join(path.read_text() for path in session.glob('*.vtt'))
                cue = re.search(r'00:01\.(\d{3}) -->', vtt)
                self.assertIsNotNone(cue)
                # AAC in the MKV fixture adds ~43 ms; the direct SRT test is exact.
                self.assertAlmostEqual(1 + int(cue[1]) / 1000, 1.5, delta=0.1)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
