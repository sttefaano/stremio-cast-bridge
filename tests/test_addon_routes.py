import io
import json
import tempfile
import threading
import time
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from addons import StremioAddon
from bridge import Bridge, ControlHandler, arguments
from media import Analysis, SetupCatalogue
from addon_fixtures import FakeAddon, SOURCE, offer, ready, wait_for


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.quit = threading.Event()
        self.bridge.state_lock = threading.Lock()
        self.bridge.active_plan = None
        self.addon = FakeAddon()
        self.bridge.catalogue = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(self.folder.name), self.addon)
        self.addCleanup(self.bridge.catalogue.close)
        self.bridge.catalogue.request(dict(SOURCE))
        self.catalogue = wait_for(lambda: self.bridge.catalogue.snapshot()['source'].get('catalogue'))
        wait_for(lambda: self.bridge.catalogue.snapshot()['source']['catalogue']['addon']['state'] == 'ready')

    def post(self, path, data, **headers):
        body = json.dumps(data).encode()
        handler = ControlHandler.__new__(ControlHandler)
        handler.server = SimpleNamespace(server_port=18777, token='secret', bridge=self.bridge)
        handler.headers = Message()
        values = {'Host': '127.0.0.1:18777', 'Origin': 'http://127.0.0.1:18777', 'X-Bridge-Token': 'secret',
                  'Content-Type': 'application/json', 'Content-Length': str(len(body))} | headers
        for key, value in values.items():
            if value is not None:
                handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        handler.path = path
        handler.reply = Mock()
        handler.do_POST()
        return handler.reply.call_args.args

    def ids(self, **extra):
        return dict(source_id='source', catalogue_id=self.catalogue['id'], **extra)

    def test_lookup_offers_and_fetch_round_trip_over_http(self):
        code, body = self.post('/api/subtitle_lookup', self.ids(hint='tt0000042 Other Show 2020'))
        self.assertEqual((code, body['catalogue']['addon']['state']), (202, 'loading'))
        wait_for(lambda: self.addon.list_calls[-1][1] == 'tt0000042 Other Show 2020')
        wait_for(lambda: self.bridge.catalogue.snapshot()['source']['catalogue']['addon']['state'] == 'ready')
        code, listing = self.post('/api/subtitle_offers', self.ids())
        self.assertEqual((code, [o['id'] for o in listing['offers']]), (200, ['offer-1', 'offer-2']))
        code, fetched = self.post('/api/subtitle_fetch', self.ids(offer_id='offer-2'))
        self.assertEqual((code, fetched['entry']['kind'], fetched['entry']['label']), (201, 'addon', 'Release 2'))
        self.assertEqual(fetched['catalogue']['entries'], [fetched['entry']])

    def test_a_null_or_blank_hint_means_automatic_matching(self):
        for hint in (None, '   '):
            calls = len(self.addon.list_calls)
            self.post('/api/subtitle_lookup', self.ids(hint=hint))
            wait_for(lambda: len(self.addon.list_calls) > calls)
            self.assertIsNone(self.addon.list_calls[-1][1])

    def test_request_shapes_are_exact_and_hints_are_bounded(self):
        bad = [('/api/subtitle_lookup', self.ids()), ('/api/subtitle_lookup', self.ids(hint=7)),
               ('/api/subtitle_lookup', self.ids(hint='x' * 201)), ('/api/subtitle_lookup', self.ids(hint='a\nb')),
               ('/api/subtitle_lookup', self.ids(hint='a\x00')), ('/api/subtitle_lookup', self.ids(hint=None, extra=1)),
               ('/api/subtitle_offers', self.ids(hint=None)), ('/api/subtitle_offers', dict(source_id='source')),
               ('/api/subtitle_offers', dict(source_id=1, catalogue_id=self.catalogue['id'])),
               ('/api/subtitle_fetch', self.ids()), ('/api/subtitle_fetch', self.ids(offer_id=3)),
               ('/api/subtitle_fetch', self.ids(offer_id='offer-1', extra='x'))]
        for path, data in bad:
            with self.subTest(path=path, data=data):
                code, body = self.post(path, data)
                self.assertEqual((code, body['code']), (400, 'invalid_request'))
        self.assertEqual(len(self.addon.list_calls), 1)
        self.assertEqual(self.addon.fetch_calls, [])
        self.assertEqual(self.post('/api/subtitle_lookup', self.ids(hint='x' * 200))[0], 202)

    def test_body_limit_stays_small_for_the_new_routes(self):
        for path, data in (('/api/subtitle_lookup', self.ids(hint='x' * 5000)), ('/api/subtitle_offers', self.ids(pad='x' * 5000)),
                           ('/api/subtitle_fetch', self.ids(offer_id='x' * 5000))):
            with self.subTest(path=path):
                code, body = self.post(path, data)
                self.assertEqual((code, body['code']), (413, 'body_limit'))

    def test_routes_require_origin_token_and_host_like_every_other_post(self):
        for headers in ({'Origin': 'http://evil.test'}, {'X-Bridge-Token': 'wrong'}, {'Host': 'localhost:18777'}, {'Origin': None}):
            for path, data in (('/api/subtitle_lookup', self.ids(hint=None)), ('/api/subtitle_offers', self.ids()),
                               ('/api/subtitle_fetch', self.ids(offer_id='offer-1'))):
                with self.subTest(path=path, headers=headers):
                    self.assertEqual(self.post(path, data, **headers)[0], 403)
        self.assertEqual((len(self.addon.list_calls), self.addon.fetch_calls), (1, []))

    def test_stale_identities_surface_as_conflicts_with_a_code(self):
        code, body = self.post('/api/subtitle_offers', dict(source_id='source', catalogue_id='gone'))
        self.assertEqual((code, body['code']), (409, 'stale_catalogue'))
        code, body = self.post('/api/subtitle_fetch', self.ids(offer_id='gone'))
        self.assertEqual((code, body['code']), (409, 'stale_offer'))

    def test_a_download_failure_is_a_readable_error_without_upstream_text(self):
        from addons import AddonError
        def failing(offer, cancelled):
            raise AddonError('offline')
        self.addon.fetch = failing
        code, body = self.post('/api/subtitle_fetch', self.ids(offer_id='offer-1'))
        self.assertEqual((code, body['code']), (502, 'addon_unavailable'))
        self.assertNotIn('strem.io', json.dumps(body))

    def test_the_active_plans_catalogue_stays_addressable_after_a_refresh(self):
        old_id = self.catalogue['id']
        self.bridge.catalogue.request(dict(SOURCE), refresh=True)
        wait_for(lambda: self.bridge.catalogue.snapshot()['source'].get('catalogue', {}).get('id') not in (None, old_id))
        wait_for(lambda: self.bridge.catalogue.snapshot()['source']['catalogue']['addon']['state'] == 'ready')
        request = dict(source_id='source', catalogue_id=old_id)
        self.assertEqual(self.post('/api/subtitle_offers', request)[0], 409)
        self.assertEqual(self.post('/api/subtitle_lookup', dict(request, hint=None))[0], 409)
        self.assertEqual(self.post('/api/subtitle_fetch', dict(request, offer_id='offer-1'))[0], 409)
        self.bridge.active_plan = SimpleNamespace(catalogue=SimpleNamespace(id=old_id))
        self.assertEqual(self.post('/api/subtitle_offers', request)[0], 200)
        self.assertEqual(self.post('/api/subtitle_fetch', dict(request, offer_id='offer-1'))[0], 201)
        self.assertEqual(self.post('/api/subtitle_lookup', dict(request, hint=None))[0], 202)

    def test_a_closing_bridge_refuses_the_routes(self):
        self.bridge.quit.set()
        for path, data in (('/api/subtitle_lookup', self.ids(hint=None)), ('/api/subtitle_offers', self.ids()),
                           ('/api/subtitle_fetch', self.ids(offer_id='offer-1'))):
            self.assertEqual(self.post(path, data)[1]['code'], 'shutdown')


class WiringTest(unittest.TestCase):
    def test_stremio_lookups_are_on_by_default_and_the_flag_turns_them_off(self):
        self.assertFalse(arguments([]).no_stremio_subtitles)
        self.assertTrue(arguments(['--no-stremio-subtitles']).no_stremio_subtitles)
        for argv, addon in (([], StremioAddon), (['--no-stremio-subtitles'], None)):
            with self.subTest(argv=argv), patch('bridge.threading.Thread'), patch('bridge.Path.mkdir'), \
                 patch('socket.socket', side_effect=AssertionError('network forbidden')):
                bridge = Bridge(arguments(argv))
                self.assertIs(type(bridge.catalogue.addon), type(addon) if addon is None else addon)
                self.assertEqual(bridge.catalogue.looker is None, addon is None)


class DiscoveryTest(unittest.TestCase):
    NAME = 'Mobland 2025 S01 1080p BluRay HEVC x265 5.1 BONE'
    FILE = 'Mobland 2025 S01E07 1080p BluRay HEVC x265 5.1 BONE.mkv'

    def discovered(self, name=NAME, file=FILE):
        stats = {'a' * 40: {'infoHash': 'a' * 40, 'name': name, 'files': [{'name': f'{name}/{file}', 'length': 10}]}}
        response = Mock()
        response.__enter__ = lambda *_: response
        response.__exit__ = lambda *_: False
        response.read.return_value = json.dumps(stats).encode()
        bridge = Bridge.__new__(Bridge)
        bridge.args = SimpleNamespace(source_file=None)
        bridge.quit, bridge.source_lock = threading.Event(), threading.Lock()
        bridge.sources, bridge.source_snapshot = [], dict(source_discovery='idle', source_error=None, sources=[], guides={})
        bridge.addon, bridge.added_sources = None, {}
        with patch('bridge.urlopen', return_value=response):
            bridge.discover()
        return bridge

    def test_the_torrent_name_is_kept_privately_for_matching_and_never_published(self):
        bridge = self.discovered()
        source = bridge.sources[0]
        self.assertEqual((source['release'], source['filename']), (self.NAME, self.FILE))
        public = bridge.source_snapshot['sources'][0]
        self.assertEqual(public['filename'], self.FILE)
        self.assertNotIn('release', public)
        self.assertNotIn('url', public)
        self.assertNotIn(self.NAME, json.dumps(bridge.source_snapshot['sources']).replace(self.FILE, ''))

    def test_a_long_torrent_name_is_clipped(self):
        self.assertEqual(len(self.discovered('n' * 500, 'a.mkv').sources[0]['release']), 180)


class StatusLeakTest(unittest.TestCase):
    def test_status_after_lookup_and_fetch_exposes_the_summary_but_no_private_data(self):
        from test_bridge import RestartPolicyTest
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bridge = RestartPolicyTest().fixture(root)
            addon = FakeAddon(lambda *_: ready(offer(1)))
            bridge.catalogue = store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), root / 'private', addon)
            try:
                source = dict(SOURCE, filename='MobLand.S01E07.mkv')
                store.request(source)
                catalogue = wait_for(lambda: store.snapshot()['source'].get('catalogue'))
                wait_for(lambda: store.snapshot()['source']['catalogue']['addon']['state'] == 'ready')
                result = store.fetch('source', catalogue['id'], 'offer-1')
                plan = store.resolve('source', catalogue['id'], result['entry']['id'], 0, True)
                status = json.dumps(bridge.status())
                self.assertIn('"state": "ready"', status)
                self.assertIn('MobLand (2025) \\u00b7 T1 E7', json.dumps(bridge.status(), ensure_ascii=True))
                for private in ('strem.io', 'PRIVATE-', 'PRIVATE-TORRENT-NAME', str(plan.subtitle.path), plan.subtitle.path.name,
                                '127.0.0.1:11470', '"offers"', '"alternatives"'):
                    self.assertNotIn(private, status)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()


class EpisodeTorrentsTest(unittest.TestCase):
    SHOW_FILE = 'mobland.s02e01.1080p.web.h264-poke[EZTVx.to].mkv'
    GUIDE = dict(state='ready', title='MobLand', imdb='tt31510819', episodes=[dict(season=2, number=2, name='Song 2', released=None)])

    def bridge(self):
        from addons import TorrentStream
        loaded = 'b' * 40
        streams = [TorrentStream('st-weak', 'c' * 40, 0, 'MobLand.S02E02.1080p.web.h264-poke.mkv', 6, '3 GB', '1080p', 'poke'),
                   TorrentStream('st-4k', 'd' * 40, 3, 'MobLand.S02E02.2160p.DV.mkv', 900, '9 GB', '2160p', None, ('udp://t.example:1337',)),
                   TorrentStream('st-good', 'e' * 40, 1, 'MobLand.S02E02.1080p.AMZN.mkv', 1396, '3.2 GB', '1080p', 'playweb')]
        addon = Mock()
        addon.streams.return_value = streams
        bridge = Bridge.__new__(Bridge)
        bridge.args = SimpleNamespace(source_file=None)
        bridge.quit, bridge.source_lock = threading.Event(), threading.Lock()
        bridge.addon, bridge.torrentio, bridge.streams, bridge.added_sources = addon, 'https://torrentio.strem.fun/cfg', {}, {}
        bridge.sources = [dict(url=f'http://127.0.0.1:11470/{loaded}/0', id='s2e1', filename=self.SHOW_FILE,
                               episode=dict(show='Mobland', season=2, number=1))]
        bridge.source_snapshot = dict(source_discovery='ready', source_error=None, sources=[], guides={'mobland': self.GUIDE})
        return bridge, addon

    def test_versions_rank_by_the_loaded_resolution_then_healthy_seeders_and_never_leak_the_hash(self):
        bridge, addon = self.bridge()
        body = bridge.episode_streams(dict(show='mobland', season=2, number=2))
        addon.streams.assert_called_once_with('https://torrentio.strem.fun/cfg', 'tt31510819', 2, 2, bridge.quit)
        self.assertEqual([s['id'] for s in body['streams']], ['st-good', 'st-weak', 'st-4k'])
        self.assertEqual(body['streams'][0], dict(id='st-good', filename='MobLand.S02E02.1080p.AMZN.mkv', seeders=1396, size='3.2 GB', resolution='1080p'))
        self.assertNotIn('e' * 40, json.dumps(body))

    def test_an_episode_outside_the_guide_is_refused(self):
        bridge, addon = self.bridge()
        with self.assertRaises(Exception) as caught:
            bridge.episode_streams(dict(show='mobland', season=9, number=1))
        self.assertEqual(caught.exception.code, 'unknown_episode')
        addon.streams.assert_not_called()

    def test_a_used_version_becomes_a_local_engine_source_that_survives_rediscovery(self):
        bridge, _ = self.bridge()
        bridge.episode_streams(dict(show='mobland', season=2, number=2))
        with patch('bridge.urlopen') as engine:
            source = bridge.use_stream(dict(stream_id='st-4k'))['source']
            for _ in range(50):
                if engine.called:
                    break
                time.sleep(.01)
        self.assertEqual(source['title'], 'MobLand · T2 E2')
        self.assertEqual(source['seeders'], 900)
        self.assertNotIn('url', source)
        request = engine.call_args[0][0]
        self.assertEqual(request.full_url, f'http://127.0.0.1:11470/{"d" * 40}/create')
        self.assertEqual(json.loads(request.data)['peerSearch']['sources'], ['tracker:udp://t.example:1337', f'dht:{"d" * 40}'])
        self.assertIn(source['id'], [s['id'] for s in bridge.source_snapshot['sources']])

        stats = {'d' * 40: {'infoHash': 'd' * 40, 'name': 'pack', 'peers': 12, 'files': [{'name': f'x{i}.mkv'} for i in range(4)]}}
        response = Mock()
        response.__enter__ = lambda *_: response
        response.__exit__ = lambda *_: False
        response.read.return_value = json.dumps(stats).encode()
        with patch('bridge.urlopen', return_value=response):
            bridge.discover()
        again = next(s for s in bridge.source_snapshot['sources'] if s['id'] == source['id'])
        self.assertEqual((again['title'], again['seeders'], again['peers']), ('MobLand · T2 E2', 900, 12))
        self.assertEqual(len([s for s in bridge.source_snapshot['sources'] if s['id'] == source['id']]), 1)

    def test_an_unknown_version_is_refused(self):
        bridge, _ = self.bridge()
        with self.assertRaises(Exception) as caught:
            bridge.use_stream(dict(stream_id='nope'))
        self.assertEqual(caught.exception.code, 'unknown_stream')

    def test_a_fresh_torrent_is_probed_only_once_the_engine_lists_its_files(self):
        bridge, _ = self.bridge()
        fresh = f'http://127.0.0.1:11470/{"d" * 40}/3'
        bridge.added_sources[fresh] = dict(url=fresh)
        replies = iter([b'null', json.dumps({'files': []}).encode(), json.dumps({'files': [{'name': 'a.mkv'}]}).encode()])

        def engine(url, timeout):
            response = Mock()
            response.__enter__ = lambda *_: response
            response.__exit__ = lambda *_: False
            response.read.return_value = next(replies)
            return response

        waits = Mock()
        waits.is_set.return_value = False
        with patch('bridge.urlopen', side_effect=engine) as asked, patch('bridge.probe', return_value='analysis') as probed:
            self.assertEqual(bridge._probe(fresh, waits), 'analysis')
        self.assertEqual(asked.call_count, 3, 'polled until the metadata arrived')
        self.assertEqual(waits.wait.call_count, 2)
        probed.assert_called_once_with(fresh, waits)

        with patch('bridge.urlopen') as asked, patch('bridge.probe', return_value='analysis'):
            bridge._probe(bridge.sources[0]['url'], waits)
        asked.assert_not_called()
