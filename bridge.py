"""Local, explicitly controlled Stremio → HLS → Chromecast bridge."""
import argparse
import functools
import hashlib
import io
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import threading
import time
import tempfile
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen
from dataclasses import replace
from addons import StremioAddon
from media import SetupCatalogue, MediaError, analyse, validate_choice, UPLOAD_BODY_LIMIT
from vod import SEGMENT_SECONDS, SUSPEND_AHEAD, Producer, VodLayout

FFMPEG = '/Applications/Stremio.app/Contents/MacOS/ffmpeg'
FFPROBE = '/Applications/Stremio.app/Contents/MacOS/ffprobe'
ROOT = Path(__file__).resolve().parent
PRIVATE_SOURCE_KEYS = ('url', 'release')
MIME = {'.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt'}


DELAY_PART = re.compile(r'd(0|-?[1-9]\d{0,4})')
SUBTITLE_PLAYLIST = 'video_vtt.m3u8'
# Cues that start this many segments before a window can still be on screen in it.
CUE_LOOKBACK = 2
DUPLICATE_MS = 100
CUE_TIMING = re.compile(r'((?:\d+:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)')


def media_request(request_path):
    """'/<session>/d<delay>/<name>' as (session, delay_ms, name); names are checked against the layout."""
    try:
        parts = unquote(urlsplit(request_path).path).lstrip('/').split('/')
    except ValueError:
        return None
    if len(parts) != 3 or any(p in ('', '.', '..') or '\\' in p or '\x00' in p for p in parts):
        return None
    delay = DELAY_PART.fullmatch(parts[1])
    if not delay or abs(int(delay[1])) > 30000:
        return None
    return parts[0], int(delay[1]), parts[2]


def open_media(root, path):
    """Open relative to held directories, rejecting symlink swaps as well."""
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        session_fd = os.open(path.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            media_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=session_fd)
        finally:
            os.close(session_fd)
    finally:
        os.close(root_fd)
    if not stat.S_ISREG(os.fstat(media_fd).st_mode):
        os.close(media_fd)
        raise OSError('Not a regular media resource')
    return os.fdopen(media_fd, 'rb')


def subtitle_segment(root, producer, index, delay_ms):
    """Window index of the layout, built from every source segment whose cues can land in it after the delay."""
    layout = producer.layout
    window = layout.window(index)
    # Cues of a negative delay come from later segments: wait for those while the producer is making them.
    last = max(index, layout.index_at((window[1] - 1 - delay_ms) / 1000))
    first = max(0, layout.index_at((window[0] - delay_ms) / 1000) - CUE_LOOKBACK)
    if not producer.request(index, extra=range(index + 1, last + 1)):
        return None
    cues = []
    for source in range(first, last + 1):
        # A .vtt is written in place; it is final only once its .ts segment exists.
        if producer.complete(source):
            try:
                cues += segment_cues(root, producer.directory / layout.cue_name(source))
            except OSError:
                pass
    return io.BytesIO(shifted_cues(cues, window, delay_ms).encode())


def segment_cues(root, path):
    info = path.stat()
    return file_cues(root, path, info.st_ino, info.st_mtime_ns, info.st_size)


@functools.lru_cache(maxsize=8192)
def file_cues(root, path, *identity):
    with open_media(root, path) as stream:
        return tuple(parse_cues(stream.read().decode('utf-8', 'replace')))


def shifted_cues(cues, window, delay_ms):
    # A restart clips a cue that crosses its first segment, so the earlier run may hold the same cue
    # with an earlier start; the two runs' timestamps differ by tens of milliseconds.
    kept = []
    for cue in sorted(cues, key=lambda cue: (cue[3], cue[2], cue[1])):
        if kept and kept[-1][2:] == cue[2:] and cue[1] - kept[-1][1] <= DUPLICATE_MS:
            kept[-1] = min(kept[-1], cue)
        else:
            kept.append(cue)
    shown = sorted((max(0, start + delay_ms), end + delay_ms, settings, text) for start, end, settings, text in kept
                   if end + delay_ms > window[0] and max(0, start + delay_ms) < window[1])
    return 'WEBVTT\n' + ''.join(f'\n{timestamp(start)} --> {timestamp(end)}{settings}\n{text}\n'
                                for start, end, settings, text in shown)


def parse_cues(text):
    cues = []
    for block in re.split(r'\n[ \t]*\n', text.replace('\r\n', '\n')):
        lines = block.strip('\n').split('\n')
        for index, line in enumerate(lines):
            timing = CUE_TIMING.match(line)
            if timing:
                cues.append((milliseconds(timing[1]), milliseconds(timing[2]), timing[3].rstrip(),
                             '\n'.join(lines[index + 1:])))
                break
    return cues


def milliseconds(stamp):
    *hours, minutes, seconds = stamp.split(':')
    return round((int(hours[0] if hours else 0) * 3600 + int(minutes) * 60 + float(seconds)) * 1000)


def timestamp(ms):
    return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02}.{ms % 1000:03}'


CLIP_SEEK_PREROLL = ("noise=amount=0:drop='lte(pts+duration,0)',"
                   "setts=pts='max(PTS,0)':dts='max(DTS,0)':duration='max(0,DURATION+min(0,PTS))'")
# setts holds each packet until the next one arrives, so a sparse embedded track would write a cue
# segments after its window. A stored file is read ahead and is not delayed, so it keeps the clip.
DROP_SEEK_PREROLL = "noise=amount=0:drop='lt(pts,0)'"


def ffmpeg_command(source, session, plan, start_index=0, duration=None, readrate=1.1):
    """Segment start_index onward; a later start keeps absolute segment numbers and timestamps."""
    analysis = plan.catalogue.analysis
    subtitle = plan.subtitle
    seek = ['-ss', str(start_index * SEGMENT_SECONDS)] if start_index else []
    command = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-rw_timeout', '15000000', '-readrate', str(readrate), '-readrate_initial_burst', '30']
    command += seek + ['-i', source]
    if subtitle and subtitle.path:
        command += seek + ['-i', str(subtitle.path)]
    if duration is not None:
        command += ['-t', str(duration)]
    for index in (analysis.video, analysis.audio):
        command += ['-map', f'0:{index}']
    if subtitle:
        command += ['-map', '1:0' if subtitle.path else f'0:{subtitle.index}']
    captions = []
    mapping = 'v:0,a:0'
    if subtitle:
        language = subtitle.language or 'und'
        captions = ['-c:s', 'webvtt', '-bsf:s', CLIP_SEEK_PREROLL if subtitle.path else DROP_SEEK_PREROLL,
                    '-metadata:s:s:0', f'language={language}']
        mapping += f',s:0,sgroup:subs,language:{language}'
    return command + ['-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', '24', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level:v', '3.1',
        '-g', '144', '-sc_threshold', '0', '-force_key_frames', f'expr:gte(t,n_forced*{SEGMENT_SECONDS})',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2'] + captions + (
        ['-output_ts_offset', str(start_index * SEGMENT_SECONDS), '-start_number', str(start_index)] if start_index else []) + [
        '-f', 'hls', '-hls_time', str(SEGMENT_SECONDS), '-hls_list_size', '0',
        '-hls_flags', 'independent_segments+temp_file', '-hls_playlist_type', 'event',
        '-master_pl_name', 'master.m3u8', '-var_stream_map', mapping,
        '-hls_segment_filename', str(session / 'segment-%04d.ts'), str(session / 'video.m3u8')]


STATUS_KEYS = {'phase', 'message', 'title', 'duration', 'absolute_time',
               'source_discovery', 'source_error', 'catalogues', 'active_catalogue', 'subtitle_choice', 'playback_id',
               'devices', 'selected_device', 'device_discovery', 'device_error', 'device_revision', 'can_change_device',
               'receiver_state', 'active_subtitle_track_ids', 'subtitle_delay_ms',
               'session', 'ffmpeg_pid', 'ffmpeg_alive', 'producer_suspended', 'segment_count',
               'generation_complete', 'sources', 'pending', 'storage_bytes',
               'volume', 'muted', 'subtitles_enabled', 'action_error', 'command_pending', 'demo',
               'action_error_revision', 'source_id', 'buffer_ahead_seconds', 'buffered_start', 'buffered_end'}


def public_status(state):
    result = {key: value for key, value in state.items() if key in STATUS_KEYS}
    result.update(buffer_ahead_seconds=None, buffered_start=None, buffered_end=None)
    values = [state.get(k) for k in ('buffered_start', 'buffered_end', 'absolute_time', 'duration')]
    if (state.get('phase') in ('buffering', 'loading', 'playing', 'paused')
            and all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in values)):
        start, end, position, duration = values
        if 0 < duration and start <= end:
            end = min(duration, end)
            result.update(buffered_start=min(start, end), buffered_end=end,
                          buffer_ahead_seconds=max(0, end - max(start, position)))
    return result


def buffered_run(layout, completed, index):
    """The contiguous segments on disk around index, in movie seconds."""
    if index not in completed:
        return None, None
    first = last = index
    while first - 1 in completed:
        first -= 1
    while last + 1 in completed:
        last += 1
    return layout.start(first), layout.start(last) + layout.length(last)


class BridgeError(MediaError):
    pass


class PreparationCancelled(BridgeError):
    pass


def validate_stop_identity(state, data):
    fields = {'device_id', 'device_revision'} if state.get('selected_device') else set()
    if set(data) not in (fields, fields | {'playback_id'}):
        raise BridgeError('Solicitud de detención inválida.')
    if 'playback_id' in data:
        identity = data['playback_id']
        if not isinstance(identity, str) or not identity:
            raise BridgeError('Identidad de reproducción inválida.')
        if identity != state.get('playback_id'):
            raise BridgeError('La reproducción cambió. Revisá la película activa.', 409, 'stale_playback')
    elif state.get('phase') in ('playing', 'paused'):
        raise BridgeError('Confirmá la reproducción que querés detener.', 409, 'stale_playback')


def discover_receivers(known_host=None):
    """One bounded mDNS snapshot; no Cast controller or host-polling thread."""
    from pychromecast.const import CAST_TYPES
    from pychromecast.dial import get_device_info
    from pychromecast.models import CastInfo, HostServiceInfo
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
    from uuid import UUID

    if known_host:
        # Explicit host opt-in can work without multicast. This is metadata HTTP only.
        status = get_device_info(known_host, timeout=3)
        if status and status.uuid:
            return [CastInfo({HostServiceInfo(known_host, 8009)}, status.uuid,
                                   status.model_name, status.friendly_name, known_host, 8009,
                                   status.cast_type, status.manufacturer)]
        return []

    devices, lock = {}, threading.Lock()

    class Listener(ServiceListener):
        def add_service(self, zconf, service_type, name):
            info = zconf.get_service_info(service_type, name, timeout=500)
            if info is None:
                return
            try:
                props = info.properties
                model = props.get(b'md', b'').decode('utf-8')
                friendly = props.get(b'fn', b'').decode('utf-8') or 'Google Cast'
                identity = UUID(props[b'id'].decode('ascii'))
                addresses = info.parsed_addresses()
                host = next(address for address in addresses if ipaddress.ip_address(address).version == 4)
                kind, maker = CAST_TYPES.get(model.lower(), (None, None))
                if info.port != 8009:
                    kind = 'group'
                elif b'ca' in props:
                    # Cast's advertised VIDEO_OUT bit; audio-only receivers have no bit.
                    kind = 'cast' if int(props[b'ca']) & 1 else 'audio'
                value = CastInfo({HostServiceInfo(host, info.port)}, identity, model,
                                 friendly, host, info.port, kind, maker)
            except (KeyError, ValueError, UnicodeError, StopIteration):
                return
            with lock:
                devices[name] = value

        def update_service(self, zconf, service_type, name):
            self.add_service(zconf, service_type, name)

        def remove_service(self, zconf, service_type, name):
            with lock:
                devices.pop(name, None)

    zconf = Zeroconf()
    browser = None
    try:
        browser = ServiceBrowser(zconf, '_googlecast._tcp.local.', Listener())
        time.sleep(5)
    finally:
        try:
            if browser:
                browser.cancel()
        finally:
            zconf.close()
    with lock:
        result = list(devices.values())
    return result


def receiver_metadata(info):
    return dict(id=str(info.uuid), name=info.friendly_name, host=info.host, model=info.model_name)


def probe(source, cancelled=None):
    try:
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen([FFPROBE, '-v', 'error', '-rw_timeout', '15000000',
            '-analyzeduration', '5000000', '-probesize', '5000000', '-show_streams',
            '-show_format', '-of', 'json', source], stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 30
            try:
                while process.poll() is None:
                    if (cancelled and cancelled.is_set() or time.monotonic() > deadline
                            or os.fstat(output.fileno()).st_size > 2 * 1024**2):
                        raise ValueError()
                    time.sleep(.02)
                if process.returncode or os.fstat(output.fileno()).st_size > 2 * 1024**2:
                    raise ValueError()
                output.seek(0)
                return analyse(json.loads(output.read(2 * 1024**2 + 1)))
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=2)
    except BridgeError:
        raise
    except Exception:
        raise BridgeError('No se pudo analizar la fuente en 30 segundos; abrila en Stremio y reintentá.') from None


def subtitle_ids(data, *strings, nullable=()):
    required = {'source_id', 'catalogue_id', *strings}
    if (set(data) != required | set(nullable) or not all(isinstance(data[k], str) for k in required)
            or not all(data[k] is None or isinstance(data[k], str) for k in nullable)):
        raise BridgeError('Solicitud de subtítulos inválida.')


def lookup_hint(hint):
    if hint is not None and (len(hint) > 200 or any(unicodedata.category(c) == 'Cc' for c in hint)):
        raise BridgeError('Título o ID inválido.')
    return hint and hint.strip() or None


class Bridge:
    """A single mutation worker; status reads never wait for probe or discovery."""
    def __init__(self, args, lan_ip=None):
        self.args, self.lan_ip = args, lan_ip
        self.sessions = ROOT / '.local' / 'sessions'
        self.sessions.mkdir(parents=True, exist_ok=True)
        self.state_lock = threading.Lock()
        self.state = {'phase': 'idle', 'message': 'Elegí una película y tocá Ver en la TV.',
                      'subtitle_delay_ms': args.subtitle_delay_ms, 'sources': [], 'pending': False,
                      'subtitles_enabled': None, 'volume': None, 'muted': None,
                      'playback_id': None, 'subtitle_choice': None, 'active_catalogue': None}
        self.sources = []
        self.devices = {}
        self.selected_device_id = None
        self.device_revision = 0
        self.destination_locked = False
        self.state.update(devices=[], selected_device=None, device_discovery='idle', device_error=None, device_revision=0)
        self.selected = None
        self.active_plan = None
        self.cast = self.browser = self.producer = self.session = None
        self.media_server = None
        self.media_url = None
        self.receiver_confirmed = False
        self.loaded = self.paused = False
        self.load_time = self.duration = 0
        self.jobs = queue.Queue(maxsize=16)
        self.cancel_generation = 0
        self.active_generation = 0
        self.connection_generation = None
        self.cleanup_active = False
        self.shutdown_error = None
        self.quit = threading.Event()
        self.device_lock = threading.Lock()
        self.source_lock = threading.Lock()
        self.device_snapshot = dict(device_discovery='idle', device_error=None, devices=[])
        self.source_snapshot = dict(source_discovery='idle', source_error=None, sources=[])
        self.device_wake, self.source_wake = threading.Event(), threading.Event()
        self.catalogue = SetupCatalogue(lambda source, cancelled: probe(source, cancelled), ROOT / '.local',
                                        None if args.no_stremio_subtitles else StremioAddon())
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()
        self.metadata_workers = [threading.Thread(target=self._scan_loop, args=(self.scan_devices, self.device_wake), daemon=True),
                                 threading.Thread(target=self._scan_loop, args=(self.discover, self.source_wake), daemon=True)]
        for worker in self.metadata_workers:
            worker.start()
        if args.device_name or args.device_host:
            bootstrap = threading.Thread(target=self._configured_startup, daemon=True)
            self.metadata_workers.append(bootstrap)
            bootstrap.start()

    def update(self, **values):
        with self.state_lock:
            self.state.update(values)

    def status(self):
        with self.state_lock:
            result = public_status(dict(self.state))
            result['can_change_device'] = not self._destination_busy()
            plan = getattr(self, 'active_plan', None)
        if hasattr(self, 'device_lock'):
            with self.device_lock:
                result.update(self.device_snapshot)
                devices = dict(self.devices)
            selected = result.get('selected_device')
            if selected:
                info = devices.get(selected['id'])
                result['selected_device'] = {**(receiver_metadata(info) if info else selected),
                                             'available': bool(info) and result['device_discovery'] != 'error'}
        if hasattr(self, 'source_lock'):
            with self.source_lock:
                result.update(self.source_snapshot)
        if hasattr(self, 'catalogue'):
            result['catalogues'] = self.catalogue.snapshot()
            if plan:
                with self.catalogue.lock:
                    result['active_catalogue'] = self.catalogue.records.get(plan.catalogue.id, plan.catalogue).public()
        return result

    def _scan_loop(self, scan, wake):
        while not self.quit.is_set():
            wake.clear()
            try:
                scan()
            except Exception:
                pass
            wake.wait(30)

    def _configured_startup(self):
        """The explicit CLI opt-in waits for metadata, never inside playback work."""
        deadline = time.monotonic() + 70
        generation = self.cancel_generation
        selection_submitted = False
        source = None
        while not self.quit.is_set() and time.monotonic() < deadline:
            with self.state_lock:
                if generation != self.cancel_generation:
                    return
                selected = self.state.get('selected_device')
                pending = self.state.get('command_pending', False)
            if not selection_submitted:
                with self.device_lock:
                    discovery = self.device_snapshot['device_discovery']
                if discovery == 'ready':
                    try:
                        self.submit('configure_device', {}, expected_generation=generation)
                    except MediaError:
                        return
                    selection_submitted = True
                elif discovery == 'error':
                    return
            elif selected and not pending:
                if not self.args.autostart:
                    return
                if source is None:
                    with self.source_lock:
                        source = dict(self.sources[0]) if self.sources and self.source_snapshot['source_discovery'] == 'ready' else None
                    if source:
                        try:
                            self.catalogue.request(source)
                        except MediaError:
                            return
                if source:
                    snapshot = self.catalogue.snapshot().get(source['id'], {})
                    if snapshot.get('state') == 'error':
                        return
                    if snapshot.get('state') == 'ready':
                        try:
                            self.submit('start', dict(device_id=selected['id'], device_revision=self.device_revision,
                                        source_id=source['id'], catalogue_id=snapshot['catalogue']['id'],
                                        subtitle_id=None, delay_ms=0), expected_generation=generation)
                        except MediaError:
                            pass
                        return
            self.quit.wait(.05)

    def request_catalogue(self, data):
        if self.quit.is_set():
            raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
        if set(data) != {'source_id', 'refresh'} or not isinstance(data['source_id'], str) or type(data['refresh']) is not bool:
            raise BridgeError('Solicitud de catálogo inválida.')
        with self.source_lock:
            source = next((s for s in self.sources if s['id'] == data['source_id']), None)
        if source is None:
            raise BridgeError('Elegí una fuente disponible.', 404, 'unknown_source')
        snapshot = self.catalogue.request(source, data['refresh'])
        if snapshot['state'] == 'ready':
            return 200, dict(catalogue=snapshot['catalogue'])
        return 202, dict(accepted=True, source_id=source['id'], analysis_id=snapshot['analysis_id'])

    def _retained(self, catalogue_id):
        with self.state_lock:
            active = self.active_plan
            return bool(active and active.catalogue.id == catalogue_id)

    def _subtitle_target(self, data, *strings, nullable=()):
        if self.quit.is_set():
            raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
        subtitle_ids(data, *strings, nullable=nullable)
        return self._retained(data['catalogue_id'])

    def subtitle_upload(self, data):
        if self.quit.is_set():
            raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
        if set(data) != {'source_id', 'catalogue_id', 'filename', 'format', 'text'} or not all(isinstance(data[k], str) for k in data):
            raise BridgeError('Solicitud de archivo inválida.')
        return self.catalogue.upload(**data, allow_retained=self._retained(data['catalogue_id']))

    def subtitle_lookup(self, data):
        retained = self._subtitle_target(data, nullable=('hint',))
        return self.catalogue.lookup(data['source_id'], data['catalogue_id'], lookup_hint(data['hint']), retained)

    def subtitle_offers(self, data):
        retained = self._subtitle_target(data)
        return self.catalogue.offers(data['source_id'], data['catalogue_id'], retained)

    def subtitle_fetch(self, data):
        retained = self._subtitle_target(data, 'offer_id')
        return self.catalogue.fetch(data['source_id'], data['catalogue_id'], data['offer_id'], retained)

    def _validate_plan_fields(self, action, data):
        fields = {'device_id', 'device_revision', 'catalogue_id', 'subtitle_id', 'delay_ms'}
        fields |= {'source_id'} if action == 'start' else {'playback_id', 'enabled'}
        if set(data) != fields:
            raise BridgeError('Faltan campos de la elección de subtítulos.')
        identifiers = ('device_id', 'catalogue_id', 'source_id' if action == 'start' else 'playback_id')
        if (not all(isinstance(data[k], str) and data[k] for k in identifiers)
                or type(data['device_revision']) is not int):
            raise BridgeError('Identidad de reproducción inválida.')
        validate_choice(data['subtitle_id'], data['delay_ms'], data['subtitle_id'] is not None if action == 'start' else data['enabled'])

    def _resolve_plan(self, action, data, retain=False):
        self._validate_plan_fields(action, data)
        if action == 'start':
            with self.source_lock:
                source = next((s for s in self.sources if s['id'] == data['source_id']), None)
                confirmed = self.source_snapshot['source_discovery'] != 'error'
            if source is None:
                raise BridgeError('Elegí una fuente disponible.', 404, 'unknown_source')
            if not confirmed:
                raise BridgeError('Volvé a buscar películas antes de iniciar.', 409, 'unconfirmed_source')
            source_id = source['id']
            enabled = data['subtitle_id'] is not None
        else:
            if (not isinstance(data['playback_id'], str) or data['playback_id'] != self.state.get('playback_id')
                    or not self.active_plan or data['catalogue_id'] != self.active_plan.catalogue.id):
                raise BridgeError('La reproducción cambió. Revisá los subtítulos activos.', 409, 'stale_playback')
            source_id = self.active_plan.catalogue.source['id']
            enabled = data['enabled']
        return self.catalogue.resolve(source_id, data['catalogue_id'], data['subtitle_id'],
                                      data['delay_ms'], enabled, current=action == 'start', retain=retain)

    def _destination_busy(self):
        return (getattr(self, 'destination_locked', False) or getattr(self, 'cleanup_active', False)
                or self.state.get('command_pending', False) or self.state.get('pending', False)
                or bool(getattr(self, 'cast', None) or getattr(self, 'producer', None)
                        or getattr(self, 'session', None) or getattr(self, 'media_url', None)
                        or getattr(self, 'connection_generation', None) is not None))

    def scan_devices(self):
        with self.device_lock:
            if self.quit.is_set():
                return
            self.device_snapshot.update(device_discovery='loading', device_error=None)
        try:
            infos = discover_receivers(self.args.device_host)
            devices = {str(i.uuid): i for i in infos if i.uuid and i.cast_type == 'cast'
                       and (not self.args.device_name or i.friendly_name == self.args.device_name)
                       and (not self.args.device_host or i.host == self.args.device_host)}
            with self.device_lock:
                if not self.quit.is_set():
                    self.devices = devices
                    self.device_snapshot.update(devices=[receiver_metadata(i) for i in devices.values()], device_discovery='ready')
        except Exception:
            with self.device_lock:
                if not self.quit.is_set():
                    self.device_snapshot.update(device_discovery='error',
                                               device_error='No se pudieron buscar dispositivos. Revisá la red y reintentá.')
            raise BridgeError('No se pudieron buscar dispositivos. Revisá la red y reintentá.') from None

    def validate_device_revision(self, expected_revision):
        if type(expected_revision) is not int:
            raise BridgeError('Revisión del destino inválida.')
        if expected_revision != self.state['device_revision']:
            raise BridgeError('El destino cambió. Revisá el dispositivo y volvé a intentar.', 409, 'stale_destination')

    def select_device(self, device_id, expected_revision, executing=False):
        with self.state_lock:
            self.validate_device_revision(expected_revision)
            with self.device_lock:
                info = self.devices.get(device_id)
            if device_id == self.selected_device_id and info:
                return
            # The worker's own pending bit is not an owned playback resource.
            pending = self.state.get('command_pending')
            if executing:
                self.state['command_pending'] = False
            try:
                if self._destination_busy():
                    raise BridgeError('Primero detené la sesión antes de cambiar de dispositivo.')
            finally:
                if executing:
                    self.state['command_pending'] = pending
            if info is None:
                raise BridgeError('Elegí un dispositivo disponible. Volvé a buscar.')
            self.selected_device_id = device_id
            self.device_revision += 1
            self.state.update(selected_device={**receiver_metadata(info), 'available': True},
                              device_revision=self.device_revision)

    def validate_destination(self, data, require_available=False):
        selected = self.state.get('selected_device')
        if (not selected or data.get('device_id') != selected['id']
                or type(data.get('device_revision')) is not int
                or data.get('device_revision') != self.state.get('device_revision')):
            raise BridgeError('El destino cambió o no está elegido. Revisá el dispositivo y volvé a intentar.', 409, 'stale_destination')
        available = selected.get('available') if selected else False
        if hasattr(self, 'device_lock'):
            with self.device_lock:
                available = selected and selected['id'] in self.devices and self.device_snapshot['device_discovery'] != 'error'
        if require_available and not available:
            raise BridgeError('El dispositivo elegido no está disponible. Volvé a buscar.', 409, 'unavailable_destination')

    def validate_stop(self, data):
        validate_stop_identity(self.state, data)
        if self.state.get('selected_device'):
            self.validate_destination(data)

    def submit(self, action, data, expected_generation=None):
        if getattr(self, 'quit', threading.Event()).is_set():
            raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
        if action in ('discover_devices', 'discover'):
            wake = self.device_wake if action == 'discover_devices' else self.source_wake
            lock = self.device_lock if action == 'discover_devices' else self.source_lock
            with self.state_lock:
                if self.quit.is_set():
                    raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
                with lock:
                    snapshot = self.device_snapshot if action == 'discover_devices' else self.source_snapshot
                    key = 'device_discovery' if action == 'discover_devices' else 'source_discovery'
                    if snapshot[key] != 'loading':
                        wake.set()
            return
        if action not in ('select_device', 'configure_device', 'start', 'pause', 'resume', 'seek', 'stop', 'volume', 'mute', 'subtitles'):
            raise BridgeError('Acción desconocida.')
        with self.state_lock:
            if getattr(self, 'quit', threading.Event()).is_set():
                raise BridgeError('El puente se está cerrando.', 503, 'shutdown')
            if expected_generation is not None and expected_generation != self.cancel_generation:
                raise PreparationCancelled('Preparación cancelada.')
            if action == 'select_device':
                if set(data) != {'device_id', 'device_revision'} or not isinstance(data.get('device_id'), str):
                    raise BridgeError('Selección del destino inválida.')
                self.validate_device_revision(data.get('device_revision'))
                if data.get('device_id') != getattr(self, 'selected_device_id', None) and self._destination_busy():
                    raise BridgeError('Primero detené la sesión antes de cambiar de dispositivo.')
                if data.get('device_id') not in self.devices:
                    raise BridgeError('Elegí un dispositivo disponible. Volvé a buscar.')
            if action in ('start', 'subtitles'):
                self._validate_plan_fields(action, data)
            if action in ('start', 'pause', 'resume', 'seek', 'volume', 'mute', 'subtitles'):
                self.validate_destination(data, require_available=action == 'start')
            if action == 'stop':
                self.validate_stop(data)
            if getattr(self, 'cleanup_active', False) and action != 'stop':
                raise BridgeError('Esperá a que termine la acción anterior.', 409, 'busy')
            if (self.state.get('command_pending') or self.state.get('pending') or not self.jobs.empty()) and action != 'stop':
                raise BridgeError('Esperá a que termine la acción anterior.', 409, 'busy')
            plan = self._resolve_plan(action, data, retain=True) if action in ('start', 'subtitles') else None
            try:
                revision = getattr(self, 'cancel_generation', 0) + (action == 'stop')
                payload = {**data, '_plan': plan} if plan else dict(data)
                self.jobs.put_nowait((action, payload, revision))
                self.cancel_generation = revision
                self.state.update(command_pending=True, action_error=None)
            except queue.Full:
                if plan:
                    self.catalogue.unpin(plan.catalogue.id)
                raise BridgeError('Hay demasiadas acciones pendientes.') from None

    def discover(self):
        with self.source_lock:
            if self.quit.is_set():
                return
            self.source_snapshot.update(source_discovery='loading', source_error=None)
        sources = []
        if self.args.source_file:
            try:
                saved = json.loads(Path(self.args.source_file).read_text())
                source = saved['source']
                if not isinstance(source, str) or not source.startswith('http://'):
                    raise ValueError()
                name = saved.get('name')
                name = Path(name).name if isinstance(name, str) else ''
                sources.append({'url': source, 'title': name or 'Película guardada anteriormente (sin nombre)',
                                'filename': name, 'saved': True, 'length': None, 'index': None})
            except Exception:
                with self.source_lock:
                    if not self.quit.is_set():
                        self.source_snapshot.update(source_discovery='error', source_error='No se pudo leer el JSON explícito de fuente.')
                raise BridgeError('No se pudo leer el JSON explícito de fuente.') from None
        # Only the streaming engine. Never query Stremio casting/player routes.
        try:
            with urlopen('http://127.0.0.1:11470/stats.json', timeout=3) as response:
                body = response.read(1024**2 + 1)
                if len(body) > 1024**2:
                    raise ValueError()
                stats = json.loads(body)
            if not isinstance(stats, dict):
                raise ValueError()
            if isinstance(stats, dict):
                single_hash = stats.get('infoHash') or stats.get('infohash')
                torrents = {single_hash: stats} if single_hash else stats
                for infohash, torrent in torrents.items():
                    if not isinstance(infohash, str):
                        continue
                    if not re.fullmatch(r'[a-fA-F0-9]{40}', infohash) or not isinstance(torrent, dict):
                        continue
                    files = torrent.get('files', [])
                    entries = files.items() if isinstance(files, dict) else enumerate(files)
                    for index, file in entries:
                        if not isinstance(file, dict) or not str(index).isdigit():
                            continue
                        name = str(file.get('name', ''))
                        if Path(name).suffix.lower() not in ('.mkv', '.mp4', '.avi', '.webm', '.m4v'):
                            continue
                        sources.append({'url': f'http://127.0.0.1:11470/{infohash}/{index}',
                                        'title': Path(name).stem.replace('.', ' ').replace('_', ' ')[:180],
                                        'filename': Path(name).name, 'length': file.get('length'),
                                        'index': int(index), 'release': str(torrent.get('name') or '')[:180]})
        except Exception:
            if not sources:
                with self.source_lock:
                    if not self.quit.is_set():
                        self.source_snapshot.update(source_discovery='error', source_error='No se pudieron buscar películas. Abrí Stremio y reintentá.')
                return
        unique = {}
        for source in sources:
            source['id'] = hashlib.sha256(source['url'].encode()).hexdigest()[:24]
            existing = unique.setdefault(source['url'], source)
            if not existing.get('filename') and source.get('filename'):
                existing.update(title=source['title'], filename=source['filename'])
        with self.source_lock:
            if not self.quit.is_set():
                self.sources = list(unique.values())
                self.source_snapshot.update(sources=[{k: v for k, v in s.items() if k not in PRIVATE_SOURCE_KEYS} for s in self.sources],
                                            source_discovery='ready', source_error=None)

    def connect(self, revision=None):
        # This is the connection's commitment point, serialized with Stop acceptance.
        # The library call may finish after cancellation; it never holds state_lock.
        with self.state_lock:
            if revision is None:
                revision = getattr(self, 'active_generation', 0)
            if self.quit.is_set() or revision != getattr(self, 'cancel_generation', 0):
                raise PreparationCancelled('Preparación cancelada.')
            if self.cast:
                return
            self.connection_generation = revision
        try:
            self._connect_receiver()
        finally:
            with self.state_lock:
                self.connection_generation = None

    def _connect_receiver(self):
        import pychromecast
        from pychromecast.dial import get_device_info
        from pychromecast.models import HostServiceInfo
        target = self.selected_device_id
        with self.device_lock:
            info = self.devices.get(target) if self.device_snapshot['device_discovery'] != 'error' else None
        if info is None:
            raise BridgeError('El dispositivo elegido no está disponible. Volvé a buscar.')
        # Validate the endpoint itself, not merely the UUID copied into CastInfo.
        actual = get_device_info(info.host, timeout=5)
        if actual is None or actual.uuid != info.uuid or actual.cast_type != 'cast':
            raise BridgeError('La identidad del dispositivo cambió. Volvé a buscar y revisá el destino.')
        if self.quit.is_set() or getattr(self, 'active_generation', 0) != getattr(self, 'cancel_generation', 0):
            raise PreparationCancelled('Preparación cancelada.')
        self.ensure_media_server(info.host)
        direct = replace(info, services={HostServiceInfo(info.host, info.port)})
        self.cast = pychromecast.get_chromecast_from_cast_info(direct, None, tries=1, timeout=5)
        self.cast.wait(timeout=10)

    def ensure_media_server(self, host):
        address = lan_address(host)
        if self.media_server and self.lan_ip == address:
            return
        if self.media_server:
            self.media_server.shutdown()
            self.media_server.server_close()
            self.media_server = None
        server = ThreadingHTTPServer((address, self.args.media_port), MediaHandler)
        server.bridge = self
        try:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        except Exception:
            server.server_close()
            raise
        self.media_server, self.lan_ip = server, address

    def stop_process(self):
        if self.producer:
            self.producer.close()
        self.update(ffmpeg_alive=False, producer_suspended=False)
        if self.session:
            self.record_session()

    def record_session(self):
        if self.session:
            try:
                temporary = self.session / 'state.json.tmp'
                temporary.write_text(json.dumps(self.status(), ensure_ascii=False))
                temporary.replace(self.session / 'state.json')
            except OSError:
                pass

    def stop(self, release_destination=True, shutdown=False):
        errors = []
        try:
            self.stop_process()
        except Exception:
            if not shutdown:
                raise
            errors.append('No se pudo detener el productor.')
        if self.cast:
            try:
                if self._tv_shows_session():
                    self.cast.media_controller.stop()
            except Exception:
                if not shutdown:
                    raise BridgeError('No se pudo detener la TV. Conservamos el destino; reintentá Detener.') from None
                errors.append('No se pudo confirmar que la TV se detuvo.')
            try:
                if shutdown:
                    self.cast.disconnect(timeout=10)
                else:
                    self.cast.disconnect()
            except Exception:
                if not shutdown:
                    raise BridgeError('No se pudo cerrar el control de la TV. Reintentá Detener.') from None
                errors.append('No se pudo cerrar el control de la TV.')
            else:
                self.cast = None
        if self.browser:
            try:
                self.browser.stop_discovery()
            except Exception:
                if shutdown:
                    errors.append('No se pudo cerrar la búsqueda de dispositivos.')
                else:
                    self.browser = None
            else:
                self.browser = None
        if errors:
            raise BridgeError(' '.join(errors))
        self.loaded = False
        self.media_url = None
        self.update(phase='stopped', message='Detenido.', pending=False, ffmpeg_alive=False,
                    producer_suspended=False, receiver_state='IDLE', active_subtitle_track_ids=[], volume=None, muted=None)
        self.record_session()
        self.session = None
        self.producer = None
        with self.state_lock:
            if self.active_plan:
                self.catalogue.unpin(self.active_plan.catalogue.id)
            self.active_plan = None
            self.state.update(playback_id=None, active_catalogue=None, subtitle_choice=None, subtitles_enabled=None)
        if release_destination:
            self.destination_locked = False

    def storage(self):
        return sum(p.stat().st_size for p in self.sessions.glob('*/*')
                   if p.is_file() and not p.is_symlink())

    def media_producer(self, name):
        producer = self.producer
        return producer if producer and producer.directory.name == name else None

    def begin(self, position=0, plan=None, new_playback=False):
        revision = getattr(self, 'active_generation', getattr(self, 'cancel_generation', 0))
        def check_cancelled():
            if self.quit.is_set() or revision != getattr(self, 'cancel_generation', 0):
                raise PreparationCancelled('Preparación cancelada.')
        check_cancelled()
        self.stop_process()
        if self.cast and self._tv_shows_session():
            self.cast.media_controller.stop()
        with self.state_lock:
            check_cancelled()
            self.loaded = False
            self.receiver_confirmed = False
            self.media_url = None
            self.session = None
            if plan is not None:
                previous = self.active_plan
                if previous is None or previous.catalogue.id != plan.catalogue.id:
                    self.catalogue.pin(plan.catalogue.id)
                    if previous:
                        self.catalogue.unpin(previous.catalogue.id)
                self.active_plan = plan
                self.selected = plan.catalogue.source
                self.state.update(subtitle_delay_ms=plan.delay_ms, subtitle_choice=plan.choice(),
                                  active_catalogue=plan.catalogue.public())
                if new_playback:
                    self.state['playback_id'] = secrets.token_hex(16)
                    self.paused = False
            self.state.update(phase='preparing', pending=True, source_id=self.selected.get('id'),
                              title=self.selected['title'], duration=None, absolute_time=0,
                              buffer_ahead_seconds=None, buffered_start=None, buffered_end=None,
                              subtitles_enabled=None, message='Preparando la película para la TV…')
        total = self.active_plan.catalogue.analysis.duration
        check_cancelled()
        self.duration = min(total, self.args.max_duration or total)
        self.load_time = min(max(0, float(position)), max(0, self.duration - 0.1))
        if shutil.disk_usage(self.sessions).free < 1024**3 or self.storage() >= 6 * 1024**3:
            raise BridgeError('Espacio insuficiente: requiere 1 GB libre y menos de 6 GB de sesiones.')
        check_cancelled()
        self.connect(revision)
        check_cancelled()
        self.session = session = self.sessions / ('session-' + secrets.token_hex(8))
        session.mkdir()
        layout = VodLayout(self.duration, subtitles=self.active_plan.subtitle is not None)
        source, playback, readrate = self.selected['url'], self.active_plan, self.args.readrate
        # Never persist raw arguments or producer stderr (both may contain private URLs).
        producer = Producer(session, layout, lambda start, limit: ffmpeg_command(
            source, session, playback, start_index=start, readrate=readrate,
            duration=min(layout.duration, layout.start(limit)) - layout.start(start)))
        with self.state_lock:
            check_cancelled()
            self.producer = producer
            producer.cover(layout.index_at(self.load_time))
        self.started_at = time.monotonic()
        self.update(title=self.selected['title'], duration=self.duration, absolute_time=self.load_time,
                    phase='buffering', session=session.name, ffmpeg_pid=producer.snapshot().pid, ffmpeg_alive=True,
                    segment_count=0, generation_complete=False)

    def mutate(self, action, data):
        if action in ('start', 'pause', 'resume', 'seek', 'volume', 'mute', 'subtitles'):
            with self.state_lock:
                self.validate_destination(data, require_available=action == 'start')
        if action == 'stop':
            with self.state_lock:
                self.validate_stop(data)
        if action == 'discover_devices':
            self.scan_devices()
        elif action == 'select_device':
            self.select_device(data.get('device_id'), data.get('device_revision'), executing=True)
        elif action == 'configure_device':
            if self.quit.is_set() or self.active_generation != self.cancel_generation:
                raise PreparationCancelled('Preparación cancelada.')
            with self.device_lock:
                devices = dict(self.devices)
                confirmed = self.device_snapshot['device_discovery'] != 'error'
            if len(devices) != 1 or not confirmed:
                raise BridgeError('Se requiere un único dispositivo de video con el nombre/host indicado.')
            self.select_device(next(iter(devices)), self.device_revision, executing=True)
        elif action == 'discover':
            self.discover()
        elif action == 'start':
            plan = data.get('_plan') or self._resolve_plan(action, data)
            with self.state_lock:
                self.validate_destination(data, require_available=True)
                self.destination_locked = True
            if (getattr(self, 'active_plan', None) and self.active_plan.key() == plan.key()
                    and self.status().get('phase') in ('playing', 'paused')
                    and self.loaded and self.cast and self.media_url
                    and self.cast.socket_client.is_connected is not False
                    and self.cast.media_controller.status.content_id == self.media_url
                    and self.cast.media_controller.status.player_state in ('PLAYING', 'PAUSED')):
                return
            self.begin(plan=plan, new_playback=True)
        elif action == 'stop':
            self.stop()
        elif action == 'subtitles':
            if data.get('playback_id') != self.state.get('playback_id') or not self.state.get('playback_id'):
                raise BridgeError('La reproducción cambió. Revisá los subtítulos activos.', 409, 'stale_playback')
            plan = data.get('_plan') or self._resolve_plan(action, data)
            if not self._owns_playback():
                raise BridgeError('Esperá a que el receptor confirme esta película.', 409, 'receiver_not_ready')
            previous = self.active_plan
            rebuild = (previous.catalogue.id, previous.subtitle) != (plan.catalogue.id, plan.subtitle)
            reload = not rebuild and previous.delay_ms != plan.delay_ms
            if not rebuild and not reload:
                if plan.enabled:
                    track = next((t.get('trackId') for t in (self.cast.media_controller.status.subtitle_tracks or [])
                                  if isinstance(t, dict) and t.get('type') == 'TEXT' and t.get('trackId') is not None), None)
                    if track is None:
                        raise BridgeError('Esperá a que estén disponibles los subtítulos.', 409, 'receiver_not_ready')
                    self.cast.media_controller.enable_subtitle(track)
                else:
                    self.cast.media_controller.disable_subtitle()
            target = self.status().get('absolute_time', self.load_time)
            receiver = self.cast.media_controller.status
            self.paused = receiver.player_state == 'PAUSED'
            if rebuild:
                self.begin(target, plan=plan)
            elif reload:
                with self.state_lock:
                    current, url = receiver.adjusted_current_time, self.media_url
                    self.active_plan = plan
                    try:
                        self.load_media(max(0, float(current) if current is not None else target))
                    except Exception:
                        self.active_plan, self.media_url = previous, url
                        raise BridgeError('No se pudo cambiar la sincronización en la TV. Reintentá.') from None
                    self.receiver_confirmed = False
                    self.state.update(subtitle_choice=plan.choice(), subtitle_delay_ms=plan.delay_ms, phase='loading',
                                      pending=True, message='Película preparada. Esperando la confirmación de la TV…')
            else:
                with self.state_lock:
                    self.active_plan = plan
                    self.state.update(subtitle_choice=plan.choice(), subtitle_delay_ms=plan.delay_ms)
        elif action in ('volume', 'mute'):
            if (not self.loaded or not self.cast or not self.media_url
                    or self.cast.socket_client.is_connected is False
                    or self.cast.media_controller.status.content_id != self.media_url
                    or self.cast.media_controller.status.player_state not in ('PLAYING', 'PAUSED')):
                raise BridgeError('Esperá a que el receptor confirme esta película.')
            if action == 'volume':
                level = data.get('level')
                if type(level) not in (int, float) or not math.isfinite(level) or not 0 <= level <= 1:
                    raise BridgeError('El volumen debe ser un número entre 0 y 1.')
                self.cast.set_volume(level)
            elif action == 'mute':
                muted = data.get('muted')
                if type(muted) is not bool:
                    raise BridgeError('Silencio requiere verdadero o falso.')
                self.cast.set_volume_muted(muted)
        elif action in ('pause', 'resume'):
            if not self.loaded:
                raise BridgeError('Esperá a que empiece la reproducción.')
            if self.cast.media_controller.status.content_id != self.media_url:
                raise BridgeError('El receptor todavía no confirmó esta sesión.')
            self.paused = action == 'pause'
            (self.cast.media_controller.pause if self.paused else self.cast.media_controller.play)()
        elif action == 'seek':
            if not self.session:
                raise BridgeError('Primero iniciá una fuente.')
            status = self.status()
            target = float(data['position']) if 'position' in data else status['absolute_time'] + float(data['delta'])
            if not math.isfinite(target):
                raise BridgeError('La posición debe ser finita.')
            target = min(max(0, target), max(0, self.duration - 0.1))
            self.begin(target)
        else:
            raise BridgeError('Acción desconocida.')

    def load_media(self, current_time):
        self.media_url = (f'http://{self.lan_ip}:{self.args.media_port}/{self.session.name}'
                          f'/d{self.active_plan.delay_ms}/master.m3u8')
        self.cast.media_controller.play_media(self.media_url, 'application/x-mpegURL', title=self.selected['title'],
            current_time=current_time, autoplay=not self.paused, stream_type='BUFFERED',
            media_info={'duration': self.duration})
        self.loaded = True

    def _tv_shows_session(self):
        content = self.cast.media_controller.status.content_id
        if not content or not self.media_url:
            return False
        return content == self.media_url or bool(self.session) and content.startswith(
            f'http://{self.lan_ip}:{self.args.media_port}/{self.session.name}/')

    def _owns_playback(self):
        return (self.loaded and self.cast and self.media_url
                and self.cast.socket_client.is_connected is not False
                and self.cast.media_controller.status.content_id == self.media_url
                and self.cast.media_controller.status.player_state in ('PLAYING', 'PAUSED'))

    def tick(self):
        if not self.session:
            return
        producer = self.producer
        layout = producer.layout
        storage = self.storage()
        if storage >= 6 * 1024**3 or shutil.disk_usage(self.sessions).free < 512 * 1024**2:
            raise BridgeError('Límite de almacenamiento alcanzado. Detenido para proteger el disco.')
        returncode = producer.snapshot().returncode
        if returncode not in (None, 0):
            raise BridgeError(f'FFmpeg terminó con código {returncode}. Fuente o códec no disponible.')
        completed = producer.completed()
        first = layout.index_at(self.load_time)
        ready = (set(range(first, min(layout.count, first + 3))) <= completed
                 and (self.session / 'master.m3u8').exists())
        if not self.loaded and ready:
            with self.state_lock:
                if (self.quit.is_set() or getattr(self, 'active_generation', 0)
                        != getattr(self, 'cancel_generation', 0)):
                    return
                self.load_media(self.load_time)
            self.update(phase='loading', message='Película preparada. Esperando la confirmación de la TV…')
        absolute, receiver = self.status().get('absolute_time', self.load_time), 'PENDING'
        tracks = []
        if self.loaded:
            connected = self.cast.socket_client.is_connected is not False
            if connected:
                self.cast.media_controller.update_status()
            status = self.cast.media_controller.status
            owns_status = connected and status.content_id == self.media_url
            if owns_status:
                absolute = min(self.duration, max(0, float(status.adjusted_current_time or 0)))
            receiver = status.player_state if owns_status else 'PENDING'
            observed_tracks = status.current_subtitle_tracks if owns_status else None
            tracks = list(observed_tracks) if observed_tracks is not None else []
            requested = self.active_plan.enabled
            for track in (status.subtitle_tracks or []) if owns_status and requested else []:
                if not isinstance(track, dict) or track.get('type') != 'TEXT':
                    continue
                track_id = track.get('trackId')
                if track_id is not None and track_id not in tracks:
                    self.cast.media_controller.enable_subtitle(track_id)
                    break
            if owns_status and tracks and not requested:
                self.cast.media_controller.disable_subtitle()
            self.update(subtitles_enabled=bool(tracks) if observed_tracks is not None else None)
            cast_status = self.cast.status
            level = getattr(cast_status, 'volume_level', None)
            muted = getattr(cast_status, 'volume_muted', None)
            self.update(volume=level if owns_status and type(level) in (int, float) and math.isfinite(level) and 0 <= level <= 1 else None,
                        muted=muted if owns_status and type(muted) is bool else None)
            if not connected:
                self.update(phase='disconnected', pending=True, message='Se perdió la conexión con la TV. Detené la sesión y volvé a intentarlo.')
            elif receiver in ('PLAYING', 'PAUSED'):
                self.receiver_confirmed = True
                self.update(phase=receiver.lower(), pending=False, message='Reproduciendo.' if receiver == 'PLAYING' else 'En pausa.')
            elif not owns_status:
                if self.receiver_confirmed:
                    self.update(phase='receiver_changed', pending=True, message='La TV reproduce otro contenido. Cancelá este control y volvé a elegir una película.')
                else:
                    self.update(phase='loading', pending=True, message='Película preparada. Esperando la confirmación de la TV…')
            elif receiver == 'BUFFERING':
                self.update(phase='buffering', pending=True, message='Esperando al receptor o a la descarga…')
            elif receiver == 'IDLE' and status.idle_reason == 'FINISHED':
                self.update(phase='ended', pending=False, message='Finalizó la reproducción.')
            elif receiver == 'IDLE' and status.idle_reason == 'ERROR':
                raise BridgeError('El receptor informó un error al reproducir esta sesión HLS.')
        playing = layout.index_at(absolute)
        if self.loaded:
            producer.cover(playing, horizon=SUSPEND_AHEAD)
        producer.throttle(absolute)
        produced = producer.snapshot()
        buffered_start, buffered_end = buffered_run(layout, completed, playing)
        self.update(absolute_time=absolute, receiver_state=receiver, active_subtitle_track_ids=tracks,
                    ffmpeg_pid=produced.pid, ffmpeg_alive=produced.alive, producer_suspended=produced.suspended,
                    segment_count=len(completed), generation_complete=len(completed) >= layout.count,
                    buffered_start=buffered_start, buffered_end=buffered_end, storage_bytes=storage)
        self.record_session()
        if not self.loaded and time.monotonic() - self.started_at > 180:
            raise BridgeError('La fuente no produjo segmentos suficientes en 3 minutos. Reintentá cuando descargue.')

    def _work(self):
        while not self.quit.is_set():
            try:
                job = self.jobs.get(timeout=0.5)
                action, data = job[:2]
                self.active_generation = job[2] if len(job) == 3 else 0
            except queue.Empty:
                action = None
            if action:
                try:
                    if action == 'stop' or self.active_generation == getattr(self, 'cancel_generation', 0):
                        self.mutate(action, data)
                except PreparationCancelled:
                    pass
                except Exception as error:
                    message = str(error) if isinstance(error, MediaError) else 'No se pudo ejecutar la acción. Revisá la fuente y el receptor.'
                    with self.state_lock:
                        self.state.update(message=message, action_error=message, pending=False,
                                          action_error_revision=self.state.get('action_error_revision', 0) + 1)
                    if self.session is None:
                        self.update(phase='error', ffmpeg_alive=False)
                finally:
                    with self.state_lock:
                        if data.get('_plan'):
                            self.catalogue.unpin(data['_plan'].catalogue.id)
                        self.state['command_pending'] = not self.jobs.empty()
            try:
                with self.state_lock:
                    can_tick = (self.jobs.empty() and getattr(self, 'active_generation', 0)
                                == getattr(self, 'cancel_generation', 0))
                if can_tick and not self.quit.is_set():
                    self.tick()
            except Exception as error:
                message = str(error) if isinstance(error, BridgeError) else 'No se pudo ejecutar la acción. Revisá la fuente y el receptor.'
                with self.state_lock:
                    self.cleanup_active = True
                    self.state['command_pending'] = True
                try:
                    self.stop(release_destination=False)
                except Exception:
                    pass
                with self.state_lock:
                    self.cleanup_active = False
                    self.state.update(phase='error', message=message, pending=False, action_error=message,
                                      command_pending=not self.jobs.empty(),
                                      action_error_revision=self.state.get('action_error_revision', 0) + 1)
            if self.args.state_file:
                target = Path(self.args.state_file)
                try:
                    temp = target.with_suffix('.tmp')
                    temp.write_text(json.dumps(self.status(), ensure_ascii=False))
                    temp.replace(target)
                except OSError:
                    pass
        try:
            self.stop(shutdown=True)
        except Exception as error:
            self.shutdown_error = str(error) if isinstance(error, BridgeError) else 'No se pudo completar la limpieza.'
            self.update(phase='error', message=self.shutdown_error, action_error=self.shutdown_error,
                        pending=False, command_pending=False,
                        action_error_revision=self.state.get('action_error_revision', 0) + 1)

    def close(self):
        with self.state_lock:
            if hasattr(self, 'catalogue'):
                self.catalogue.cancel()
            self.quit.set()
            self.cancel_generation = getattr(self, 'cancel_generation', 0) + 1
        for wake in (getattr(self, 'device_wake', None), getattr(self, 'source_wake', None)):
            if wake:
                wake.set()
        self.worker.join(timeout=50)
        errors = []
        if self.worker.is_alive():
            errors.append('La limpieza del worker todavía no terminó.')
        if getattr(self, 'shutdown_error', None):
            errors.append(self.shutdown_error)
        for worker in getattr(self, 'metadata_workers', []):
            worker.join(timeout=10)
            if worker.is_alive():
                errors.append('La búsqueda todavía no terminó.')
        if hasattr(self, 'catalogue'):
            try:
                self.catalogue.close(cleanup=not errors)
            except MediaError as error:
                errors.append(str(error))
        if self.media_server:
            stopped = True
            try:
                self.media_server.shutdown()
            except Exception:
                stopped = False
                errors.append('No se pudo detener el servidor de medios.')
            try:
                self.media_server.server_close()
            except Exception:
                errors.append('No se pudo cerrar el servidor de medios.')
            else:
                if stopped:
                    self.media_server = None
        if errors:
            self.cleanup_active = True
            message = ' '.join(errors)
            self.update(phase='error', message=message, action_error=message)
            raise BridgeError(message)


PANEL = (ROOT / "player.html").read_text().replace("__SCRIPT__", (ROOT / "player.js").read_text())


class MediaHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.serve_media(False)

    def do_HEAD(self):
        self.serve_media(True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.end_headers()

    def serve_media(self, head):
        root = self.server.bridge.sessions
        request = media_request(self.path)
        producer = request and self.server.bridge.media_producer(request[0])
        try:
            stream = producer and self.media_stream(root, producer, request[2], request[1])
        except OSError:
            stream = None
        try:
            if stream is None:
                self.send_error(404)
                return
            with stream:
                size = stream.seek(0, os.SEEK_END)
                start, end = 0, size - 1
                value = self.headers.get('Range')
                if value:
                    match = re.fullmatch(r'bytes=(\d+)-(\d*)', value)
                    if not match:
                        self.send_error(416)
                        return
                    start = int(match[1])
                    end = min(int(match[2]), size - 1) if match[2] else size - 1
                    if start > end:
                        self.send_error(416)
                        return
                self.send_response(206 if value else 200)
                self.send_header('Content-Type', MIME[Path(request[2]).suffix])
                self.send_header('Content-Length', str(end - start + 1))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Cache-Control', 'no-store')
                if value:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.end_headers()
                if not head:
                    stream.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        block = stream.read(min(65536, remaining))
                        if not block:
                            break
                        self.wfile.write(block)
                        remaining -= len(block)
        except (OSError, ConnectionError):
            pass

    @staticmethod
    def media_stream(root, producer, name, delay_ms):
        layout = producer.layout
        if name == 'master.m3u8':
            return open_media(root, producer.directory / name)
        if name == 'video.m3u8':
            return io.BytesIO(layout.media_playlist().encode())
        if name == SUBTITLE_PLAYLIST and layout.subtitles:
            return io.BytesIO(layout.subtitle_playlist().encode())
        kind, index = layout.parse(name) or (None, None)
        if kind == 'segment':
            return open_media(root, producer.directory / name) if producer.request(index) else None
        if kind == 'cue':
            return subtitle_segment(root, producer, index, delay_ms)
        return None

    def log_message(self, *_):
        pass


class ControlHandler(BaseHTTPRequestHandler):
    def trusted_host(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

    def reply(self, code, body, content_type='application/json'):
        payload = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type + '; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if not self.trusted_host():
            self.reply(403, {})
        elif self.path == '/':
            import html
            panel = PANEL.replace('__TOKEN__', self.server.token).replace('__DEVICE__', html.escape(self.server.bridge.args.device_name or 'Sin dispositivo')).replace('__DELAY__', str(self.server.bridge.args.subtitle_delay_ms))
            if self.server.bridge.status().get('demo'):
                panel = panel.replace('id="demo-banner" hidden', 'id="demo-banner"')
            self.reply(200, panel, 'text/html')
        elif self.path == '/api/status':
            self.reply(200, self.server.bridge.status())
        else:
            self.reply(404, {})

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if (not self.trusted_host() or self.headers.get('Origin') != origin
                or not secrets.compare_digest(self.headers.get('X-Bridge-Token', ''), self.server.token)
                or self.headers.get_content_type() != 'application/json'):
            self.reply(403, {'code': 'unauthorized', 'message': 'Solicitud no autorizada.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            limit = UPLOAD_BODY_LIMIT if self.path == '/api/subtitle_upload' else 4096
            if length > limit:
                raise BridgeError('La solicitud supera el límite permitido.', 413, 'body_limit')
            if length <= 0:
                raise ValueError()
            if hasattr(self, 'connection'):
                self.connection.settimeout(5)
            data = json.loads(self.rfile.read(length))
            if (not isinstance(data, dict) or 'autostart' in data or not self.path.startswith('/api/')
                    or self.path == '/api/configure_device'):
                raise ValueError()
            if self.path == '/api/catalogue':
                code, body = self.server.bridge.request_catalogue(data)
                self.reply(code, body)
            elif self.path == '/api/subtitle_upload':
                self.reply(201, self.server.bridge.subtitle_upload(data))
            elif self.path == '/api/subtitle_lookup':
                self.reply(202, self.server.bridge.subtitle_lookup(data))
            elif self.path == '/api/subtitle_offers':
                self.reply(200, self.server.bridge.subtitle_offers(data))
            elif self.path == '/api/subtitle_fetch':
                self.reply(201, self.server.bridge.subtitle_fetch(data))
            else:
                self.server.bridge.submit(self.path[5:], data)
                self.reply(202, {'accepted': True})
        except MediaError as error:
            self.reply(error.status, {'code': error.code, 'message': str(error)})
        except (ValueError, UnicodeError, TimeoutError):
            self.reply(400, {'code': 'invalid_request', 'message': 'Solicitud inválida o cola ocupada.'})
        except Exception:
            self.reply(503, {'code': 'unavailable', 'message': 'No se pudo completar la solicitud. Reintentá.'})

    def log_message(self, *_):
        pass


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-file', help='JSON explícito con source y device_id; no se publica')
    parser.add_argument('--device-name', help='Nombre exacto opcional del destino')
    parser.add_argument('--device-host', help='IP exacta del Chromecast autorizado')
    parser.add_argument('--subtitle-delay-ms', type=int, default=0)
    parser.add_argument('--max-duration', type=float)
    parser.add_argument('--readrate', type=float, default=1.1)
    parser.add_argument('--media-port', type=int, default=18766)
    parser.add_argument('--control-port', type=int, default=18767)
    parser.add_argument('--autostart', action='store_true')
    parser.add_argument('--no-stremio-subtitles', action='store_true',
                        help='No consultar los subtítulos de Stremio (OpenSubtitles v3 y Cinemeta)')
    parser.add_argument('--no-open', action='store_true', help='Aceptado; nunca se abre un navegador automáticamente')
    parser.add_argument('--state-file', nargs='?', const=str(ROOT / '.local' / 'state.json'))
    args = parser.parse_args(argv)
    if args.autostart and not (args.device_name or args.device_host):
        parser.error('--autostart requiere --device-name o --device-host explícito')
    if not math.isfinite(args.readrate) or not 0 < args.readrate <= 10:
        parser.error('--readrate debe estar entre 0 y 10')
    if args.max_duration is not None and (not math.isfinite(args.max_duration) or args.max_duration <= 0):
        parser.error('--max-duration debe ser positivo')
    if abs(args.subtitle_delay_ms) > 30000:
        parser.error('--subtitle-delay-ms debe estar entre -30000 y 30000')
    if args.state_file:
        state = Path(args.state_file).resolve()
        local = (ROOT / '.local').resolve()
        if not state.is_relative_to(local):
            parser.error('--state-file debe estar dentro de .local/ del repo')
        state.parent.mkdir(parents=True, exist_ok=True)
    return args


def lan_address(host):
    # Routing lookup only at runtime; worker tests never call this or bind sockets.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((host, 8009))
        address = sock.getsockname()[0]
    if not ipaddress.ip_address(address).is_private or address.startswith('127.'):
        raise BridgeError('No hay una dirección LAN privada hacia el Chromecast.')
    return address


def main(argv=None):
    args = arguments(argv)
    logging.disable(logging.CRITICAL)  # Receiver libraries can log private media URLs.
    bridge = media = control = None
    serving = []
    try:
        bridge = Bridge(args)
        control = ThreadingHTTPServer(('127.0.0.1', args.control_port), ControlHandler)
        control.bridge, control.token = bridge, secrets.token_urlsafe(32)
        threading.Thread(target=control.serve_forever, daemon=True).start()
        serving.append(control)
        print(json.dumps({'ready': True, 'control_url': f'http://127.0.0.1:{args.control_port}'}), flush=True)
        signal.signal(signal.SIGTERM, lambda *_: bridge.quit.set())
        while not bridge.quit.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(json.dumps({'ready': False, 'message': str(error) if isinstance(error, BridgeError)
                          else 'No se pudo iniciar. Verificá dependencias, red y puertos.'}), flush=True)
        return 1
    finally:
        for server in (control, media):
            if server:
                if server in serving:
                    server.shutdown()
                server.server_close()
        if bridge:
            bridge.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
