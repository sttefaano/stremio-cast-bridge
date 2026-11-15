"""Source-bound subtitle catalogues and private, process-local uploads."""
from dataclasses import dataclass, replace
import copy
import hashlib
import html
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import tempfile
import threading
import unicodedata
from types import MappingProxyType


class MediaError(Exception):
    def __init__(self, message, status=400, code='invalid_request'):
        super().__init__(message)
        self.status, self.code = status, code


TEXT_CODECS = frozenset(('subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'))
MAX_UPLOAD = 1024 ** 2
MAX_STORAGE = 16 * MAX_UPLOAD
UPLOAD_BODY_LIMIT = 6 * MAX_UPLOAD + 4096
EXTERNAL_RESOURCE = re.compile(r'(?i)[a-z][a-z0-9+.-]*://|(?:https?|file|data|javascript):|www\.')


@dataclass(frozen=True)
class Subtitle:
    id: str
    kind: str
    label: str
    language: str | None = None
    supported: bool = True
    index: int | None = None
    path: Path | None = None
    digest: str | None = None

    def public(self):
        return dict(id=self.id, kind=self.kind, label=self.label, language=self.language,
                    supported=self.supported, reason=None if self.supported else 'Subtítulos de imagen o códec no compatible.')


@dataclass(frozen=True)
class Analysis:
    video: int
    audio: int
    duration: float
    entries: tuple[Subtitle, ...] = ()


@dataclass(frozen=True)
class Catalogue:
    id: str
    source: dict
    analysis: Analysis

    def __post_init__(self):
        object.__setattr__(self, 'source', MappingProxyType(dict(self.source)))

    def public(self):
        return dict(id=self.id, source_id=self.source['id'], duration=self.analysis.duration,
                    entries=[entry.public() for entry in self.analysis.entries])


@dataclass(frozen=True)
class PlaybackPlan:
    catalogue: Catalogue
    subtitle: Subtitle | None
    delay_ms: int
    enabled: bool

    def key(self):
        return self.catalogue.id, self.subtitle.id if self.subtitle else None, self.delay_ms, self.enabled

    def choice(self):
        return dict(catalogue_id=self.catalogue.id, subtitle_id=self.subtitle.id if self.subtitle else None,
                    enabled=self.enabled, delay_ms=self.delay_ms,
                    label=self.subtitle.label if self.subtitle else 'Sin subtítulos',
                    language=self.subtitle.language if self.subtitle else None)


def analyse(data):
    streams = data['streams']
    video = next(s['index'] for s in streams if s['codec_type'] == 'video'
                 and not s.get('disposition', {}).get('attached_pic'))
    audio = next(s['index'] for s in streams if s['codec_type'] == 'audio')
    duration = float(data['format']['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('duration')
    entries = []
    for stream in streams:
        if stream['codec_type'] != 'subtitle':
            continue
        tags = stream.get('tags', {})
        language = tags.get('language')
        language = language.lower() if isinstance(language, str) and re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', language) else None
        title = tags.get('title')
        label = title[:180] if isinstance(title, str) and title.strip() else language or f'Subtítulo {len(entries) + 1}'
        entries.append(Subtitle(secrets.token_hex(12), 'embedded', label, language,
                                stream.get('codec_name') in TEXT_CODECS, index=stream['index']))
    return Analysis(video, audio, duration, tuple(entries))


def validate_choice(subtitle_id, delay_ms, enabled):
    if (subtitle_id is not None and (not isinstance(subtitle_id, str) or not subtitle_id)
            or type(delay_ms) is not int or abs(delay_ms) > 30000 or type(enabled) is not bool
            or subtitle_id is None and (delay_ms != 0 or enabled)):
        raise MediaError('Elección o tiempo de subtítulos inválido.')


def upload_label(filename):
    if (not isinstance(filename, str) or not 0 < len(filename) <= 180
            or any(unicodedata.category(c).startswith('C') for c in filename)):
        raise MediaError('Nombre de archivo inválido.')
    label = filename.replace('\\', '/').rsplit('/', 1)[-1]
    if label in ('', '.', '..'):
        raise MediaError('Nombre de archivo inválido.')
    return label


def normalize_subtitles(format, text):
    if format not in ('srt', 'vtt') or not isinstance(text, str):
        raise MediaError('Usá texto UTF-8 SRT o VTT.', 422, 'invalid_subtitle')
    try:
        encoded = text.encode('utf-8')
    except UnicodeError:
        raise MediaError('Usá texto UTF-8 válido.', 422, 'invalid_subtitle') from None
    if len(encoded) > MAX_UPLOAD:
        raise MediaError('El archivo supera 1 MiB.', 413, 'upload_limit')
    text = text.removeprefix('\ufeff').replace('\r\n', '\n').replace('\r', '\n').strip()
    if any(unicodedata.category(c) in ('Cc', 'Cf') and c not in '\n\t' for c in text):
        raise MediaError('El archivo contiene controles no permitidos.', 422, 'invalid_subtitle')
    blocks = re.split(r'\n(?:[ \t]*\n)+', text)
    if format == 'vtt':
        header = blocks.pop(0)
        if (not blocks or not re.fullmatch(r'WEBVTT(?:[ \t][^\n]*)?', header.split('\n', 1)[0])
                or '-->' in header or EXTERNAL_RESOURCE.search(header)):
            raise MediaError('Encabezado VTT inválido.', 422, 'invalid_subtitle')
    stamp = r'\d{2,6}:[0-5]\d:[0-5]\d,\d{3}' if format == 'srt' else r'(?:\d{2,6}:)?[0-5]\d:[0-5]\d\.\d{3}'
    timing = re.compile(rf'({stamp}) --> ({stamp})(?:[ \t]+(.*))?')
    def milliseconds(value):
        parts = value.replace(',', '.').split(':')
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + float(part)
        return round(seconds * 1000)
    def timestamp(value):
        return f'{value // 3600000:02d}:{value // 60000 % 60:02d}:{value // 1000 % 60:02d}.{value % 1000:03d}'
    cues = []
    for block in blocks:
        lines = block.splitlines()
        if format == 'vtt' and re.match(r'NOTE(?:[ \t]|$)', lines[0]):
            continue
        if lines and not timing.fullmatch(lines[0]):
            if format == 'srt' and lines[0].strip().isdigit() or format == 'vtt' and len(lines) > 1 and not re.search(r'(?i)STYLE|REGION|-->', lines[0]):
                lines = lines[1:]
        match = timing.fullmatch(lines[0]) if lines else None
        content = '\n'.join(lines[1:])
        if (not match or not content.strip() or len(content.encode()) > 16384
                or re.search(r'(?i)-->|<(?:img|script|iframe|object|svg|style|audio|video|link|embed)\b', content)):
            raise MediaError('Cue de subtítulos inválido o recurso externo.', 422, 'invalid_subtitle')
        if match[3]:
            if format != 'vtt':
                raise MediaError('Cue SRT inválido.', 422, 'invalid_subtitle')
            validate_vtt_settings(match[3])
        start, end = map(milliseconds, match.groups()[:2])
        for reference in re.finditer(r'&#(?:x([0-9a-fA-F]+)|([0-9]+));?', content):
            try:
                character = chr(int(reference[1], 16) if reference[1] else int(reference[2]))
            except (ValueError, OverflowError):
                raise MediaError('Referencia de texto inválida.', 422, 'invalid_subtitle') from None
            if unicodedata.category(character).startswith('C'):
                raise MediaError('El archivo contiene controles no permitidos.', 422, 'invalid_subtitle')
        content = html.unescape(re.sub(r'<[^>]*>', '', content)).strip()
        if (end <= start or not content or any(unicodedata.category(c) in ('Cc', 'Cf') and c not in '\n\t' for c in content)
                or re.search(r'-->|[<>]', content)):
            raise MediaError('Cue de subtítulos inválido.', 422, 'invalid_subtitle')
        cues.append(f'{timestamp(start)} --> {timestamp(end)}\n{content}')
        if len(cues) > 20000:
            raise MediaError('Demasiados cues.', 413, 'upload_limit')
    if not cues:
        raise MediaError('El archivo no tiene cues.', 422, 'invalid_subtitle')
    return ('WEBVTT\n\n' + '\n\n'.join(cues) + '\n').encode('utf-8')


def validate_vtt_settings(settings):
    percent = r'\d{1,3}(?:\.\d{1,6})?%'
    patterns = {'vertical': r'rl|lr', 'align': r'start|center|end|left|right',
                'size': percent, 'line': rf'(?:auto|-?\d{{1,6}}|{percent})(?:,(?:start|center|end))?',
                'position': rf'(?:auto|{percent})(?:,(?:line-left|center|line-right|auto))?'}
    seen = set()
    if len(settings) > 400:
        raise MediaError('Configuración de cue inválida.', 422, 'invalid_subtitle')
    for setting in settings.split():
        name, separator, value = setting.partition(':')
        if (not separator or name in seen or name not in patterns or not re.fullmatch(patterns[name], value)
                or any(float(p) > 100 for p in re.findall(r'(\d+(?:\.\d+)?)%', value))):
            raise MediaError('Configuración de cue inválida.', 422, 'invalid_subtitle')
        seen.add(name)


class SetupCatalogue:
    def __init__(self, probe, parent):
        self.probe = probe
        self.parent = parent
        self.lock = threading.Condition()
        self.closed = False
        self.cancelled = threading.Event()
        self.writers = 0
        self.records, self.snapshots = {}, {}
        self.pins = {}
        self.storage = 0
        self.upload_dir = None
        self.jobs = queue.Queue(maxsize=8)
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    def _admit(self):
        if self.closed:
            raise MediaError('El puente se está cerrando.', 503, 'shutdown')

    def pin(self, catalogue_id):
        with self.lock:
            if catalogue_id not in self.records:
                raise MediaError('El catálogo cambió.', 409, 'stale_catalogue')
            self.pins[catalogue_id] = self.pins.get(catalogue_id, 0) + 1

    def unpin(self, catalogue_id):
        with self.lock:
            count = self.pins.get(catalogue_id, 0)
            if count <= 1:
                self.pins.pop(catalogue_id, None)
            else:
                self.pins[catalogue_id] = count - 1

    def _make_room(self):
        while len(self.records) + sum(s['state'] != 'ready' for s in self.snapshots.values()) >= 8:
            latest = {s['catalogue']['id'] for s in self.snapshots.values() if s['state'] == 'ready'}
            candidates = [identity for identity in self.records if identity not in self.pins]
            identity = next((identity for identity in candidates if identity not in latest),
                            candidates[0] if candidates else None)
            if identity is not None:
                catalogue = self.records.pop(identity)
                self.snapshots = {source: snapshot for source, snapshot in self.snapshots.items()
                                  if snapshot.get('catalogue', {}).get('id') != identity}
                for entry in catalogue.analysis.entries:
                    if entry.kind == 'upload' and entry.path:
                        try:
                            size = entry.path.stat().st_size
                            entry.path.unlink()
                        except OSError:
                            raise MediaError('No se pudo liberar el subtítulo privado.', 503, 'storage_unavailable') from None
                        self.storage -= size
                continue
            failed = next((source for source, snapshot in self.snapshots.items() if snapshot['state'] == 'error'), None)
            if failed is not None:
                del self.snapshots[failed]
                continue
            raise MediaError('Todos los análisis están en uso. Esperá o detené la reproducción.', 409, 'catalogue_limit')

    def request(self, source, refresh=False):
        with self.lock:
            self._admit()
            previous = self.snapshots.get(source['id'])
            if previous and (previous['state'] == 'loading' or previous['state'] == 'ready' and not refresh):
                return copy.deepcopy(previous)
            if previous and previous['state'] == 'error':
                del self.snapshots[source['id']]
            self._make_room()
            analysis_id = secrets.token_hex(12)
            snapshot = dict(state='loading', analysis_id=analysis_id)
            self.snapshots[source['id']] = snapshot
            self.jobs.put_nowait((dict(source), analysis_id))
            return snapshot.copy()

    def _work(self):
        while not self.cancelled.is_set():
            try:
                source, analysis_id = self.jobs.get(timeout=.1)
            except queue.Empty:
                continue
            try:
                analysis = self.probe(source['url'], self.cancelled)
                catalogue = Catalogue(secrets.token_hex(12), source, analysis)
                snapshot = dict(state='ready', catalogue=catalogue.public())
            except Exception:
                catalogue = None
                snapshot = dict(state='error', analysis_id=analysis_id,
                                message='No se pudo analizar la película. Abrila en Stremio y reintentá.')
            with self.lock:
                if not self.closed:
                    if catalogue:
                        self.records[catalogue.id] = catalogue
                    self.snapshots[source['id']] = snapshot

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.snapshots)

    def catalogue(self, source_id, catalogue_id):
        catalogue = self.records.get(catalogue_id)
        if not catalogue or catalogue.source['id'] != source_id:
            raise MediaError('El catálogo cambió. Volvé a elegir los subtítulos.', 409, 'stale_catalogue')
        return catalogue

    def resolve(self, source_id, catalogue_id, subtitle_id, delay_ms, enabled, current=False, retain=False):
        validate_choice(subtitle_id, delay_ms, enabled)
        with self.lock:
            self._admit()
            catalogue = self.catalogue(source_id, catalogue_id)
            if current:
                latest = self.snapshots.get(source_id, {})
                if latest.get('state') != 'ready' or latest['catalogue']['id'] != catalogue_id:
                    raise MediaError('Esperá al análisis actual de la película.', 409, 'stale_catalogue')
            entry = next((s for s in catalogue.analysis.entries if s.id == subtitle_id), None)
            if subtitle_id is not None and entry is None:
                raise MediaError('Subtítulo ajeno o desactualizado.', 409, 'stale_subtitle')
            if entry and not entry.supported:
                raise MediaError('Este subtítulo no es texto compatible.', 422, 'unsupported_subtitle')
            if retain:
                self.pin(catalogue_id)
            return PlaybackPlan(catalogue, entry, delay_ms, enabled)

    def upload(self, source_id, catalogue_id, filename, format, text, allow_retained=False):
        with self.lock:
            self._admit()
            self.catalogue(source_id, catalogue_id)
            self._upload_identity(source_id, catalogue_id, allow_retained)
            self.writers += 1
        try:
            label = upload_label(filename)
            canonical = normalize_subtitles(format, text)
            digest = hashlib.sha256(canonical).hexdigest()
            with self.lock:
                self._admit()
                catalogue = self.catalogue(source_id, catalogue_id)
                self._upload_identity(source_id, catalogue_id, allow_retained)
                uploads = [s for s in catalogue.analysis.entries if s.kind == 'upload']
                duplicate = next((s for s in uploads if s.digest == digest), None)
                if duplicate:
                    return dict(entry=duplicate.public(), catalogue=catalogue.public())
                if len(uploads) >= 8 or self.storage + len(canonical) > MAX_STORAGE:
                    raise MediaError('Límite de subtítulos locales alcanzado.', 413, 'upload_limit')
                if self.upload_dir is None:
                    self.parent.mkdir(parents=True, exist_ok=True)
                    self.upload_dir = Path(tempfile.mkdtemp(prefix='subtitles-', dir=self.parent))
                    self.upload_dir.chmod(0o700)
                path = self.upload_dir / (secrets.token_hex(24) + '.vtt')
                try:
                    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
                        stream.write(canonical)
                except Exception:
                    path.unlink(missing_ok=True)
                    raise
                entry = Subtitle(secrets.token_hex(12), 'upload', label, path=path, digest=digest)
                catalogue = replace(catalogue, analysis=replace(catalogue.analysis,
                                    entries=catalogue.analysis.entries + (entry,)))
                self.records[catalogue.id] = catalogue
                self.storage += len(canonical)
                latest = self.snapshots.get(source_id, {})
                if latest.get('state') == 'ready' and latest['catalogue']['id'] == catalogue.id:
                    self.snapshots[source_id] = dict(state='ready', catalogue=catalogue.public())
                return dict(entry=entry.public(), catalogue=catalogue.public())
        except OSError:
            raise MediaError('No se pudo guardar el subtítulo local.', 503, 'storage_unavailable') from None
        finally:
            with self.lock:
                self.writers -= 1
                self.lock.notify_all()

    def _upload_identity(self, source_id, catalogue_id, allow_retained):
        latest = self.snapshots.get(source_id, {})
        if not allow_retained and (latest.get('state') != 'ready' or latest['catalogue']['id'] != catalogue_id):
            raise MediaError('El catálogo cambió. Volvé a elegir la película.', 409, 'stale_catalogue')

    def cancel(self):
        with self.lock:
            self.closed = True
            self.cancelled.set()

    def close(self, cleanup=True):
        self.cancel()
        self.worker.join(timeout=35)
        with self.lock:
            drained = self.lock.wait_for(lambda: self.writers == 0, timeout=10)
        if self.worker.is_alive() or not drained:
            raise MediaError('La limpieza de subtítulos todavía no terminó.', 503, 'shutdown')
        if cleanup and self.upload_dir:
            try:
                shutil.rmtree(self.upload_dir)
            except OSError:
                raise MediaError('No se pudo limpiar el almacenamiento privado.', 503, 'storage_unavailable') from None
            self.upload_dir = None
