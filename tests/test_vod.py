import unittest

from vod import VodLayout


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


if __name__ == '__main__':
    unittest.main()
