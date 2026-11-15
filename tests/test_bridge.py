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

from bridge import (main, Bridge, media_request, CLIP_SEEK_PREROLL, FFMPEG, FFPROBE, public_status,
                    ffmpeg_command, probe, parse_cues, BridgeError)
from media import Catalogue, PlaybackPlan, Subtitle, normalize_subtitles
from vod import Producer, VodLayout
from backend_fixtures import (install_media, apply_data, media_server, served_cues, finished_producer,
                              running_producer, produce)


def unexpected_launch(*_):
    raise AssertionError('this fixture session never starts FFmpeg')


class RestartPolicyTest(unittest.TestCase):
    def fixture(self, root):
        bridge = Bridge.__new__(Bridge)  # No worker, sockets or discovery.
        bridge.args = SimpleNamespace(max_duration=90, readrate=1.1, media_port=18766)
        bridge.lan_ip = '192.0.2.1'
        bridge.sessions = root
        bridge.state_lock = threading.Lock()
        bridge.state = dict(subtitle_delay_ms=500, absolute_time=65, selected_device={'id':'fixture-device','available':True}, device_revision=1)
        bridge.selected_device_id = 'fixture-device'
        bridge.media_server = None
        bridge.selected = dict(url='offline-fixture', title='Fixture')
        install_media(bridge)
        bridge.selected = bridge.active_plan.catalogue.source
        bridge.quit = threading.Event()
        bridge.browser = None
        bridge.session = root / 'old'
        bridge.session.mkdir()
        bridge.producer = Producer(bridge.session, VodLayout(90, subtitles=True), unexpected_launch)
        bridge.media_url = 'http://old/master.m3u8'
        bridge.loaded = True
        bridge.receiver_confirmed = False
        bridge.paused = True
        bridge.load_time, bridge.duration = 0, 90
        bridge.cast = Mock()
        bridge.cast.media_controller.status = SimpleNamespace(
            content_id='http://unrelated/movie', player_state='PLAYING',
            adjusted_current_time=65, current_subtitle_tracks=[], subtitle_tracks=[])
        return bridge

    def test_track_change_restarts_at_the_receiver_position_and_waits_for_matching_receiver(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.state['playback_id'] = 'playback'
            receiver = bridge.cast.media_controller.status
            receiver.content_id, receiver.player_state, receiver.adjusted_current_time = bridge.media_url, 'PAUSED', 60
            bridge.update(absolute_time=60)
            producer = Mock(pid=123)
            producer.poll.return_value = None
            with patch('bridge.subprocess.Popen', return_value=producer) as launch, \
                 patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)):
                bridge.mutate('subtitles', apply_data(bridge, enabled=False, subtitle_id=None, delay=0))
                bridge.cast.media_controller.stop.assert_called_once()
                command = launch.call_args.args[0]
                self.assertLess(command.index('-ss'), command.index('-i'))
                self.assertEqual(command[command.index('-ss') + 1], '60')
                self.assertEqual(command[command.index('-start_number') + 1], '10')
                self.assertEqual(command[command.index('-t') + 1], '30')
                self.assertTrue(bridge.status()['pending'])
                produce(bridge.session, 10, 11, 12)
                (bridge.session / 'master.m3u8').touch()
                bridge.tick()
                call = bridge.cast.media_controller.play_media.call_args
                self.assertEqual(call.args[0], f'http://192.0.2.1:18766/{bridge.session.name}/d0/master.m3u8')
                self.assertFalse(call.kwargs['autoplay'])
                self.assertEqual(call.kwargs['current_time'], 60)
                self.assertEqual(call.kwargs['media_info']['duration'], 90)
                self.assertTrue(bridge.status()['pending'])
                receiver.content_id = bridge.media_url
                receiver.player_state = 'BUFFERING'
                receiver.adjusted_current_time = 65
                bridge.tick()
                self.assertTrue(bridge.status()['pending'])
                receiver.player_state = 'PAUSED'
                bridge.tick()
                status = bridge.status()
                self.assertFalse(status['pending'])
                self.assertEqual(status['absolute_time'], 65)
                self.assertEqual((status['buffered_start'], status['buffered_end'], status['buffer_ahead_seconds']), (60, 78, 13))

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

    def test_delay_change_reloads_the_running_session_at_the_receiver_position(self):
        for player_state in ('PLAYING', 'PAUSED'):
            with self.subTest(player_state=player_state), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                bridge.state['playback_id'] = 'playback'
                bridge.receiver_confirmed = True
                producer = running_producer(bridge)
                produce(bridge.session, *range(15))
                bridge.started_at = time.monotonic()
                receiver = bridge.cast.media_controller.status
                receiver.content_id = bridge.media_url
                receiver.player_state = player_state
                receiver.adjusted_current_time = 65.5
                with patch.object(bridge, 'begin', side_effect=AssertionError('no rebuild')):
                    bridge.mutate('subtitles', apply_data(bridge, delay=-1500))
                call = bridge.cast.media_controller.play_media.call_args
                self.assertEqual(call.args[0], 'http://192.0.2.1:18766/old/d-1500/master.m3u8')
                self.assertEqual(call.kwargs['current_time'], 65.5)
                self.assertEqual(call.kwargs['autoplay'], player_state == 'PLAYING')
                self.assertEqual(call.kwargs['media_info']['duration'], 90)
                self.assertEqual(bridge.media_url, call.args[0])
                self.assertEqual(bridge.session, Path(folder) / 'old')
                producer.kill.assert_not_called()
                bridge.cast.media_controller.stop.assert_not_called()
                self.assertEqual(bridge.status()['subtitle_delay_ms'], -1500)
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
            bridge.state['playback_id'] = 'playback'
            bridge.receiver_confirmed = True
            running_producer(bridge)
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

    def test_failed_delay_reload_keeps_the_previous_plan_and_url(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
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


class ReceiverSeekTest(unittest.TestCase):
    fixture = RestartPolicyTest.fixture

    def playing(self, folder, player_state='PLAYING'):
        bridge = self.fixture(Path(folder))
        bridge.update(duration=90)
        bridge.producer.command = lambda start, limit: ['ffmpeg', start, limit]
        receiver = bridge.cast.media_controller.status
        receiver.content_id, receiver.player_state, receiver.adjusted_current_time = bridge.media_url, player_state, 30
        bridge.update(absolute_time=30)
        running_producer(bridge)
        return bridge

    def seek(self, bridge, **target):
        bridge.mutate('seek', {'device_id': 'fixture-device', 'device_revision': 1, **target})

    def sent(self, bridge):
        return [call.args for call in bridge.cast.media_controller._send_command.call_args_list]

    def test_seek_is_a_receiver_seek_that_keeps_the_pause_state(self):
        for player_state, resume in (('PLAYING', 'PLAYBACK_START'), ('PAUSED', 'PLAYBACK_PAUSE')):
            with self.subTest(player_state=player_state), tempfile.TemporaryDirectory() as folder:
                bridge = self.playing(folder, player_state)
                produce(bridge.session, *range(15))
                session, identity, url = bridge.session, bridge.state['playback_id'], bridge.media_url
                with patch('vod.subprocess.Popen', side_effect=AssertionError('no restart')):
                    self.seek(bridge, position=60)
                    self.seek(bridge, delta=-45)
                self.assertEqual(self.sent(bridge), [
                    ({'type': 'SEEK', 'currentTime': 60, 'resumeState': resume}, None),
                    ({'type': 'SEEK', 'currentTime': 15, 'resumeState': resume}, None)])
                self.assertEqual(bridge.paused, player_state == 'PAUSED')
                self.assertEqual((bridge.session, bridge.state['playback_id'], bridge.media_url), (session, identity, url))
                controller = bridge.cast.media_controller
                controller.play_media.assert_not_called()
                controller.stop.assert_not_called()
                controller.seek.assert_not_called()

    def test_seek_clamps_to_the_movie(self):
        for position, expected in ((999, 89.9), (-5, 0)):
            with self.subTest(position=position), tempfile.TemporaryDirectory() as folder:
                bridge = self.playing(folder)
                produce(bridge.session, *range(15))
                self.seek(bridge, position=position)
                self.assertEqual(self.sent(bridge)[0][0]['currentTime'], expected)

    def test_far_seek_warms_the_producer_at_the_target_and_a_near_one_does_not(self):
        with tempfile.TemporaryDirectory() as folder, patch('vod.subprocess.Popen') as launch:
            bridge = self.playing(folder)
            produce(bridge.session, *range(0, 6))
            previous = bridge.producer.process
            self.seek(bridge, position=40)
            launch.assert_not_called()
            self.seek(bridge, position=70)
            previous.kill.assert_called_once()
            self.assertEqual(launch.call_args.args[0], ['ffmpeg', 11, 15])
            self.assertEqual(self.sent(bridge)[-1][0]['currentTime'], 70)

    def test_tick_follows_the_seek_target_until_the_receiver_reports_it(self):
        with tempfile.TemporaryDirectory() as folder, patch('vod.subprocess.Popen') as launch:
            bridge = self.playing(folder)
            produce(bridge.session, *range(0, 6))
            launch.return_value = Mock(pid=4321, **{'poll.return_value': None})
            self.seek(bridge, position=70)
            self.assertEqual(launch.call_count, 1)
            bridge.tick()
            self.assertEqual(launch.call_count, 1, 'a stale receiver time must not pull the producer back')
            self.assertEqual(bridge.status()['absolute_time'], 70)
            bridge.cast.media_controller.status.adjusted_current_time = 70.5
            bridge.tick()
            self.assertEqual(bridge.status()['absolute_time'], 70.5)
            bridge.cast.media_controller.status.adjusted_current_time = 31
            bridge.tick()
            self.assertEqual(bridge.status()['absolute_time'], 31, 'once confirmed, the receiver is the playhead again')

    def test_seek_needs_the_receiver_to_show_this_playback(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = self.playing(folder)
            bridge.cast.media_controller.status.content_id = 'http://unrelated/movie'
            with self.assertRaises(BridgeError) as refused:
                self.seek(bridge, position=60)
            self.assertEqual(refused.exception.code, 'receiver_not_ready')
            bridge.cast.media_controller._send_command.assert_not_called()
            for target in ({'position': float('nan')}, {'delta': float('inf')}, {'position': '60'}, {}):
                with self.subTest(target=target), self.assertRaises(BridgeError):
                    bridge.cast.media_controller.status.content_id = bridge.media_url
                    self.seek(bridge, **target)
            bridge.cast.media_controller._send_command.assert_not_called()


class ReceiverOwnershipTest(unittest.TestCase):
    fixture = RestartPolicyTest.fixture

    def test_delayed_first_status_remains_loading_then_confirms(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.loaded = False
            bridge.started_at = time.monotonic()
            bridge.update(phase='buffering', pending=True, absolute_time=0)
            running_producer(bridge)
            produce(bridge.session, 0, 1, 2)
            (bridge.session / 'master.m3u8').touch()
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'loading')
            self.assertTrue(bridge.status()['pending'])
            bridge.cast.media_controller.status.content_id = bridge.media_url
            bridge.cast.media_controller.status.adjusted_current_time = 1
            bridge.tick()
            self.assertEqual(bridge.status()['phase'], 'playing')
            self.assertFalse(bridge.status()['pending'])

    def test_first_load_waits_for_three_segments_from_the_load_position(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            bridge.loaded = False
            bridge.load_time = 61
            bridge.producer.start = bridge.producer.position = 10
            running_producer(bridge)
            bridge.started_at = time.monotonic()
            (bridge.session / 'master.m3u8').touch()
            for produced in ((0, 1, 2), (10, 11), (10, 11, 12)):
                produce(bridge.session, *produced)
                bridge.tick()
                self.assertEqual(bridge.cast.media_controller.play_media.called, produced == (10, 11, 12), produced)
            self.assertEqual(bridge.cast.media_controller.play_media.call_args.kwargs['current_time'], 61)

    def test_producer_failure_stops_the_session_but_a_finished_run_does_not(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            bridge = self.fixture(Path(folder))
            process = running_producer(bridge)
            produce(bridge.session, *range(15))
            process.poll.return_value = 0
            bridge.tick()
            process.poll.return_value = 1
            with self.assertRaises(BridgeError):
                bridge.tick()

    def test_ownership_loss_preserves_position_and_stop_leaves_foreign_media(self):
        for player_state in ('PLAYING', 'PAUSED'):
            with self.subTest(player_state=player_state), tempfile.TemporaryDirectory(
                    dir=Path(__file__).resolve().parents[1]) as folder:
                bridge = self.fixture(Path(folder))
                running_producer(bridge)
                produce(bridge.session, *range(15))
                receiver = bridge.cast.media_controller.status
                receiver.content_id = bridge.media_url
                receiver.player_state = player_state
                receiver.adjusted_current_time = 65
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
    def test_requests_name_a_session_a_delay_and_one_resource(self):
        self.assertEqual(media_request('/session-123/d0/video.m3u8'), ('session-123', 0, 'video.m3u8'))
        self.assertEqual(media_request('/session-123/d-1500/segment-0004.ts'), ('session-123', -1500, 'segment-0004.ts'))
        self.assertEqual(media_request('/session-123/d30000/video7.vtt?x=1'), ('session-123', 30000, 'video7.vtt'))
        for path in ('/session-123/video.m3u8', '/session-123/d0/', '/../d0/video.m3u8',
                     '/session-123/d0/%2e%2e/session-123/video.m3u8', '/session-123/%2e%2e/video.m3u8',
                     '/session-123/d0/file%00.vtt', '/session-123/d0/a%5cb.vtt',
                     '/session-123/d-0/video.m3u8', '/session-123/d+5/video.m3u8', '/session-123/d05/video.m3u8',
                     '/session-123/d30001/video.m3u8', '/session-123/dx/video.m3u8', '/session-123/500/video.m3u8'):
            with self.subTest(path=path):
                self.assertIsNone(media_request(path))


def synthetic_movie(root, srt_text, seconds, name='movie.mkv'):
    srt = root / (name + '.srt')
    srt.write_text(srt_text)
    source = root / name
    fixture = subprocess.run([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i',
        f'color=c=black:s=160x90:r=24:d={seconds}', '-f', 'lavfi', '-i',
        'anullsrc=r=48000:cl=stereo', '-i', str(srt), '-map', '0:v',
        '-map', '1:a', '-map', '2:s', '-t', str(seconds), '-c:v', 'libx264',
        '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
        '-metadata:s:s:0', 'language=spa', str(source)],
        capture_output=True, timeout=30)
    assert fixture.returncode == 0, fixture.stderr.decode()
    return source


class SubtitleTimingTest(unittest.TestCase):
    def test_embedded_restart_drops_cues_that_start_before_it_and_served_views_shift_the_rest(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            source = synthetic_movie(root,
                '1\n00:00:07,000 --> 00:00:11,000\nPast\n\n'
                '2\n00:00:11,000 --> 00:00:15,000\nCrossing\n\n'
                '3\n00:00:12,200 --> 00:00:12,400\nEarly\n\n'
                '4\n00:00:13,000 --> 00:00:17,000\nFuture\n\n'
                '5\n00:00:19,000 --> 00:00:23,000\nLater\n', 26)
            analysis = probe(str(source))
            catalogue = Catalogue('synthetic', dict(id='synthetic', url=str(source)), analysis)

            sessions = root / 'sessions'
            sessions.mkdir()
            session = sessions / 'session-seek'
            session.mkdir()
            result = subprocess.run(ffmpeg_command(str(source), session,
                PlaybackPlan(catalogue, analysis.entries[0], 0, True), start_index=2, duration=12, readrate=1000),
                capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(sorted(p.name for p in session.glob('*.ts')), ['segment-0002.ts', 'segment-0003.ts'])
            self.assertNotIn('X-TIMESTAMP-MAP', ''.join(p.read_text() for p in session.glob('*.vtt')))
            # Movie times; allow only the small AAC offset.
            cases = (
                (500, {'Early': (12.7, 12.9), 'Future': (13.5, 17.5), 'Later': (19.5, 23.5)}),
                (0, {'Early': (12.2, 12.4), 'Future': (13, 17), 'Later': (19, 23)}),
                (-500, {'Future': (12.5, 16.5), 'Later': (18.5, 22.5)}),
            )
            with media_server(sessions, finished_producer(session, 24)) as fetch:
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
            source = synthetic_movie(root, '1\n00:00:01,040 --> 00:00:02,500\nOpening\n\n'
                                           '2\n00:00:20,000 --> 00:00:21,500\nAfterSilence\n\n'
                                           '3\n00:00:47,500 --> 00:00:49,000\nLast\n', 54)
            analysis = probe(str(source))
            session = root / 'session-sparse'
            session.mkdir()
            result = subprocess.run(ffmpeg_command(str(source), session, PlaybackPlan(
                Catalogue('sparse', dict(id='sparse', url=str(source)), analysis), analysis.entries[0], 0, True),
                readrate=1000), capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            layout = VodLayout(analysis.duration, subtitles=True)
            placed = {}
            for index in range(layout.count):
                for cue_start, _, _, text in parse_cues((session / layout.cue_name(index)).read_text()):
                    placed[text] = (cue_start, *layout.window(index))
            self.assertEqual(set(placed), {'Opening', 'AfterSilence', 'Last'})
            for text, (cue_start, start, end) in placed.items():
                with self.subTest(cue=text):
                    self.assertTrue(start <= cue_start < end, (cue_start, start, end))

    def test_input_seek_normalizes_source_cue_to_the_seek_point(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            source = Path(folder) / 'seek.srt'
            source.write_text('1\n00:01:02,355 --> 00:01:04,000\nHola\n')
            result = subprocess.run([FFMPEG, '-v', 'error', '-ss', '60', '-i', str(source),
                '-c:s', 'webvtt', '-bsf:s', CLIP_SEEK_PREROLL, '-f', 'webvtt', '-'],
                capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertIn(b'00:02.355 --> 00:04.000', result.stdout)


class DelayedSubtitleViewTest(unittest.TestCase):
    def session(self, root):
        session = root / 'session-view'
        session.mkdir()
        (session / 'video0.vtt').write_text('WEBVTT\n\n00:00.100 --> 00:00.900\nGone\n\n'
                                            '00:00.200 --> 00:01.500 align:start\nFirst\nline two\n\n'
                                            '00:04.800 --> 00:05.900\nEdge\n')
        (session / 'video1.vtt').write_text('WEBVTT\n\n00:06.500 --> 00:08.000\nPulled\n')
        (session / 'video2.vtt').write_text('WEBVTT\n\n00:12.500 --> 00:17.000\nLate\n')
        (session / 'video3.vtt').write_text('')
        (session / 'master.m3u8').write_text('#EXTM3U\n')
        produce(session, 1, 2)
        (session / 'segment-0000.ts').write_bytes(bytes(range(256)) * 4)
        return session

    def test_positive_delay_shifts_cues_and_repeats_a_cue_that_crosses_into_the_next_window(self):
        with tempfile.TemporaryDirectory() as folder:
            session = self.session(Path(folder))
            with media_server(Path(folder), finished_producer(session, 18)) as fetch:
                self.assertEqual(fetch('/session-view/d1000/video0.vtt').read().decode(),
                                 'WEBVTT\n\n00:00:01.100 --> 00:00:01.900\nGone\n\n'
                                 '00:00:01.200 --> 00:00:02.500 align:start\nFirst\nline two\n\n'
                                 '00:00:05.800 --> 00:00:06.900\nEdge\n')
                self.assertEqual(fetch('/session-view/d1000/video1.vtt').read().decode(),
                                 'WEBVTT\n\n00:00:05.800 --> 00:00:06.900\nEdge\n\n00:00:07.500 --> 00:00:09.000\nPulled\n')
                self.assertEqual(served_cues(fetch, 'session-view', 1000), {
                    'Gone': (1.1, 1.9), 'First': (1.2, 2.5), 'Edge': (5.8, 6.9), 'Pulled': (7.5, 9), 'Late': (13.5, 18)})

    def test_negative_delay_drops_expired_cues_clips_at_zero_and_pulls_later_cues_forward(self):
        with tempfile.TemporaryDirectory() as folder:
            session = self.session(Path(folder))
            with media_server(Path(folder), finished_producer(session, 18)) as fetch:
                self.assertEqual(fetch('/session-view/d-1000/video0.vtt').read().decode(),
                                 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500 align:start\nFirst\nline two\n\n'
                                 '00:00:03.800 --> 00:00:04.900\nEdge\n\n00:00:05.500 --> 00:00:07.000\nPulled\n')
                self.assertEqual(served_cues(fetch, 'session-view', -1000), {
                    'First': (0, 0.5), 'Edge': (3.8, 4.9), 'Pulled': (5.5, 7), 'Late': (11.5, 16)})

    def test_every_window_is_listed_and_a_negative_delay_waits_for_the_segments_it_pulls_from(self):
        with tempfile.TemporaryDirectory() as folder:
            session = self.session(Path(folder))
            (session / 'segment-0001.ts').unlink()
            producer = finished_producer(session, 18, hold_seconds=5)
            producer.process.poll.return_value = None
            with media_server(Path(folder), producer) as fetch:
                for delay in (0, 4000, -1000, -6001):
                    with self.subTest(delay=delay):
                        self.assertEqual(fetch(f'/session-view/d{delay}/video_vtt.m3u8').read().decode(),
                                         VodLayout(18, subtitles=True).subtitle_playlist())
                self.assertNotIn('Pulled', fetch('/session-view/d0/video0.vtt').read().decode())
                answer = []
                waiting = threading.Thread(target=lambda: answer.append(
                    fetch('/session-view/d-1000/video0.vtt').read().decode()))
                waiting.start()
                time.sleep(.3)
                self.assertEqual(answer, [], 'the window waits for the later segment it pulls cues from')
                produce(session, 1)
                waiting.join(3)
                self.assertIn('Pulled', answer[0])
            (session / 'segment-0002.ts').unlink()
            with media_server(Path(folder), finished_producer(session, 18)) as fetch:
                started = time.monotonic()
                self.assertNotIn('Late', fetch('/session-view/d-6000/video1.vtt').read().decode())
                self.assertLess(time.monotonic() - started, 1, 'a segment the producer will not write is not awaited')

    def test_a_cue_from_two_runs_is_shown_once_from_its_earlier_start(self):
        with tempfile.TemporaryDirectory() as folder:
            session = self.session(Path(folder))
            (session / 'video1.vtt').write_text('WEBVTT\n\n00:06.021 --> 00:07.021\nCrossing\n')
            (session / 'video0.vtt').write_text('WEBVTT\n\n00:05.043 --> 00:07.043\nCrossing\n')
            with media_server(Path(folder), finished_producer(session, 18)) as fetch:
                self.assertEqual(fetch('/session-view/d0/video1.vtt').read().decode(),
                                 'WEBVTT\n\n00:00:05.043 --> 00:00:07.043\nCrossing\n')

    def test_video_passes_through_and_unknown_or_escaping_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            session = self.session(Path(folder))
            (session / 'secret.json').write_text('{}')
            (session / 'segment-0002.ts').unlink()
            (session / 'segment-0002.ts').symlink_to(session / 'segment-0000.ts')
            (Path(folder) / 'linked').symlink_to(session)
            with media_server(Path(folder), finished_producer(session, 18)) as fetch:
                for delay in (0, 1500, -1500):
                    self.assertEqual(fetch(f'/session-view/d{delay}/segment-0000.ts').read(),
                                     (session / 'segment-0000.ts').read_bytes())
                    self.assertEqual(fetch(f'/session-view/d{delay}/video.m3u8').read().decode(),
                                     VodLayout(18).media_playlist())
                partial = fetch('/session-view/d1500/segment-0000.ts', Range='bytes=10-19')
                self.assertEqual((partial.status, partial.read()), (206, bytes(range(10, 20))))
                whole = fetch('/session-view/d1500/video1.vtt').read()
                partial = fetch('/session-view/d1500/video1.vtt', Range='bytes=0-5')
                self.assertEqual((partial.status, partial.headers['Content-Range'], partial.read()),
                                 (206, f'bytes 0-5/{len(whole)}', whole[:6]))
                for path in ('/session-view/video0.vtt', '/session-view/d1500/video3.vtt',
                             '/session-view/d1500/missing.vtt', '/session-view/d0/secret.json',
                             '/session-view/d0/segment-0002.ts', '/session-view/d0/video2.vtt',
                             '/session-view/d0/segment-0000.ts.tmp', '/linked/d0/segment-0000.ts',
                             '/other-session/d0/segment-0000.ts', '/session-view/d0/video_vtt0.vtt',
                             '/session-view/d1500/%2e%2e/session-view/video0.vtt',
                             '/session-view/d1500/..%2fsession-view%2fvideo0.vtt', '/session-view/d01500/video0.vtt',
                             '/..%2fsession-view/d0/video0.vtt'):
                    with self.subTest(path=path), self.assertRaises(HTTPError) as refused:
                        fetch(path)
                    self.assertEqual(refused.exception.code, 404)
            with media_server(Path(folder), finished_producer(session, 18, subtitles=False)) as fetch:
                for path in ('/session-view/d0/video_vtt.m3u8', '/session-view/d0/video0.vtt'):
                    with self.subTest(path=path), self.assertRaises(HTTPError) as refused:
                        fetch(path)
                    self.assertEqual(refused.exception.code, 404)


class StatusTest(unittest.TestCase):
    def test_buffered_interval_is_reported_in_movie_time_and_status_excludes_private_values(self):
        result = public_status({'source': 'http://private/movie', 'error': 'private URL',
                                'phase': 'playing', 'absolute_time': 135, 'duration': 200,
                                'buffered_start': 120, 'buffered_end': 210,
                                'active_subtitle_track_ids': [1]})
        self.assertNotIn('private', str(result))
        self.assertEqual(result['absolute_time'], 135)
        self.assertEqual((result['buffered_start'], result['buffered_end'], result['buffer_ahead_seconds']), (120, 200, 65))


class GrowingHLSTest(unittest.TestCase):
    def test_actual_pipeline_holds_a_segment_until_ffmpeg_writes_it(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            source = synthetic_movie(root, '1\n00:00:01,000 --> 00:00:02,000\nHola\n\n2\n00:00:25,000 --> 00:00:26,000\nFinal\n', 60)
            analysis = probe(str(source))
            self.assertGreaterEqual(analysis.duration, 60)
            catalogue = Catalogue('synthetic', dict(id='synthetic', url=str(source)), analysis)
            plan = PlaybackPlan(catalogue, analysis.entries[0], 0, True)
            session = root / 'session-test'
            session.mkdir()
            layout = VodLayout(60, subtitles=True)
            producer = Producer(session, layout, lambda start, limit: ffmpeg_command(
                str(source), session, plan, start_index=start, readrate=4,
                duration=min(60, layout.start(limit)) - layout.start(start)))
            producer.cover(0)
            try:
                with media_server(root, producer) as fetch:
                    playlist = fetch('/session-test/d500/video.m3u8').read().decode()
                    self.assertIn('#EXT-X-PLAYLIST-TYPE:VOD', playlist)
                    self.assertTrue(playlist.endswith('segment-0009.ts\n#EXT-X-ENDLIST\n'))
                    self.assertFalse((session / 'segment-0003.ts').exists())
                    segment = fetch('/session-test/d500/segment-0003.ts').read()
                    self.assertTrue(producer.snapshot().alive, 'served while FFmpeg is still writing later segments')
                    self.assertEqual(segment, (session / 'segment-0003.ts').read_bytes())
                    cue = served_cues(fetch, session.name, 500)['Hola']
                # AAC in the MKV fixture adds ~43 ms; the direct SRT test is exact.
                self.assertAlmostEqual(cue[0], 1.5, delta=0.1)
            finally:
                producer.close()



class RestartArgumentsTest(unittest.TestCase):
    def plan(self):
        from media import Analysis
        upload = Subtitle('upload', 'upload', 'Subida', path=Path('/private/upload.vtt'))
        return PlaybackPlan(Catalogue('c', dict(id='s', url='u'), Analysis(0, 1, 120, ())), upload, 0, True)

    def test_a_run_from_zero_has_no_restart_arguments(self):
        command = ffmpeg_command('http://source', Path('/session'), self.plan(), duration=120)
        for flag in ('-ss', '-start_number', '-output_ts_offset'):
            self.assertNotIn(flag, command)

    def test_a_restart_at_k_seeks_both_inputs_and_keeps_absolute_numbers_and_times(self):
        command = ffmpeg_command('http://source', Path('/session'), self.plan(), start_index=3, duration=30)
        inputs = [i for i, value in enumerate(command) if value == '-i']
        self.assertEqual([command[i + 1] for i in inputs], ['http://source', '/private/upload.vtt'])
        self.assertEqual([command[i - 2:i] for i in inputs], [['-ss', '18'], ['-ss', '18']])
        for flag, value in (('-output_ts_offset', '18'), ('-start_number', '3'), ('-t', '30'),
                            ('-readrate', '1.1'), ('-readrate_initial_burst', '30')):
            self.assertEqual(command[command.index(flag) + 1], value, flag)
        self.assertLess(command.index('-output_ts_offset'), command.index('-f'))


class RestartSeamTest(unittest.TestCase):
    """A run restarted at segment k must line up with a run from 0, so the TV can play both mixed."""
    TOLERANCE = .05

    def packets(self, path, stream):
        output = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', stream, '-show_entries',
                                 'packet=pts_time', '-of', 'csv=p=0', str(path)], capture_output=True, text=True, timeout=10)
        times = [float(value.strip(',')) for value in output.stdout.split() if value.strip(',')]
        return min(times), max(times)

    def test_restart_at_k_matches_the_run_from_zero_for_video_audio_and_cues(self):
        k = 3
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            root = Path(folder)
            srt = ('1\n00:00:16,500 --> 00:00:19,500\nSpanning\n\n'
                   '2\n00:00:20,000 --> 00:00:21,000\nAfter\n\n'
                   '3\n00:00:25,000 --> 00:00:26,000\nLater\n')
            source = synthetic_movie(root, srt, 40)
            analysis = probe(str(source))
            catalogue = Catalogue('seam', dict(id='seam', url=str(source)), analysis)
            upload = root / 'upload.vtt'
            upload.write_bytes(normalize_subtitles('srt', srt))
            for entry in (analysis.entries[0], Subtitle('upload', 'upload', 'Subida', path=upload)):
                with self.subTest(kind=entry.kind):
                    plan = PlaybackPlan(catalogue, entry, 0, True)
                    runs = {}
                    for name, start in (('zero', 0), ('restart', k)):
                        runs[name] = root / f'{entry.kind}-{name}'
                        runs[name].mkdir()
                        result = subprocess.run(ffmpeg_command(str(source), runs[name], plan, start_index=start,
                            duration=analysis.duration - 6 * start, readrate=1000), capture_output=True, timeout=60)
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                    zero, restart = runs['zero'], runs['restart']
                    self.assertFalse((restart / 'segment-0002.ts').exists())
                    zero_cues = {text: (start, end) for vtt in zero.glob('*.vtt')
                                 for start, end, _, text in parse_cues(vtt.read_text())}
                    restarted = set()
                    for index in (k, k + 1):
                        segment = VodLayout.segment_name(index)
                        video = self.packets(zero / segment, 'v:0'), self.packets(restart / segment, 'v:0')
                        audio = self.packets(zero / segment, 'a:0'), self.packets(restart / segment, 'a:0')
                        self.assertAlmostEqual(video[1][0], video[0][0], delta=self.TOLERANCE)
                        self.assertAlmostEqual(video[1][1], video[0][1], delta=self.TOLERANCE)
                        self.assertAlmostEqual(audio[1][1], audio[0][1], delta=self.TOLERANCE)
                        # The restart's first segment also carries the AAC pre-roll the earlier run put in k - 1.
                        self.assertAlmostEqual(audio[1][0], video[0][0] if index == k else audio[0][0], delta=self.TOLERANCE)
                        for start, end, _, text in parse_cues((restart / VodLayout.cue_name(index)).read_text()):
                            restarted.add(text)
                            with self.subTest(index=index, cue=text):
                                self.assertAlmostEqual(end, zero_cues[text][1], delta=self.TOLERANCE * 1000)
                                if text != 'Spanning':
                                    self.assertAlmostEqual(start, zero_cues[text][0], delta=self.TOLERANCE * 1000)
                    # An uploaded file is clipped at the restart point; an embedded track drops the cue.
                    self.assertEqual(restarted, {'Spanning', 'After', 'Later'} if entry.path else {'After', 'Later'})
                    mixed = root / f'session-{entry.kind}'
                    mixed.mkdir()
                    layout = VodLayout(analysis.duration, subtitles=True)
                    for index in range(layout.count):
                        run = zero if index < k else restart
                        for name in (layout.segment_name(index), layout.cue_name(index)):
                            (mixed / name).write_bytes((run / name).read_bytes())
                    with media_server(root, finished_producer(mixed, analysis.duration)) as fetch:
                        cues = served_cues(fetch, mixed.name, 0)
                    self.assertEqual(set(cues), {'Spanning', 'After', 'Later'})
                    self.assertAlmostEqual(cues['Spanning'][0], 16.5, delta=self.TOLERANCE)
                    self.assertAlmostEqual(cues['After'][0], 20, delta=self.TOLERANCE)


if __name__ == '__main__':
    unittest.main()
