import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

from bridge import ROOT, ControlHandler


class PanelFontsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), ControlHandler)
        cls.server.token = 'secret'
        cls.server.bridge = Mock()
        cls.server.bridge.status.return_value = {}
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        conn.putrequest('GET', path, skip_host=True)
        conn.putheader('Host', host or f'127.0.0.1:{self.port}')
        conn.endheaders()
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    def test_csp_allows_same_origin_fonts_only(self):
        res, _ = self.get('/api/status')
        csp = res.getheader('Content-Security-Policy')
        self.assertIn("font-src 'self'", csp)
        self.assertIn("default-src 'none'", csp)

    def test_fonts_are_served_immutable_with_exact_bytes(self):
        for name in ('archivo.woff2', 'jetbrains-mono.woff2'):
            res, body = self.get(f'/fonts/{name}')
            self.assertEqual(res.status, 200)
            self.assertEqual(res.getheader('Content-Type'), 'font/woff2')
            self.assertEqual(res.getheader('Cache-Control'), 'public, max-age=31536000, immutable')
            self.assertEqual(res.getheader('X-Content-Type-Options'), 'nosniff')
            self.assertEqual(res.getheader('Content-Length'), str(len(body)))
            self.assertEqual(body, (ROOT / 'fonts' / name).read_bytes())
            self.assertEqual(body[:4], b'wOF2')

    def test_other_font_paths_are_not_found(self):
        for path in ('/fonts/../bridge.py', '/fonts/other.woff2', '/fonts/', '/fonts/archivo.woff2?x=1'):
            res, body = self.get(path)
            self.assertEqual(res.status, 404, path)
            self.assertEqual(body, b'{}')

    def test_wrong_host_is_forbidden(self):
        res, _ = self.get('/fonts/archivo.woff2', host='localhost:%d' % self.port)
        self.assertEqual(res.status, 403)


if __name__ == '__main__':
    unittest.main()
