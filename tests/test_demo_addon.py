import json
import unittest

from bridge import BridgeError
from demo import DemoBridge


class DemoAddonTest(unittest.TestCase):
    def setUp(self):
        self.demo = DemoBridge()
        _, response = self.demo.request_catalogue(dict(source_id='demo-a', refresh=False))
        self.catalogue = response['catalogue']
        self.ids = dict(source_id='demo-a', catalogue_id=self.catalogue['id'])

    def offers(self):
        return self.demo.subtitle_offers(self.ids)['offers']

    def test_a_demo_catalogue_carries_a_ready_summary_and_offers_come_from_the_offers_call(self):
        self.assertEqual(self.catalogue['addon']['state'], 'ready')
        self.assertEqual(self.catalogue['addon']['count'], 8)
        self.assertNotIn('offers', self.catalogue['addon'])
        status = json.dumps(self.demo.status())
        self.assertIn('"addon"', status)
        self.assertNotIn('offers', status)
        self.assertNotIn('strem.io', status + json.dumps(self.demo.subtitle_offers(self.ids)))

    def test_offers_are_the_real_parsers_grouped_and_ranked_output(self):
        languages = []
        for offer in self.offers():
            if not languages or languages[-1] != offer['language']:
                languages.append(offer['language'])
        self.assertEqual(languages[:3], ['spl', 'spa', 'eng'])
        self.assertEqual([o['note'] for o in self.offers() if o['language'] == 'spa'], [None, 'para sordos'])

    def test_special_hints_reach_the_error_and_unidentified_states_and_any_other_hint_a_manual_match(self):
        for hint, state in (('error', 'error'), ('nada', 'unidentified'), ('Dune 2021', 'ready')):
            addon = self.demo.subtitle_lookup(dict(self.ids, hint=hint))['catalogue']['addon']
            self.assertEqual(addon['state'], state)
        self.assertEqual(addon['match'], dict(label='Dune (2021)', confidence='manual'))
        self.assertEqual(addon['revision'], 4)
        self.assertEqual(len(self.demo.subtitle_offers(self.ids)['offers']), 8)
        unidentified = self.demo.subtitle_lookup(dict(self.ids, hint='nada'))['catalogue']
        self.assertEqual(len(self.demo.subtitle_offers(self.ids)['alternatives']), 2)
        self.assertEqual(unidentified['addon']['match'], None)

    def test_fetch_appends_an_ordinary_entry_once_and_the_plan_can_start_with_it(self):
        offer = self.offers()[0]
        first = self.demo.subtitle_fetch(dict(self.ids, offer_id=offer['id']))
        again = self.demo.subtitle_fetch(dict(self.ids, offer_id=offer['id']))
        self.assertEqual((first['entry']['kind'], first['entry']['language'], first['entry']['supported']), ('addon', 'spa', True))
        self.assertEqual(first['entry'], again['entry'])
        self.assertEqual(len(again['catalogue']['entries']), 4)
        self.demo.submit('select_device', dict(device_id='demo-tv-a', device_revision=0))
        self.demo.submit('start', dict(device_id='demo-tv-a', device_revision=1, source_id='demo-a',
                                       catalogue_id=self.catalogue['id'], subtitle_id=first['entry']['id'], delay_ms=0))
        self.assertEqual(self.demo.status()['subtitle_choice']['label'], offer['label'])

    def test_an_unreadable_offer_fails_with_the_reading_copy_and_stays_listed(self):
        bad = next(o for o in self.offers() if 'CORRUPTO' in o['label'])
        with self.assertRaises(BridgeError) as error:
            self.demo.subtitle_fetch(dict(self.ids, offer_id=bad['id']))
        self.assertEqual((error.exception.status, error.exception.code), (422, 'invalid_subtitle'))
        self.assertEqual(str(error.exception), 'Ese subtítulo no se pudo leer. Probá otra versión.')
        self.assertIn(bad['id'], [o['id'] for o in self.offers()])

    def test_stale_offers_catalogues_and_shapes_are_rejected_like_the_real_routes(self):
        offer = self.offers()[0]
        self.demo.subtitle_lookup(dict(self.ids, hint=None))
        for call, data, code in ((self.demo.subtitle_fetch, dict(self.ids, offer_id=offer['id']), 'stale_offer'),
                                 (self.demo.subtitle_offers, dict(source_id='demo-a', catalogue_id='gone'), 'stale_catalogue')):
            with self.assertRaises(BridgeError) as error:
                call(data)
            self.assertEqual((error.exception.status, error.exception.code), (409, code))
        for call, data in ((self.demo.subtitle_lookup, self.ids), (self.demo.subtitle_lookup, dict(self.ids, hint='x' * 201)),
                           (self.demo.subtitle_fetch, self.ids), (self.demo.subtitle_offers, dict(self.ids, hint=None))):
            with self.assertRaises(BridgeError) as error:
                call(data)
            self.assertEqual(error.exception.status, 400)

    def test_evicting_a_catalogue_forgets_its_listing_and_fetched_entries(self):
        self.demo.subtitle_fetch(dict(self.ids, offer_id=self.offers()[0]['id']))
        self.demo.request_catalogue(dict(source_id='demo-a', refresh=True))
        for _ in range(10):
            self.demo.request_catalogue(dict(source_id='demo-b', refresh=True))
        self.assertFalse(self.catalogue['id'] in self.demo.listings)
        self.assertFalse([key for key in self.demo.fetched if key[0] == self.catalogue['id']])
        self.assertEqual(set(self.demo.listings), set(self.demo.catalogues))


if __name__ == '__main__':
    unittest.main()
