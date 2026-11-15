import contextlib
import io
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from media import MediaError
from vod import Producer, Run, VodLayout, segment_action


class VodLayoutTest(unittest.TestCase):
    def test_media_playlist_lists_every_segment_up_front_with_the_remainder_last(self):
        layout = VodLayout(15.5)
        self.assertEqual(layout.media_playlist(),
                         '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n'
                         '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n'
                         '#EXTINF:6.000000,\nsegment-0000.ts\n#EXTINF:6.000000,\nsegment-0001.ts\n'
                         '#EXTINF:3.500000,\nsegment-0002.ts\n#EXT-X-ENDLIST\n')

    def test_subtitle_playlist_mirrors_the_media_windows(self):
        self.assertEqual(VodLayout(12, subtitles=True).subtitle_playlist(),
                         '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n'
                         '#EXT-X-PLAYLIST-TYPE:VOD\n'
                         '#EXTINF:6.000000,\nvideo0.vtt\n#EXTINF:6.000000,\nvideo1.vtt\n#EXT-X-ENDLIST\n')

    def test_tail_matches_what_ffmpeg_writes(self):
        # Measured: 60.334 s gave 11 segments ending in 0.333 s; 60.021 s (audio priming only) gave 10.
        for duration, count, last in ((60.334, 11, '0.334000'), (60.021, 10, '6.021000'), (60, 10, '6.000000'),
                                      (5400, 900, '6.000000'), (0.1, 1, '0.100000'), (6.2, 1, '6.200000')):
            with self.subTest(duration=duration):
                layout = VodLayout(duration)
                self.assertEqual(layout.count, count)
                text = layout.media_playlist()
                self.assertEqual(text.count('#EXTINF:'), count)
                self.assertIn(f'#EXTINF:{last},\nsegment-{count - 1:04d}.ts\n#EXT-X-ENDLIST\n', text)

    def test_names_map_to_absolute_indices_and_back(self):
        layout = VodLayout(120, subtitles=True)
        self.assertEqual(layout.segment_name(7), 'segment-0007.ts')
        self.assertEqual(layout.cue_name(7), 'video7.vtt')
        self.assertEqual(layout.parse('segment-0007.ts'), ('segment', 7))
        self.assertEqual(layout.parse('video13.vtt'), ('cue', 13))
        self.assertEqual(layout.parse('video0.vtt'), ('cue', 0))
        for name in ('segment-7.ts', 'segment-00007.ts', 'segment-0020.ts', 'video07.vtt', 'video20.vtt',
                     'video-1.vtt', 'segment-0001.ts.tmp', 'video.m3u8', 'master.m3u8'):
            with self.subTest(name=name):
                self.assertIsNone(layout.parse(name))
        self.assertIsNone(VodLayout(120).parse('video3.vtt'))
        self.assertEqual(VodLayout(6 * 10001).segment_name(10000), 'segment-10000.ts')
        self.assertEqual(VodLayout(6 * 10001).parse('segment-10000.ts'), ('segment', 10000))

    def test_movie_time_maps_to_its_segment_and_window(self):
        layout = VodLayout(60.334)
        for seconds, index in ((0, 0), (5.999, 0), (6, 1), (36, 6), (59.9, 9), (60.2, 10), (999, 10), (-3, 0)):
            with self.subTest(seconds=seconds):
                self.assertEqual(layout.index_at(seconds), index)
        self.assertEqual(layout.start(6), 36)
        self.assertEqual(layout.window(6), (36000, 42000))
        self.assertEqual(layout.window(10), (60000, 60334))



class SegmentActionTest(unittest.TestCase):
    def test_request_decision_table(self):
        running = Run(start=10, limit=30, position=12, state='running')
        cases = (
            ('on disk', 4, True, running, 'serve'),
            ('being written', 12, False, running, 'hold'),
            ('within reach', 15, False, running, 'hold'),
            ('just out of reach', 16, False, running, 'restart'),
            ('behind the producer start', 9, False, running, 'restart'),
            ('past the run bound', 30, False, Run(10, 30, 28, 'running'), 'restart'),
            ('never started', 0, False, Run(0, 0, 0, 'idle'), 'restart'),
            ('finished run never wrote it', 29, False, Run(10, 30, 29, 'finished'), 'missing'),
            ('finished run elsewhere', 40, False, Run(10, 30, 30, 'finished'), 'restart'),
            ('failed producer', 12, False, Run(10, 30, 12, 'failed'), 'missing'),
        )
        for label, index, complete, run, expected in cases:
            with self.subTest(label):
                self.assertEqual(segment_action(index, complete, run), expected)

    def test_who_may_restart(self):
        running, stopped = Run(10, 30, 12, 'running'), Run(10, 30, 30, 'finished')
        cases = (
            # A new request or an explicit seek is the newest demand and always wins.
            ('arrival', running, True, 'restart'),
            ('arrival', stopped, True, 'restart'),
            # A held request never takes a running run from a newer demand.
            ('held', running, False, 'wait'),
            ('held', stopped, False, 'restart'),
            ('held', stopped, True, 'wait'),
            # The playhead heuristic yields to any waiting segment request.
            ('cover', running, False, 'restart'),
            ('cover', running, True, 'wait'),
            ('cover', stopped, True, 'wait'),
        )
        for caller, run, yields, expected in cases:
            with self.subTest(caller=caller, state=run.state, yields=yields):
                self.assertEqual(segment_action(40, False, run, caller, yields), expected)
                self.assertEqual(segment_action(13, False, running, caller, yields), 'hold')


class FakeProcess:
    pids = iter(range(1000, 2000))

    def __init__(self, command, **_):
        self.command, self.pid, self.code, self.signals = command, next(self.pids), None, []

    def poll(self):
        return self.code

    def send_signal(self, value):
        self.signals.append(value)

    def kill(self):
        self.signals.append(signal.SIGKILL)
        self.code = -9

    def wait(self, timeout=None):
        return self.code


class ProducerTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.directory = Path(folder.name)
        self.layout = VodLayout(120)
        self.launched = []
        launch = patch('vod.subprocess.Popen', side_effect=self.launch)
        launch.start()
        self.addCleanup(launch.stop)

    def launch(self, command, **kwargs):
        process = FakeProcess(command, **kwargs)
        self.launched.append(process)
        return process

    def producer(self, **kwargs):
        return Producer(self.directory, self.layout, lambda start, limit: ['ffmpeg', start, limit],
                        poll_seconds=.01, **kwargs)

    def write(self, *indices):
        for index in indices:
            (self.directory / self.layout.segment_name(index)).write_bytes(b'ts')

    def test_cover_starts_at_the_first_gap_and_stops_before_segments_already_on_disk(self):
        self.write(0, 1, 2, 8, 9)
        producer = self.producer()
        producer.cover(0)
        self.assertEqual([p.command for p in self.launched], [['ffmpeg', 3, 8]])
        producer.cover(1)
        self.assertEqual(len(self.launched), 1, 'the gap is already being produced')
        self.write(3, 4, 5, 6, 7)
        self.launched[0].code = 0
        producer.cover(5)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 10, 20])
        self.assertEqual(self.launched[0].signals, [])

    def test_restart_kills_the_previous_run_and_removes_its_partial_files(self):
        producer = self.producer()
        producer.cover(0)
        (self.directory / 'segment-0000.ts.tmp').write_bytes(b'partial')
        producer.cover(15)
        self.assertEqual(self.launched[0].signals, [signal.SIGKILL])
        self.assertEqual(self.launched[1].command, ['ffmpeg', 15, 20])
        self.assertFalse((self.directory / 'segment-0000.ts.tmp').exists())

    def test_cover_within_a_horizon_leaves_far_gaps_alone(self):
        self.write(*range(0, 12))
        producer = self.producer()
        producer.cover(0, horizon=60)
        self.assertEqual(self.launched, [])
        producer.cover(3, horizon=60)
        self.assertEqual(self.launched[0].command, ['ffmpeg', 12, 20])

    def test_concurrent_requests_for_a_far_segment_restart_once(self):
        producer = self.producer(hold_seconds=2)
        producer.cover(0)
        results = []
        threads = [threading.Thread(target=lambda: results.append(producer.request(15))) for _ in range(4)]
        for thread in threads:
            thread.start()
        time.sleep(.1)
        self.write(15)
        for thread in threads:
            thread.join(3)
        self.assertEqual(results, [True] * 4)
        self.assertEqual([p.command for p in self.launched], [['ffmpeg', 0, 20], ['ffmpeg', 15, 20]])

    def test_held_request_keeps_the_producer_running(self):
        self.write(*range(0, 12))
        producer = self.producer(hold_seconds=2)
        producer.cover(0, horizon=None)
        process = self.launched[0]
        producer.throttle(0)
        self.assertEqual(process.signals, [signal.SIGSTOP])
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(13)))
        holder.start()
        time.sleep(.1)
        self.assertEqual(process.signals, [signal.SIGSTOP, signal.SIGCONT])
        producer.throttle(0)
        self.assertEqual(process.signals, [signal.SIGSTOP, signal.SIGCONT], 'no SIGSTOP while a request is held')
        self.write(12, 13)
        holder.join(2)
        self.assertEqual(result, [True])
        producer.throttle(0)
        self.assertEqual(process.signals, [signal.SIGSTOP, signal.SIGCONT, signal.SIGSTOP])

    def test_throttle_follows_the_producer_position(self):
        producer = self.producer()
        producer.cover(0)
        process = self.launched[0]
        self.write(*range(0, 11))
        producer.throttle(6)
        self.assertEqual(process.signals, [], '66 s produced, 60 s ahead')
        producer.throttle(5)
        self.assertEqual(process.signals, [signal.SIGSTOP])
        producer.throttle(20)
        self.assertEqual(process.signals, [signal.SIGSTOP], '46 s ahead stays suspended')
        producer.throttle(22)
        self.assertEqual(process.signals, [signal.SIGSTOP, signal.SIGCONT])
        self.assertEqual(producer.snapshot().suspended, False)

    def test_cues_awaited_from_later_segments_never_restart_the_producer(self):
        self.write(*range(0, 6))
        producer = self.producer(hold_seconds=2)
        producer.cover(0)
        self.assertEqual(self.launched[0].command, ['ffmpeg', 6, 20])
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(5, extra=range(6, 12))))
        holder.start()
        time.sleep(.1)
        self.assertEqual(result, [], 'waits while the running producer is making them')
        self.write(*range(6, 12))
        holder.join(2)
        self.assertEqual(result, [True])
        self.assertEqual(len(self.launched), 1)
        self.launched[0].code = 0
        self.assertTrue(producer.request(5, extra=range(18, 22)), 'cues the producer will not write are not awaited')
        self.assertEqual(len(self.launched), 1)

    def test_a_held_cue_never_pins_the_producer(self):
        producer = self.producer(hold_seconds=2)
        producer.cover(0)
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(2, cue=True)))
        holder.start()
        time.sleep(.05)
        self.assertEqual(result, [], 'held while the running producer reaches it')
        producer.cover(15)
        holder.join(1)
        self.assertEqual(result, [False], 'answered as soon as the producer moved away')
        self.assertEqual([p.command[1] for p in self.launched], [0, 15])
        self.assertFalse(producer.request(3, cue=True))
        self.assertEqual(len(self.launched), 2)

    def test_hold_is_bounded_per_segment_across_receiver_retries(self):
        producer = self.producer(hold_seconds=.3)
        producer.cover(0)
        started = time.monotonic()
        self.assertFalse(producer.request(2))
        self.assertFalse(producer.request(2))
        self.assertLess(time.monotonic() - started, .6, 'a retry shares the first deadline')

    def test_finished_run_answers_missing_segments_without_restarting(self):
        self.layout = VodLayout(60.021)
        producer = self.producer()
        producer.cover(0)
        self.launched[0].code = 0
        self.write(*range(0, 9))
        self.assertFalse(producer.request(9))
        self.assertEqual(len(self.launched), 1)

    def test_a_killed_run_that_will_not_exit_never_leaks_its_arguments(self):
        producer = self.producer()
        producer.cover(0)
        def stuck(timeout=None):
            raise subprocess.TimeoutExpired(['ffmpeg', '-i', 'http://private/infohash'], timeout)
        self.launched[0].wait = stuck
        printed = io.StringIO()
        with contextlib.redirect_stderr(printed):
            producer.cover(15)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 15, 20])
        self.assertNotIn('private', printed.getvalue())

    def test_a_failed_launch_leaves_no_run_and_says_nothing_private(self):
        producer = self.producer()
        producer.cover(0)
        with patch('vod.subprocess.Popen', side_effect=OSError(2, 'No such file', 'http://private/infohash')):
            with self.assertRaises(MediaError) as failed:
                producer.cover(15)
            self.assertNotIn('private', str(failed.exception))
            self.assertFalse(producer.request(16))
        self.assertEqual(self.launched[0].signals, [signal.SIGKILL])
        self.assertEqual(producer.snapshot(), (None, False, False, None))
        producer.cover(15)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 15, 20])

    def test_a_newer_request_takes_the_run_and_the_displaced_hold_waits_without_restarting(self):
        self.layout = VodLayout(6000)
        producer = self.producer(hold_seconds=.6)
        result = {}
        def ask(index):
            result[index] = producer.request(index)
        first = threading.Thread(target=ask, args=(100,))
        first.start()
        time.sleep(.05)
        started = time.monotonic()
        second = threading.Thread(target=ask, args=(105,))
        second.start()
        time.sleep(.1)
        self.assertEqual([p.command[1] for p in self.launched], [100, 105])
        self.write(105)
        second.join(1)
        self.assertEqual(result, {105: True})
        time.sleep(.1)
        self.assertEqual(len(self.launched), 2, 'the displaced hold does not take the run back')
        first.join(2)
        self.assertEqual(result[100], False)
        self.assertGreater(time.monotonic() - started, .4, 'answered at its deadline, not when the run changed')
        retry = threading.Thread(target=ask, args=(100,))
        retry.start()
        time.sleep(.05)
        self.assertEqual(self.launched[-1].command[1], 100, 'a receiver retry is a new demand')
        self.write(100)
        retry.join(1)

    def test_cover_never_replaces_a_run_a_held_request_waits_on(self):
        self.layout = VodLayout(6000)
        producer = self.producer(hold_seconds=.5)
        producer.cover(0)
        holder = threading.Thread(target=producer.request, args=(300,))
        holder.start()
        time.sleep(.05)
        producer.cover(0, horizon=60)
        holder.join(1)
        self.assertEqual([p.command[1] for p in self.launched], [0, 300])
        self.assertEqual(self.launched[1].signals, [])

    def test_closed_producer_releases_holds_and_never_starts_again(self):
        producer = self.producer(hold_seconds=2)
        producer.cover(0)
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(2)))
        holder.start()
        time.sleep(.05)
        producer.close()
        holder.join(1)
        self.assertEqual(result, [False])
        self.assertEqual(self.launched[0].signals, [signal.SIGKILL])
        producer.cover(5)
        self.assertFalse(producer.request(5))
        self.assertEqual(len(self.launched), 1)


if __name__ == '__main__':
    unittest.main()
