"""Test double for yt-dlp, used only by the automated tests.

It mimics the small part of the YoutubeDL API the helper relies on: it "extracts"
a page by downloading big.mp4 from the same host, reports progress through the
hooks, and converts to MP3 with the real ffmpeg when asked.
"""

import os
import subprocess
import urllib.request
from types import SimpleNamespace
from urllib.parse import urljoin

version = SimpleNamespace(__version__="0000.00.00-fake")


class YoutubeDL:
    def __init__(self, params):
        self.params = params

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _hooks(self, key, data):
        for hook in self.params.get(key, []):
            hook(data)

    def prepare_filename(self, info):
        return self.params["outtmpl"].replace("%(title).150B", info["title"]).replace("%(id)s", info["id"]).replace("%(ext)s", info["ext"])

    def extract_info(self, url, download=True):
        media = urljoin(url, "big.mp4")
        info = {"id": "fake123", "title": "Video de test", "ext": "mp4"}
        path = self.prepare_filename(info)
        with urllib.request.urlopen(media) as r:
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(path, "wb") as f:
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    self._hooks("progress_hooks", {"status": "downloading", "downloaded_bytes": done, "total_bytes": total, "info_dict": {"format_id": "18"}})
        self._hooks("progress_hooks", {"status": "finished"})
        for pp in self.params.get("postprocessors", []):
            if pp["key"] == "FFmpegExtractAudio":
                self._hooks("postprocessor_hooks", {"status": "started", "postprocessor": "ExtractAudio"})
                mp3 = os.path.splitext(path)[0] + ".mp3"
                subprocess.run([self.params["ffmpeg_location"], "-y", "-v", "error", "-i", path, "-vn", "-c:a", "libmp3lame", "-q:a", "4", mp3], check=True)
                os.remove(path)
                path = mp3
        info["requested_downloads"] = [{"filepath": path}]
        return info
