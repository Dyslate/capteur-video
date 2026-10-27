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
        self.assertIn("audio", [r.get("stage") for r in replies])
        done = replies[-1]
        self.assertEqual(done["type"], "done")
        self.assertTrue(done["file"].endswith(".mp3"))
        self.assertGreater(os.path.getsize(done["file"]), 10000)

    def probe(self, path):
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type:format=format_name,bit_rate",
                              "-of", "json", path], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_audio_formats_and_bitrates(self):
        cases = {
            ("mp3", 320): "mp3",
            ("m4a", 128): "aac",
            ("opus", 96): "opus",
            ("flac", None): "flac",
            ("wav", None): "pcm_s16le",
        }
        for (fmt, abr), codec in cases.items():
            with self.subTest(format=fmt):
                replies = self.run_helper({"cmd": "download", "url": self.page, "format": fmt, "abr": abr})
                logs = [r["message"] for r in replies if r["type"] == "log"]
                expected_q = str(abr) if abr else "0"
                self.assertIn("extract=%s@%s" % (fmt, expected_q), logs)
                done = replies[-1]
                self.assertEqual(done["type"], "done", done)
                self.assertTrue(done["file"].endswith("." + fmt))
                streams = self.probe(done["file"])["streams"]
                self.assertEqual([st["codec_name"] for st in streams], [codec])

    def test_mkv(self):
        replies = self.run_helper({"cmd": "download", "url": self.page, "format": "mkv", "quality": 480})
        logs = [r["message"] for r in replies if r["type"] == "log"]
        self.assertIn("format_sort=res:480", logs)
        done = replies[-1]
        self.assertEqual(done["type"], "done", done)
        self.assertTrue(done["file"].endswith(".mkv"))
        self.assertIn("matroska", self.probe(done["file"])["format"]["format_name"])
        # The helper reports the real duration of the written file (not the manifest's
        # advertised one), so it matches what ffprobe sees on disk and is not the fake's 123.0.
        real = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", done["file"]],
                              capture_output=True, text=True, check=True).stdout.strip()
        self.assertAlmostEqual(done["seconds"], float(real), delta=0.5)

    def test_unknown_format(self):
        (reply,) = self.run_helper({"cmd": "download", "url": self.page, "format": "avi"})
        self.assertEqual(reply["type"], "error")

    def test_never_deletes_or_overwrites(self):
        """MP4, then MP3, then MP4 again of the same page: three files, the first MP4 kept."""
        first = self.run_helper({"cmd": "download", "url": self.page, "format": "mp4", "title": "same"})[-1]
        audio = self.run_helper({"cmd": "download", "url": self.page, "format": "mp3"})[-1]
        second = self.run_helper({"cmd": "download", "url": self.page, "format": "mp4"})[-1]
        for r in (first, audio, second):
            self.assertEqual(r["type"], "done", r)
        self.assertTrue(os.path.exists(first["file"]), "the first MP4 was deleted")
        self.assertTrue(os.path.exists(audio["file"]))
        self.assertNotEqual(first["file"], second["file"])
        self.assertTrue(second["file"].endswith(" (2).mp4"), second["file"])
        work = os.path.join(os.path.dirname(first["file"]), ".capteur-tmp")
        self.assertEqual(os.listdir(work), [], "job folders must be cleaned up")

    def test_unknown_command(self):
        (reply,) = self.run_helper({"cmd": "nope"})
        self.assertEqual(reply["type"], "error")


if __name__ == "__main__":
    unittest.main(verbosity=2)
