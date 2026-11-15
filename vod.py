"""The receiver sees each playback as VOD: every segment is listed up front at its absolute movie time."""
from dataclasses import dataclass
import math
import os
import re
import signal
import subprocess
import threading
import time
from typing import NamedTuple

SEGMENT_SECONDS = 6
# A remainder this short is audio priming without video frames; FFmpeg writes no segment for it.
TAIL_SECONDS = 0.25
SEGMENT_NAME = re.compile(r'segment-(\d{4,})\.ts')
CUE_NAME = re.compile(r'video(0|[1-9]\d*)\.vtt')
# A held segment this close to the producer arrives well inside the receiver's ~10.5 s retry.
REACH = 3
# Held below the receiver's ~45 s give-up, measured from the first request for that segment.
HOLD_SECONDS = 40
# The receiver retries every ~10.5 s; a request after this long a pause starts a fresh hold.
RETRY_GAP_SECONDS = 15
SUSPEND_AHEAD, RESUME_AHEAD = 60, 45


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
    state: str


def segment_action(index, complete, run, reach=REACH):
    """serve, hold (the running producer reaches it soon), restart there, or missing (it never will)."""
    if complete:
        return 'serve'
    covered = run.start <= index < run.limit
    if run.state == 'failed' or covered and run.state == 'finished':
        return 'missing'
    if covered and run.state == 'running' and index <= run.position + reach:
        return 'hold'
    return 'restart'


class ProducerState(NamedTuple):
    pid: int | None
    alive: bool
    suspended: bool
    returncode: int | None
    run: Run


class Producer:
    """The one owner of a session's FFmpeg: HTTP holds and the bridge worker both go through its lock.

    A run starts at the first missing segment and stops before the next one already on disk, so a
    completed segment is never rewritten (FFmpeg writes .vtt files in place, not through temp_file).
    """
    def __init__(self, directory, layout, command, hold_seconds=HOLD_SECONDS, poll_seconds=.1):
        self.directory, self.layout, self.command = directory, layout, command
        self.hold_seconds, self.poll_seconds = hold_seconds, poll_seconds
        self.lock = threading.Lock()
        self.process = None
        self.start = self.limit = self.position = 0
        self.suspended = self.closed = False
        self.held = 0
        self.first_seen = {}

    def complete(self, index):
        return os.path.isfile(self.directory / self.layout.segment_name(index))

    def completed(self):
        try:
            names = os.listdir(self.directory)
        except OSError:
            return set()
        return {parsed[1] for parsed in map(self.layout.parse, names) if parsed and parsed[0] == 'segment'}

    def _run(self):
        code = self.process.poll() if self.process else None
        state = 'idle' if not self.process else 'running' if code is None else 'finished' if code == 0 else 'failed'
        while self.position < self.limit and self.complete(self.position):
            self.position += 1
        return Run(self.start, self.limit, self.position, state)

    def _first_missing(self, index, until):
        return next((i for i in range(index, until) if not self.complete(i)), None)

    def _restart(self, index):
        self._kill()
        limit = next((i for i in range(index + 1, self.layout.count) if self.complete(i)), self.layout.count)
        for partial in self.directory.glob('*.tmp'):
            partial.unlink(missing_ok=True)
        self.process = subprocess.Popen(self.command(index, limit), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.start, self.limit, self.position = index, limit, index
        self.suspended = False
        self.first_seen.clear()

    def _kill(self):
        # SIGKILL, not SIGTERM: a terminated FFmpeg drains its input and finalizes a short segment.
        if self.process and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        self.suspended = False

    def _resume(self):
        if self.suspended and self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGCONT)
        self.suspended = False

    def cover(self, index, horizon=None):
        """Make sure the first gap at or after index is being produced."""
        with self.lock:
            if self.closed:
                return
            until = self.layout.count if horizon is None else min(
                self.layout.count, self.layout.index_at(self.layout.start(index) + horizon) + 1)
            need = self._first_missing(index, until)
            if need is not None and segment_action(need, False, self._run()) == 'restart':
                self._restart(need)

    def request(self, index, extra=()):
        """Hold an HTTP request until segment index is on disk; wait for extra only while they are coming."""
        with self.lock:
            if self.closed:
                return False
            run = self._run()
            action = segment_action(index, self.complete(index), run)
            if action == 'missing':
                return False
            if action == 'serve' and not self._coming(extra, run):
                return True
            if action == 'restart':
                self._restart(index)
            now = time.monotonic()
            seen = self.first_seen.get(index)
            if seen is None or now - seen > self.hold_seconds + RETRY_GAP_SECONDS:
                seen = self.first_seen[index] = now
            deadline = seen + self.hold_seconds
            self.held += 1
            self._resume()
        try:
            while True:
                with self.lock:
                    if self.closed:
                        return False
                    run = self._run()
                    action = segment_action(index, self.complete(index), run)
                    expired = time.monotonic() >= deadline
                    if action == 'serve':
                        if not self._coming(extra, run) or expired:
                            self.first_seen.pop(index, None)
                            return True
                    elif action != 'hold' or expired:
                        return False
                time.sleep(self.poll_seconds)
        finally:
            with self.lock:
                self.held -= 1

    def _coming(self, indices, run):
        return [j for j in indices if not self.complete(j) and run.state == 'running' and run.start <= j < run.limit]

    def throttle(self, playhead):
        """Pause FFmpeg once it is a minute ahead of the TV; never while a request waits on it."""
        with self.lock:
            if self.closed or not self.process or self.process.poll() is not None:
                return
            ahead = self.layout.start(self._run().position) - playhead
            if not self.suspended and not self.held and ahead > SUSPEND_AHEAD:
                self.process.send_signal(signal.SIGSTOP)
                self.suspended = True
            elif self.suspended and (self.held or ahead < RESUME_AHEAD):
                self._resume()

    def snapshot(self):
        with self.lock:
            run = self._run()
            return ProducerState(self.process.pid if self.process else None, run.state == 'running',
                                 self.suspended, self.process.poll() if self.process else None, run)

    def close(self):
        with self.lock:
            self.closed = True
            self._kill()
