"""Synthetic plans for the existing worker and receiver test seams."""
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import queue
import re
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from unittest.mock import Mock, patch
from types import SimpleNamespace

from bridge import MediaHandler
from media import Analysis, Catalogue, PlaybackPlan, SetupCatalogue, Subtitle
from vod import Producer, VodLayout


def finished_producer(directory, duration, subtitles=True, hold_seconds=1):
    """A session whose producer gave up: whatever is not on disk never will be."""
    layout = VodLayout(duration, subtitles=subtitles)
    def command(*_):
        raise AssertionError('a finished fixture never starts FFmpeg')
    producer = Producer(directory, layout, command, hold_seconds=hold_seconds, poll_seconds=.01, retries=0)
    producer.process = Mock(pid=None, **{'poll.return_value': 0})
    producer.limit = layout.count
    return producer


def running_producer(bridge, pid=123):
    """An alive FFmpeg run that started at the playhead and has written nothing yet."""
    producer = bridge.producer
    producer.process = Mock(pid=pid, **{'poll.return_value': None})
    producer.start = producer.position = producer.layout.index_at(bridge.state.get('absolute_time') or 0)
    producer.limit = producer.layout.count
    producer.settled = False
    return producer.process


def produce(directory, *indices):
    for index in indices:
        (directory / VodLayout.segment_name(index)).write_bytes(b'segment')


@contextmanager
def media_server(sessions, *producers):
    server = ThreadingHTTPServer(('127.0.0.1', 0), MediaHandler)
    served = {producer.directory.name: producer for producer in producers}
    server.bridge = SimpleNamespace(sessions=sessions, media_producer=served.get)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    opener = build_opener(ProxyHandler({}))
    try:
        yield lambda path, **headers: opener.open(
            Request(f'http://127.0.0.1:{server.server_port}{path}', headers=headers))
    finally:
        server.shutdown()
        server.server_close()


def seconds(stamp):
    value = 0
    for part in stamp.split(':'):
        value = value * 60 + float(part)
    return value


def served_cues(fetch, session, delay_ms):
    def get(name):
        try:
            return fetch(f'/{session}/d{delay_ms}/{name}').read().decode()
        except HTTPError as error:
            if error.code != 404:
                raise
            return ''
    cues = {}
    for name in re.findall(r'^([\w-]+\.vtt)$', get('video_vtt.m3u8'), re.M):
        for start, end, label in re.findall(r'(\d+(?::\d+){1,2}\.\d+) --> (\d+(?::\d+){1,2}\.\d+)[^\n]*\n([^\n]+)', get(name)):
            times = seconds(start), seconds(end)
            assert times[1] > times[0], (label, times)
            assert cues.setdefault(label, times) == times, (label, cues[label], times)
    return cues


def install_media(bridge, source=None, duration=120, delay=500):
    source = source or dict(id='fixture-source', url='offline-fixture', title='Fixture')
    bridge.device_lock, bridge.source_lock = threading.Lock(), threading.Lock()
    bridge.device_snapshot = dict(devices=[], device_discovery='ready', device_error=None)
    bridge.source_snapshot = dict(sources=[], source_discovery='ready', source_error=None)
    bridge.device_wake, bridge.source_wake = threading.Event(), threading.Event()
    bridge.metadata_workers = []
    bridge.quit = getattr(bridge, 'quit', threading.Event())
    bridge.jobs = getattr(bridge, 'jobs', queue.Queue(maxsize=16))
    bridge.devices = getattr(bridge, 'devices', {})
    selected = bridge.state.get('selected_device')
    if selected:
        bridge.devices[selected['id']] = SimpleNamespace(uuid=selected['id'], friendly_name='Fixture',
            host='192.0.2.2', model_name='Chromecast', port=8009, cast_type='cast')
    with patch('media.threading.Thread'):
        bridge.catalogue = SetupCatalogue(Mock(), Path('unused-synthetic-upload-root'))
    bridge.catalogue.worker.is_alive.return_value = False
    plan = seed_plan(bridge, source, duration, delay)
    bridge.active_plan = plan
    bridge.catalogue.pin(plan.catalogue.id)
    bridge.sources = [source]
    bridge.state.update(playback_id='fixture-playback', subtitle_choice=plan.choice(),
                        active_catalogue=plan.catalogue.public(), subtitle_delay_ms=delay)
    return plan


def seed_plan(bridge, source, duration=120, delay=0):
    entry = Subtitle('text-' + source['id'], 'embedded', 'English', 'eng', index=2)
    catalogue = Catalogue('catalogue-' + source['id'], dict(source), Analysis(0, 1, duration, (entry,)))
    bridge.catalogue.records[catalogue.id] = catalogue
    bridge.catalogue.snapshots[source['id']] = dict(state='ready', catalogue=catalogue.public())
    return PlaybackPlan(catalogue, entry, delay, True)


def start_data(bridge, source=None, delay=0, subtitle=True):
    source = source or bridge.sources[0]
    catalogue_id = 'catalogue-' + source['id']
    if catalogue_id not in bridge.catalogue.records:
        seed_plan(bridge, source)
    return dict(device_id=bridge.state['selected_device']['id'], device_revision=bridge.state['device_revision'],
                source_id=source['id'], catalogue_id=catalogue_id,
                subtitle_id='text-' + source['id'] if subtitle else None, delay_ms=delay)


def apply_data(bridge, enabled=True, delay=None, subtitle_id=...):
    choice = bridge.active_plan.choice()
    return dict(device_id=bridge.state['selected_device']['id'], device_revision=bridge.state['device_revision'],
                playback_id=bridge.state['playback_id'], catalogue_id=choice['catalogue_id'],
                subtitle_id=choice['subtitle_id'] if subtitle_id is ... else subtitle_id,
                enabled=enabled, delay_ms=choice['delay_ms'] if delay is None else delay)


def demo_start(bridge, source_id='demo-a', subtitle=True, delay=0):
    _, response = bridge.request_catalogue(dict(source_id=source_id, refresh=False))
    catalogue = response['catalogue']
    return dict(device_id=bridge.state['selected_device']['id'], device_revision=bridge.state['device_revision'],
                source_id=source_id, catalogue_id=catalogue['id'],
                subtitle_id=catalogue['entries'][0]['id'] if subtitle else None, delay_ms=delay)


def demo_apply(bridge, enabled=True, delay=None):
    choice = bridge.status()['subtitle_choice']
    return dict(device_id=bridge.state['selected_device']['id'], device_revision=bridge.state['device_revision'],
                playback_id=bridge.state['playback_id'], catalogue_id=choice['catalogue_id'],
                subtitle_id=choice['subtitle_id'], enabled=enabled, delay_ms=choice['delay_ms'] if delay is None else delay)
