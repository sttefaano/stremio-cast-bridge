"""Memory-only preview. Launch manually; never connects to a receiver or Stremio."""
import argparse
import copy
import math
import secrets
import threading
from types import SimpleNamespace
from http.server import ThreadingHTTPServer

from addons import (FETCH_FAILED, LISTING_ERROR, UNIDENTIFIED, Candidate, Listing, Match, MetaId, match_label,
                    parse_offers, parse_release, subtitle_language)
from bridge import BridgeError, ControlHandler, lookup_hint, public_status, subtitle_ids, validate_stop_identity
from media import MediaError, normalize_subtitles, validate_choice, upload_label, MAX_STORAGE
from vod import SEGMENT_SECONDS

DEMO_OFFERS = dict(subtitles=[
    dict(lang=code, url=f'https://subs5.strem.io/demo/{n}', subtitleFileName=name, releaseGroup=group)
    for n, (code, name, group) in enumerate([
        ('spl', 'La.noche.del.faro.2026.WEB-DL.EJEMPLO.srt', 'EJEMPLO'),
        ('spa', 'La.noche.del.faro.2026.BluRay.srt', 'BluRay'),
        ('spa', 'La.noche.del.faro.2026.1080p.WEB-DL.SDH.srt', 'SDH'),
        ('eng', 'The.Lighthouse.Night.2026.1080p.WEB-DL.srt', 'WEB'),
        ('eng', 'The.Lighthouse.Night.2026.720p.HDTV.srt', 'HDTV'),
        ('eng', 'The.Lighthouse.Night.2026.WEB-DL.SDH.srt', 'SDH'),
        ('pob', 'A.Noite.do.Farol.2026.WEB-DL.srt', 'WEB'),
        ('ita', 'La.notte.del.faro.2026.CORRUPTO.srt', 'CORRUPTO')])])
DEMO_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nSubtítulo de ejemplo\n\n00:00:05.000 --> 00:00:08.000\nOtra línea de ejemplo\n'


class DemoBridge:
    def __init__(self):
        self.args = SimpleNamespace(device_name='TV simulada', subtitle_delay_ms=0)
        self.lock = threading.Lock()
        self.selected = None
        self.catalogues = {}
        self.uploads = {}
        self.upload_storage = 0
        self.listings = {}
        self.fetched = {}
        self.devices = [dict(id='demo-tv-a', name='Sala', host='192.0.2.2', model='Chromecast'),
                        dict(id='demo-tv-b', name='Sala', host='192.0.2.3', model='Google TV')]
        self.sources = [dict(id='demo-a', title='La noche del faro · ejemplo sintético',
                             filename='La.noche.del.faro.2026.EJEMPLO.mkv'),
                        dict(id='demo-b', title='Viaje al sur · ejemplo sintético',
                             filename='Viaje.al.sur.EJEMPLO.mp4')]
        self.state = dict(demo=True, phase='idle', message='Elegí una película de ejemplo.',
                          sources=self.sources, pending=False, command_pending=False, title='',
                          duration=5400, absolute_time=0, subtitle_delay_ms=0,
                          subtitles_enabled=None, volume=None, muted=None, playback_id=None,
                          catalogues={}, active_catalogue=None, subtitle_choice=None,
                          source_discovery='ready', source_error=None,
                          source_id=None, buffered_start=None, buffered_end=None, scenario='ready',
                          action_error_revision=0, devices=[], selected_device=None, device_revision=0,
                          device_discovery='ready', device_error=None, can_change_device=True)
        self.state['devices'] = self.devices

    def request_catalogue(self, data):
        with self.lock:
            if (set(data) != {'source_id', 'refresh'} or type(data['refresh']) is not bool
                    or not isinstance(data['source_id'], str)):
                raise BridgeError('Solicitud de catálogo inválida.')
            source = next((v for v in self.sources if v['id'] == data['source_id']), None)
            if not source:
                raise BridgeError('Elegí un ejemplo.', 404, 'unknown_source')
            snapshot = self.state['catalogues'].get(source['id'])
            if not snapshot or data['refresh']:
                if len(self.catalogues) >= 8:
                    active = (self.state['active_catalogue'] or {}).get('id')
                    latest = {s['catalogue']['id'] for s in self.state['catalogues'].values()}
                    candidates = [identity for identity in self.catalogues if identity != active]
                    evicted = next((identity for identity in candidates if identity not in latest),
                                   candidates[0] if candidates else None)
                    if evicted is None:
                        raise BridgeError('Todos los análisis están en uso.', 409, 'catalogue_limit')
                    del self.catalogues[evicted]
                    self.state['catalogues'] = {source: snapshot for source, snapshot in self.state['catalogues'].items()
                                                if snapshot['catalogue']['id'] != evicted}
                    for key in [key for key in self.uploads if key[0] == evicted]:
                        self.upload_storage -= len(key[1])
                        del self.uploads[key]
                    self.listings.pop(evicted, None)
                    self.fetched = {key: entry for key, entry in self.fetched.items() if key[0] != evicted}
                identity = secrets.token_hex(12)
                entries = [dict(id=identity + '-eng', kind='embedded', label='English · ejemplo', language='eng', supported=True, reason=None),
                           dict(id=identity + '-jpn', kind='embedded', label='日本語 · ejemplo', language='jpn', supported=True, reason=None),
                           dict(id=identity + '-pgs', kind='embedded', label='Imagen PGS · ejemplo', language='fra', supported=False, reason='Subtítulos de imagen no compatibles.')]
                catalogue = dict(id=identity, source_id=source['id'], duration=5400, entries=entries)
                self.listings[identity] = self._listing(source, None, 1)
                catalogue['addon'] = self.listings[identity].summary()
                self.catalogues[identity] = catalogue
                snapshot = dict(state='ready', catalogue=catalogue)
                self.state['catalogues'][source['id']] = snapshot
            return 200, copy.deepcopy(dict(catalogue=snapshot['catalogue']))

    def subtitle_upload(self, data):
        if (set(data) != {'source_id', 'catalogue_id', 'filename', 'format', 'text'}
                or not all(isinstance(data[k], str) for k in data)):
            raise BridgeError('Solicitud de archivo inválida.')
        canonical = normalize_subtitles(data['format'], data['text'])
        with self.lock:
            catalogue = self.catalogues.get(data['catalogue_id'])
            if not catalogue or catalogue['source_id'] != data['source_id']:
                raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
            latest = self.state['catalogues'].get(data['source_id'], {}).get('catalogue', {}).get('id')
            active = (self.state['active_catalogue'] or {}).get('id')
            if catalogue['id'] not in (latest, active):
                raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
            label = upload_label(data['filename'])
            key = (catalogue['id'], canonical)
            entry = self.uploads.get(key)
            if not entry:
                if (sum(e['kind'] == 'upload' for e in catalogue['entries']) >= 8
                        or self.upload_storage + len(canonical) > MAX_STORAGE):
                    raise BridgeError('Límite de subtítulos locales alcanzado.', 413, 'upload_limit')
                entry = dict(id=secrets.token_hex(12), kind='upload', label=label,
                             language=None, supported=True, reason=None)
                self.uploads[key] = entry
                self.upload_storage += len(canonical)
                catalogue['entries'].append(entry)
            if self.state['active_catalogue'] and self.state['active_catalogue']['id'] == catalogue['id']:
                self.state['active_catalogue'] = catalogue
            return copy.deepcopy(dict(entry=entry, catalogue=catalogue))

    def _listing(self, source, hint, revision):
        if hint == 'error':
            return Listing('error', revision, message=LISTING_ERROR)
        others = (Candidate('tt0000002', 'movie', 'Otra película de ejemplo', 2024),
                  Candidate('tt0000003', 'movie', 'Un tercer ejemplo', None))
        if hint == 'nada':
            return Listing('unidentified', revision, alternatives=others, message=UNIDENTIFIED)
        guess = parse_release(hint or source['filename'])
        meta = MetaId('tt0000001')
        confidence = 'manual' if hint else 'doubtful' if source['id'] == 'demo-b' else 'exact'
        match = Match(meta, match_label(guess.title or source['title'], guess.year, meta), confidence)
        return Listing('ready', revision, match, others, parse_offers(DEMO_OFFERS, source['filename']))

    def _target(self, data):
        catalogue = self.catalogues.get(data['catalogue_id'])
        if not catalogue or catalogue['source_id'] != data['source_id']:
            raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
        latest = self.state['catalogues'].get(data['source_id'], {}).get('catalogue', {}).get('id')
        active = (self.state['active_catalogue'] or {}).get('id')
        if catalogue['id'] not in (latest, active):
            raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
        return catalogue

    def _publish(self, catalogue, listing=None):
        if listing:
            self.listings[catalogue['id']] = listing
            catalogue['addon'] = listing.summary()
        if self.state['active_catalogue'] and self.state['active_catalogue']['id'] == catalogue['id']:
            self.state['active_catalogue'] = catalogue

    def subtitle_lookup(self, data):
        subtitle_ids(data, nullable=('hint',))
        hint = lookup_hint(data['hint'])
        with self.lock:
            catalogue = self._target(data)
            source = next(v for v in self.sources if v['id'] == catalogue['source_id'])
            self._publish(catalogue, self._listing(source, hint, self.listings[catalogue['id']].revision + 1))
            return copy.deepcopy(dict(catalogue=catalogue))

    def subtitle_offers(self, data):
        subtitle_ids(data)
        with self.lock:
            return self.listings[self._target(data)['id']].public()

    def subtitle_fetch(self, data):
        subtitle_ids(data, 'offer_id')
        with self.lock:
            catalogue = self._target(data)
            offer = next((o for o in self.listings[catalogue['id']].offers if o.id == data['offer_id']), None)
            if offer is None:
                raise BridgeError('La lista de subtítulos cambió. Volvé a elegir.', 409, 'stale_offer')
            existing = self.fetched.get((catalogue['id'], offer.id))
            if existing:
                return copy.deepcopy(dict(entry=existing, catalogue=catalogue))
        try:
            normalize_subtitles('vtt', 'esto no es un subtítulo' if 'CORRUPTO' in offer.label else DEMO_VTT, lenient=True)
        except MediaError:
            raise BridgeError(FETCH_FAILED, 422, 'invalid_subtitle') from None
        with self.lock:
            catalogue = self._target(data)
            entry = self.fetched.get((catalogue['id'], offer.id))
            if entry is None:
                entry = dict(id=secrets.token_hex(12), kind='addon', label=offer.label,
                             language=subtitle_language(offer.language), supported=True, reason=None)
                self.fetched[(catalogue['id'], offer.id)] = entry
                catalogue['entries'].append(entry)
            self._publish(catalogue)
            return copy.deepcopy(dict(entry=entry, catalogue=catalogue))

    def _choice(self, action, data):
        fields = {'device_id', 'device_revision', 'catalogue_id', 'subtitle_id', 'delay_ms'}
        fields |= {'source_id'} if action == 'start' else {'playback_id', 'enabled'}
        if set(data) != fields:
            raise BridgeError('Faltan campos de subtítulos.')
        identifiers = ('device_id', 'catalogue_id', 'source_id' if action == 'start' else 'playback_id')
        if (not all(isinstance(data[k], str) and data[k] for k in identifiers)
                or type(data['device_revision']) is not int):
            raise BridgeError('Identidad de reproducción inválida.')
        enabled = data['subtitle_id'] is not None if action == 'start' else data['enabled']
        validate_choice(data['subtitle_id'], data['delay_ms'], enabled)
        catalogue = self.catalogues.get(data['catalogue_id'])
        source_id = data.get('source_id') if action == 'start' else self.state['source_id']
        if not catalogue or catalogue['source_id'] != source_id:
            raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
        if action == 'start' and self.state['catalogues'].get(source_id, {}).get('catalogue', {}).get('id') != catalogue['id']:
            raise BridgeError('El catálogo cambió.', 409, 'stale_catalogue')
        if action == 'subtitles' and (data['playback_id'] != self.state['playback_id'] or not data['playback_id']
                                     or catalogue['id'] != self.state['active_catalogue']['id']):
            raise BridgeError('La reproducción cambió.', 409, 'stale_playback')
        entry = next((e for e in catalogue['entries'] if e['id'] == data['subtitle_id']), None)
        if data['subtitle_id'] is not None and not entry:
            raise BridgeError('Subtítulo ajeno.', 409, 'stale_subtitle')
        if entry and not entry['supported']:
            raise BridgeError('Subtítulo no compatible.', 422, 'unsupported_subtitle')
        return catalogue, dict(catalogue_id=catalogue['id'], subtitle_id=data['subtitle_id'], enabled=enabled,
                               delay_ms=data['delay_ms'], label=entry['label'] if entry else 'Sin subtítulos',
                               language=entry['language'] if entry else None)

    def status(self):
        with self.lock:
            return copy.deepcopy({**public_status(self.state), 'scenario': self.state['scenario']})

    def submit(self, action, data):
        with self.lock:
            s = self.state
            if action == 'scenario':
                value = data.get('state')
                if value in ('devices-loading', 'devices-empty', 'devices-error'):
                    s.update(devices=[], device_discovery={'devices-loading':'loading', 'devices-empty':'ready', 'devices-error':'error'}[value],
                             device_error='Error sintético de búsqueda. Reintentá.' if value == 'devices-error' else None,
                             scenario=value)
                    if s['selected_device']:
                        s['selected_device'] = {**s['selected_device'], 'available': False}
                    return
                if value not in ('empty', 'loading', 'error', 'foreign', 'disconnect', 'ready'):
                    raise BridgeError('Estado de prueba desconocido.')
                s.update(action_error=None, pending=False, volume=None, muted=None, scenario=value,
                         buffered_start=None, buffered_end=None)
                if value in ('empty', 'ready'):
                    s.update(phase='idle', can_change_device=True, sources=[] if value == 'empty' else self.sources,
                             title='', source_id=None, absolute_time=0,
                             message='Lista vacía de prueba.' if value == 'empty' else 'Elegí un ejemplo.')
                else:
                    s.update(can_change_device=False, devices=self.devices, device_discovery='ready')
                    if not s['selected_device']:
                        s.update(selected_device={**self.devices[0], 'available':True}, device_revision=s['device_revision'] + 1)
                    phase = {'foreign': 'receiver_changed', 'disconnect': 'disconnected'}.get(value, value)
                    s.update(phase=phase, pending=value == 'loading', message={
                        'loading': 'Preparando el ejemplo. Podés cancelar.',
                        'error': 'Falló el ejemplo. Buscá películas y reintentá.',
                        'foreign': 'La TV reproduce otro contenido.',
                        'disconnect': 'TV simulada desconectada. Buscá películas para reintentar.'}[value])
                    if value == 'error':
                        s.update(action_error=s['message'], action_error_revision=s['action_error_revision'] + 1)
                return
            if action == 'discover_devices':
                s.update(devices=self.devices, device_discovery='ready', device_error=None)
                if s['selected_device']:
                    s['selected_device'] = {**s['selected_device'], 'available': True}
                return
            if action == 'select_device':
                if type(data.get('device_revision')) is not int or data['device_revision'] != s['device_revision']:
                    raise BridgeError('El destino cambió. Revisá el dispositivo y volvé a intentar.')
                target = next((v for v in s['devices'] if v['id'] == data.get('device_id')), None)
                if not target:
                    raise BridgeError('Elegí un dispositivo disponible.')
                if s['selected_device'] and target['id'] == s['selected_device']['id']:
                    return
                if not s['can_change_device']:
                    raise BridgeError('Primero detené la sesión antes de cambiar de dispositivo.')
                s.update(selected_device={**target, 'available': True}, device_revision=s['device_revision'] + 1)
                return
            if action in ('start', 'pause', 'resume', 'seek', 'volume', 'mute', 'subtitles') or action == 'stop' and s['selected_device']:
                if (not s['selected_device'] or data.get('device_id') != s['selected_device']['id']
                        or type(data.get('device_revision')) is not int or data.get('device_revision') != s['device_revision']):
                    raise BridgeError('El destino cambió o no está elegido. Revisá el dispositivo.')
                if action == 'start' and not s['selected_device']['available']:
                    raise BridgeError('El dispositivo elegido no está disponible.')
            if action == 'discover':
                s.update(sources=self.sources, phase='idle' if s['phase'] not in ('playing', 'paused') else s['phase'],
                         source_discovery='ready', source_error=None, scenario='ready')
                return
            if action == 'start':
                catalogue, choice = self._choice(action, data)
                source = next((v for v in self.sources if v['id'] == data.get('source_id')), None)
                if source is None:
                    raise BridgeError('Elegí un ejemplo.')
                if s['subtitle_choice'] == choice and s['source_id'] == source['id'] and s['phase'] in ('playing', 'paused'):
                    return
                self.selected = source['id']
                s.update(phase='playing', can_change_device=False, title=source['title'], absolute_time=0, volume=.35,
                         muted=False, subtitle_delay_ms=choice['delay_ms'], subtitle_choice=choice,
                         active_catalogue=catalogue, playback_id=secrets.token_hex(16), subtitles_enabled=choice['enabled'],
                         source_id=self.selected, sources=self.sources, scenario='ready',
                         pending=False, action_error=None, message='Reproduciendo el ejemplo.')
                self._convert_from(0)
                return
            if action == 'stop':
                validate_stop_identity(s, data)
                s.update(phase='stopped', can_change_device=True, pending=False, scenario='ready' if s['sources'] else 'empty', message='Ejemplo detenido.', volume=None, muted=None,
                          buffered_start=None, buffered_end=None, playback_id=None, subtitle_choice=None, active_catalogue=None, subtitles_enabled=None)
                return
            if s['phase'] not in ('playing', 'paused'):
                raise BridgeError('La TV simulada no está reproduciendo esta película.')
            if action in ('pause', 'resume'):
                s.update(phase='paused' if action == 'pause' else 'playing')
            elif action == 'seek':
                position = data.get('position', s['absolute_time'] + data.get('delta', 0))
                if type(position) not in (float, int) or not math.isfinite(position):
                    raise BridgeError('Posición inválida.')
                s['absolute_time'] = min(s['duration'], max(0, position))
                if not s['buffered_start'] <= s['absolute_time'] < s['buffered_end']:
                    self._convert_from(s['absolute_time'])
            elif action == 'volume':
                level = data.get('level')
                if type(level) not in (int, float) or not math.isfinite(level) or not 0 <= level <= 1:
                    raise BridgeError('Volumen inválido.')
                s['volume'] = level
            elif action == 'mute':
                if type(data.get('muted')) is not bool:
                    raise BridgeError('Valor inválido.')
                s['muted'] = data['muted']
            elif action == 'subtitles':
                catalogue, choice = self._choice(action, data)
                previous = s['subtitle_choice']
                if previous['subtitle_id'] != choice['subtitle_id']:
                    self._convert_from(s['absolute_time'])
                s.update(subtitle_choice=choice, subtitle_delay_ms=choice['delay_ms'], subtitles_enabled=choice['enabled'])
            else:
                raise BridgeError('Acción desconocida.')
            s['message'] = 'En pausa.' if s['phase'] == 'paused' else 'Reproduciendo el ejemplo.'


    def _convert_from(self, position):
        """The real TV jumps by itself; only a jump outside what is converted restarts conversion there."""
        start = position // SEGMENT_SECONDS * SEGMENT_SECONDS
        self.state.update(buffered_start=start, buffered_end=min(self.state['duration'], start + 60))


def arguments(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', choices=['127.0.0.1'], default='127.0.0.1')
    p.add_argument('--port', type=int, default=18777)
    p.add_argument('--lifetime', type=float, default=7200)
    args = p.parse_args(argv)
    if not 1024 <= args.port <= 65535 or args.port in (18766, 18767):
        p.error('Use an unprivileged preview port other than 18766/18767.')
    if not math.isfinite(args.lifetime) or not 0 < args.lifetime <= 7200:
        p.error('Lifetime must be between 0 and 7200 seconds.')
    return args


def main(argv=None):
    args = arguments(argv)
    with ThreadingHTTPServer((args.host, args.port), ControlHandler) as server:
        server.bridge = DemoBridge()
        server.token = secrets.token_hex(24)
        timer = threading.Timer(args.lifetime, server.shutdown)
        timer.daemon = True
        timer.start()
        print(f'Modo de prueba — No controla tu TV: http://127.0.0.1:{args.port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            timer.cancel()


if __name__ == '__main__':
    main()
