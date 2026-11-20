import hashlib
import http.client
import re
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

from bridge import PANEL_SCRIPTS, ROOT, ControlHandler, build_panel


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

    def font_urls(self):
        _, page = self.get('/')
        return dict(re.findall(r'url\((/fonts/([a-z-]+)\.[0-9a-f]+\.woff2)\)', page.decode()))

    def test_fonts_are_served_immutable_at_a_url_that_names_their_bytes(self):
        urls = self.font_urls()
        self.assertEqual(sorted(urls.values()), ['archivo', 'jetbrains-mono'])
        for url, stem in urls.items():
            payload = (ROOT / 'fonts' / f'{stem}.woff2').read_bytes()
            self.assertIn(hashlib.sha256(payload).hexdigest()[:16], url)
            res, body = self.get(url)
            self.assertEqual(res.status, 200)
            self.assertEqual(res.getheader('Content-Type'), 'font/woff2')
            self.assertEqual(res.getheader('Cache-Control'), 'public, max-age=31536000, immutable')
            self.assertEqual(res.getheader('X-Content-Type-Options'), 'nosniff')
            self.assertEqual(res.getheader('Content-Length'), str(len(body)))
            self.assertEqual(body, payload)
            self.assertEqual(body[:4], b'wOF2')

    def test_other_font_paths_are_not_found(self):
        url = next(iter(self.font_urls()))
        for path in ('/fonts/../bridge.py', '/fonts/other.woff2', '/fonts/', '/fonts/archivo.woff2', url + '?x=1', url.replace('.woff2', '0.woff2')):
            res, body = self.get(path)
            self.assertEqual(res.status, 404, path)
            self.assertEqual(body, b'{}')

    def copy_panel(self, root):
        for name in ('player.html', *PANEL_SCRIPTS):
            shutil.copy(ROOT / name, root / name)
        shutil.copytree(ROOT / 'fonts', root / 'fonts')

    def test_a_missing_font_fails_when_the_panel_is_built(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.copy_panel(root)
            (root / 'fonts' / 'jetbrains-mono.woff2').unlink()
            with self.assertRaises(FileNotFoundError):
                build_panel(root)

    def test_a_script_that_would_close_the_inline_tag_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.copy_panel(root)
            build_panel(root)
            with open(root / PANEL_SCRIPTS[-1], 'a') as script:
                script.write("const tail = '</SCRIPT>';\n")
            with self.assertRaisesRegex(RuntimeError, '</script'):
                build_panel(root)

    def test_the_page_inlines_every_panel_script_in_order(self):
        _, page = self.get('/')
        page = page.decode()
        starts = [page.index((ROOT / name).read_text().splitlines()[0]) for name in PANEL_SCRIPTS]
        self.assertEqual(starts, sorted(starts))

    def test_wrong_host_is_forbidden(self):
        res, _ = self.get('/fonts/archivo.woff2', host='localhost:%d' % self.port)
        self.assertEqual(res.status, 403)


if __name__ == '__main__':
    unittest.main()
