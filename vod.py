"""The receiver sees each playback as VOD: every segment is listed up front at its absolute movie time."""
from dataclasses import dataclass
import math
import re

SEGMENT_SECONDS = 6
# A remainder this short is audio priming without video frames; FFmpeg writes no segment for it.
TAIL_SECONDS = 0.25
SEGMENT_NAME = re.compile(r'segment-(\d{4,})\.ts')
CUE_NAME = re.compile(r'video(0|[1-9]\d*)\.vtt')


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
