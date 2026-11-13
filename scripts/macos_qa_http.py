"""Loopback-only QA HTTP without reverse DNS. 不执行反向 DNS 的仅回环 QA HTTP。"""

import http.server
import socketserver


class LoopbackHTTPServer(http.server.ThreadingHTTPServer):
    def __init__(self, handler):
        super().__init__(("127.0.0.1", 0), handler)

    def server_bind(self):
        # HTTPServer's reverse lookup is unnecessary for numeric loopback fixtures.
        # 数字回环地址的测试服务不需要 HTTPServer 默认执行的反向查询。
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]
