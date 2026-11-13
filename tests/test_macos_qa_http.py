import http.client
import http.server
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from macos_qa_http import LoopbackHTTPServer


class LoopbackHTTPTests(unittest.TestCase):
    def test_loopback_feed_serves_without_a_reverse_hostname_lookup(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"feed")

        with mock.patch("socket.getfqdn", side_effect=AssertionError("Unexpected reverse lookup")) as lookup:
            server = LoopbackHTTPServer(Handler)
            self.assertEqual(server.server_address[0], "127.0.0.1")
            self.assertEqual(server.server_name, "localhost")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request("GET", "/appcast.xml")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"feed")
                lookup.assert_not_called()
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
