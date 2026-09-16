#!/usr/bin/env python3
# PhotoMap - minimal static file server (zero dependency, python3 fallback)
# Serves the PROJECT ROOT (parent of tools/). Usage: python3 tools/server.py [port]
import http.server
import os
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
# tools/ 的上一级才是项目根（index.html / assets / photo-data 都在那里）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.ico': 'image/x-icon',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def log_message(self, *args):
        pass


try:
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
except OSError:
    print('Port %d is busy. Try another port:  python3 tools/server.py 8138' % PORT)
    sys.exit(1)

url = 'http://127.0.0.1:%d/' % PORT
print('=============================================')
print('  PhotoMap server running')
print('  ' + url)
print('  Close this window to stop.')
print('=============================================')
if os.environ.get('NO_OPEN') != '1':
    try:
        webbrowser.open(url)
    except Exception:
        print('Auto-open failed, please visit ' + url)
srv.serve_forever()
