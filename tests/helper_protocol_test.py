#!/usr/bin/env python3
"""Tests the local helper's native messaging protocol, offline.

Uses tests/fake_yt_dlp (a yt-dlp test double) and a throwaway HTTP server that
serves a generated video, so no network access or real yt-dlp is needed.
Requires ffmpeg on PATH.
"""

import http.server
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "helper", "capteur_helper.py")
FAKE = os.path.join(ROOT, "tests", "fake_yt_dlp")


class HelperProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        site = os.path.join(cls.tmp.name, "site")
        os.makedirs(site)
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
             "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
             "-c:a", "aac", "-shortest", os.path.join(site, "big.mp4")],
            check=True,
        )
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=site, **k)
        http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.page = "http://127.0.0.1:%d/page.html" % cls.server.server_port
        cls.home = os.path.join(cls.tmp.name, "home")
        os.makedirs(cls.home)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def run_helper(self, *messages):
        env = dict(os.environ, PYTHONPATH=FAKE, HOME=self.home, LOCALAPPDATA=self.home, USERPROFILE=self.home)
        proc = subprocess.Popen([sys.executable, "-u", HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        for m in messages:
            data = json.dumps(m).encode()
            proc.stdin.write(struct.pack("<I", len(data)) + data)
        proc.stdin.close()
        replies = []
        while True:
            raw = proc.stdout.read(4)
            if len(raw) < 4:
                break
            replies.append(json.loads(proc.stdout.read(struct.unpack("<I", raw)[0])))
        proc.stdout.close()
        proc.wait(timeout=60)
        return replies

    def test_ping(self):
        (pong,) = self.run_helper({"cmd": "ping"})
        self.assertEqual(pong["type"], "pong")
        self.assertEqual(pong["ytdlp"], "0000.00.00-fake")
        self.assertTrue(pong["ffmpeg"])

    def test_drm_refused(self):
        (reply,) = self.run_helper({"cmd": "download", "url": "https://www.netflix.com/watch/1", "mode": "video"})
        self.assertEqual(reply["type"], "error")
        self.assertIn("DRM", reply["message"])

    def test_video_with_quality(self):
        replies = self.run_helper({"cmd": "download", "url": self.page, "mode": "video", "quality": 720})
        logs = [r["message"] for r in replies if r["type"] == "log"]
        self.assertIn("format_sort=vcodec:h264,res:720,acodec:aac", logs)
        self.assertEqual(replies[-1]["type"], "done")
        self.assertTrue(os.path.exists(replies[-1]["file"]))

    def test_mp3(self):
        replies = self.run_helper({"cmd": "download", "url": self.page, "mode": "mp3"})
        self.assertIn("mp3", [r.get("stage") for r in replies])
        done = replies[-1]
        self.assertEqual(done["type"], "done")
        self.assertTrue(done["file"].endswith(".mp3"))
        self.assertGreater(os.path.getsize(done["file"]), 10000)

    def test_unknown_command(self):
        (reply,) = self.run_helper({"cmd": "nope"})
        self.assertEqual(reply["type"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)
