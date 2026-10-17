import tempfile
import unittest
from pathlib import Path
import subprocess
import time
import re
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge import main, Bridge, safe_media_path, subtitle_filter, FFMPEG, playback_position, public_status, ffmpeg_command, probe


class RestartPolicyTest(unittest.TestCase):
    def fixture(self, root):
        bridge = Bridge.__new__(Bridge)  # No worker, sockets or discovery.
        bridge.args = SimpleNamespace(max_duration=90, readrate=1.1, media_port=18766)
        bridge.lan_ip = '192.0.2.1'
        bridge.sessions = root
        bridge.state_lock = threading.Lock()
        bridge.state = dict(subtitle_delay_ms=500, absolute_time=65, playlist_duration=80)
        bridge.selected = dict(url='offline-fixture', title='Fixture')
        bridge.source_delays = {'offline-fixture': 500}
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
                bridge.mutate('seek', {'position': 60})
                bridge.cast.media_controller.stop.assert_not_called()
                bridge.cast.media_controller.seek.assert_not_called()
                command = launch.call_args.args[0]
                self.assertLess(command.index('-ss'), command.index('-i'))
                self.assertEqual(command[command.index('-ss') + 1], '60.0')
                self.assertEqual(command[command.index('-t') + 1], '30.0')
                self.assertTrue(bridge.status()['pending'])
                self.assertEqual(bridge.source_delays['offline-fixture'], 500)
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
                    bridge.mutate('seek', {'position': 999})
                    self.assertAlmostEqual(bridge.status()['origin'], expected)
                    bridge.cast.media_controller.stop.assert_called_once()
                    bridge.update(absolute_time=65)
                    bridge.mutate('delay', {'delay_ms': 500})
                    self.assertEqual(bridge.status()['origin'], 65)
                    self.assertTrue(bridge.paused)
                    self.assertEqual(bridge.source_delays['offline-fixture'], 500)


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
    def run_failure(self, bind_failure=None, start_failure=None):
        bridge = Mock(lan_ip='192.0.2.1')
        media, control = Mock(), Mock()
        servers = [media, control]
        if bind_failure is not None:
            servers[bind_failure] = OSError('occupied')
        threads = [Mock(), Mock()]
        if start_failure is not None:
            threads[start_failure].start.side_effect = RuntimeError('thread failed')
        with patch('bridge.Bridge', return_value=bridge), \
             patch('bridge.lan_address', return_value='192.0.2.1'), \
             patch('bridge.ThreadingHTTPServer', side_effect=servers), \
             patch('bridge.threading.Thread', side_effect=threads), \
             patch('builtins.print'):
            self.assertEqual(main(['--device-host', '192.0.2.2']), 1)
        bridge.close.assert_called_once()
        return media, control

    def test_second_bind_failure_closes_unused_media_without_shutdown(self):
        media, control = self.run_failure(bind_failure=1)
        media.shutdown.assert_not_called()
        media.server_close.assert_called_once()
        control.shutdown.assert_not_called()

    def test_first_bind_failure_has_no_server_to_shutdown(self):
        media, control = self.run_failure(bind_failure=0)
        for server in (media, control):
            server.shutdown.assert_not_called()
            server.server_close.assert_not_called()

    def test_thread_start_failure_only_shuts_down_started_servers(self):
        for failed in (0, 1):
            with self.subTest(failed=failed):
                media, control = self.run_failure(start_failure=failed)
                self.assertEqual(media.shutdown.call_count, int(failed == 1))
                control.shutdown.assert_not_called()
                media.server_close.assert_called_once()
                control.server_close.assert_called_once()


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
            streams, duration = probe(str(source))
            self.assertGreaterEqual(duration, 30)
            session = root / 'session-test'
            session.mkdir()
            process = subprocess.Popen(ffmpeg_command(str(source), session, streams,
                delay_ms=500, duration=30, readrate=4), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
