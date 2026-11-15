import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from addon_fixtures import FakeAddon, MATCH, SOURCE, offer, ready, vtt, wait_for
from addons import AddonError, FETCH_FAILED, LISTING_ERROR, LOADING, MESSAGES, Candidate, Listing
from media import Analysis, Catalogue, MediaError, SetupCatalogue, Subtitle


class AddonStoreTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.stores = []

    def store(self, addon, probe=None):
        store = SetupCatalogue(probe or (lambda *_: Analysis(0, 1, 90)), Path(self.folder.name), addon)
        self.stores.append(store)
        self.addCleanup(self.close, store)
        return store

    def close(self, store):
        store.close()

    def catalogue(self, store, source=SOURCE, refresh=False):
        store.request(dict(source), refresh)
        return wait_for(lambda: store.snapshot().get(source['id'], {}).get('catalogue')
                        if store.snapshot().get(source['id'], {}).get('state') == 'ready' else None)

    def listed(self, store, source_id='source'):
        return wait_for(lambda: (lambda c: c if c['addon']['state'] not in ('loading', 'off') else None)(
            store.snapshot()[source_id]['catalogue']))

    def test_a_ready_catalogue_is_looked_up_automatically_on_a_second_worker(self):
        addon = FakeAddon()
        store = self.store(addon)
        first = self.catalogue(store)
        self.assertIn(first['addon']['state'], ('loading', 'ready'))
        catalogue = self.listed(store)
        self.assertEqual(catalogue['addon']['state'], 'ready')
        self.assertEqual(catalogue['addon']['count'], 2)
        self.assertEqual(catalogue['addon']['match'], dict(label='MobLand (2025) · T1 E7', confidence='exact'))
        source, hint, _ = addon.list_calls[0]
        self.assertEqual((source['filename'], source['release'], hint), (SOURCE['filename'], SOURCE['release'], None))

    def test_the_track_list_is_published_before_the_lookup_finishes(self):
        release = threading.Event()
        store = self.store(FakeAddon(lambda *_: (release.wait(3), ready(offer(1)))[1]))
        catalogue = self.catalogue(store)
        self.assertEqual(catalogue['addon'], dict(state='loading', revision=1, match=None, message=LOADING, count=0))
        self.assertEqual(store.resolve('source', catalogue['id'], None, 0, False).catalogue.id, catalogue['id'])
        release.set()
        self.assertEqual(self.listed(store)['addon']['count'], 1)

    def test_without_an_addon_nothing_runs_and_the_state_is_off(self):
        store = self.store(None)
        self.assertIsNone(store.looker)
        catalogue = self.catalogue(store)
        self.assertEqual(catalogue['addon'], dict(state='off', revision=0, match=None, message=None, count=0))
        with self.assertRaises(MediaError) as error:
            store.lookup('source', catalogue['id'], None)
        self.assertEqual(error.exception.code, 'addon_off')
        self.assertEqual(store.offers('source', catalogue['id'])['state'], 'off')

    def test_status_carries_only_the_summary_and_offers_come_from_the_offers_call(self):
        store = self.store(FakeAddon(lambda *_: ready(offer(1), alternatives=(Candidate('tt0000042', 'series', 'Other', 2020),))))
        self.catalogue(store)
        catalogue = self.listed(store)
        self.assertEqual(set(catalogue['addon']), {'state', 'revision', 'match', 'message', 'count'})
        listing = store.offers('source', catalogue['id'])
        self.assertEqual([o['label'] for o in listing['offers']], ['Release 1'])
        self.assertEqual(listing['alternatives'], [dict(id='tt0000042', title='Other', year=2020)])
        self.assertNotIn('PRIVATE', json.dumps(listing) + json.dumps(store.snapshot()))

    def test_offers_follow_the_same_catalogue_identity_rules_as_uploads(self):
        store = self.store(FakeAddon())
        old = self.catalogue(store)
        self.listed(store)
        new = self.catalogue(store, refresh=True)
        self.assertNotEqual(old['id'], new['id'])
        with self.assertRaises(MediaError) as error:
            store.offers('source', old['id'])
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(store.offers('source', old['id'], allow_retained=True)['state'], 'ready')
        with self.assertRaises(MediaError):
            store.offers('other', new['id'])

    def hold_each_enqueue_until_the_lookup_worker_moves_on(self, store):
        moved_on = threading.Event()
        get, put = store.lookups.get, store.lookups.put_nowait
        def watched_get(*args, **kwargs):
            moved_on.set()
            return get(*args, **kwargs)
        def held_put(item):
            moved_on.clear()
            put(item)
            moved_on.wait(.5)
        store.lookups.get, store.lookups.put_nowait = watched_get, held_put

    def test_an_automatic_lookup_picked_up_before_the_probe_publishes_still_runs(self):
        store = self.store(FakeAddon())
        self.hold_each_enqueue_until_the_lookup_worker_moves_on(store)
        self.catalogue(store)
        self.assertEqual(self.listed(store)['addon']['state'], 'ready')

    def test_a_manual_lookup_picked_up_before_it_is_published_still_runs(self):
        store = self.store(FakeAddon())
        catalogue = self.catalogue(store)
        self.listed(store)
        self.hold_each_enqueue_until_the_lookup_worker_moves_on(store)
        store.lookup('source', catalogue['id'], 'tt0000042')
        final = self.listed(store)['addon']
        self.assertEqual((final['state'], final['revision']), ('ready', 2))

    def test_a_manual_lookup_passes_the_hint_and_a_stale_result_is_dropped(self):
        started, release_first = threading.Event(), threading.Event()
        def listing(source, hint, cancelled):
            if hint is None:
                started.set()
                release_first.wait(3)
                return Listing('ready', 0, MATCH, (), (offer(1),), None)
            return Listing('ready', 0, MATCH, (), (offer(2), offer(3)), None)
        store = self.store(FakeAddon(listing))
        catalogue = self.catalogue(store)
        self.assertTrue(started.wait(3))
        response = store.lookup('source', catalogue['id'], 'tt0000042')
        self.assertEqual(response['catalogue']['addon']['state'], 'loading')
        self.assertEqual(response['catalogue']['addon']['revision'], 2)
        release_first.set()
        wait_for(lambda: store.snapshot()['source']['catalogue']['addon']['state'] == 'ready')
        time.sleep(.1)
        final = store.snapshot()['source']['catalogue']['addon']
        self.assertEqual((final['revision'], final['count']), (2, 2))

    def test_a_newer_lookup_cancels_the_one_in_flight(self):
        seen = []
        def listing(source, hint, cancelled):
            if hint is None:
                deadline = time.monotonic() + 3
                while not cancelled.is_set() and time.monotonic() < deadline:
                    time.sleep(.005)
                seen.append(cancelled.is_set())
                raise AddonError('cancelled')
            return ready(offer(9))
        store = self.store(FakeAddon(listing))
        catalogue = self.catalogue(store)
        wait_for(lambda: store.addon.list_calls)
        store.lookup('source', catalogue['id'], 'tt0000042')
        self.assertEqual(wait_for(lambda: self.listed(store))['addon']['count'], 1)
        self.assertEqual(seen, [True])

    def test_a_lookup_for_an_evicted_catalogue_is_discarded_and_the_worker_survives(self):
        release = threading.Event()
        calls = []
        def listing(source, hint, cancelled):
            calls.append(source['id'])
            if source['id'] == 'victim':
                release.wait(3)
            return ready(offer(1))
        store = self.store(FakeAddon(listing))
        self.catalogue(store, dict(SOURCE, id='victim'))
        wait_for(lambda: calls)
        for index in range(8):
            self.catalogue(store, dict(SOURCE, id=f'other-{index}'))
        release.set()
        self.assertNotIn('victim', {c.source['id'] for c in store.records.values()})
        self.assertEqual(self.listed(store, 'other-7')['addon']['state'], 'ready')

    def test_a_late_lookup_never_erases_an_upload_that_landed_meanwhile(self):
        release = threading.Event()
        store = self.store(FakeAddon(lambda *_: (release.wait(3), ready(offer(1)))[1]))
        catalogue = self.catalogue(store)
        upload = store.upload('source', catalogue['id'], 'mine.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nMine')
        release.set()
        final = self.listed(store)
        self.assertEqual([e['id'] for e in final['entries']], [upload['entry']['id']])
        self.assertEqual(final['addon']['state'], 'ready')

    def test_failures_become_an_error_listing_with_closed_copy_and_the_worker_keeps_going(self):
        outcomes = iter([AddonError('offline'), AddonError('busy'), RuntimeError('PRIVATE-DETAIL'), ValueError('x'), None])
        def listing(*_):
            outcome = next(outcomes)
            if outcome:
                raise outcome
            return ready(offer(1))
        store = self.store(FakeAddon(listing))
        catalogue = self.catalogue(store)
        expected = [LISTING_ERROR, MESSAGES['busy'], LISTING_ERROR, LISTING_ERROR]
        for message in expected:
            summary = self.listed(store)['addon']
            self.assertEqual((summary['state'], summary['message']), ('error', message))
            self.assertNotIn('PRIVATE', json.dumps(store.snapshot()))
            store.lookup('source', catalogue['id'], None)
        self.assertEqual(self.listed(store)['addon']['state'], 'ready')

    def test_a_full_lookup_queue_refuses_without_touching_the_listing_and_never_kills_the_probe_worker(self):
        release = threading.Event()
        store = self.store(FakeAddon(lambda *_: (release.wait(5), ready(offer(1)))[1]))
        catalogue = self.catalogue(store)
        wait_for(lambda: store.addon.list_calls)
        for _ in range(8):
            store.lookup('source', catalogue['id'], 'x')
        before = store.snapshot()['source']['catalogue']['addon']
        with self.assertRaises(MediaError) as error:
            store.lookup('source', catalogue['id'], 'x')
        self.assertEqual((error.exception.status, error.exception.code), (409, 'busy'))
        self.assertEqual(store.snapshot()['source']['catalogue']['addon'], before)
        other = self.catalogue(store, dict(SOURCE, id='other'))
        self.assertEqual(other['addon']['state'], 'error')
        self.assertEqual(other['addon']['message'], LISTING_ERROR)
        later = self.catalogue(store, dict(SOURCE, id='later'))
        self.assertEqual(later['entries'], [])
        release.set()

    def fetched(self, store, offer_id='offer-1'):
        catalogue = self.catalogue(store)
        self.listed(store)
        return catalogue, store.fetch('source', catalogue['id'], offer_id)

    def test_fetch_stores_an_ordinary_private_subtitle_the_plan_can_resolve(self):
        store = self.store(FakeAddon())
        catalogue, result = self.fetched(store)
        entry = result['entry']
        self.assertEqual((entry['kind'], entry['label'], entry['language'], entry['supported']),
                         ('addon', 'Release 1', 'spa', True))
        self.assertEqual(result['catalogue']['entries'], [entry])
        self.assertNotIn('origin', entry)
        plan = store.resolve('source', catalogue['id'], entry['id'], 0, True)
        self.assertEqual(plan.subtitle.path.read_bytes(), b'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello offer-1\n')
        self.assertEqual(plan.subtitle.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(plan.subtitle.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(plan.subtitle.index, None)
        self.assertEqual(store.snapshot()['source']['catalogue']['entries'], [entry])

    def test_fetch_normalises_leniently_and_stores_the_hls_language_tag(self):
        text = '\ufeffWEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\u202bHola\u200f\n'
        store = self.store(FakeAddon(text=text))
        _, result = self.fetched(store)
        plan = store.resolve('source', result['catalogue']['id'], result['entry']['id'], 0, True)
        self.assertEqual(plan.subtitle.language, 'spa')
        self.assertEqual(plan.subtitle.path.read_text(), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHola\n')

    def test_fetching_the_same_offer_again_is_idempotent_and_offline(self):
        addon = FakeAddon()
        store = self.store(addon)
        catalogue, first = self.fetched(store)
        again = store.fetch('source', catalogue['id'], 'offer-1')
        self.assertEqual(again['entry'], first['entry'])
        self.assertEqual(len(addon.fetch_calls), 1)
        self.assertEqual(len(again['catalogue']['entries']), 1)

    def test_identical_content_from_two_offers_collapses_to_one_entry(self):
        store = self.store(FakeAddon(text=vtt(0)))
        catalogue, first = self.fetched(store)
        second = store.fetch('source', catalogue['id'], 'offer-2')
        self.assertEqual(second['entry']['id'], first['entry']['id'])
        self.assertEqual(len(second['catalogue']['entries']), 1)

    def test_an_upload_and_an_addon_subtitle_with_the_same_bytes_do_not_collapse(self):
        store = self.store(FakeAddon(text=vtt(0)))
        catalogue, fetched = self.fetched(store)
        upload = store.upload('source', catalogue['id'], 'same.vtt', 'vtt', vtt(0))
        self.assertNotEqual(upload['entry']['id'], fetched['entry']['id'])
        self.assertEqual([e['kind'] for e in upload['catalogue']['entries']], ['addon', 'upload'])

    def test_unknown_and_replaced_offers_are_stale(self):
        store = self.store(FakeAddon())
        catalogue = self.catalogue(store)
        self.listed(store)
        for offer_id in ('nope', 7):
            with self.assertRaises(MediaError) as error:
                store.fetch('source', catalogue['id'], offer_id)
            self.assertEqual((error.exception.status, error.exception.code), (409, 'stale_offer'))
        store.addon.listing = lambda *_: ready(offer(5))
        store.lookup('source', catalogue['id'], 'again')
        wait_for(lambda: [o['id'] for o in store.offers('source', catalogue['id'])['offers']] == ['offer-5'])
        with self.assertRaises(MediaError) as error:
            store.fetch('source', catalogue['id'], 'offer-1')
        self.assertEqual(error.exception.code, 'stale_offer')

    def test_a_listing_that_changes_during_the_download_discards_the_download(self):
        entered, release = threading.Event(), threading.Event()
        addon = FakeAddon()
        def slow(offer, cancelled):
            entered.set()
            release.wait(3)
            return vtt(1)
        addon.fetch = lambda offer, cancelled: slow(offer, cancelled)
        store = self.store(addon)
        catalogue = self.catalogue(store)
        self.listed(store)
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(self.attempt(store, catalogue['id'])))
        thread.start()
        self.assertTrue(entered.wait(3))
        addon.listing = lambda *_: ready(offer(5))
        store.lookup('source', catalogue['id'], 'again')
        wait_for(lambda: [o['id'] for o in store.offers('source', catalogue['id'])['offers']] == ['offer-5'])
        release.set()
        thread.join(3)
        self.assertEqual(outcome[0].code, 'stale_offer')
        self.assertEqual(store.snapshot()['source']['catalogue']['entries'], [])
        self.assertEqual(store.storage, 0)

    def attempt(self, store, catalogue_id, offer_id='offer-1'):
        try:
            return store.fetch('source', catalogue_id, offer_id)
        except MediaError as error:
            return error

    def test_download_failures_are_closed_copy_with_distinct_statuses(self):
        for error, status in ((AddonError('offline'), 502), (AddonError('timeout'), 502), (AddonError('too_large'), 502),
                              (AddonError('bad_response'), 502), (AddonError('busy'), 503)):
            with self.subTest(code=error.code):
                addon = FakeAddon()
                def failing(offer, cancelled, error=error):
                    raise error
                addon.fetch = failing
                store = self.store(addon)
                catalogue = self.catalogue(store, dict(SOURCE, id=error.code))
                self.listed(store, error.code)
                with self.assertRaises(MediaError) as raised:
                    store.fetch(error.code, catalogue['id'], 'offer-1')
                self.assertEqual((raised.exception.status, raised.exception.code, str(raised.exception)),
                                 (status, 'addon_unavailable', MESSAGES[error.code]))
                self.assertIsNone(raised.exception.__cause__)

    def test_unreadable_subtitle_text_is_a_422_that_leaves_the_catalogue_unchanged(self):
        for text in ('not a subtitle', 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<img src=x>\n'):
            with self.subTest(text=text[:12]):
                store = self.store(FakeAddon(text=text))
                catalogue = self.catalogue(store)
                self.listed(store)
                with self.assertRaises(MediaError) as error:
                    store.fetch('source', catalogue['id'], 'offer-1')
                self.assertEqual((error.exception.status, error.exception.code, str(error.exception)),
                                 (422, 'invalid_subtitle', FETCH_FAILED))
                self.assertEqual(store.snapshot()['source']['catalogue']['entries'], [])
                self.assertIsNone(store.upload_dir)

    def test_a_second_download_while_one_is_running_is_busy_and_the_flag_clears_afterwards(self):
        entered, release = threading.Event(), threading.Event()
        addon = FakeAddon()
        def slow(offer, cancelled):
            entered.set()
            release.wait(3)
            return vtt(offer.id)
        addon.fetch = slow
        store = self.store(addon)
        catalogue = self.catalogue(store)
        self.listed(store)
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(self.attempt(store, catalogue['id'], 'offer-1')))
        thread.start()
        self.assertTrue(entered.wait(3))
        with self.assertRaises(MediaError) as error:
            store.fetch('source', catalogue['id'], 'offer-2')
        self.assertEqual((error.exception.status, error.exception.code), (409, 'busy'))
        release.set()
        thread.join(3)
        self.assertEqual(outcome[0]['entry']['label'], 'Release 1')
        self.assertEqual(store.fetch('source', catalogue['id'], 'offer-2')['entry']['label'], 'Release 2')

    def test_addon_and_upload_caps_are_separate_and_storage_is_shared(self):
        many = [offer(n) for n in range(9)]
        store = self.store(FakeAddon(lambda *_: ready(*many)))
        catalogue = self.catalogue(store)
        self.listed(store)
        for n in range(8):
            store.fetch('source', catalogue['id'], f'offer-{n}')
        with self.assertRaises(MediaError) as error:
            store.fetch('source', catalogue['id'], 'offer-8')
        self.assertEqual((error.exception.status, str(error.exception)), (413, 'Límite de subtítulos de Stremio alcanzado.'))
        for n in range(8):
            store.upload('source', catalogue['id'], f'{n}.srt', 'srt', f'1\n00:00:01,000 --> 00:00:03,000\nCue {n}')
        with self.assertRaises(MediaError) as error:
            store.upload('source', catalogue['id'], 'ninth.srt', 'srt', '1\n00:00:01,000 --> 00:00:03,000\nNinth')
        self.assertEqual(str(error.exception), 'Límite de subtítulos locales alcanzado.')
        self.assertEqual(len(store.snapshot()['source']['catalogue']['entries']), 16)

    def test_shared_storage_cap_applies_to_addon_subtitles(self):
        store = self.store(FakeAddon())
        catalogue = self.catalogue(store)
        self.listed(store)
        store.storage = 16 * 1024 ** 2 - 10
        with self.assertRaises(MediaError) as error:
            store.fetch('source', catalogue['id'], 'offer-1')
        self.assertEqual(error.exception.status, 413)

    def test_evicting_a_catalogue_frees_its_addon_files_and_storage(self):
        store = self.store(FakeAddon())
        catalogue, result = self.fetched(store)
        plan = store.resolve('source', catalogue['id'], result['entry']['id'], 0, True)
        self.assertTrue(plan.subtitle.path.exists())
        for _ in range(10):
            self.catalogue(store, refresh=True)
        self.assertFalse(plan.subtitle.path.exists())
        self.assertEqual(store.storage, 0)

    def test_close_stops_the_lookup_worker_even_mid_request_and_cleans_files(self):
        started = threading.Event()
        def listing(source, hint, cancelled):
            started.set()
            while not cancelled.is_set():
                time.sleep(.005)
            raise AddonError('cancelled')
        store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(self.folder.name), FakeAddon(listing))
        self.catalogue(store)
        self.assertTrue(started.wait(3))
        store.close()
        self.assertFalse(store.looker.is_alive())
        self.assertFalse(store.worker.is_alive())

    def test_close_waits_for_an_in_flight_download_before_removing_files(self):
        entered, release = threading.Event(), threading.Event()
        addon = FakeAddon()
        def slow(offer, cancelled):
            entered.set()
            release.wait(5)
            return vtt(1)
        addon.fetch = slow
        store = SetupCatalogue(lambda *_: Analysis(0, 1, 90), Path(self.folder.name), addon)
        catalogue = self.catalogue(store)
        self.listed(store)
        outcome = []
        thread = threading.Thread(target=lambda: outcome.append(self.attempt(store, catalogue['id'])))
        thread.start()
        self.assertTrue(entered.wait(3))
        closer = threading.Thread(target=store.close)
        closer.start()
        time.sleep(.1)
        self.assertTrue(closer.is_alive())
        release.set()
        closer.join(5)
        thread.join(3)
        self.assertFalse(closer.is_alive())
        self.assertEqual(outcome[0].status, 503)
        self.assertIsNone(store.upload_dir)

    def test_nothing_private_reaches_status_errors_or_public_payloads(self):
        store = self.store(FakeAddon())
        catalogue, result = self.fetched(store)
        plan = store.resolve('source', catalogue['id'], result['entry']['id'], 0, True)
        failures = []
        for call in (lambda: store.fetch('source', catalogue['id'], 'nope'), lambda: store.fetch('other', catalogue['id'], 'offer-1'),
                     lambda: store.lookup('other', catalogue['id'], 'x')):
            try:
                call()
            except MediaError as error:
                failures.append(f'{error} {error.code} {error!r}')
        surfaces = json.dumps([store.snapshot(), store.offers('source', catalogue['id']), result, failures])
        for private in ('strem.io', 'PRIVATE-', '127.0.0.1', str(plan.subtitle.path.parent), plan.subtitle.path.name):
            self.assertNotIn(private, surfaces)
        self.assertNotIn('strem.io', repr(store.records[catalogue['id']]))


class SubtitleInvariantTest(unittest.TestCase):
    def test_an_entry_is_embedded_with_an_index_or_stored_with_a_path_never_both_or_neither(self):
        Subtitle('a', 'embedded', 'x', index=2)
        for kind in ('upload', 'addon'):
            Subtitle('a', kind, 'x', path=Path('x.vtt'))
        for kwargs in (dict(kind='embedded'), dict(kind='upload'), dict(kind='embedded', path=Path('x'), index=1),
                       dict(kind='upload', index=1), dict(kind='addon', index=1, path=Path('x')), dict(kind='embedded', path=Path('x'))):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Subtitle('a', label='x', **kwargs)

    def test_a_catalogue_defaults_to_an_off_listing(self):
        catalogue = Catalogue('id', dict(id='s'), Analysis(0, 1, 90))
        self.assertEqual(catalogue.public()['addon'], dict(state='off', revision=0, match=None, message=None, count=0))


if __name__ == '__main__':
    unittest.main()
