import contextlib
import io
import os
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from media import MediaError
from vod import Producer, Run, VodLayout, exit_outcome, segment_action


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
        running = Run(start=10, limit=30, position=12, state='running', end=40)
        cases = (
            ('on disk', 4, True, running, 'serve'),
            ('being written', 12, False, running, 'hold'),
            ('within reach', 15, False, running, 'hold'),
            ('just out of reach', 16, False, running, 'restart'),
            ('behind the producer start', 9, False, running, 'restart'),
            ('past the run bound', 30, False, Run(10, 30, 28, 'running', 40), 'restart'),
            ('never started', 0, False, Run(0, 0, 0, 'stopped', 40), 'restart'),
            ('a stopped run never wrote it', 29, False, Run(10, 30, 29, 'stopped', 40), 'restart'),
            ('backing off after a failure', 12, False, Run(10, 30, 12, 'backoff', 40), 'wait'),
            ('retry budget spent', 12, False, Run(10, 30, 12, 'exhausted', 40), 'missing'),
            ('past the end of the source', 40, False, running, 'end'),
            ('past the end, budget spent', 41, False, Run(10, 30, 12, 'exhausted', 40), 'end'),
        )
        for label, index, complete, run, expected in cases:
            with self.subTest(label):
                self.assertEqual(segment_action(index, complete, run), expected)

    def test_who_may_restart(self):
        running, stopped = Run(10, 30, 12, 'running', 50), Run(10, 30, 30, 'stopped', 50)
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


class ExitOutcomeTest(unittest.TestCase):
    def test_how_a_run_that_exited_by_itself_ended(self):
        # A stall exits 0 too, but only after FFmpeg's read timeout without data (measured ~45 s, never under 15).
        cases = (
            ('reached its bound', 10, 20, 20, 0, 'complete'),
            ('reached its bound after a long silence', 10, 20, 20, 60, 'complete'),
            ('stopped promptly in the last two listed segments', 10, 50, 48, 1, 'end'),
            ('stopped promptly having written nothing near the end', 49, 50, 49, 1, 'end'),
            ('stopped in the last two after a silence', 10, 50, 48, 45, 'stalled'),
            ('wrote nothing near the end after a silence', 49, 50, 49, 45, 'stalled'),
            ('stopped promptly far from the end', 10, 50, 30, 1, 'stalled'),
            ('stopped near the end of a run bounded before the list end', 10, 49, 48, 1, 'stalled'),
        )
        for label, start, limit, position, quiet, expected in cases:
            with self.subTest(label):
                self.assertEqual(exit_outcome(start, limit, position, 50, quiet, stall_seconds=10), expected)


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
                        **{'poll_seconds': .01, **kwargs})

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
        threads = [threading.Thread(target=lambda: results.append(producer.request(15))) for _ in range(2)]
        for thread in threads:
            thread.start()
        time.sleep(.1)
        self.write(15)
        for thread in threads:
            thread.join(3)
        self.assertEqual(results, ['serve'] * 2)
        self.assertEqual([p.command for p in self.launched], [['ffmpeg', 0, 20], ['ffmpeg', 15, 20]])

    def test_receiver_retries_replace_the_oldest_wait_instead_of_stacking(self):
        producer = self.producer(hold_seconds=5)
        results = {}
        def ask(label):
            results[label] = producer.request(15)
        threads = [threading.Thread(target=ask, args=(label,)) for label in ('first', 'retry', 'again')]
        for thread in threads:
            thread.start()
            time.sleep(.05)
        threads[0].join(1)
        self.assertEqual(results, {'first': 'missing'}, 'the abandoned wait is released')
        self.write(15)
        for thread in threads:
            thread.join(1)
        self.assertEqual(results, {'first': 'missing', 'retry': 'serve', 'again': 'serve'})
        self.assertEqual(len(self.launched), 1)

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
        self.assertEqual(result, ['serve'])
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
        self.assertEqual(result, ['serve'])
        self.assertEqual(len(self.launched), 1)
        self.launched[0].code = 0
        self.assertEqual(producer.request(5, extra=range(18, 22)), 'serve', 'cues the producer will not write are not awaited')
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
        self.assertEqual(result, ['missing'], 'answered as soon as the producer moved away')
        self.assertEqual([p.command[1] for p in self.launched], [0, 15])
        self.assertEqual(producer.request(3, cue=True), 'missing')
        self.assertEqual(len(self.launched), 2)

    def test_hold_is_bounded_per_segment_across_receiver_retries(self):
        producer = self.producer(hold_seconds=.3)
        producer.cover(0)
        started = time.monotonic()
        self.assertEqual(producer.request(2), 'missing')
        self.assertEqual(producer.request(2), 'missing')
        self.assertLess(time.monotonic() - started, .6, 'a retry shares the first deadline')

    def test_a_cue_request_never_shortens_the_hold_of_the_video_segment_it_shares_an_index_with(self):
        producer = self.producer(hold_seconds=.4)
        producer.cover(0)
        cue = threading.Thread(target=producer.request, args=(2,), kwargs={'cue': True})
        cue.start()
        time.sleep(.3)
        started = time.monotonic()
        self.assertEqual(producer.request(2), 'missing')
        self.assertGreater(time.monotonic() - started, .35, 'the video request holds for its own full window')
        cue.join(1)

    def test_a_run_that_stops_within_the_last_two_listed_segments_marks_the_end(self):
        self.layout = VodLayout(60.021)
        producer = self.producer()
        producer.cover(0)
        self.write(*range(0, 8))
        self.launched[0].code = 0
        self.assertEqual(producer.request(8), 'end')
        self.assertEqual(producer.request(9), 'end')
        self.assertEqual(producer.request(7), 'serve')
        self.assertEqual(producer.snapshot().end, 8)
        self.assertEqual(len(self.launched), 1)

    def test_a_stall_in_the_last_two_segments_is_retried_not_taken_for_the_end(self):
        producer = self.producer(backoff_seconds=0, stall_seconds=.1)
        producer.seek(17)
        self.write(17, 18)
        written = time.time() - 1
        os.utime(self.directory / self.layout.segment_name(17), (written, written))
        self.launched[0].code = 0
        producer.cover(17)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 18, 20], 'the short segment the stall left is redone')
        self.assertFalse((self.directory / self.layout.segment_name(18)).exists())
        time.sleep(.15)
        self.launched[-1].code = 0
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(18)))
        holder.start()
        time.sleep(.05)
        self.assertEqual(result, [], 'a run that wrote nothing for longer than a read timeout stalled')
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 18, 20])
        self.assertEqual(len(self.launched), 3)
        self.write(18)
        holder.join(1)
        self.assertEqual(result, ['serve'])
        self.assertEqual(producer.snapshot().end, 20)

    def test_a_prompt_stop_with_nothing_written_near_the_end_marks_the_end_until_a_run_passes_it(self):
        self.layout = VodLayout(60.021)
        producer = self.producer(stall_seconds=5)
        producer.seek(8)
        self.launched[0].code = 0
        self.assertEqual(producer.request(9), 'end')
        self.assertEqual(producer.snapshot().end, 8)
        producer.cover(3)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 3, 10])
        self.write(*range(3, 9))
        self.assertEqual(producer.snapshot().end, 10, 'media past the marked end proves it wrong')

    def test_a_held_request_restarts_its_run_when_it_dies(self):
        producer = self.producer(hold_seconds=1, backoff_seconds=0)
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(4)))
        holder.start()
        time.sleep(.05)
        self.launched[0].code = 1
        time.sleep(.1)
        self.assertEqual([p.command for p in self.launched], [['ffmpeg', 4, 20], ['ffmpeg', 4, 20]])
        self.write(4)
        holder.join(1)
        self.assertEqual(result, ['serve'])

    def test_a_truncated_run_resumes_from_its_last_segment(self):
        # A stalled source makes FFmpeg exit 0 and finalize the segment it was writing, short.
        producer = self.producer(backoff_seconds=0)
        producer.cover(0)
        self.write(*range(0, 5))
        self.launched[0].code = 0
        producer.cover(0)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 4, 20])
        self.assertFalse((self.directory / self.layout.segment_name(4)).exists())
        self.assertTrue((self.directory / self.layout.segment_name(3)).exists())

    def test_a_held_request_is_not_served_the_short_segment_a_stalled_run_left(self):
        producer = self.producer(hold_seconds=2, backoff_seconds=0)
        producer.cover(0)
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(2)))
        holder.start()
        time.sleep(.05)
        with producer.lock:
            self.write(0, 1, 2)
            self.launched[0].code = 0
        time.sleep(.1)
        self.assertEqual(result, [])
        self.assertEqual([p.command for p in self.launched], [['ffmpeg', 0, 20], ['ffmpeg', 2, 20]])
        self.write(2)
        holder.join(1)
        self.assertEqual(result, ['serve'])

    def test_failures_without_a_new_segment_spend_a_bounded_retry_budget(self):
        producer = self.producer(backoff_seconds=0)
        producer.cover(0)
        self.write(0, 1)
        self.launched[-1].code = 1
        producer.cover(0)
        self.assertEqual(self.launched[-1].command, ['ffmpeg', 1, 20], 'a failed run is retried from its partial segment')
        for _ in range(3):
            self.launched[-1].code = 1
            producer.cover(0)
        self.assertEqual(len(self.launched), 4, 'three runs in a row that wrote nothing spend the budget')
        self.assertTrue(producer.snapshot().failed)
        self.assertEqual(producer.request(1), 'missing')
        self.assertEqual(producer.request(0), 'serve')
        self.assertEqual(len(self.launched), 4)

    def test_a_retry_waits_out_a_short_backoff(self):
        producer = self.producer(backoff_seconds=.2)
        producer.cover(0)
        self.launched[0].code = 1
        producer.cover(0)
        self.assertEqual(len(self.launched), 1)
        self.assertFalse(producer.snapshot().failed)
        result = []
        holder = threading.Thread(target=lambda: result.append(producer.request(0)))
        holder.start()
        time.sleep(.3)
        self.assertEqual(len(self.launched), 2, 'the held request retries once the backoff passes')
        self.write(0)
        holder.join(1)
        self.assertEqual(result, ['serve'])

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
            self.assertEqual(producer.request(16), 'missing')
        self.assertEqual(self.launched[0].signals, [signal.SIGKILL])
        self.assertEqual(producer.snapshot()[:4], (None, False, False, None))
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
        self.assertEqual(result, {105: 'serve'})
        time.sleep(.1)
        self.assertEqual(len(self.launched), 2, 'the displaced hold does not take the run back')
        first.join(2)
        self.assertEqual(result[100], 'missing')
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
        self.assertEqual(result, ['missing'])
        self.assertEqual(self.launched[0].signals, [signal.SIGKILL])
        producer.cover(5)
        self.assertEqual(producer.request(5), 'missing')
        self.assertEqual(len(self.launched), 1)


if __name__ == '__main__':
    unittest.main()
