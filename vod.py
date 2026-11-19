"""The receiver sees each playback as VOD: every segment is listed up front at its absolute movie time."""
from dataclasses import dataclass
import math
import os
import re
import signal
import stat
import subprocess
import threading
import time
from typing import NamedTuple

from media import MediaError

SEGMENT_SECONDS = 6
# A remainder this short is audio priming without video frames; FFmpeg writes no segment for it.
TAIL_SECONDS = 0.25
SEGMENT_NAME = re.compile(r'segment-(\d{4,})\.ts')
CUE_NAME = re.compile(r'video(0|[1-9]\d*)\.vtt')
# FFmpeg's own playlist for a run, listing how long each segment it wrote came out.
PLAYLIST_NAME = 'video.m3u8'
# A whole segment ends within a frame of its window (measured 6.000000 s); a stall leaves it seconds short
# (measured 2.833333 s).
SHORT_SECONDS = .5
# A segment this close to the producer arrives within a retry or two of the receiver (~10.5 s each);
# a farther one is quicker to restart at.
REACH = 3
# Held below the receiver's ~45 s give-up, measured from the first request for that segment.
HOLD_SECONDS = 40
# The receiver retries every ~10.5 s; a request after this long a pause starts a fresh hold.
RETRY_GAP_SECONDS = 15
# A retry means the receiver dropped its earlier request, so only this many waits per segment are kept.
WAITS_PER_SEGMENT = 2
SUSPEND_AHEAD, RESUME_AHEAD = 60, 45
# Runs in a row that may stop without a new segment before the session gives up, and the pause before each retry.
RETRIES, BACKOFF_SECONDS = 3, 2
# A run that stops this close to the listed end may have met the source's real end; the probed duration can run long.
END_SLACK = 2
# FFmpeg's -rw_timeout. A source that sends nothing for this long makes FFmpeg exit 0, as at the real end.
READ_TIMEOUT_SECONDS = 15
# So a run that exits sooner than this after its previous segment did not stall (measured: EOF under 5 s, stall ~45 s).
STALL_SECONDS = READ_TIMEOUT_SECONDS - 5
# A stalled run finalizes its short last segment 6-26 ms before FFmpeg exits (measured), so a running run's
# newest segment is served only once it is this old; a healthy run's next segment takes 0.25-5.5 s.
FRESH_SECONDS = 1


@dataclass(frozen=True)
class VodLayout:
    duration: float
    subtitles: bool = False

    @property
    def count(self):
        return max(1, math.ceil((self.duration - TAIL_SECONDS) / SEGMENT_SECONDS))

    def start(self, index):
        return index * SEGMENT_SECONDS

    def length(self, index):
        return self.duration - self.start(index) if index == self.count - 1 else SEGMENT_SECONDS

    def index_at(self, seconds):
        return min(self.count - 1, max(0, int(seconds // SEGMENT_SECONDS)))

    def window(self, index):
        start = self.start(index)
        return round(start * 1000), round((start + self.length(index)) * 1000)

    @staticmethod
    def segment_name(index):
        return f'segment-{index:04d}.ts'

    @staticmethod
    def cue_name(index):
        return f'video{index}.vtt'

    def parse(self, name):
        segment = SEGMENT_NAME.fullmatch(name)
        if segment and int(segment[1]) < self.count and name == self.segment_name(int(segment[1])):
            return 'segment', int(segment[1])
        cue = CUE_NAME.fullmatch(name)
        if cue and self.subtitles and int(cue[1]) < self.count:
            return 'cue', int(cue[1])
        return None

    def media_playlist(self):
        return self._playlist(self.segment_name, '#EXT-X-INDEPENDENT-SEGMENTS\n')

    def subtitle_playlist(self):
        return self._playlist(self.cue_name, '')

    def _playlist(self, name, tags):
        return (f'#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:{SEGMENT_SECONDS}\n#EXT-X-MEDIA-SEQUENCE:0\n'
                f'#EXT-X-PLAYLIST-TYPE:VOD\n{tags}'
                + ''.join(f'#EXTINF:{self.length(i):.6f},\n{name(i)}\n' for i in range(self.count))
                + '#EXT-X-ENDLIST\n')


class Run(NamedTuple):
    start: int
    limit: int
    position: int
    state: str  # running, stopped (no FFmpeg; asking again is fine), backoff, or exhausted (retries spent)
    end: int  # the first index the source has no media for


# Who may replace the run when a segment needs a restart, given whether it is running and whether
# another waiting segment request comes first. The newest explicit demand decides: a new request or a seek
# always; a held request only revives a run that stopped, and only the newest one; the playhead
# heuristic never moves the producer away from a waiting request. Receivers fetch subtitle windows
# ahead of the video, so a cue never moves it at all. A request restarts the run at the earliest segment
# still awaited since the last seek, when a run there reaches it too, so one ahead never starves one behind
# it; one farther ahead is a seek from another sender and wins.
MAY_RESTART = {
    'arrival': lambda running, yields: True,
    'held': lambda running, yields: not running and not yields,
    'cover': lambda running, yields: not yields,
    'cue': lambda running, yields: False,
}


def segment_action(index, complete, run, caller='arrival', yields=False, reach=REACH):
    """serve, end (past the source), missing (retries spent), hold (the running producer reaches it
    soon), restart there, or wait (backing off, or not this caller's call)."""
    if complete:
        return 'serve'
    if index >= run.end:
        return 'end'
    if run.state == 'exhausted':
        return 'missing'
    if run.state == 'running' and run.start <= index < run.limit and index <= run.position + reach:
        return 'hold'
    if run.state == 'backoff' or not MAY_RESTART[caller](run.state == 'running', yields):
        return 'wait'
    return 'restart'


def exit_outcome(start, limit, position, count, short, quiet, stall_seconds=STALL_SECONDS):
    """How a run that exited by itself ended: complete, end (the source's real end), or stalled.
    short says its last segment came out shorter than its window, as a stall finalizes the one it was
    writing, so even a run that reached its bound may have left it short. quiet is how long it ran after
    its previous segment (or its launch) until it exited."""
    if position == limit and not short:
        return 'complete'
    if limit == count and position >= count - END_SLACK and quiet < stall_seconds:
        return 'end'
    return 'stalled'


class ProducerState(NamedTuple):
    pid: int | None
    alive: bool
    suspended: bool
    returncode: int | None
    failed: bool
    end: int


class Producer:
    """The one owner of a session's FFmpeg: HTTP holds and the bridge worker both go through its lock.

    A run starts at the first missing segment and stops before the next one already on disk, so a
    completed segment is never rewritten (FFmpeg writes .vtt files in place, not through temp_file).
    """
    def __init__(self, directory, layout, command, hold_seconds=HOLD_SECONDS, poll_seconds=.1,
                 retries=RETRIES, backoff_seconds=BACKOFF_SECONDS, stall_seconds=STALL_SECONDS,
                 fresh_seconds=FRESH_SECONDS):
        self.directory, self.layout, self.command = directory, layout, command
        self.hold_seconds, self.poll_seconds, self.fresh_seconds = hold_seconds, poll_seconds, fresh_seconds
        self.retries, self.backoff_seconds, self.stall_seconds = retries, backoff_seconds, stall_seconds
        self.launched_at = time.time()  # wall clock, to compare with segment mtimes
        self.failures, self.retry_at, self.end, self.settled = 0, 0, layout.count, True
        self.lock = threading.Lock()
        self.process = None
        self.start = self.limit = self.position = 0
        self.suspended = self.closed = False
        self.holds = {}  # arrival number -> (index, cue), for every request held right now
        self.arrivals = self.seek_arrival = 0  # holds that arrived before the last seek were left behind by it
        self.first_seen = {}  # (index, cue) -> when the receiver first asked, across its retries

    def complete(self, index):
        try:
            return stat.S_ISREG(os.lstat(self.directory / self.layout.segment_name(index)).st_mode)
        except OSError:
            return False

    def completed(self):
        try:
            names = os.listdir(self.directory)
        except OSError:
            return set()
        return {parsed[1] for parsed in map(self.layout.parse, names) if parsed and parsed[0] == 'segment'}

    def _run(self):
        code = self.process.poll() if self.process else None
        while self.position < self.limit and self.complete(self.position):
            self.position += 1
        if self.position > self.end:
            self.end = self.layout.count
        if self.process and code is not None and not self.settled:
            self._settle()
        state = ('running' if self.process and code is None else 'exhausted' if self.failures >= self.retries
                 else 'backoff' if time.monotonic() < self.retry_at else 'stopped')
        return Run(self.start, self.limit, self.position, state, self.end)

    def _settle(self):
        """Judge a run that exited by itself, once: complete, the source's end, or a failure to retry."""
        self.settled = True
        try:
            since = (os.stat(self.directory / self.layout.segment_name(self.position - 2)).st_mtime
                     if self.position - 2 >= self.start else self.launched_at)
        except OSError:
            since = self.launched_at
        short = self.position == self.start or self._short(self.position - 1)
        outcome = exit_outcome(self.start, self.limit, self.position, self.layout.count, short, time.time() - since,
                               self.stall_seconds)
        if outcome == 'complete':
            self.failures = 0
        elif outcome == 'end':
            self.end, self.failures = self.position, 0
        else:
            # A stall makes FFmpeg exit (even with 0) and finalize the segment it was writing, short.
            if self.position > self.start:
                self.position -= 1
                (self.directory / self.layout.segment_name(self.position)).unlink(missing_ok=True)
            self.failures = 0 if self.position > self.start else self.failures + 1
            self.retry_at = time.monotonic() + self.backoff_seconds

    def _short(self, index):
        try:
            text = (self.directory / PLAYLIST_NAME).read_text()
        except OSError:
            return True
        name = re.escape(self.layout.segment_name(index))
        lengths = re.findall(rf'#EXTINF:([\d.]+),\n{name}\n', text)
        return not lengths or float(lengths[-1]) < self.layout.length(index) - SHORT_SECONDS

    def _first_missing(self, index, until):
        return next((i for i in range(index, until) if not self.complete(i)), None)

    def _restart(self, index):
        self._kill()
        limit = next((i for i in range(index + 1, self.layout.count) if self.complete(i)), self.layout.count)
        for partial in self.directory.glob('*.tmp'):
            partial.unlink(missing_ok=True)
        try:
            self.process = subprocess.Popen(self.command(index, limit), stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise MediaError('No se pudo iniciar FFmpeg.', 500, 'producer_failed') from None
        self.launched_at = time.time()
        self.start, self.limit, self.position, self.settled = index, limit, index, False
        self.suspended = False
        self.first_seen.clear()

    def _kill(self):
        # SIGKILL, not SIGTERM: a terminated FFmpeg drains its input and finalizes a short segment.
        if self.process and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass  # Its message embeds the arguments, which may hold the source URL.
        self.process = None
        self.suspended = False

    def _resume(self):
        if self.suspended and self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGCONT)
        self.suspended = False

    def cover(self, index, horizon=None):
        """Make sure the first gap at or after index is being produced, unless a held request needs the producer."""
        with self.lock:
            if self.closed:
                return
            until = self.layout.count if horizon is None else min(
                self.layout.count, self.layout.index_at(self.layout.start(index) + horizon) + 1)
            run = self._run()
            need = self._first_missing(index, until)
            waiting = any(not cue for _, cue in self.holds.values())
            if need is not None and segment_action(need, False, run, 'cover', waiting) == 'restart':
                self._restart(need)

    def seek(self, index):
        """An explicit jump: produce from index now unless it is on disk or coming soon."""
        with self.lock:
            if self.closed:
                return
            self.seek_arrival = self.arrivals
            run = self._run()
            if segment_action(index, self.complete(index), run) == 'restart':
                self._restart(index)

    def request(self, index, extra=(), cue=False):
        """Hold an HTTP request until segment index is on disk; wait for extra only while they are coming.

        Answers serve, end (the source has no media there) or missing. A cue request only waits for what
        the running producer reaches; it never restarts it."""
        caller, again = ('cue', 'cue') if cue else ('arrival', 'held')
        with self.lock:
            if self.closed:
                return 'missing'
            now = time.monotonic()
            seen = self.first_seen.get((index, cue))
            if seen is None or now - seen > self.hold_seconds + RETRY_GAP_SECONDS:
                seen = self.first_seen[index, cue] = now
            deadline = seen + self.hold_seconds
            same = [other for other, held in self.holds.items() if held == (index, cue)]
            for abandoned in same[:len(same) + 1 - WAITS_PER_SEGMENT]:
                del self.holds[abandoned]
            self.arrivals += 1
            ticket = self.arrivals
            self.holds[ticket] = index, cue
        try:
            while True:
                with self.lock:
                    outcome = self._answer(index, extra, ticket, caller, deadline)
                    if outcome is None:
                        self._resume()
                if outcome:
                    return outcome
                caller = again
                time.sleep(self.poll_seconds)
        finally:
            with self.lock:
                self.holds.pop(ticket, None)

    def _answer(self, index, extra, ticket, caller, deadline):
        if self.closed or ticket not in self.holds:
            return 'missing'
        run = self._run()
        newer = any(other > ticket and not cue for other, (_, cue) in self.holds.items())
        action = segment_action(index, self._servable(index, run), run, caller, newer)
        expired = time.monotonic() >= deadline
        if action == 'serve' and (expired or not self._coming(extra, run)):
            self.first_seen.pop((index, caller == 'cue'), None)
            return 'serve'
        if action in ('end', 'missing'):
            return action
        if expired or caller == 'cue' and action == 'wait':
            return 'missing'
        if action == 'restart':
            target = min([index] + [i for other, (i, cue) in self.holds.items()
                                    if not cue and other > self.seek_arrival and index <= i + 1 + REACH])
            if target != index and segment_action(target, self._servable(target, run), run, caller, newer) != 'restart':
                return None
            try:
                self._restart(target)
            except MediaError:
                return 'missing'
        return None

    def _servable(self, index, run):
        """On disk, and not a running run's newest segment so fresh it may be the short one a stall leaves."""
        complete = self.complete(index)
        if not complete or run.state != 'running' or not run.start <= index == run.position - 1:
            return complete
        try:
            return time.time() - os.lstat(self.directory / self.layout.segment_name(index)).st_mtime >= self.fresh_seconds
        except OSError:
            return False

    def _coming(self, indices, run):
        return [j for j in indices if not self.complete(j) and run.state == 'running' and run.start <= j < run.limit]

    def throttle(self, playhead):
        """Pause FFmpeg once it is a minute ahead of the TV; never while a request waits on it."""
        with self.lock:
            if self.closed or not self.process or self.process.poll() is not None:
                return
            ahead = self.layout.start(self._run().position) - playhead
            if not self.suspended and not self.holds and ahead > SUSPEND_AHEAD:
                self.process.send_signal(signal.SIGSTOP)
                self.suspended = True
            elif self.suspended and (self.holds or ahead < RESUME_AHEAD):
                self._resume()

    def snapshot(self):
        with self.lock:
            run = self._run()
            return ProducerState(self.process.pid if self.process else None, run.state == 'running',
                                 self.suspended, self.process.poll() if self.process else None,
                                 run.state == 'exhausted', run.end)

    def close(self):
        with self.lock:
            self.closed = True
            self._kill()
