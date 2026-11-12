import time

from addons import Listing, MetaId, Match, Offer

SOURCE = dict(id='source', url='http://127.0.0.1:11470/PRIVATE-HASH/0', filename='Mobland 2025 S01E07.mkv',
              release='PRIVATE-TORRENT-NAME', title='Mobland 2025 S01E07')
MATCH = Match(MetaId('tt31510819', 1, 7), 'MobLand (2025) · T1 E7', 'exact')


def offer(n, language='spl'):
    return Offer(f'offer-{n}', language, 'Español (Latinoamérica)', f'Release {n}', None, f'https://subs5.strem.io/PRIVATE-{n}')


def ready(*offers, alternatives=()):
    return Listing('ready', 0, MATCH, tuple(alternatives), tuple(offers))


def vtt(n):
    return f'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello {n}\n'


def wait_for(condition, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(.005)
    raise AssertionError('condition never held')


class FakeAddon:
    def __init__(self, listing=None, text=vtt):
        self.listing, self.text = listing or (lambda *_: ready(offer(1), offer(2))), text
        self.list_calls, self.fetch_calls = [], []

    def list(self, source, hint, cancelled):
        self.list_calls.append((source, hint, cancelled))
        return self.listing(source, hint, cancelled)

    def fetch(self, offer, cancelled):
        self.fetch_calls.append(offer)
        return self.text(offer.id) if callable(self.text) and not isinstance(self.text, str) else self.text
