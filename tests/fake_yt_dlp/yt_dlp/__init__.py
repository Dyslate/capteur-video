"""Test double for yt-dlp, used only by the automated tests.

It mimics the small part of the YoutubeDL API the helper relies on: it "extracts"
a page by downloading big.mp4 from the same host, reports progress through the
hooks, and converts to MP3 with the real ffmpeg when asked.
"""

import html
import os
import re
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
        out = self.params["outtmpl"].replace("%(title).150B", info["title"]).replace("%(id)s", info["id"]).replace("%(ext)s", info["ext"])
        return out.replace("%%", "%")

    def _extract(self, url):
        """Mimics yt-dlp's generic extractor: page <title> and first <video>/<source>."""
        path = url.split("?")[0]
        if re.search(r"\.(m3u8|mpd)$", path):
            return "manifest", urljoin(url, "../direct.mp4")  # lab layout: media/<kind>/manifest
        if re.search(r"\.(mp4|m4a|webm)$", path) and not path.endswith("/big.mp4"):
            return os.path.splitext(os.path.basename(path))[0], url  # direct file: download it as is
        if not re.search(r"\.(mp4|m4a|webm)$", path):
            try:
                page = urllib.request.urlopen(url).read().decode("utf-8", "replace")
                title = re.search(r"<title>(.*?)</title>", page, re.S)
                src = re.search(r'<(?:video|source)[^>]+src="([^"]+)"', page)
                if src:
                    return (html.unescape(title.group(1).strip()) if title else "page"), urljoin(url, src.group(1))
            except Exception:
                pass
        return "Video de test", urljoin(url, "big.mp4")

    def extract_info(self, url, download=True):
        # Echo the format preferences so tests can check what the helper asked for.
        if self.params.get("logger") and self.params.get("format_sort"):
            self.params["logger"].warning("format_sort=" + ",".join(self.params["format_sort"]))
        title, media = self._extract(url)
        info = {"id": "fake123", "title": title, "ext": "mp4", "duration": 123.0}
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
        codecs = {"mp3": ["-c:a", "libmp3lame"], "m4a": ["-c:a", "aac"], "opus": ["-c:a", "libopus"], "flac": ["-c:a", "flac"], "wav": ["-c:a", "pcm_s16le"]}
        for pp in self.params.get("postprocessors", []):
            if pp["key"] == "FFmpegExtractAudio":
                codec, q = pp["preferredcodec"], pp.get("preferredquality", "0")
                self.params["logger"].warning("extract=%s@%s" % (codec, q))
                self._hooks("postprocessor_hooks", {"status": "started", "postprocessor": "ExtractAudio"})
                out = os.path.splitext(path)[0] + "." + codec
                bitrate = ["-b:a", q + "k"] if q != "0" and codec in ("mp3", "m4a", "opus") else []
                subprocess.run([self.params["ffmpeg_location"], "-y", "-v", "error", "-i", path, "-vn", *codecs[codec], *bitrate, out], check=True)
                os.remove(path)
                path = out
            elif pp["key"] == "FFmpegVideoRemuxer":
                ext = pp["preferedformat"]
                self._hooks("postprocessor_hooks", {"status": "started", "postprocessor": "FFmpegVideoRemuxer"})
                if not path.endswith("." + ext):
                    out = os.path.splitext(path)[0] + "." + ext
                    subprocess.run([self.params["ffmpeg_location"], "-y", "-v", "error", "-i", path, "-c", "copy", out], check=True)
                    os.remove(path)
                    path = out
        info["requested_downloads"] = [{"filepath": path}]
        return info
