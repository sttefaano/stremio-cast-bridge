"""Local, explicitly controlled Stremio → HLS → Chromecast bridge."""
import argparse
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

FFMPEG = '/Applications/Stremio.app/Contents/MacOS/ffmpeg'
FFPROBE = '/Applications/Stremio.app/Contents/MacOS/ffprobe'
ROOT = Path(__file__).resolve().parent
MIME = {'.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt'}


def safe_media_path(root, request_path):
    try:
        parts = unquote(urlsplit(request_path).path).lstrip('/').split('/')
        if len(parts) != 2 or any(p in ('', '.', '..') or '\\' in p or '\x00' in p for p in parts):
            return None
        path = Path(root)
        for part in parts:
            path = path / part
            if path.is_symlink():
                return None
        if path.suffix not in MIME or not path.is_file():
            return None
        return path
    except (ValueError, OSError):
        return None


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


def subtitle_filter(delay_ms):
    delay = int(delay_ms) / 1000
    return f'setts=pts=PTS+({delay:.3f})/TB:dts=DTS+({delay:.3f})/TB'


def ffmpeg_command(source, session, streams, delay_ms=0, origin=0, duration=None, readrate=1.1):
    command = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-rw_timeout', '15000000', '-readrate', str(readrate)]
    if origin:
        command += ['-ss', str(origin)]
    command += ['-i', source]
    if duration is not None:
        command += ['-t', str(duration)]
    for index in streams:
        command += ['-map', f'0:{index}']
    return command + ['-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', '24', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level:v', '3.1',
        '-g', '144', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*6)',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-c:s', 'webvtt',
        '-bsf:s', subtitle_filter(delay_ms), '-metadata:s:s:0', 'language=es',
        '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_flags', 'independent_segments+temp_file', '-hls_playlist_type', 'event',
        '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0,s:0,sgroup:subs,language:es',
        '-hls_segment_filename', str(session / 'segment-%04d.ts'), str(session / 'video.m3u8')]


def playback_position(origin, relative, duration):
    return min(duration, max(0, origin) + max(0, relative))


STATUS_KEYS = {'phase', 'message', 'title', 'duration', 'origin', 'absolute_time',
               'receiver_state', 'active_subtitle_track_ids', 'subtitle_delay_ms',
               'session', 'ffmpeg_pid', 'ffmpeg_alive', 'producer_suspended',
               'segment_count', 'playlist_duration', 'generated_while_playing',
               'generation_complete', 'sources', 'pending', 'storage_bytes'}


def public_status(state):
    return {key: value for key, value in state.items() if key in STATUS_KEYS}


class BridgeError(Exception):
    pass


def probe(source):
    try:
        result = subprocess.run([FFPROBE, '-v', 'error', '-rw_timeout', '15000000',
            '-analyzeduration', '5000000', '-probesize', '5000000', '-show_streams',
            '-show_format', '-of', 'json', source], capture_output=True, timeout=30)
        data = json.loads(result.stdout)
        streams = data['streams']
        video = next(s['index'] for s in streams if s['codec_type'] == 'video'
                     and not s.get('disposition', {}).get('attached_pic'))
        audio = next(s['index'] for s in streams if s['codec_type'] == 'audio')
        spanish = [s for s in streams if s['codec_type'] == 'subtitle'
                   and s.get('tags', {}).get('language', '').lower() in ('spa', 'es', 'es-419', 'es-mx', 'es-es')]
        spanish.sort(key=lambda s: not re.search(r'latin|latino|latam|mexic|es-419|es-mx',
                          ' '.join(str(v).lower() for v in s.get('tags', {}).values())))
        text = next((s for s in spanish if s['codec_name'] in ('subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text')), None)
        if text is None:
            raise BridgeError('No hay subtítulos de texto en español. PGS/imagen no es compatible.')
        duration = float(data['format']['duration'])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        return [video, audio, text['index']], duration
    except BridgeError:
        raise
    except Exception:
        raise BridgeError('No se pudo analizar la fuente en 30 segundos; abrila en Stremio y reintentá.') from None


class Bridge:
    """A single mutation worker; status reads never wait for probe or discovery."""
    def __init__(self, args, lan_ip):
        self.args, self.lan_ip = args, lan_ip
        self.sessions = ROOT / '.local' / 'sessions'
        self.sessions.mkdir(parents=True, exist_ok=True)
        self.state_lock = threading.Lock()
        self.state = {'phase': 'idle', 'message': 'Elegí una fuente y presioná Iniciar.',
                      'subtitle_delay_ms': args.subtitle_delay_ms, 'sources': [], 'pending': False}
        self.sources = []
        self.selected = None
        self.source_delays = {}
        self.initial_delay_applied = False
        self.cast = self.browser = self.process = self.session = None
        self.media_url = None
        self.receiver_confirmed = False
        self.suspended = self.loaded = self.paused = False
        self.origin = self.duration = self.total_duration = 0
        self.last_playing_segments = None
        self.jobs = queue.Queue(maxsize=16)
        self.quit = threading.Event()
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    def update(self, **values):
        with self.state_lock:
            self.state.update(values)

    def status(self):
        with self.state_lock:
            return public_status(dict(self.state))

    def submit(self, action, data):
        if action not in ('discover', 'start', 'pause', 'resume', 'seek', 'delay', 'stop'):
            raise BridgeError('Acción desconocida.')
        try:
            self.jobs.put_nowait((action, data))
        except queue.Full:
            raise BridgeError('Hay demasiadas acciones pendientes.') from None

    def discover(self):
        sources = []
        if self.args.source_file:
            try:
                saved = json.loads(Path(self.args.source_file).read_text())
                source = saved['source']
                if not isinstance(source, str) or not source.startswith('http://'):
                    raise ValueError()
                sources.append({'url': source, 'title': 'Fuente guardada', 'length': None, 'index': None})
            except Exception:
                raise BridgeError('No se pudo leer el JSON explícito de fuente.') from None
        # Only the streaming engine. Never query Stremio casting/player routes.
        try:
            with urlopen('http://127.0.0.1:11470/stats.json', timeout=3) as response:
                stats = json.load(response)
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
                                        'title': Path(name).name[:180], 'length': file.get('length'),
                                        'index': int(index)})
        except Exception:
            pass
        self.sources = sources
        self.update(sources=[{'id': str(i), **{k: v for k, v in s.items() if k != 'url'}}
                             for i, s in enumerate(sources)], message='Fuentes actualizadas.')

    def connect(self):
        if self.cast:
            return
        import pychromecast
        casts, self.browser = pychromecast.get_listed_chromecasts(
            friendly_names=[self.args.device_name],
            known_hosts=[self.args.device_host] if self.args.device_host else None,
            discovery_timeout=8)
        matches = [c for c in casts if c.cast_info.friendly_name == self.args.device_name
                   and (not self.args.device_host or c.cast_info.host == self.args.device_host)]
        for cast in casts:
            if cast not in matches:
                cast.disconnect()
        if len(matches) != 1:
            for cast in matches:
                cast.disconnect()
            raise BridgeError('Se requiere exactamente el Chromecast indicado por nombre y host.')
        self.cast = matches[0]
        self.cast.wait(timeout=10)

    def stop_process(self):
        if self.process and self.process.poll() is None:
            if self.suspended:
                self.process.send_signal(signal.SIGCONT)
            self.process.terminate()
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.suspended = False
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

    def stop(self):
        self.stop_process()
        if self.cast:
            try:
                if self.media_url and self.cast.media_controller.status.content_id == self.media_url:
                    self.cast.media_controller.stop()
            except Exception:
                pass
            finally:
                try:
                    self.cast.disconnect()
                except Exception:
                    pass
                self.cast = None
        if self.browser:
            try:
                self.browser.stop_discovery()
            except Exception:
                pass
            self.browser = None
        self.loaded = False
        self.media_url = None
        self.update(phase='stopped', message='Detenido.', pending=False, ffmpeg_alive=False,
                    producer_suspended=False, receiver_state='IDLE', active_subtitle_track_ids=[])
        self.record_session()
        self.session = None

    def storage(self):
        return sum(p.stat().st_size for p in self.sessions.glob('*/*')
                   if p.is_file() and not p.is_symlink())

    def begin(self, origin=0):
        self.stop_process()
        if (self.cast and self.media_url
                and self.cast.media_controller.status.content_id == self.media_url):
            self.cast.media_controller.stop()
        self.loaded = False
        self.receiver_confirmed = False
        self.media_url = None
        self.session = None
        self.update(phase='preparing', pending=True, message='Analizando fuente / esperando descarga…')
        self.streams, self.total_duration = probe(self.selected['url'])
        if self.quit.is_set():
            raise BridgeError('Servicio detenido.')
        self.duration = min(self.total_duration, self.args.max_duration or self.total_duration)
        self.origin = min(max(0, float(origin)), max(0, self.duration - 0.1))
        if shutil.disk_usage(self.sessions).free < 1024**3 or self.storage() >= 6 * 1024**3:
            raise BridgeError('Espacio insuficiente: requiere 1 GB libre y menos de 6 GB de sesiones.')
        self.connect()
        if self.quit.is_set():
            raise BridgeError('Servicio detenido.')
        self.session = self.sessions / ('session-' + secrets.token_hex(8))
        self.session.mkdir()
        delay = self.status()['subtitle_delay_ms']
        command = ffmpeg_command(self.selected['url'], self.session, self.streams, delay,
                                 self.origin, self.duration - self.origin, self.args.readrate)
        # Never persist raw arguments or producer stderr (both may contain private URLs).
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.last_playing_segments = None
        self.started_at = time.monotonic()
        self.update(title=self.selected['title'], duration=self.duration, origin=self.origin,
                    absolute_time=self.origin, phase='buffering', session=self.session.name,
                    ffmpeg_pid=self.process.pid, ffmpeg_alive=True, segment_count=0,
                    playlist_duration=0, generated_while_playing=False, generation_complete=False)

    def mutate(self, action, data):
        if action == 'discover':
            self.discover()
        elif action == 'start':
            if not self.sources:
                self.discover()
            index = int(data.get('source_id', 0))
            if not 0 <= index < len(self.sources):
                raise BridgeError('Elegí una fuente disponible.')
            self.selected = self.sources[index]
            source = self.selected['url']
            if source not in self.source_delays:
                self.source_delays[source] = self.args.subtitle_delay_ms if not self.initial_delay_applied else 0
                self.initial_delay_applied = True
            self.update(subtitle_delay_ms=self.source_delays[source])
            self.paused = False
            self.begin()
        elif action == 'stop':
            self.stop()
        elif action in ('pause', 'resume'):
            if not self.loaded:
                raise BridgeError('Esperá a que empiece la reproducción.')
            if self.cast.media_controller.status.content_id != self.media_url:
                raise BridgeError('El receptor todavía no confirmó esta sesión.')
            self.paused = action == 'pause'
            (self.cast.media_controller.pause if self.paused else self.cast.media_controller.play)()
        elif action in ('seek', 'delay'):
            if not self.session:
                raise BridgeError('Primero iniciá una fuente.')
            status = self.status()
            if action == 'delay':
                delay = int(data['delay_ms'])
                if abs(delay) > 30000:
                    raise BridgeError('El retraso debe estar entre -30000 y 30000 ms.')
                self.update(subtitle_delay_ms=delay)
                self.source_delays[self.selected['url']] = delay
                target = status['absolute_time']
            else:
                target = float(data['position']) if 'position' in data else status['absolute_time'] + float(data['delta'])
                if not math.isfinite(target):
                    raise BridgeError('La posición debe ser finita.')
                target = min(max(0, target), max(0, self.duration - 0.1))
            self.begin(target)

    def tick(self):
        if not self.session:
            return
        manifest = self.session / 'video.m3u8'
        text = manifest.read_text() if manifest.exists() else ''
        durations = [float(v) for v in re.findall(r'#EXTINF:([0-9.]+)', text)]
        generated, count = sum(durations), len(durations)
        alive = self.process.poll() is None
        complete = '#EXT-X-ENDLIST' in text
        storage = self.storage()
        if storage >= 6 * 1024**3 or shutil.disk_usage(self.sessions).free < 512 * 1024**2:
            raise BridgeError('Límite de almacenamiento alcanzado. Detenido para proteger el disco.')
        subtitle_manifest = self.session / 'video_vtt.m3u8'
        ready = count >= 3 and subtitle_manifest.exists() and (self.session / 'master.m3u8').exists()
        if not alive and self.process.returncode != 0:
            raise BridgeError(f'FFmpeg terminó con código {self.process.returncode}. Fuente o códec no disponible.')
        if not self.loaded and (ready or complete and count > 0 and subtitle_manifest.exists()):
            url = f'http://{self.lan_ip}:{self.args.media_port}/{self.session.name}/master.m3u8'
            self.media_url = url
            self.cast.media_controller.play_media(url, 'application/x-mpegURL', title=self.selected['title'],
                current_time=0, autoplay=not self.paused, stream_type='BUFFERED',
                media_info={'duration': self.duration - self.origin})
            self.loaded = True
            self.update(phase='loading', message='HLS listo; esperando al Chromecast…')
        absolute = self.status().get('absolute_time', self.origin)
        relative, receiver = max(0, absolute - self.origin), 'PENDING'
        tracks = []
        if self.loaded:
            self.cast.media_controller.update_status()
            status = self.cast.media_controller.status
            owns_status = status.content_id == self.media_url
            if owns_status:
                relative = max(0, float(status.adjusted_current_time or 0))
            receiver = status.player_state if owns_status else 'PENDING'
            tracks = list(status.current_subtitle_tracks or []) if owns_status else []
            for track in (status.subtitle_tracks or []) if owns_status else []:
                if not isinstance(track, dict) or track.get('type') != 'TEXT':
                    continue
                track_id = track.get('trackId')
                if track_id is not None and track_id not in tracks:
                    self.cast.media_controller.enable_subtitle(track_id)
                    break
            if receiver in ('PLAYING', 'PAUSED'):
                self.receiver_confirmed = True
                self.update(phase=receiver.lower(), pending=False, message='Reproduciendo.' if receiver == 'PLAYING' else 'En pausa.')
            elif not owns_status:
                if self.receiver_confirmed:
                    self.update(phase='receiver_changed', pending=True, message='El receptor cambió de contenido; esperando esta sesión…')
                else:
                    self.update(phase='loading', pending=True, message='HLS listo; esperando al Chromecast…')
            elif receiver == 'BUFFERING':
                self.update(phase='buffering', pending=True, message='Esperando al receptor o a la descarga…')
            elif receiver == 'IDLE' and status.idle_reason == 'FINISHED':
                self.update(phase='ended', pending=False, message='Finalizó la reproducción.')
            elif receiver == 'IDLE' and status.idle_reason == 'ERROR':
                raise BridgeError('El receptor informó un error al reproducir esta sesión HLS.')
            if receiver == 'PLAYING' and alive:
                if self.last_playing_segments is not None and count > self.last_playing_segments:
                    self.update(generated_while_playing=True)
                self.last_playing_segments = count
        ahead = generated - relative
        if alive and ahead > 60 and not self.suspended:
            self.process.send_signal(signal.SIGSTOP)
            self.suspended = True
        elif alive and ahead < 45 and self.suspended:
            self.process.send_signal(signal.SIGCONT)
            self.suspended = False
        self.update(absolute_time=playback_position(self.origin, relative, self.duration),
                    receiver_state=receiver, active_subtitle_track_ids=tracks,
                    ffmpeg_alive=alive, producer_suspended=self.suspended,
                    segment_count=count, playlist_duration=generated, generation_complete=complete,
                    storage_bytes=storage)
        self.record_session()
        if not self.loaded and time.monotonic() - self.started_at > 180:
            raise BridgeError('La fuente no produjo segmentos suficientes en 3 minutos. Reintentá cuando descargue.')

    def _work(self):
        while not self.quit.is_set():
            try:
                action, data = self.jobs.get(timeout=0.5)
            except queue.Empty:
                action = None
            if action:
                try:
                    self.mutate(action, data)
                except Exception as error:
                    message = str(error) if isinstance(error, BridgeError) else 'No se pudo ejecutar la acción. Revisá la fuente y el receptor.'
                    self.update(message=message, pending=False)
                    if self.session is None:
                        self.update(phase='error', ffmpeg_alive=False)
            try:
                self.tick()
            except Exception as error:
                message = str(error) if isinstance(error, BridgeError) else 'No se pudo ejecutar la acción. Revisá la fuente y el receptor.'
                try:
                    self.stop()
                except Exception:
                    pass
                self.update(phase='error', message=message, pending=False)
            if self.args.state_file:
                target = Path(self.args.state_file)
                try:
                    temp = target.with_suffix('.tmp')
                    temp.write_text(json.dumps(self.status(), ensure_ascii=False))
                    temp.replace(target)
                except OSError:
                    pass
        self.stop()

    def close(self):
        self.quit.set()
        self.worker.join(timeout=50)


PANEL = '''<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stremio → Chromecast</title><style>
body{font:17px system-ui;background:#13151a;color:#eee;max-width:760px;margin:32px auto;padding:0 18px}
button,input,select{font:inherit;padding:10px;margin:5px 4px 5px 0;border-radius:6px;border:1px solid #666}
button{cursor:pointer}input{width:130px}select{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#bed9ed}
label{display:inline-block}#message{min-height:2em}small{color:#bbb}
</style><h1>Stremio → Chromecast</h1>
<p>Abrí una película en Stremio. Elegí la fuente para enviarla a <strong>__DEVICE__</strong>.</p>
<button id="discover">Actualizar fuentes</button><select id="source" aria-label="Fuente"></select>
<button id="start">Iniciar</button><p id="message" role="status" aria-live="polite">Conectando…</p>
<div><button id="pause">Pausa</button><button id="resume">Continuar</button>
<button id="back">−30 s</button><button id="forward">+30 s</button><button id="stop">Detener</button></div>
<p><label>Posición absoluta (segundos) <input id="position" type="number" min="0" value="0"></label>
<button id="seek">Ir</button></p>
<p><label>Retraso de subtítulos (ms) <input id="delay" type="number" min="-30000" max="30000" step="100" value="__DELAY__"></label>
<button id="apply">Aplicar retraso</button><br><small>Un valor positivo muestra el texto más tarde. Aplicar reinicia desde la posición actual.</small></p>
<pre id="status"></pre><small>Cada salto reinicia desde la posición absoluta con una sesión HLS nueva y conserva la pausa. Esperá la confirmación del receptor; puede depender de la descarga del torrent.</small>
<script>
const token='__TOKEN__';
async function command(action,data={}){try{const r=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':token},body:JSON.stringify(data)});if(!r.ok)throw Error('No se pudo enviar la acción');document.querySelector('#message').textContent='Acción solicitada…';}catch(e){document.querySelector('#message').textContent=e.message}}
for(const action of ['discover','pause','resume','stop'])document.getElementById(action).onclick=()=>command(action);
document.querySelector('#start').onclick=()=>command('start',{source_id:document.querySelector('#source').value});
document.querySelector('#back').onclick=()=>command('seek',{delta:-30});
document.querySelector('#forward').onclick=()=>command('seek',{delta:30});
document.querySelector('#seek').onclick=()=>command('seek',{position:Number(document.querySelector('#position').value)});
document.querySelector('#apply').onclick=()=>command('delay',{delay_ms:Number(document.querySelector('#delay').value)});
let sourceSignature='',lastDelay=null;
async function poll(){try{const r=await fetch('/api/status');const s=await r.json();document.querySelector('#message').textContent=s.message;
const signature=JSON.stringify(s.sources);if(signature!==sourceSignature){sourceSignature=signature;const select=document.querySelector('#source');select.replaceChildren();for(const source of s.sources||[]){const option=document.createElement('option');option.value=source.id;option.textContent=source.title;select.append(option)}}
if(lastDelay!==s.subtitle_delay_ms){lastDelay=s.subtitle_delay_ms;if(document.activeElement!==document.querySelector('#delay'))document.querySelector('#delay').value=lastDelay}
document.querySelector('#status').textContent=JSON.stringify(s,null,2);
}catch(e){document.querySelector('#message').textContent='Servicio desconectado.'}setTimeout(poll,1500)}poll();
</script></html>'''


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
        path = safe_media_path(self.server.bridge.sessions, self.path)
        if path is None:
            self.send_error(404)
            return
        try:
            with open_media(self.server.bridge.sessions, path) as stream:
                size = os.fstat(stream.fileno()).st_size
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
                self.send_header('Content-Type', MIME[path.suffix])
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
            panel = PANEL.replace('__TOKEN__', self.server.token).replace('__DEVICE__', html.escape(self.server.bridge.args.device_name)).replace('__DELAY__', str(self.server.bridge.args.subtitle_delay_ms))
            self.reply(200, panel, 'text/html')
        elif self.path == '/api/status':
            self.reply(200, self.server.bridge.status())
        else:
            self.reply(404, {})

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if (not self.trusted_host() or self.headers.get('Origin') not in (None, origin)
                or not secrets.compare_digest(self.headers.get('X-Bridge-Token', ''), self.server.token)
                or self.headers.get_content_type() != 'application/json'):
            self.reply(403, {'message': 'Solicitud no autorizada.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                raise ValueError()
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or not self.path.startswith('/api/'):
                raise ValueError()
            self.server.bridge.submit(self.path[5:], data)
            self.reply(202, {'accepted': True})
        except (ValueError, BridgeError):
            self.reply(400, {'message': 'Solicitud inválida o cola ocupada.'})

    def log_message(self, *_):
        pass


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-file', help='JSON explícito con source y device_id; no se publica')
    parser.add_argument('--device-name', default='Stefano')
    parser.add_argument('--device-host', help='IP exacta del Chromecast autorizado')
    parser.add_argument('--subtitle-delay-ms', type=int, default=0)
    parser.add_argument('--max-duration', type=float)
    parser.add_argument('--readrate', type=float, default=1.1)
    parser.add_argument('--media-port', type=int, default=18766)
    parser.add_argument('--control-port', type=int, default=18767)
    parser.add_argument('--autostart', action='store_true')
    parser.add_argument('--no-open', action='store_true', help='Aceptado; nunca se abre un navegador automáticamente')
    parser.add_argument('--state-file', nargs='?', const=str(ROOT / '.local' / 'state.json'))
    args = parser.parse_args(argv)
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
        # With no fixed host, discover the exact name to determine the LAN route first.
        host = args.device_host
        if not host:
            import pychromecast
            casts, browser = pychromecast.get_listed_chromecasts(friendly_names=[args.device_name], discovery_timeout=8)
            try:
                matches = [c for c in casts if c.cast_info.friendly_name == args.device_name]
                if len(matches) != 1:
                    raise BridgeError('No se encontró un único Chromecast con el nombre indicado.')
                host = matches[0].cast_info.host
                args.device_host = host
            finally:
                for cast in casts:
                    cast.disconnect()
                browser.stop_discovery()
        bridge = Bridge(args, lan_address(host))
        media = ThreadingHTTPServer((bridge.lan_ip, args.media_port), MediaHandler)
        media.bridge = bridge
        control = ThreadingHTTPServer(('127.0.0.1', args.control_port), ControlHandler)
        control.bridge, control.token = bridge, secrets.token_urlsafe(32)
        for server in (media, control):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            serving.append(server)
        bridge.submit('discover', {})
        if args.autostart:
            bridge.submit('start', {})
        print(json.dumps({'ready': True, 'control_url': f'http://127.0.0.1:{args.control_port}',
                          'media_lan_ip': bridge.lan_ip, 'device_name': args.device_name}), flush=True)
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
