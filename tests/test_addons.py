import io
import json
import tempfile
import re
import threading
import unittest
from itertools import count
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request

import addons
from addons import (AddonError, Candidate, Guess, Listing, MESSAGES, LANGUAGES, MetaId, Match, Offer,
                    StremioAddon, choose_meta, http_get, parse_offers, parse_release, subtitle_language)
from media import MediaError, normalize_subtitles

FIXTURES = Path(__file__).parent / 'fixtures'
PAYLOAD = json.loads((FIXTURES / 'opensubtitles-e07.json').read_text())
SOURCE = dict(filename='Mobland 2025 S01E07 1080p BluRay HEVC x265 5.1 BONE.mkv',
              release='Mobland 2025 S01 1080p BluRay HEVC x265 5.1 BONE')
CINEMETA_SEARCH = 'https://v3-cinemeta.strem.io/catalog/series/top/search=Mobland.json'
SUBTITLES = ('https://opensubtitles-v3.strem.io/subtitles/series/tt31510819:1:7/filename='
             + quote(SOURCE['filename'], safe='') + '.json')
METAS = {'metas': [dict(id='tt31510819', name='MobLand', releaseInfo='2025'),
                   dict(id='tt6046238', name='Molang', releaseInfo='2015-')]}


class FakeGet:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, *, cap, deadline, cancelled=None):
        self.calls.append(url)
        if url not in self.routes:
            raise AssertionError(f'unexpected request {url}')
        value = self.routes[url]
        if isinstance(value, Exception):
            raise value
        return value if isinstance(value, bytes) else json.dumps(value).encode()


class FakeResponse:
    def __init__(self, chunks, status=200):
        self.chunks, self.status = list(chunks), status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read1(self, size):
        return self.chunks.pop(0) if self.chunks else b''


class FakeOpener:
    def __init__(self, result):
        self.result, self.requests, self.timeouts = result, [], []

    def open(self, request, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def http_error(code, message):
    return HTTPError(CINEMETA_SEARCH, code, message, {}, io.BytesIO())


def meta(imdb, name, year):
    return dict(id=imdb, name=name, releaseInfo=str(year))


class ParseReleaseTest(unittest.TestCase):
    def test_real_file_name_yields_title_year_and_episode(self):
        self.assertEqual(parse_release(SOURCE['filename']), Guess('Mobland', 2025, 1, 7, None))

    def test_titleless_file_takes_title_and_year_from_the_torrent_name(self):
        self.assertEqual(parse_release('S01E07.mkv', SOURCE['release']), Guess('Mobland', 2025, 1, 7, None))

    def test_a_named_file_ignores_the_torrent_name(self):
        self.assertEqual(parse_release('Other Show S02E03.mkv', SOURCE['release']), Guess('Other Show', None, 2, 3, None))

    def test_imdb_id_wins_and_stays_out_of_the_title(self):
        guess = parse_release('tt31510819 MobLand 2025 S01E07')
        self.assertEqual(guess, Guess('MobLand', 2025, 1, 7, 'tt31510819'))
        self.assertEqual(parse_release('anything', 'x tt1234567 y').imdb, 'tt1234567')

    def test_cross_episode_notation_and_split_season_episode_tokens(self):
        self.assertEqual(parse_release('Show Name 1x07 720p'), Guess('Show Name', None, 1, 7, None))
        self.assertEqual(parse_release('Show.S01.E07.mkv'), Guess('Show', None, 1, 7, None))

    def test_movie_with_bracketed_year_and_a_title_that_is_a_year(self):
        self.assertEqual(parse_release('The Matrix (1999) [1080p].mkv'), Guess('The Matrix', 1999, None, None, None))
        self.assertEqual(parse_release('2012 (2009).mkv'), Guess('2012', 2009, None, None, None))

    def test_a_season_pack_name_is_not_an_episode(self):
        self.assertEqual(parse_release(SOURCE['release']), Guess('Mobland', 2025, None, None, None))

    def test_garbage_input_is_unidentified_instead_of_raising(self):
        self.assertEqual(parse_release(None), Guess())
        self.assertEqual(parse_release('1080p.mkv'), Guess())


class MetaIdTest(unittest.TestCase):
    def test_path_and_type_follow_the_episode(self):
        self.assertEqual(MetaId('tt31510819', 1, 7).path(), 'series/tt31510819:1:7')
        self.assertEqual(MetaId('tt31510819', 1, 7).type, 'series')
        self.assertEqual(MetaId('tt0133093').path(), 'movie/tt0133093')
        self.assertEqual(MetaId('tt0133093').type, 'movie')

    def test_illegal_combinations_cannot_be_built(self):
        for args in (('0133093',), ('tt0133093', 1), ('tt0133093', None, 2), ('tt0133093', -1, 2), ('tt/../x', None, None)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                MetaId(*args)


class ChooseMetaTest(unittest.TestCase):
    def test_unique_name_with_year_within_one_is_exact(self):
        match, alternatives = choose_meta(Guess('Mobland', 2025, 1, 7), METAS['metas'])
        self.assertEqual((match.meta, match.label, match.confidence),
                         (MetaId('tt31510819', 1, 7), 'MobLand (2025) · T1 E7', 'exact'))
        self.assertEqual([c.imdb for c in alternatives], ['tt6046238'])
        _, adjacent = choose_meta(Guess('Mobland', 2026, 1, 7), METAS['metas'])
        self.assertEqual(choose_meta(Guess('Mobland', 2026, 1, 7), METAS['metas'])[0].confidence, 'exact')
        self.assertEqual(len(adjacent), 1)

    def test_movie_labels_carry_no_episode(self):
        match, _ = choose_meta(Guess('The Matrix', 1999), [meta('tt0133093', 'The Matrix', 1999)])
        self.assertEqual((match.meta.path(), match.label), ('movie/tt0133093', 'The Matrix (1999)'))

    def test_names_fold_case_and_accents(self):
        match, _ = choose_meta(Guess('amelie', 2001), [meta('tt0211915', 'Amélie', 2001)])
        self.assertEqual(match.confidence, 'exact')

    def test_year_conflict_or_two_same_name_candidates_are_doubtful(self):
        far, _ = choose_meta(Guess('Mobland', 2019, 1, 7), METAS['metas'])
        self.assertEqual((far.meta.imdb, far.confidence), ('tt31510819', 'doubtful'))
        twins = [meta('tt0000001', 'Dune', 1984), meta('tt0000002', 'Dune', 2021)]
        unknown_year, alternatives = choose_meta(Guess('Dune'), twins)
        self.assertEqual((unknown_year.meta.imdb, unknown_year.confidence), ('tt0000001', 'doubtful'))
        self.assertEqual([c.imdb for c in alternatives], ['tt0000002'])

    def test_partial_name_is_doubtful_and_unrelated_results_are_only_alternatives(self):
        partial, _ = choose_meta(Guess('Crossroads'), [meta('tt0000003', 'The Crossroads', 2001)])
        self.assertEqual(partial.confidence, 'doubtful')
        metas = [meta(f'tt000000{n}', f'Unrelated {n}', 2000 + n) for n in range(1, 8)]
        none, alternatives = choose_meta(Guess('Mobland', 2025), metas)
        self.assertIsNone(none)
        self.assertEqual([c.imdb for c in alternatives], [m['id'] for m in metas[:4]])

    def test_alternatives_are_capped_at_four_and_exclude_the_match(self):
        metas = [meta('tt0000009', 'Mobland', 2025)] + [meta(f'tt000001{n}', f'Other {n}', 2000) for n in range(8)]
        match, alternatives = choose_meta(Guess('Mobland', 2025), metas)
        self.assertEqual(len(alternatives), 4)
        self.assertNotIn(match.meta.imdb, [c.imdb for c in alternatives])

    def test_malformed_entries_are_skipped(self):
        junk = [None, 'x', dict(id='nope', name='Mobland'), dict(id='tt31510819'), dict(id='tt31510819', name=7)]
        self.assertEqual(choose_meta(Guess('Mobland', 2025), junk), (None, ()))


class ParseOffersTest(unittest.TestCase):
    def offers(self, source=SOURCE['filename']):
        return parse_offers(PAYLOAD, source)

    def test_every_language_in_the_real_sample_has_a_table_entry(self):
        self.assertEqual({item['lang'] for item in PAYLOAD['subtitles']} - set(LANGUAGES), set())

    def test_languages_group_spl_spa_eng_first_then_alphabetically_by_spanish_name(self):
        order = []
        for offer in self.offers():
            if not order or order[-1] != offer.language:
                order.append(offer.language)
        self.assertEqual(len(order), len(set(order)))
        self.assertEqual(order[:3], ['spl', 'spa', 'eng'])
        names = [LANGUAGES[code][1] for code in order[3:]]
        fold = lambda name: addons.fold(name)
        self.assertEqual(names, sorted(names, key=fold))

    def test_duplicates_collapse_and_the_public_shape_hides_the_url(self):
        offers = self.offers()
        self.assertEqual(len(offers), 69)
        self.assertEqual(len({o.id for o in offers}), 69)
        for offer in offers:
            self.assertRegex(offer.id, r'^[0-9a-f]{24}$')
            self.assertEqual(set(offer.public()), {'id', 'language', 'language_name', 'label', 'note'})
            self.assertNotIn('strem.io', repr(offer))
            self.assertNotIn('strem.io', json.dumps(offer.public()))

    def test_ids_are_fresh_per_listing(self):
        self.assertFalse({o.id for o in self.offers()} & {o.id for o in self.offers()})

    def test_a_bluray_source_ranks_the_bluray_release_first_within_its_language(self):
        spanish = [o for o in self.offers() if o.language == 'spa']
        self.assertEqual(spanish[0].label, 'MobLand S01E07 1080p BluRay GANGSTA')
        web = 'MobLand S01E07 1080p WEB H264-SuccessfulCrab.mkv'
        english = [o for o in self.offers(web) if o.language == 'eng']
        self.assertEqual(english[0].label, 'MobLand S01E07 1080p WEB H264-SuccessfulCrab')

    def test_hearing_impaired_versions_are_flagged_and_listed_after_plain_ones(self):
        english = [o for o in self.offers() if o.language == 'eng']
        self.assertEqual([o.note for o in english], [None, None, None, 'para sordos', 'para sordos'])
        self.assertTrue(all('sdh' in o.label.lower() or o.label.endswith('Hi') for o in english if o.note))

    def test_same_release_group_is_noted_and_ranks_first(self):
        payload = dict(subtitles=[
            dict(lang='eng', url='https://subs5.strem.io/a', subtitleFileName='Show.S01E01.720p.WEB-GRPA.srt', releaseGroup='GRPA'),
            dict(lang='eng', url='https://subs5.strem.io/b', subtitleFileName='Show.S01E01.1080p.BluRay-BONE.srt', releaseGroup='BONE')])
        offers = parse_offers(payload, 'Show S01E01 1080p BluRay x265 BONE.mkv')
        self.assertEqual([(o.label, o.note) for o in offers],
                         [('Show S01E01 1080p BluRay-BONE', 'mismo origen'), ('Show S01E01 720p WEB-GRPA', None)])

    def test_hindi_dot_hi_is_not_mistaken_for_hearing_impaired(self):
        payload = dict(subtitles=[dict(lang='hin', url='https://subs5.strem.io/a', subtitleFileName='Movie.2020.hi.srt')])
        self.assertIsNone(parse_offers(payload, 'Movie 2020.mkv')[0].note)

    def test_only_https_strem_subtitle_hosts_survive_parsing(self):
        urls = ['http://subs5.strem.io/a', 'https://subs5.strem.io.evil.example/a', 'https://evil.example/subs5.strem.io',
                'https://user@subs5.strem.io/a', 'https://subs5.strem.io:444/a', 'https://xsubs5.strem.io/a',
                'https://subs5.strem.io/a b', 'ftp://subs5.strem.io/a', None, 7]
        payload = dict(subtitles=[dict(lang='eng', url=url, subtitleFileName=f'Movie.{n}.srt') for n, url in enumerate(urls)]
                       + [dict(lang='eng', url='https://subs12.strem.io/ok', subtitleFileName='Movie.ok.srt')])
        self.assertEqual([o.url for o in parse_offers(payload, 'Movie.mkv')], ['https://subs12.strem.io/ok'])

    def test_labels_are_stripped_of_control_and_format_characters(self):
        payload = dict(subtitles=[dict(lang='eng', url='https://subs5.strem.io/a', subtitleFileName='Mo\u202bvie\x07.srt')])
        self.assertEqual(parse_offers(payload, 'x.mkv')[0].label, 'Movie')

    def test_at_most_two_hundred_offers_are_kept(self):
        payload = dict(subtitles=[dict(lang='eng', url='https://subs5.strem.io/a', subtitleFileName=f'Movie.{n}.srt')
                                  for n in range(500)])
        self.assertEqual(len(parse_offers(payload, 'Movie.mkv')), 200)

    def test_unexpected_payload_shapes_are_a_bad_response(self):
        for payload in (None, [], {}, {'subtitles': 'x'}):
            with self.subTest(payload=payload), self.assertRaises(AddonError) as error:
                parse_offers(payload, 'x.mkv')
            self.assertEqual(error.exception.code, 'bad_response')

    def test_unknown_three_letter_codes_get_an_uppercase_name_and_themselves_as_hls_tag(self):
        payload = dict(subtitles=[dict(lang='xyz', url='https://subs5.strem.io/a', subtitleFileName='Movie.srt'),
                                  dict(lang='toolong', url='https://subs5.strem.io/b', subtitleFileName='Movie.b.srt')])
        offers = parse_offers(payload, 'Movie.mkv')
        self.assertEqual([(o.language, o.language_name) for o in offers], [('xyz', 'XYZ')])
        self.assertEqual(subtitle_language('xyz'), 'xyz')

    def test_stored_languages_never_use_non_iso_codes(self):
        self.assertEqual((subtitle_language('spl'), subtitle_language('pob'), subtitle_language('ger'),
                          subtitle_language('fre'), subtitle_language('eng')), ('spa', 'por', 'deu', 'fra', 'eng'))
        for code in LANGUAGES:
            self.assertRegex(subtitle_language(code), r'^[a-z]{3}$')
            self.assertNotIn(subtitle_language(code), ('spl', 'pob'))


class ListingTest(unittest.TestCase):
    def test_summary_carries_no_offers_and_public_adds_alternatives_and_offers(self):
        offer = Offer('abc', 'eng', 'Inglés', 'Label', None, 'https://subs5.strem.io/secret')
        listing = Listing('ready', 3, Match(MetaId('tt0133093'), 'The Matrix (1999)', 'exact'),
                          (Candidate('tt0000001', 'movie', 'Other', 2000),), (offer,))
        self.assertEqual(listing.summary(), dict(state='ready', revision=3, count=1, message=None,
                                                 match=dict(label='The Matrix (1999)', confidence='exact')))
        public = listing.public()
        self.assertEqual(public['alternatives'], [dict(id='tt0000001', title='Other', year=2000)])
        self.assertEqual(public['offers'], [offer.public()])
        self.assertNotIn('secret', json.dumps(public))

    def test_off_is_the_default_and_unknown_states_are_rejected(self):
        self.assertEqual(Listing().summary(), dict(state='off', revision=0, match=None, message=None, count=0))
        with self.assertRaises(ValueError):
            Listing('maybe')


class StremioAddonListTest(unittest.TestCase):
    def addon(self, **routes):
        self.get = FakeGet(routes)
        return StremioAddon(get=self.get)

    def test_identifies_the_film_then_lists_ranked_offers_with_two_requests(self):
        listing = self.addon(**{CINEMETA_SEARCH: METAS, SUBTITLES: PAYLOAD}).list(SOURCE, None, None)
        self.assertEqual(self.get.calls, [CINEMETA_SEARCH, SUBTITLES])
        self.assertEqual(listing.state, 'ready')
        self.assertEqual(listing.match.label, 'MobLand (2025) · T1 E7')
        self.assertEqual(listing.match.confidence, 'exact')
        self.assertEqual([c.title for c in listing.alternatives], ['Molang'])
        self.assertEqual(len(listing.offers), 69)

    def test_an_imdb_hint_skips_cinemeta_and_keeps_the_episode_of_the_file(self):
        listing = self.addon(**{SUBTITLES.replace('tt31510819', 'tt0000042'): PAYLOAD}).list(SOURCE, 'tt0000042 Other Show 2020', None)
        self.assertEqual(self.get.calls, [SUBTITLES.replace('tt31510819', 'tt0000042')])
        self.assertEqual((listing.match.label, listing.match.confidence), ('Other Show (2020) · T1 E7', 'manual'))
        self.assertEqual(listing.alternatives, ())

    def test_a_filename_imdb_id_is_exact_without_a_search(self):
        source = dict(filename='Mobland.tt31510819.S01E07.mkv', release='')
        url = ('https://opensubtitles-v3.strem.io/subtitles/series/tt31510819:1:7/filename='
               + quote(source['filename'], safe='') + '.json')
        listing = self.addon(**{url: PAYLOAD}).list(source, None, None)
        self.assertEqual((listing.match.confidence, listing.match.label), ('exact', 'Mobland · T1 E7'))

    def test_a_typed_title_searches_with_the_episode_inherited_from_the_file(self):
        search = 'https://v3-cinemeta.strem.io/catalog/series/top/search=Other%20Show.json'
        subtitles = SUBTITLES.replace('tt31510819', 'tt0000042')
        metas = dict(metas=[meta('tt0000042', 'Other Show', 2020)])
        listing = self.addon(**{search: metas, subtitles: dict(subtitles=[])}).list(SOURCE, 'Other Show 2020', None)
        self.assertEqual(listing.match.label, 'Other Show (2020) · T1 E7')
        self.assertEqual((listing.state, listing.offers), ('ready', ()))

    def test_a_movie_uses_the_movie_catalogue_and_path(self):
        source = dict(filename='The.Matrix.1999.1080p.BluRay.x264-GRP.mkv', release='')
        search = 'https://v3-cinemeta.strem.io/catalog/movie/top/search=The%20Matrix.json'
        url = ('https://opensubtitles-v3.strem.io/subtitles/movie/tt0133093/filename='
               + quote(source['filename'], safe='') + '.json')
        listing = self.addon(**{search: dict(metas=[meta('tt0133093', 'The Matrix', 1999)]), url: PAYLOAD}).list(source, None, None)
        self.assertEqual(listing.match.label, 'The Matrix (1999)')

    def test_an_unrecognised_file_is_unidentified_without_any_request(self):
        listing = self.addon().list(dict(filename='1080p.mkv'), None, None)
        self.assertEqual((listing.state, self.get.calls), ('unidentified', []))
        self.assertEqual(listing.message, addons.UNIDENTIFIED)

    def test_no_name_match_is_unidentified_and_offers_alternatives_to_pick(self):
        metas = dict(metas=[meta(f'tt000000{n}', f'Unrelated {n}', 2000 + n) for n in range(1, 4)])
        listing = self.addon(**{CINEMETA_SEARCH: metas}).list(SOURCE, None, None)
        self.assertEqual((listing.state, listing.match, len(listing.alternatives)), ('unidentified', None, 3))
        self.assertEqual(self.get.calls, [CINEMETA_SEARCH])

    def test_failures_surface_as_addon_errors_without_extra_requests(self):
        for failure, code in ((AddonError('busy'), 'busy'), (AddonError('offline'), 'offline'),
                              (b'not json', 'bad_response'), ({'metas': 'x'}, 'bad_response'), ([], 'bad_response')):
            with self.subTest(code=code, failure=failure), self.assertRaises(AddonError) as error:
                self.addon(**{CINEMETA_SEARCH: failure}).list(SOURCE, None, None)
            self.assertEqual(error.exception.code, code)
            self.assertEqual(self.get.calls, [CINEMETA_SEARCH])


class StremioAddonFetchTest(unittest.TestCase):
    URL = 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1961665695'

    def offer(self, url=None):
        return Offer('id', 'eng', 'Inglés', 'Label', None, url or self.URL)

    def test_downloads_through_the_local_engine_with_the_source_url_quoted(self):
        engine = 'http://127.0.0.1:11470/subtitles.vtt?from=' + quote(self.URL, safe='')
        get = FakeGet({engine: '\ufeffWEBVTT\n\n'.encode()})
        self.assertEqual(StremioAddon(get=get).fetch(self.offer(), None), '\ufeffWEBVTT\n\n')
        self.assertEqual(get.calls, [engine])

    def test_a_url_outside_the_subtitle_hosts_is_refused_before_any_request(self):
        get = FakeGet({})
        for url in ('https://evil.example/x', 'http://subs5.strem.io/x', 'https://subs5.strem.io@evil.example/x'):
            with self.subTest(url=url), self.assertRaises(AddonError) as error:
                StremioAddon(get=get).fetch(self.offer(url), None)
            self.assertEqual(error.exception.code, 'bad_response')
        self.assertEqual(get.calls, [])

    def test_invalid_utf8_is_a_bad_response(self):
        get = FakeGet({'http://127.0.0.1:11470/subtitles.vtt?from=' + quote(self.URL, safe=''): b'WEBVTT\n\n\xff\xfe'})
        with self.assertRaises(AddonError) as error:
            StremioAddon(get=get).fetch(self.offer(), None)
        self.assertEqual(error.exception.code, 'bad_response')


class HttpGetTest(unittest.TestCase):
    def get(self, url, result, **options):
        opener = FakeOpener(result)
        with patch('addons.OPENER', opener):
            try:
                return http_get(url, **dict(cap=1024, deadline=5, cancelled=None) | options), opener
            except AddonError as error:
                error.opener = opener
                raise

    def test_returns_the_body_and_sends_only_an_honest_user_agent(self):
        body, opener = self.get(CINEMETA_SEARCH, FakeResponse([b'ab', b'cd']))
        self.assertEqual(body, b'abcd')
        request = opener.requests[0]
        self.assertEqual(request.full_url, CINEMETA_SEARCH)
        self.assertEqual(dict(request.header_items()), {'User-agent': 'stremio-cast-bridge/1'})

    def test_only_the_three_allowed_targets_are_opened(self):
        allowed = (CINEMETA_SEARCH, SUBTITLES, 'http://127.0.0.1:11470/subtitles.vtt?from=https%3A%2F%2Fsubs5.strem.io%2Fa')
        for url in allowed:
            with self.subTest(url=url):
                self.assertEqual(self.get(url, FakeResponse([b'x']))[0], b'x')
        refused = ('http://v3-cinemeta.strem.io/x', 'https://v3-cinemeta.strem.io@evil.example/x',
                   'https://user:pw@v3-cinemeta.strem.io/x', 'https://v3-cinemeta.strem.io.evil.example/x',
                   'https://v3-cinemeta.strem.io:444/x', 'https://evil.example/x', 'https://subs5.strem.io/a',
                   'https://v3-cinemeta.strem.io/x#frag', 'https://v3-cinemeta.strem.io/x y',
                   'http://127.0.0.1:11470/stats.json', 'http://127.0.0.1:11470/subtitles.vtt',
                   'http://127.0.0.1:11470/subtitles.vtt/../x?from=a', 'http://127.0.0.1:11471/subtitles.vtt?from=a',
                   'http://localhost:11470/subtitles.vtt?from=a', 'file:///etc/passwd', 'https://v3-cinemeta.strem.io/é')
        for url in refused:
            opener = FakeOpener(FakeResponse([b'x']))
            with self.subTest(url=url), patch('addons.OPENER', opener), self.assertRaises(AddonError) as error:
                http_get(url, cap=1024, deadline=5, cancelled=None)
            self.assertEqual((error.exception.code, opener.requests), ('bad_response', []))

    def test_redirects_are_never_followed(self):
        handler = addons._NoRedirect()
        request = Request(CINEMETA_SEARCH)
        self.assertIsNone(handler.redirect_request(request, None, 302, 'Found', {}, 'http://127.0.0.1:11470/stats.json'))
        with self.assertRaises(AddonError) as error:
            self.get(CINEMETA_SEARCH, http_error(302, 'Found'))
        self.assertEqual(error.exception.code, 'bad_response')

    def test_one_stalled_read_cannot_stretch_a_subtitle_fetch_past_the_panels_six_second_abort(self):
        budgets = []
        def get(url, *, cap, deadline, cancelled=None):
            budgets.append(deadline)
            return self.get(url, FakeResponse([b'WEBVTT\n']), cap=cap, deadline=deadline)[0]
        offer = Offer('o', 'spa', 'Español', 'x', None, 'https://subs5.strem.io/a')
        StremioAddon(get=get).fetch(offer, None)
        _, opener = self.get(CINEMETA_SEARCH, FakeResponse([b'x']), deadline=budgets[0])
        self.assertLessEqual(budgets[0] + opener.timeouts[0], 6)
        self.assertGreaterEqual(opener.timeouts[0], 1.5)

    def test_the_opener_ignores_environment_proxies(self):
        self.assertFalse([h for h in addons.OPENER.handlers if isinstance(h, ProxyHandler)])

    def test_the_body_cap_counts_bytes_across_chunks(self):
        self.assertEqual(self.get(CINEMETA_SEARCH, FakeResponse([b'a' * 512, b'b' * 512]))[0], b'a' * 512 + b'b' * 512)
        with self.assertRaises(AddonError) as error:
            self.get(CINEMETA_SEARCH, FakeResponse([b'a' * 512, b'b' * 513]))
        self.assertEqual(error.exception.code, 'too_large')

    def test_a_stalled_download_hits_the_deadline_between_chunks(self):
        class Endless(FakeResponse):
            def read1(self, size):
                return b'x'
        clock = count(0, 3)
        with patch('addons.time.monotonic', side_effect=lambda: next(clock)), self.assertRaises(AddonError) as error:
            self.get(CINEMETA_SEARCH, Endless([]), cap=10 ** 9, deadline=5)
        self.assertEqual(error.exception.code, 'timeout')

    def test_a_cancelled_request_is_never_opened(self):
        class Flag:
            def is_set(self):
                return True
        with self.assertRaises(AddonError) as error:
            self.get(CINEMETA_SEARCH, FakeResponse([b'x']), cancelled=Flag())
        self.assertEqual((error.exception.code, error.exception.opener.requests), ('cancelled', []))

    def test_cancellation_stops_a_download_between_chunks(self):
        cancelled = threading.Event()
        class CancelAfterFirstChunk(FakeResponse):
            def read1(self, size):
                cancelled.set()
                return b'x'
        with self.assertRaises(AddonError) as error:
            self.get(CINEMETA_SEARCH, CancelAfterFirstChunk([]), cancelled=cancelled)
        self.assertEqual(error.exception.code, 'cancelled')

    def test_a_lookup_cancelled_during_the_search_never_opens_the_subtitle_request(self):
        cancelled = threading.Event()
        class SearchThenCancel(FakeResponse):
            def read1(self, size):
                chunk = super().read1(size)
                if not chunk:
                    cancelled.set()
                return chunk
        opener = FakeOpener(SearchThenCancel([json.dumps(METAS).encode()]))
        with patch('addons.OPENER', opener), self.assertRaises(AddonError) as error:
            StremioAddon().list(SOURCE, None, cancelled)
        self.assertEqual(error.exception.code, 'cancelled')
        self.assertEqual([request.full_url for request in opener.requests], [CINEMETA_SEARCH])

    def test_failures_map_to_a_closed_set_of_codes_and_carry_no_url_or_upstream_text(self):
        secret = 'PRIVATE-UPSTREAM-TEXT'
        cases = ((http_error(429, secret), 'busy'),
                 (http_error(403, secret), 'bad_response'),
                 (http_error(500, secret), 'bad_response'),
                 (URLError(ConnectionRefusedError(secret)), 'offline'),
                 (URLError(TimeoutError(secret)), 'timeout'),
                 (TimeoutError(secret), 'timeout'),
                 (ConnectionResetError(secret), 'offline'),
                 (ValueError(secret), 'bad_response'),
                 (FakeResponse([b'x'], status=204), 'bad_response'))
        for failure, code in cases:
            with self.subTest(code=code, failure=failure), self.assertRaises(AddonError) as error:
                self.get(CINEMETA_SEARCH, failure)
            exception = error.exception
            self.assertEqual((exception.code, str(exception)), (code, MESSAGES[code]))
            self.assertIsNone(exception.__cause__)
            self.assertTrue(exception.__suppress_context__ or exception.__context__ is None)
            self.assertNotIn(secret, repr(exception) + str(exception))
            self.assertNotIn('strem.io', repr(exception) + str(exception))

    def test_error_copy_is_closed_and_free_of_urls(self):
        self.assertEqual(set(MESSAGES), {'offline', 'timeout', 'busy', 'too_large', 'bad_response', 'cancelled'})
        self.assertFalse([m for m in MESSAGES.values() if re.search(r'https?:|strem\.io|\d+\.\d+\.\d+', m)])
        self.assertEqual(addons.listing_error('busy'), MESSAGES['busy'])
        self.assertEqual(addons.listing_error('offline'), addons.LISTING_ERROR)


class LenientNormalizationTest(unittest.TestCase):
    NAMES = ('13093475-spa.vtt', '13139362-heb.vtt', '13125792-ita.vtt', '14159711-mac.vtt')

    def text(self, name):
        return (FIXTURES / name).read_text(encoding='utf-8')

    def test_lenient_accepts_every_recorded_engine_file(self):
        for name in self.NAMES:
            with self.subTest(name=name):
                canonical = normalize_subtitles('vtt', self.text(name), lenient=True).decode()
                self.assertTrue(canonical.startswith('WEBVTT\n\n00:'))
                self.assertFalse(re.search(r'[\u200b\u2060\ufeff]', canonical))

    def test_lenient_keeps_the_joiners_and_bidi_marks_rtl_text_needs(self):
        lines = ('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', '\u200f\u05e9\u05dc\u05d5\u05dd!\u200e',
                 '\u202b\u05e9\u05dc\u05d5\u05dd!\u202c', '\u2067\u0645\u0631\u062d\u0628\u0627\u2069 \u061c1',
                 'a\u200db')
        for line in lines:
            with self.subTest(line=line):
                text = f'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{line}\n'
                self.assertEqual(normalize_subtitles('vtt', text, lenient=True).decode(), text)

    def test_lenient_strips_invisible_format_characters_that_carry_no_meaning(self):
        text = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHo\u200bla\u2060 mun\ufeffdo\u00ad\n'
        self.assertEqual(normalize_subtitles('vtt', text, lenient=True).decode(),
                         'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHola mundo\n')

    def test_strict_still_rejects_bidi_marks_and_stray_angle_brackets(self):
        for name in self.NAMES:
            with self.subTest(name=name), self.assertRaises(MediaError) as error:
                normalize_subtitles('vtt', self.text(name))
            self.assertEqual(error.exception.code, 'invalid_subtitle')

    def test_lenient_drops_only_the_bad_cue(self):
        good = 'WEBVTT\n\n' + ''.join(f'00:00:{n:02d}.000 --> 00:00:{n:02d}.500\nline {n}\n\n' for n in range(30))
        broken = good + '00:01:00.000 --> 00:01:02.000\nI <3 you\n'
        with self.assertRaises(MediaError):
            normalize_subtitles('vtt', broken)
        self.assertEqual(normalize_subtitles('vtt', broken, lenient=True), normalize_subtitles('vtt', good))

    def test_lenient_fails_when_a_tenth_of_the_cues_are_dropped_or_none_survive(self):
        good = ''.join(f'00:00:{n:02d}.000 --> 00:00:{n:02d}.500\nline {n}\n\n' for n in range(9))
        bad = '00:00:30.000 --> 00:00:31.000\nbroken <\n\n'
        self.assertTrue(normalize_subtitles('vtt', 'WEBVTT\n\n' + good + bad + good.replace('00:00:0', '00:01:0'), lenient=True))
        with self.assertRaises(MediaError):
            normalize_subtitles('vtt', 'WEBVTT\n\n' + good + bad, lenient=True)
        with self.assertRaises(MediaError):
            normalize_subtitles('vtt', 'WEBVTT\n\n' + bad, lenient=True)

    def test_file_level_rules_stay_strict_in_lenient_mode(self):
        for text in ('not a subtitle', 'WEBVTT http://example.test\n\n00:00:01.000 --> 00:00:02.000\nx',
                     'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nbad\x07control', 'x' * (1024 ** 2 + 1)):
            with self.subTest(text=text[:40]), self.assertRaises(MediaError):
                normalize_subtitles('vtt', text, lenient=True)

    def test_external_resources_in_a_cue_are_dropped_not_kept(self):
        body = ''.join(f'00:00:{n:02d}.000 --> 00:00:{n:02d}.500\nline {n}\n\n' for n in range(30))
        text = 'WEBVTT\n\n' + body + '00:01:00.000 --> 00:01:01.000\n<img src=x>caption\n'
        canonical = normalize_subtitles('vtt', text, lenient=True).decode()
        self.assertNotIn('caption', canonical)
        self.assertNotIn('img', canonical)


if __name__ == '__main__':
    unittest.main()


class SourceEpisodeTest(unittest.TestCase):
    def test_sources_carry_their_season_and_an_episode_title(self):
        from bridge import episode_of, episode_title
        pack = episode_of('Mobland 2025 S01E07 1080p BluRay HEVC x265 5.1 BONE.mkv', 'Mobland 2025 S01 1080p BluRay')
        single = episode_of('mobland.s02e01.1080p.web.h264-poke[EZTVx.to].mkv')
        self.assertEqual(pack, dict(show='Mobland', season=1, number=7))
        self.assertEqual(single, dict(show='Mobland', season=2, number=1))
        self.assertEqual(episode_title(single), 'Mobland · T2 E1')
        for movie in ('Inception.2010.1080p.mkv', '1917.2019.1920x1080.x264.mkv'):
            self.assertIsNone(episode_of(movie))


class SeriesGuideTest(unittest.TestCase):
    def test_the_guide_lists_every_episode_of_the_show_without_specials(self):
        from addons import StremioAddon
        meta = {'meta': {'videos': [
            {'season': 2, 'episode': 1, 'name': 'Back', 'released': '2026-09-25T03:00:00.000Z'},
            {'season': 1, 'episode': 2, 'name': 'Jigsaw Puzzle', 'released': '2025-04-06T03:00:00.000Z'},
            {'season': 1, 'number': 1, 'name': 'Stick or Twist'},
            {'season': 0, 'episode': 1, 'name': 'Trailer'},
            {'season': '1', 'episode': 3}, {'season': 1, 'episode': 2, 'name': 'duplicate'}]}}
        asked = []

        def get(url, *, cap, deadline, cancelled=None):
            asked.append(url)
            if '/catalog/' in url:
                return json.dumps({'metas': [{'id': 'tt31510819', 'name': 'MobLand', 'releaseInfo': '2025'},
                                             {'id': 'tt6046238', 'name': 'Molang', 'releaseInfo': '2015'}]}).encode()
            return json.dumps(meta).encode()

        guide = StremioAddon(get=get).guide('Mobland', None)
        self.assertEqual(asked[1], 'https://v3-cinemeta.strem.io/meta/series/tt31510819.json')
        self.assertEqual(guide['title'], 'MobLand')
        self.assertEqual([(e['season'], e['number'], e['name'], e['released']) for e in guide['episodes']],
                         [(1, 1, 'Stick or Twist', None), (1, 2, 'Jigsaw Puzzle', '2025-04-06'), (2, 1, 'Back', '2026-09-25')])

    def test_an_unknown_show_has_no_guide(self):
        from addons import StremioAddon
        get = lambda url, **_: json.dumps({'metas': [{'id': 'tt6046238', 'name': 'Molang', 'releaseInfo': '2015'}]}).encode()
        self.assertIsNone(StremioAddon(get=get).guide('Mobland', None))


class TorrentioTest(unittest.TestCase):
    def test_streams_keep_seeders_size_and_trackers_and_drop_broken_entries(self):
        from addons import parse_streams
        good = {'infoHash': 'A' * 40, 'fileIdx': 3, 'title': 'Pack name\n./S02/MobLand.S02E02.1080p.WEB-DL-playWEB.mkv\n\U0001F464 1396 \U0001F4BE 3.23 GB \u2699\ufe0f EXT',
                'behaviorHints': {'filename': 'MobLand.S02E02.1080p.WEB-DL-playWEB.mkv'},
                'sources': ['tracker:udp://tracker.opentrackr.org:1337/announce', 'dht:' + 'a' * 40, 'tracker:javascript:alert(1)']}
        streams = parse_streams({'streams': [good, dict(good), {'infoHash': 'zz', 'fileIdx': 1}, {'infoHash': 'b' * 40, 'title': 'no file index'},
                                             {'infoHash': 'c' * 40, 'fileIdx': 0, 'title': 'Show.S02E02.2160p.mkv'}]})
        self.assertEqual(len(streams), 2, 'duplicates, bad hashes and streams without a file index are dropped')
        first = streams[0]
        self.assertEqual((first.info_hash, first.file_idx, first.filename, first.seeders, first.size, first.resolution, first.group),
                         ('a' * 40, 3, 'MobLand.S02E02.1080p.WEB-DL-playWEB.mkv', 1396, '3.23 GB', '1080p', 'playweb'))
        self.assertEqual(first.trackers, ('udp://tracker.opentrackr.org:1337/announce',))
        self.assertEqual((streams[1].seeders, streams[1].resolution), (None, '2160p'))
        self.assertNotIn('info_hash', first.public())

    def test_the_users_torrentio_configuration_comes_from_the_stremio_profile(self):
        import sqlite3
        from addons import TORRENTIO, torrentio_base
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'localstorage.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('create table ItemTable (key text, value blob)')
                profile = '{"addons":[{"transportUrl":"https://torrentio.strem.fun/qualityfilter=480p,scr|limit=5/manifest.json"}]}'
                db.execute('insert into ItemTable values (?, ?)', ('profile', profile.encode('utf-16-le')))
            self.assertEqual(torrentio_base([str(path)]), f'{TORRENTIO}/qualityfilter=480p,scr|limit=5')
            self.assertEqual(torrentio_base([str(Path(folder) / 'missing.sqlite3')]), TORRENTIO)
