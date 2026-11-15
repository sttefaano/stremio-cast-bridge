import io
import json
import queue
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID
from pychromecast.models import CastInfo
from bridge import Bridge, BridgeError, main, arguments
from backend_fixtures import seed_plan, start_data


class DeviceSelectorTest(unittest.TestCase):
    def setUp(self):
        guard = patch('socket.socket', side_effect=AssertionError('network forbidden'))
        guard.start()
        self.addCleanup(guard.stop)
    def fixture(self):
        with patch('bridge.threading.Thread'), patch('bridge.Path.mkdir'):
            b = Bridge(arguments([]))
            b.worker.is_alive.return_value = False
            b.catalogue.worker.is_alive.return_value = False
            for worker in b.metadata_workers:
                worker.is_alive.return_value = False
            return b

    def info(self, number=1, name='Sala', host='192.0.2.2', kind='cast'):
        return CastInfo(set(), UUID(int=number), 'Chromecast', name, host, 8009, kind, 'Google')

    def test_discovery_and_explicit_uuid_selection_are_metadata_only(self):
        b = self.fixture()
        devices = [self.info(), self.info(2, host='192.0.2.3'), self.info(3, kind='audio'), self.info(4, kind='group')]
        with patch('bridge.discover_receivers', return_value=devices), \
             patch('pychromecast.get_chromecast_from_cast_info', side_effect=AssertionError('connection forbidden')), \
             patch('bridge.urlopen', side_effect=AssertionError('Stremio forbidden')):
            b.mutate('discover_devices', {})
            s = b.status()
            self.assertEqual(len(s['devices']), 2)
            self.assertIsNone(s['selected_device'])
            self.assertEqual(s['device_discovery'], 'ready')
            target = str(devices[1].uuid)
            b.submit('select_device', {'device_id': target, 'device_revision': b.status()['device_revision']})
            action, data, revision = b.jobs.get_nowait()
            b.mutate(action, data)
            self.assertEqual(b.status()['selected_device']['id'], target)
            self.assertTrue(b.status()['selected_device']['available'])
            b.update(command_pending=False)
            with patch('bridge.discover_receivers', return_value=[devices[1], devices[0]]):
                b.mutate('discover_devices', {})
            self.assertEqual(b.status()['selected_device']['id'], target)
            with patch('bridge.discover_receivers', return_value=[devices[0]]):
                b.mutate('discover_devices', {})
            self.assertEqual(b.status()['selected_device']['id'], target)
            self.assertFalse(b.status()['selected_device']['available'])
            with self.assertRaises(BridgeError):
                b.submit('start', {'source_id': 'movie', 'device_id': target, 'device_revision': b.status()['device_revision']})

    def test_panel_starts_without_receiver_discovery_route_or_media_binding(self):
        b = Mock()
        b.quit.wait.return_value = True
        server = Mock()
        out = io.StringIO()
        with patch('bridge.Bridge', return_value=b), patch('bridge.ThreadingHTTPServer', return_value=server) as bind, \
             patch('bridge.threading.Thread'), patch('bridge.signal.signal'), \
             patch('bridge.lan_address', side_effect=AssertionError('no route')), \
             patch('socket.socket', side_effect=AssertionError('no network')), patch('sys.stdout', out):
            self.assertEqual(main([]), 0)
        self.assertTrue(json.loads(out.getvalue())['ready'])
        self.assertIsNone(arguments([]).device_name)
        bind.assert_called_once()
        self.assertEqual(bind.call_args.args[0][0], '127.0.0.1')
        b.submit.assert_not_called()
        b.close.assert_called_once()

    def test_destination_lock_survives_terminal_phases_until_explicit_stop(self):
        b = self.fixture()
        infos = [self.info(), self.info(2, host='192.0.2.3')]
        with patch('bridge.discover_receivers', return_value=infos):
            b.mutate('discover_devices', {})
        first, second = map(lambda i: str(i.uuid), infos)
        b.mutate('select_device', {'device_id': first, 'device_revision': b.status()['device_revision']})
        b.sources = [dict(id='movie', url='offline', title='Fixture')]
        data = start_data(b)
        with patch.object(b, 'begin', side_effect=BridgeError('Offline producer fixture')):
            with self.assertRaises(BridgeError):
                b.mutate('start', data)
        for phase in ('playing', 'paused', 'preparing', 'stopped', 'ended', 'error', 'receiver_changed', 'disconnected'):
            b.update(phase=phase, pending=False, command_pending=False)
            self.assertFalse(b.status()['can_change_device'])
            with self.assertRaises(BridgeError):
                b.submit('select_device', {'device_id': second, 'device_revision': b.status()['device_revision']})
            with self.assertRaises(BridgeError):
                b.mutate('select_device', {'device_id': second, 'device_revision': b.status()['device_revision']})
        b.mutate('stop', {'device_id':str(self.info().uuid), 'device_revision':1})
        b.mutate('select_device', {'device_id': second, 'device_revision': b.status()['device_revision']})
        self.assertEqual(b.status()['selected_device']['id'], second)
        with self.assertRaises(BridgeError):
            b.submit('start', data)
        with self.assertRaises(BridgeError):
            b.mutate('start', data)

    def test_start_resolves_uuid_current_endpoint_and_rejects_endpoint_uuid_mismatch(self):
        b = self.fixture()
        original = self.info()
        current = self.info(name='Nuevo nombre', host='192.0.2.9')
        with patch('bridge.discover_receivers', return_value=[original]):
            b.mutate('discover_devices', {})
        b.mutate('select_device', {'device_id': str(original.uuid), 'device_revision': b.status()['device_revision']})
        receiver = Mock()
        receiver.cast_info = current
        with patch('bridge.discover_receivers', return_value=[current]):
            b.scan_devices()
        with patch('bridge.discover_receivers', return_value=[current]), \
             patch('pychromecast.dial.get_device_info', return_value=SimpleNamespace(uuid=UUID(int=2), cast_type='cast')), \
             patch('pychromecast.get_chromecast_from_cast_info', return_value=receiver) as connect, \
             patch('bridge.lan_address', return_value='192.0.2.10'), patch('bridge.ThreadingHTTPServer'):
            with self.assertRaises(BridgeError):
                b.connect()
            connect.assert_not_called()
            receiver.media_controller.play_media.assert_not_called()
        with patch('bridge.discover_receivers', return_value=[current]), \
             patch('pychromecast.dial.get_device_info', return_value=SimpleNamespace(uuid=current.uuid, cast_type='cast')), \
             patch('pychromecast.get_chromecast_from_cast_info', return_value=receiver) as connect, \
             patch('bridge.lan_address', return_value='192.0.2.10') as route, \
             patch('bridge.ThreadingHTTPServer') as bind, patch('bridge.threading.Thread'):
            b.connect()
            route.assert_called_once_with('192.0.2.9')
            self.assertEqual(bind.call_args.args[0], ('192.0.2.10', 18766))
            self.assertEqual(connect.call_args.args[0].host, '192.0.2.9')
            self.assertEqual(b.status()['selected_device']['id'], str(original.uuid))
            b.stop()

    def test_queued_selection_rechecks_owned_resources_and_clean_stop_releases_them(self):
        b = self.fixture()
        infos = [self.info(), self.info(2, host='192.0.2.3')]
        with patch('bridge.discover_receivers', return_value=infos):
            b.mutate('discover_devices', {})
        b.mutate('select_device', {'device_id': str(infos[0].uuid), 'device_revision': b.status()['device_revision']})
        b.submit('select_device', {'device_id': str(infos[1].uuid), 'device_revision': b.status()['device_revision']})
        action, data, _ = b.jobs.get_nowait()
        cast, producer = Mock(), Mock()
        cast.media_controller.status.content_id = 'owned'
        b.cast, b.producer, b.media_url = cast, producer, 'owned'
        b.update(phase='ended', pending=False)
        with self.assertRaises(BridgeError):
            b.mutate(action, data)
        b.mutate('stop', {'device_id':str(self.info().uuid), 'device_revision':1})
        cast.media_controller.stop.assert_called_once()
        cast.disconnect.assert_called_once()
        producer.close.assert_called_once()
        b.update(command_pending=False)
        self.assertTrue(b.status()['can_change_device'])
        b.mutate(action, data)
        self.assertEqual(b.status()['selected_device']['id'], str(infos[1].uuid))

    def test_discovery_is_responsive_and_does_not_change_playback_or_selection_on_error(self):
        b = self.fixture()
        entered, release = threading.Event(), threading.Event()
        def blocked(*args):
            entered.set()
            self.assertTrue(release.wait(2))
            raise OSError('private diagnostic')
        errors = []
        def scan():
            try:
                b.mutate('discover_devices', {})
            except BridgeError as error:
                errors.append(error)
        with patch('bridge.discover_receivers', side_effect=blocked):
            thread = threading.Thread(target=scan)
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertEqual(b.status()['device_discovery'], 'loading')
                self.assertEqual(b.status()['phase'], 'idle')
                b.submit('stop', {})
            finally:
                release.set()
                thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertEqual(b.status()['devices'], [])
        self.assertEqual(b.status()['device_discovery'], 'error')
        self.assertNotIn('private', json.dumps(b.status()))
        self.assertIsNone(b.cast)

    def test_opt_in_flags_do_not_connect_or_choose_ambiguous_names(self):
        with self.assertRaises(SystemExit):
            arguments(['--autostart'])
        b = self.fixture()
        b.args = arguments(['--device-name', 'Sala'])
        with patch('bridge.discover_receivers', return_value=[self.info(), self.info(2)]), \
             patch('pychromecast.get_chromecast_from_cast_info', side_effect=AssertionError('no connection')):
            b.scan_devices()
            with self.assertRaises(BridgeError):
                b.mutate('configure_device', {})
            self.assertIsNone(b.status()['selected_device'])
        b.args = arguments(['--device-host', '192.0.2.2'])
        with patch('bridge.discover_receivers', return_value=[self.info(), self.info(2, host='192.0.2.3')]):
            b.scan_devices()
            b.mutate('configure_device', {})
        self.assertEqual(b.status()['selected_device']['id'], str(self.info().uuid))
        self.assertIsNone(b.cast)

    def test_unavailable_destination_never_connects_and_media_rebind_owns_cleanup(self):
        b = self.fixture()
        with patch('bridge.discover_receivers', return_value=[self.info()]):
            b.mutate('discover_devices', {})
        b.mutate('select_device', {'device_id': str(self.info().uuid), 'device_revision': b.status()['device_revision']})
        with patch('bridge.discover_receivers', return_value=[]), \
             patch('pychromecast.get_chromecast_from_cast_info') as connect:
            b.scan_devices()
            with self.assertRaises(BridgeError):
                b.connect()
            connect.assert_not_called()
        first, second = Mock(), Mock()
        with patch('bridge.lan_address', side_effect=['192.0.2.1', '192.0.2.1', '192.0.2.10']), \
             patch('bridge.ThreadingHTTPServer', side_effect=[first, second]) as bind, patch('bridge.threading.Thread'):
            b.ensure_media_server('192.0.2.2')
            b.ensure_media_server('192.0.2.3')
            self.assertEqual(bind.call_count, 1)
            b.ensure_media_server('192.0.2.9')
            first.shutdown.assert_called_once()
            first.server_close.assert_called_once()
            b.close()
            second.shutdown.assert_called_once()
            second.server_close.assert_called_once()

    def test_failed_stop_retains_receiver_ownership_and_blocks_destination_change(self):
        b = self.fixture()
        with patch('bridge.discover_receivers', return_value=[self.info(), self.info(2)]):
            b.mutate('discover_devices', {})
        b.mutate('select_device', {'device_id': str(self.info().uuid), 'device_revision': b.status()['device_revision']})
        cast = Mock()
        b.cast, b.media_url = cast, 'owned'
        cast.media_controller.status.content_id = 'owned'
        cast.media_controller.stop.side_effect = OSError('offline')
        with self.assertRaises(BridgeError):
            b.mutate('stop', {'device_id':str(self.info().uuid), 'device_revision':1})
        self.assertFalse(b.status()['can_change_device'])
        with self.assertRaises(BridgeError):
            b.submit('select_device', {'device_id': str(self.info(2).uuid), 'device_revision': b.status()['device_revision']})
        self.assertIs(b.cast, cast)
        cast.media_controller.stop.side_effect = None
        b.mutate('stop', {'device_id':str(self.info().uuid), 'device_revision':1})
        self.assertTrue(b.status()['can_change_device'])

    def test_real_handler_discovery_and_selection_reject_unbound_or_stale_commands(self):
        from test_player_ux import ControlHTTPTest
        b = self.fixture()
        h = ControlHTTPTest().handler()
        h.server.bridge = b
        h.path = '/api/discover_devices'
        h.do_POST()
        self.assertEqual(h.reply.call_args.args[0], 202)
        self.assertTrue(b.jobs.empty())
        with patch('bridge.discover_receivers', return_value=[self.info()]):
            b.scan_devices()
        b.update(command_pending=False)
        h = ControlHTTPTest().handler(data={'device_id':str(self.info().uuid), 'device_revision':0})
        h.server.bridge = b
        h.path = '/api/select_device'
        h.do_POST()
        self.assertEqual(h.reply.call_args.args[0], 202)
        action, data, _ = b.jobs.get_nowait()
        b.mutate(action, data)
        b.update(command_pending=False)
        for payload in ({'source_id':'movie'}, {'source_id':'movie', 'device_id':str(self.info().uuid), 'device_revision':0}):
            h = ControlHTTPTest().handler(data=payload)
            h.server.bridge = b
            h.path = '/api/start'
            h.do_POST()
            self.assertIn(h.reply.call_args.args[0], (400, 409))
            self.assertTrue(b.jobs.empty())
        h.path = '/api/configure_device'
        h.do_POST()
        self.assertEqual(h.reply.call_args.args[0], 400)
        self.assertIsNone(b.cast)

    def test_mdns_capabilities_filter_audio_groups_and_clean_metadata_resources(self):
        b = self.fixture()
        zconf, browser = Mock(), Mock()
        records = [SimpleNamespace(properties={b'id':str(UUID(int=n)).encode(), b'fn':b'Sala', b'md':b'Unknown TV', b'ca':cap},
                                   port=port, parsed_addresses=lambda: ['192.0.2.2'])
                   for n, cap, port in [(1,b'5',8009),(2,b'4',8009),(3,b'5',12345)]]
        zconf.get_service_info.side_effect = records
        def browse(zc, kind, listener):
            for n in range(3):
                listener.add_service(zc, kind, f'device-{n}')
            return browser
        with patch('zeroconf.Zeroconf', return_value=zconf), patch('zeroconf.ServiceBrowser', side_effect=browse), \
             patch('bridge.time.sleep'), patch('pychromecast.get_chromecast_from_cast_info') as connect:
            b.mutate('discover_devices', {})
        self.assertEqual([i['id'] for i in b.status()['devices']], [str(UUID(int=1))])
        self.assertIsNone(b.status()['selected_device'])
        browser.cancel.assert_called_once()
        zconf.close.assert_called_once()
        connect.assert_not_called()

    def test_stop_during_receiver_wait_releases_handle_before_allowing_destination_change(self):
        b = self.fixture()
        info = self.info()
        with patch('bridge.discover_receivers', return_value=[info]):
            b.mutate('discover_devices', {})
        b.mutate('select_device', {'device_id':str(info.uuid), 'device_revision': b.status()['device_revision']})
        b.sources = [dict(id='movie', title='Fixture', url='offline')]
        entered, release = threading.Event(), threading.Event()
        receiver = Mock(cast_info=info)
        def wait(**kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
        receiver.wait.side_effect = wait
        receiver.disconnect.side_effect = b.quit.set
        b.media_server, b.lan_ip = Mock(), '192.0.2.1'
        payload = dict(device_id=str(info.uuid), device_revision=1)
        with patch('bridge.discover_receivers', return_value=[info]), \
             patch('pychromecast.dial.get_device_info', return_value=SimpleNamespace(uuid=info.uuid, cast_type='cast')), \
             patch('pychromecast.get_chromecast_from_cast_info', return_value=receiver), \
             patch('bridge.lan_address', return_value='192.0.2.1'), \
             patch('bridge.probe', return_value=([0,1,2],120)), \
             patch('bridge.shutil.disk_usage', return_value=SimpleNamespace(free=2**40)), \
             patch('bridge.subprocess.Popen') as producer:
            b.submit('start', start_data(b))
            thread = threading.Thread(target=b._work)
            thread.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertFalse(b.status()['can_change_device'])
                b.submit('stop', payload)
            finally:
                release.set()
                thread.join(3)
            self.assertFalse(thread.is_alive())
            producer.assert_not_called()
        receiver.disconnect.assert_called_once()
        receiver.media_controller.play_media.assert_not_called()
        self.assertTrue(b.status()['can_change_device'])

    def test_explicit_host_uses_only_bounded_metadata_without_multicast(self):
        b = self.fixture()
        b.args = arguments(['--device-host','192.0.2.2'])
        status = SimpleNamespace(uuid=self.info().uuid, cast_type='cast', model_name='Chromecast',
                                 friendly_name='Sala', manufacturer='Google')
        with patch('zeroconf.Zeroconf', side_effect=AssertionError('multicast forbidden')), \
             patch('pychromecast.dial.get_device_info', return_value=status) as metadata, \
             patch('pychromecast.get_chromecast_from_cast_info') as connect:
            b.scan_devices()
            b.mutate('configure_device', {})
        metadata.assert_called_once_with('192.0.2.2', timeout=3)
        self.assertEqual(b.status()['selected_device']['id'], str(self.info().uuid))
        connect.assert_not_called()

    def test_selection_http_rejects_stale_missing_and_malformed_prior_revisions(self):
        from test_player_ux import ControlHTTPTest
        b = self.fixture()
        with patch('bridge.discover_receivers', return_value=[self.info(n) for n in (1, 2, 3)]):
            b.mutate('discover_devices', {})
        def post(payload):
            h = ControlHTTPTest().handler(data=payload)
            h.server.bridge, h.path = b, '/api/select_device'
            h.do_POST()
            return h.reply.call_args.args[0]
        for revision, target in [(0, 1), (1, 2)]:
            self.assertEqual(post(dict(device_id=str(self.info(target).uuid), device_revision=revision)), 202)
            action, data, _ = b.jobs.get_nowait()
            b.mutate(action, data)
            b.update(command_pending=False)
        for fields in ({}, {'device_revision':1}, {'device_revision':None},
                       {'device_revision':True}, {'device_revision':2.0},
                       {'device_revision':'2'}, {'device_revision':[]}, {'device_revision':{}}):
            with self.subTest(fields=fields):
                expected = 409 if type(fields.get('device_revision')) is int and fields['device_revision'] == 1 else 400
                self.assertEqual(post(dict(device_id=str(self.info(3).uuid), **fields)), expected)
                self.assertTrue(b.jobs.empty())
                self.assertEqual(b.status()['selected_device']['id'], str(self.info(2).uuid))
                self.assertEqual(b.status()['device_revision'], 2)
        fresh = self.fixture()
        with patch('bridge.discover_receivers', return_value=[self.info()]):
            fresh.mutate('discover_devices', {})
        for fields in ({}, {'device_revision':False}, {'device_revision':0.0}):
            for operation in (fresh.submit, fresh.mutate):
                with self.assertRaises(BridgeError):
                    operation('select_device', dict(device_id=str(self.info().uuid), **fields))
        self.assertIsNone(fresh.status()['selected_device'])

    def test_deferred_selection_rejects_changed_revision_at_execution(self):
        b = self.fixture()
        with patch('bridge.discover_receivers', return_value=[self.info(n) for n in (1, 2, 3)]):
            b.mutate('discover_devices', {})
        b.mutate('select_device', dict(device_id=str(self.info().uuid), device_revision=0))
        b.submit('select_device', dict(device_id=str(self.info(2).uuid), device_revision=1))
        action, data, _ = b.jobs.get_nowait()
        b.mutate('select_device', dict(device_id=str(self.info(3).uuid), device_revision=1))
        with self.assertRaises(BridgeError):
            b.mutate(action, data)
        self.assertEqual(b.status()['selected_device']['id'], str(self.info(3).uuid))
        self.assertEqual(b.status()['device_revision'], 2)
        for revision in (1, None, True, 2.0, '2'):
            with self.assertRaises(BridgeError):
                b.mutate('select_device', dict(device_id=str(self.info(3).uuid), device_revision=revision))

    def test_demo_selection_uses_the_same_prior_revision_contract(self):
        from demo import DemoBridge
        b = DemoBridge()
        b.submit('discover_devices', {})
        for fields in ({}, {'device_revision':False}, {'device_revision':0.0}):
            with self.assertRaises(BridgeError):
                b.submit('select_device', dict(device_id='demo-tv-a', **fields))
        b.submit('select_device', dict(device_id='demo-tv-a', device_revision=0))
        b.submit('select_device', dict(device_id='demo-tv-b', device_revision=1))
        with self.assertRaises(BridgeError):
            b.submit('select_device', dict(device_id='demo-tv-a', device_revision=1))
        self.assertEqual(b.status()['selected_device']['id'], 'demo-tv-b')

    def test_shutdown_worker_cleans_all_resources_and_reports_failures(self):
        for failure in ('media-stop', 'disconnect', None):
            with self.subTest(failure=failure):
                b = self.fixture()
                cast, producer, server, discovery = Mock(), Mock(), Mock(), Mock()
                cast.media_controller.status.content_id = 'owned'
                if failure == 'media-stop':
                    cast.media_controller.stop.side_effect = OSError('private stop diagnostic')
                if failure == 'disconnect':
                    cast.disconnect.side_effect = OSError('private disconnect diagnostic')
                b.cast, b.producer, b.media_server, b.browser = cast, producer, server, discovery
                b.media_url, b.destination_locked = 'owned', True
                b.update(phase='playing')
                errors = []
                # Real worker and close/join, with all hardware/server/producer boundaries faked.
                b.quit.set()
                b.worker = threading.Thread(target=b._work)
                with patch('threading.excepthook', side_effect=lambda args: errors.append(args.exc_value)):
                    b.worker.start()
                    if failure:
                        with self.assertRaises(BridgeError):
                            b.close()
                    else:
                        b.close()
                self.assertFalse(b.worker.is_alive())
                self.assertEqual(errors, [])
                cast.disconnect.assert_called_once()
                cast.media_controller.stop.assert_called_once()
                producer.close.assert_called_once()
                discovery.stop_discovery.assert_called_once()
                server.shutdown.assert_called_once()
                server.server_close.assert_called_once()
                self.assertIsNone(b.media_server)
                if failure:
                    self.assertEqual(b.status()['phase'], 'error')
                    self.assertTrue(b.status()['action_error'])
                    self.assertNotIn('private', json.dumps(b.status()))
                    self.assertFalse(b.status()['can_change_device'])
                else:
                    self.assertEqual(b.status()['phase'], 'stopped')
                    self.assertTrue(b.status()['can_change_device'])
                if failure == 'disconnect':
                    self.assertIs(b.cast, cast)
                else:
                    self.assertIsNone(b.cast)
