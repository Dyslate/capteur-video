#!/usr/bin/env python3
"""Local web server for the Capteur vidéo test lab.

  python serve.py                 serves the lab on http://127.0.0.1:8765 and opens it
  python serve.py --port 9000     another port
  python serve.py --no-browser    do not open the browser

Supports byte ranges (Range header) and the bytestart/byteend query parameters used
by Instagram's CDN, and prints each media request with its Referer.
Generates the test media first if they are missing.
"""

import argparse
import http.server
import mimetypes
import os
import re
import subprocess
import sys
import time
import webbrowser
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "media")

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".m4s": "video/iso.segment",
    ".webm": "video/webm",
    ".ts": "video/mp2t",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".mpd": "application/dash+xml",
    ".bin": "application/octet-stream",
}


class LabHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CapteurVideoLab/1.0"

    def log_message(self, fmt, *args):
        pass  # requests are printed by log_media() instead

    def log_media(self, path, status, length):
        if "/media/" in path:
            ref = self.headers.get("Referer") or "-"
            rng = self.headers.get("Range") or ""
            print("  %s %3d %8d B  %s  %s  referer=%s" % (time.strftime("%H:%M:%S"), status, length, path, rng, ref), flush=True)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        url = urlparse(self.path)
        rel = unquote(url.path).lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(HERE, rel))
        if not path.startswith(HERE) or not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        start, end = 0, size - 1

        # Instagram-style partial requests: ?bytestart=…&byteend=…
        query = parse_qs(url.query)
        if "bytestart" in query:
            start = int(query["bytestart"][0])
            end = min(size - 1, int(query.get("byteend", [size - 1])[0]))
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
        if m:
            if m.group(1):
                start = int(m.group(1))
                end = min(size - 1, int(m.group(2))) if m.group(2) else size - 1
            elif m.group(2):  # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return

        partial = start != 0 or end != size - 1
        length = end - start + 1
        self.send_response(206 if partial else 200)
        ext = os.path.splitext(path)[1].lower()
        self.send_header("Content-Type", TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        self.log_media(url.path + ("?" + url.query if url.query else ""), 206 if partial else 200, length)
        if head:
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return  # the browser stopped reading (normal for media)
                remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser(description="Capteur vidéo test lab server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(os.path.join(MEDIA, "direct.mp4")):
        print("Test media missing: generating…")
        subprocess.run([sys.executable, os.path.join(HERE, "make_fixtures.py")], check=True)

    # verify.py only checks files downloaded after this moment
    with open(os.path.join(MEDIA, ".lab-started"), "w") as f:
        f.write(str(time.time()))

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), LabHandler)
    url = "http://127.0.0.1:%d/" % args.port
    print("Test lab: %s  (Ctrl+C to stop)" % url)
    print("Media requests:")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLab stopped.")


if __name__ == "__main__":
    main()
