from dataclasses import dataclass, field
import json
import re
import secrets
import sqlite3
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

USER_AGENT = 'stremio-cast-bridge/1'
CINEMETA = 'https://v3-cinemeta.strem.io'
OPENSUBTITLES = 'https://opensubtitles-v3.strem.io'
TORRENTIO = 'https://torrentio.strem.fun'
MAX_STREAMS = 12
HEALTHY_SEEDERS = 20
ENGINE = 'http://127.0.0.1:11470/subtitles.vtt?from='
MAX_SUBTITLE = 1024 ** 2
MAX_META = 4 * 1024 ** 2
MAX_OFFERS = 200
CHUNK = 64 * 1024

LOADING = 'Buscando subtítulos de Stremio…'
UNIDENTIFIED = 'No pude reconocer la película. Elegí una opción o escribí el título.'
LISTING_ERROR = 'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.'
FETCH_FAILED = 'Ese subtítulo no se pudo leer. Probá otra versión.'

MESSAGES = {
    'offline': 'No se pudo conectar. Revisá tu conexión y que Stremio esté abierto.',
    'timeout': 'La consulta tardó demasiado. Reintentá.',
    'busy': 'Stremio está limitando las consultas. Esperá unos segundos y reintentá.',
    'too_large': 'La respuesta es demasiado grande.',
    'bad_response': 'Stremio respondió algo inesperado.',
    'cancelled': 'La consulta se canceló.',
}

LANGUAGES = {
    'eng': ('eng', 'Inglés'), 'spa': ('spa', 'Español'), 'spl': ('spa', 'Español (Latinoamérica)'),
    'por': ('por', 'Portugués'), 'pob': ('por', 'Portugués (Brasil)'),
    'fre': ('fra', 'Francés'), 'fra': ('fra', 'Francés'), 'ger': ('deu', 'Alemán'), 'deu': ('deu', 'Alemán'),
    'ita': ('ita', 'Italiano'), 'ell': ('ell', 'Griego'), 'gre': ('ell', 'Griego'),
    'nld': ('nld', 'Holandés'), 'dut': ('nld', 'Holandés'), 'hrv': ('hrv', 'Croata'), 'srp': ('srp', 'Serbio'),
    'bul': ('bul', 'Búlgaro'), 'ara': ('ara', 'Árabe'), 'fin': ('fin', 'Finés'), 'nor': ('nor', 'Noruego'),
    'est': ('est', 'Estonio'), 'tha': ('tha', 'Tailandés'), 'kor': ('kor', 'Coreano'),
    'mac': ('mkd', 'Macedonio'), 'mkd': ('mkd', 'Macedonio'), 'cze': ('ces', 'Checo'), 'ces': ('ces', 'Checo'),
    'ind': ('ind', 'Indonesio'), 'tur': ('tur', 'Turco'), 'jpn': ('jpn', 'Japonés'), 'pol': ('pol', 'Polaco'),
    'dan': ('dan', 'Danés'), 'alb': ('sqi', 'Albanés'), 'sqi': ('sqi', 'Albanés'), 'rus': ('rus', 'Ruso'),
    'hun': ('hun', 'Húngaro'), 'vie': ('vie', 'Vietnamita'), 'bel': ('bel', 'Bielorruso'),
    'slv': ('slv', 'Esloveno'), 'per': ('fas', 'Persa'), 'fas': ('fas', 'Persa'), 'zho': ('zho', 'Chino'),
    'chi': ('zho', 'Chino'), 'zht': ('zho', 'Chino (tradicional)'), 'ben': ('ben', 'Bengalí'),
    'ron': ('ron', 'Rumano'), 'rum': ('ron', 'Rumano'), 'heb': ('heb', 'Hebreo'), 'swe': ('swe', 'Sueco'),
    'ukr': ('ukr', 'Ucraniano'), 'cat': ('cat', 'Catalán'), 'baq': ('eus', 'Vasco'), 'eus': ('eus', 'Vasco'),
    'glg': ('glg', 'Gallego'), 'hin': ('hin', 'Hindi'), 'lit': ('lit', 'Lituano'), 'lav': ('lav', 'Letón'),
    'slk': ('slk', 'Eslovaco'), 'slo': ('slk', 'Eslovaco'), 'isl': ('isl', 'Islandés'), 'ice': ('isl', 'Islandés'),
    'msa': ('msa', 'Malayo'), 'may': ('msa', 'Malayo'), 'fil': ('fil', 'Filipino'), 'urd': ('urd', 'Urdu'),
    'tam': ('tam', 'Tamil'), 'tel': ('tel', 'Telugu'), 'mal': ('mal', 'Malayalam'), 'kan': ('kan', 'Canarés'),
    'mar': ('mar', 'Maratí'), 'pan': ('pan', 'Panyabí'), 'sin': ('sin', 'Cingalés'), 'nep': ('nep', 'Nepalés'),
    'khm': ('khm', 'Jemer'), 'mon': ('mon', 'Mongol'), 'kat': ('kat', 'Georgiano'), 'geo': ('kat', 'Georgiano'),
    'hye': ('hye', 'Armenio'), 'arm': ('hye', 'Armenio'), 'aze': ('aze', 'Azerí'), 'kaz': ('kaz', 'Kazajo'),
    'afr': ('afr', 'Afrikáans'), 'swa': ('swa', 'Suajili'), 'bos': ('bos', 'Bosnio'), 'mlt': ('mlt', 'Maltés'),
    'lat': ('lat', 'Latín'), 'gle': ('gle', 'Irlandés'),
}
LANGUAGE_FIRST = ('spl', 'spa', 'eng')

IMDB = re.compile(r'(?<![A-Za-z0-9])tt\d{7,10}(?!\d)')
EXTENSION = re.compile(r'(?i)\.(?:mkv|mp4|avi|webm|m4v|mov|wmv|ts|srt|vtt|sub|ass|ssa)$')
EPISODE = re.compile(r'(?i)s(\d{1,3})e(\d{1,4})(?:e\d{1,4}|-e?\d{1,4})*')
CROSS_EPISODE = re.compile(r'(?i)(\d{1,2})x(\d{2,3})')
SEASON = re.compile(r'(?i)s\d{1,3}')
YEAR = re.compile(r'(?:19|20)\d\d')
RESOLUTION = re.compile(r'(?i)(?:\d{3,4}[pi]|4k|uhd|hdr\d*|dv|bluray|bdrip|brrip|web(?:-?dl|rip)?|hdtv|dvdrip|hdrip'
                        r'|x26[45]|h26[45]|hevc|av1|remux|repack|proper|extended|imax|amzn|nf|dsnp|hmax)')
MEDIA = {'bluray': 'bluray', 'bdrip': 'bluray', 'brrip': 'bluray', 'bd': 'bluray',
         'web': 'web', 'webrip': 'web', 'webdl': 'web', 'amzn': 'web', 'nf': 'web', 'dsnp': 'web', 'hmax': 'web',
         'hdtv': 'hdtv'}
SUBS_HOST = re.compile(r'subs\d*\.strem\.io')


class AddonError(Exception):
    def __init__(self, code):
        super().__init__(MESSAGES[code])
        self.code = code


def listing_error(code):
    return MESSAGES[code] if code == 'busy' else LISTING_ERROR


@dataclass(frozen=True)
class Guess:
    title: str | None = None
    year: int | None = None
    season: int | None = None
    episode: int | None = None
    imdb: str | None = None


@dataclass(frozen=True)
class MetaId:
    imdb: str
    season: int | None = None
    episode: int | None = None

    def __post_init__(self):
        if (not re.fullmatch(r'tt\d{7,10}', self.imdb)
                or (self.season is None) != (self.episode is None)
                or any(v is not None and not 0 <= v < 10000 for v in (self.season, self.episode))):
            raise ValueError('meta id')

    @property
    def type(self):
        return 'movie' if self.season is None else 'series'

    def path(self):
        return f'series/{self.imdb}:{self.season}:{self.episode}' if self.season is not None else f'movie/{self.imdb}'


@dataclass(frozen=True)
class Match:
    meta: MetaId
    label: str
    confidence: str

    def __post_init__(self):
        if self.confidence not in ('exact', 'doubtful', 'manual'):
            raise ValueError('confidence')

    def public(self):
        return dict(label=self.label, confidence=self.confidence)


@dataclass(frozen=True)
class Candidate:
    imdb: str
    kind: str
    title: str
    year: int | None = None

    def public(self):
        return dict(id=self.imdb, title=self.title, year=self.year)


@dataclass(frozen=True)
class Offer:
    id: str
    language: str
    language_name: str
    label: str
    note: str | None
    url: str = field(repr=False)

    def public(self):
        return dict(id=self.id, language=self.language, language_name=self.language_name,
                    label=self.label, note=self.note)


@dataclass(frozen=True)
class Listing:
    state: str = 'off'
    revision: int = 0
    match: Match | None = None
    alternatives: tuple[Candidate, ...] = ()
    offers: tuple[Offer, ...] = ()
    message: str | None = None

    def __post_init__(self):
        if self.state not in ('off', 'loading', 'ready', 'unidentified', 'error'):
            raise ValueError('state')

    def summary(self):
        return dict(state=self.state, revision=self.revision, match=self.match.public() if self.match else None,
                    message=self.message, count=len(self.offers))

    def public(self):
        return dict(self.summary(), alternatives=[c.public() for c in self.alternatives],
                    offers=[o.public() for o in self.offers])


def subtitle_language(code):
    return LANGUAGES.get(code, (code,))[0]


def clean(text, limit):
    text = ''.join(c for c in text if not unicodedata.category(c).startswith('C') or c in '\t\n')
    return re.sub(r'\s+', ' ', text).strip()[:limit].strip()


def readable(name):
    kept = re.sub(r'(?<=\d)\.(?=\d+(?![\dA-Za-z]))', '\0', name)
    return clean(re.sub(r'[._]', ' ', kept), 120).replace('\0', '.')


def fold(text):
    text = unicodedata.normalize('NFKD', text.casefold())
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', ''.join(c for c in text if not unicodedata.combining(c))).split())


def tokens_of(text):
    return [t for t in re.split(r'[^a-z0-9]+', fold(text)) if t]


def _parse(text):
    text = EXTENSION.sub('', text.replace('_', ' '))
    imdb = IMDB.search(text)
    text = re.sub(r'(?i)\b(s\d{1,3})[ ._-]+(e\d{1,4})\b', r'\1\2', IMDB.sub(' ', text))
    tokens = [t for t in (t.strip('-') for t in re.split(r'[\s.()\[\]{}]+', text)) if t]
    year = season = episode = None
    stop = len(tokens)
    for position, token in enumerate(tokens):
        found = EPISODE.fullmatch(token) or CROSS_EPISODE.fullmatch(token)
        if found:
            if season is None:
                season, episode = int(found[1]), int(found[2])
        elif YEAR.fullmatch(token) and position:
            if year is None:
                year = int(token)
        elif not (RESOLUTION.fullmatch(token) or SEASON.fullmatch(token)):
            continue
        stop = min(stop, position)
    return Guess(clean(' '.join(tokens[:stop]), 100) or None, year, season, episode, imdb[0] if imdb else None)


def parse_release(text, fallback=''):
    guess = _parse(text if isinstance(text, str) else '')
    other = _parse(fallback) if isinstance(fallback, str) and fallback else Guess()
    if guess.title is None:
        guess = Guess(other.title, guess.year or other.year, guess.season, guess.episode, guess.imdb)
    return Guess(guess.title, guess.year, guess.season, guess.episode, guess.imdb or other.imdb)


def _year(meta):
    found = re.match(r'\d{4}', str(meta.get('releaseInfo') or meta.get('year') or ''))
    return int(found[0]) if found else None


def choose_meta(guess, metas):
    kind = 'movie' if guess.season is None else 'series'
    wanted = fold(guess.title or '')
    words = set(wanted.split())
    scored = []
    for meta in (m for m in metas[:20] if isinstance(m, dict)):
        imdb, name = meta.get('id'), meta.get('name')
        if not (isinstance(imdb, str) and re.fullmatch(r'tt\d{7,10}', imdb) and isinstance(name, str)):
            continue
        title = clean(name, 100)
        year = _year(meta)
        folded = fold(title)
        named = set(folded.split())
        rank = 2 if wanted and folded == wanted else 1 if words and named and (named <= words or words <= named) else 0
        fits = guess.year is None or year is None or abs(guess.year - year) <= 1
        scored.append((rank, fits, Candidate(imdb, kind, title, year)))
    exact = [c for rank, fits, c in scored if rank == 2 and fits]
    best = max((s for s in scored if s[0]), key=lambda s: (s[0], s[1]), default=None)
    chosen = exact[0] if len(exact) == 1 else best[2] if best else None
    others = tuple(c for _, _, c in scored if c is not chosen)[:4]
    if chosen is None:
        return None, others
    meta = MetaId(chosen.imdb, guess.season, guess.episode)
    return Match(meta, match_label(chosen.title, chosen.year, meta), 'exact' if len(exact) == 1 else 'doubtful'), others


def parse_videos(payload):
    meta = payload.get('meta') if isinstance(payload, dict) else None
    videos = meta.get('videos') if isinstance(meta, dict) else None
    if not isinstance(videos, list):
        raise AddonError('bad_response')
    episodes = {}
    for video in videos:
        if not isinstance(video, dict):
            continue
        season, number = video.get('season'), video.get('episode', video.get('number'))
        if type(season) is not int or type(number) is not int or not 1 <= season < 1000 or not 0 <= number < 10000:
            continue
        name, released = video.get('name') or video.get('title'), video.get('released')
        released = released[:10] if isinstance(released, str) and re.match(r'\d{4}-\d\d-\d\d', released) else None
        episodes.setdefault((season, number), dict(season=season, number=number,
                                                   name=clean(name, 120) or None if isinstance(name, str) else None,
                                                   released=released))
    return [episodes[k] for k in sorted(episodes)]


@dataclass(frozen=True)
class TorrentStream:
    id: str
    info_hash: str
    file_idx: int
    filename: str
    seeders: int | None
    size: str | None
    resolution: str | None
    group: str | None
    trackers: tuple[str, ...] = field(repr=False, default=())

    def public(self):
        return dict(id=self.id, filename=self.filename, seeders=self.seeders, size=self.size, resolution=self.resolution)


def release_traits(filename):
    stem = EXTENSION.sub('', filename or '')
    resolution = re.search(r'(?i)(?<![0-9])(2160|1080|720|480)p', stem)
    group = re.search(r'-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$', stem)
    return (resolution[1] + 'p' if resolution else '2160p' if re.search(r'(?i)\b(4k|uhd)\b', stem) else None,
            group[1].lower() if group else None)


def parse_streams(payload):
    items = payload.get('streams') if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise AddonError('bad_response')
    streams, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            continue
        info_hash, file_idx, title = item.get('infoHash'), item.get('fileIdx'), item.get('title')
        if (not isinstance(info_hash, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', info_hash)
                or type(file_idx) is not int or not 0 <= file_idx < 100000 or (info_hash.lower(), file_idx) in seen):
            continue
        seen.add((info_hash.lower(), file_idx))
        hints = item.get('behaviorHints') if isinstance(item.get('behaviorHints'), dict) else {}
        lines = title.split('\n') if isinstance(title, str) else []
        filename = hints.get('filename') if isinstance(hints.get('filename'), str) else lines[0] if lines else ''
        filename = clean(filename.rsplit('/', 1)[-1], 180)
        seeders = re.search(r'\U0001F464\s*(\d{1,7})', title or '')
        size = re.search(r'\U0001F4BE\s*(\d{1,5}(?:\.\d{1,2})?\s*[KMGT]B)', title or '')
        trackers = tuple(s[8:] for s in item.get('sources') or () if isinstance(s, str) and s.startswith('tracker:')
                         and re.fullmatch(r'(?:udp|https?)://[\x21-\x7e]{1,300}', s[8:]))[:20]
        resolution, group = release_traits(filename)
        streams.append(TorrentStream(secrets.token_hex(12), info_hash.lower(), file_idx, filename or 'Archivo sin nombre',
                                     int(seeders[1]) if seeders else None, size[1] if size else None,
                                     resolution, group, trackers))
    return streams


def rank_streams(streams, reference_filenames=(), loaded_hashes=()):
    """Same torrent as a loaded episode, the loaded resolution, enough seeders, the loaded release group, more seeders."""
    traits = [release_traits(name) for name in reference_filenames]
    resolutions, groups = {r for r, _ in traits if r}, {g for _, g in traits if g}
    return sorted(streams, key=lambda s: (s.info_hash not in loaded_hashes, s.resolution not in resolutions,
                                          (s.seeders or 0) < HEALTHY_SEEDERS, s.group not in groups,
                                          -(s.seeders or 0)))[:MAX_STREAMS]


def torrentio_base(profile_paths):
    """The user's Torrentio URL from Stremio's own profile, so its filters apply; the public one otherwise."""
    for path in profile_paths:
        try:
            with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=1) as db:
                row = db.execute("select value from ItemTable where key = 'profile'").fetchone()
        except sqlite3.Error:
            continue
        value = row[0] if row else b''
        text = value.decode('utf-16-le', 'ignore') if isinstance(value, bytes) else str(value)
        found = re.search(r'https://torrentio\.strem\.fun/([A-Za-z0-9=|,%._-]{1,500})/manifest\.json', text)
        if found:
            return f'{TORRENTIO}/{found[1]}'
    return TORRENTIO


def match_label(title, year, meta):
    label = f'{title} ({year})' if title and year else title or meta.imdb
    return label if meta.season is None else f'{label} · T{meta.season} E{meta.episode}'


def valid_subtitle_url(url):
    if not isinstance(url, str) or not (url.isascii() and url.isprintable() and ' ' not in url and len(url) <= 512):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return (parts.scheme == 'https' and parts.hostname is not None and bool(SUBS_HOST.fullmatch(parts.hostname))
            and parts.netloc.lower() == parts.hostname and not parts.fragment)


def _language_key(code):
    if code in LANGUAGE_FIRST:
        return LANGUAGE_FIRST.index(code), '', code
    return len(LANGUAGE_FIRST), fold(LANGUAGES.get(code, (code, code))[1]), code


def _is_hearing_impaired(tokens, code):
    return bool({'sdh', 'hoh', 'cc'} & set(tokens) or 'hi' in tokens and code != 'hin'
                or {'hearing', 'impaired'} <= set(tokens))


def parse_offers(payload, source_filename):
    items = payload.get('subtitles') if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise AddonError('bad_response')
    source = set(tokens_of(EXTENSION.sub('', source_filename or '')))
    medium = {MEDIA[t] for t in source if t in MEDIA}
    seen, ranked = set(), []
    for item in items:
        if not isinstance(item, dict):
            continue
        code, url, name = item.get('lang'), item.get('url'), item.get('subtitleFileName') or item.get('movieReleaseName')
        if (not isinstance(code, str) or not re.fullmatch(r'[a-z]{3}', code) or not isinstance(name, str)
                or not valid_subtitle_url(url)):
            continue
        label = readable(EXTENSION.sub('', name))
        if not label or (code, label) in seen:
            continue
        seen.add((code, label))
        tokens = tokens_of(label)
        group = fold(item['releaseGroup']) if isinstance(item.get('releaseGroup'), str) else ''
        same_group = len(group) >= 3 and group in source and group not in MEDIA and not RESOLUTION.fullmatch(group)
        hearing = _is_hearing_impaired(tokens, code) or group == 'sdh'
        note = 'para sordos' if hearing else 'mismo origen' if same_group else None
        offer = Offer(secrets.token_hex(12), code, LANGUAGES.get(code, (code, code.upper()))[1], label, note, url)
        ranked.append((code, (hearing, not same_group, not ({MEDIA[t] for t in tokens if t in MEDIA} & medium),
                              -len(source.intersection(tokens)), len(ranked)), offer))
        if len(ranked) == MAX_OFFERS:
            break
    ranked.sort(key=lambda r: (_language_key(r[0]), r[1]))
    return tuple(offer for _, _, offer in ranked)


def _allowed(url):
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if not (url.isascii() and url.isprintable() and ' ' not in url) or parts.fragment or parts.username or parts.password:
        return False
    if parts.scheme == 'https':
        return parts.netloc in ('v3-cinemeta.strem.io', 'opensubtitles-v3.strem.io', 'torrentio.strem.fun') and parts.path.startswith('/')
    return (parts.scheme == 'http' and parts.netloc == '127.0.0.1:11470' and parts.path == '/subtitles.vtt'
            and parts.query.startswith('from='))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_, **__):
        return None


OPENER = build_opener(ProxyHandler({}), _NoRedirect)


def http_get(url, *, cap, deadline, cancelled=None):
    if not _allowed(url):
        raise AddonError('bad_response')
    if cancelled is not None and cancelled.is_set():
        raise AddonError('cancelled')
    limit = time.monotonic() + deadline
    try:
        with OPENER.open(Request(url, headers={'User-Agent': USER_AGENT}), timeout=min(deadline / 2, 4.0)) as response:
            if response.status != 200:
                raise AddonError('bad_response')
            body = bytearray()
            while True:
                if cancelled is not None and cancelled.is_set():
                    raise AddonError('cancelled')
                if time.monotonic() > limit:
                    raise AddonError('timeout')
                chunk = response.read1(CHUNK)
                if not chunk:
                    return bytes(body)
                body += chunk
                if len(body) > cap:
                    raise AddonError('too_large')
    except AddonError:
        raise
    except HTTPError as error:
        error.close()
        raise AddonError('busy' if error.code == 429 else 'bad_response') from None
    except TimeoutError:
        raise AddonError('timeout') from None
    except URLError as error:
        raise AddonError('timeout' if isinstance(error.reason, TimeoutError) else 'offline') from None
    except OSError:
        raise AddonError('offline') from None
    except Exception:
        raise AddonError('bad_response') from None


class StremioAddon:
    def __init__(self, get=http_get):
        self.get = get

    def _json(self, url, cancelled, cap=MAX_SUBTITLE):
        try:
            return json.loads(self.get(url, cap=cap, deadline=8, cancelled=cancelled))
        except (ValueError, RecursionError):
            raise AddonError('bad_response') from None

    def list(self, source, hint, cancelled):
        filename = source.get('filename') or ''
        base = parse_release(filename, source.get('release') or '')
        guess = base
        if hint:
            typed = parse_release(hint)
            guess = Guess(typed.title, typed.year, typed.season if typed.season is not None else base.season,
                          typed.episode if typed.season is not None else base.episode, typed.imdb)
        if guess.imdb:
            meta = MetaId(guess.imdb, guess.season, guess.episode)
            match = Match(meta, match_label(guess.title, guess.year, meta), 'manual' if hint else 'exact')
            alternatives = ()
        elif guess.title:
            kind = 'movie' if guess.season is None else 'series'
            metas = self._json(f'{CINEMETA}/catalog/{kind}/top/search={quote(guess.title, safe="")}.json', cancelled)
            metas = metas.get('metas') if isinstance(metas, dict) else None
            if not isinstance(metas, list):
                raise AddonError('bad_response')
            match, alternatives = choose_meta(guess, metas)
        else:
            return Listing('unidentified', message=UNIDENTIFIED)
        if match is None:
            return Listing('unidentified', alternatives=alternatives, message=UNIDENTIFIED)
        extra = f'/filename={quote(filename, safe="")}' if filename else ''
        payload = self._json(f'{OPENSUBTITLES}/subtitles/{match.meta.path()}{extra}.json', cancelled)
        return Listing('ready', match=match, alternatives=alternatives, offers=parse_offers(payload, filename))

    def guide(self, show, cancelled):
        metas = self._json(f'{CINEMETA}/catalog/series/top/search={quote(show, safe="")}.json', cancelled)
        metas = metas.get('metas') if isinstance(metas, dict) else None
        if not isinstance(metas, list):
            raise AddonError('bad_response')
        match, _ = choose_meta(Guess(show, None, 1, 1), metas)
        if match is None:
            return None
        payload = self._json(f'{CINEMETA}/meta/series/{match.meta.imdb}.json', cancelled, cap=MAX_META)
        return dict(title=match.label.split(' (')[0].split(' · ')[0], imdb=match.meta.imdb, episodes=parse_videos(payload))

    def streams(self, base, imdb, season, episode, cancelled):
        meta = MetaId(imdb, season, episode)
        return parse_streams(self._json(f'{base}/stream/{meta.path()}.json', cancelled, cap=MAX_META))

    def fetch(self, offer, cancelled):
        if not valid_subtitle_url(offer.url):
            raise AddonError('bad_response')
        body = self.get(ENGINE + quote(offer.url, safe=''), cap=MAX_SUBTITLE, deadline=3.5, cancelled=cancelled)
        try:
            return body.decode('utf-8')
        except UnicodeDecodeError:
            raise AddonError('bad_response') from None
