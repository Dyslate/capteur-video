#!/usr/bin/env python3
"""Capteur vidéo - local helper (Chrome native messaging host).

The extension talks to this program through Chrome's native messaging:
each message is a 4-byte little-endian length followed by UTF-8 JSON.

Commands received from the extension:
  {"cmd": "ping"}
      -> {"type": "pong", "version", "ytdlp", "ffmpeg", "jsRuntime", "downloadDir"}
  {"cmd": "download", "url", "mode": "video"|"mp3", "referer"?, "title"?, "quality"?: 1080|720|480}
      -> {"type": "progress", ...} (many), then {"type": "done", "file"} or {"type": "error", "message"}
  {"cmd": "reveal", "path"}       -> opens the file manager on the file
  {"cmd": "update"}               -> updates yt-dlp, then {"type": "updated", "ytdlp"}

DRM-protected services are refused, both here and in the extension.
"""

import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import urlparse

VERSION = "1.0.0"
APP_DIR_NAME = "CapteurVideo" if os.name == "nt" else ".capteur-video"

# Same list as lib/policy.js: encrypted platforms that must never be downloaded.
DRM_DOMAINS = [
    "netflix.com", "nflxvideo.net", "disneyplus.com", "dssott.com", "bamgrid.com",
    "primevideo.com", "aiv-cdn.net", "aiv-delivery.net", "max.com", "hbomax.com",
    "tv.apple.com", "canalplus.com", "mycanal.fr", "paramountplus.com", "crunchyroll.com",
    "spotify.com", "scdn.co", "deezer.com", "dzcdn.net", "music.apple.com",
]

# Native messaging owns stdout: keep the real binary stream for the protocol and send
# anything a library might print to stderr instead.
_PROTO_OUT = sys.stdout.buffer
_PROTO_IN = sys.stdin.buffer
sys.stdout = sys.stderr
if os.name == "nt":
    import msvcrt

    msvcrt.setmode(_PROTO_OUT.fileno(), os.O_BINARY)
    msvcrt.setmode(_PROTO_IN.fileno(), os.O_BINARY)

_send_lock = threading.Lock()
_connected = True


def send(message):
    """Sends one message to the extension. Ignores a closed pipe so a download
    keeps going if the browser side goes away."""
    global _connected
    if not _connected:
        return
    data = json.dumps(message).encode("utf-8")
    with _send_lock:
        try:
            _PROTO_OUT.write(struct.pack("<I", len(data)))
            _PROTO_OUT.write(data)
            _PROTO_OUT.flush()
        except (BrokenPipeError, OSError, ValueError):
            _connected = False


def read_message():
    raw = _PROTO_IN.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(_PROTO_IN.read(length).decode("utf-8"))


# ---------- environment ----------

def app_dir():
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), APP_DIR_NAME)
    return os.path.join(os.path.expanduser("~"), APP_DIR_NAME)


def load_config():
    try:
        with open(os.path.join(app_dir(), "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def download_dir():
    configured = load_config().get("download_dir")
    if configured:
        path = os.path.expanduser(configured)
    else:
        path = os.path.join(os.path.expanduser("~"), "Downloads", "Capteur video")
    os.makedirs(path, exist_ok=True)
    return path


def ffmpeg_location():
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # bundled ffmpeg binary installed by install.py

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def js_runtime():
    # yt-dlp needs a JavaScript runtime for YouTube (Deno is the default one).
    for name in ("deno", "node", "bun"):
        if shutil.which(name):
            return name
    return None


def ytdlp_version():
    try:
        import yt_dlp

        return yt_dlp.version.__version__
    except Exception:
        return None


def is_drm(url):
    host = (urlparse(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in DRM_DOMAINS)


# ---------- commands ----------

def cmd_ping(_msg):
    send({
        "type": "pong",
        "version": VERSION,
        "ytdlp": ytdlp_version(),
        "ffmpeg": bool(ffmpeg_location()),
        "jsRuntime": js_runtime(),
        "downloadDir": download_dir(),
        "platform": platform.system(),
    })


class _Logger:
    """Forwards yt-dlp warnings and errors to the extension, drops the rest."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        send({"type": "log", "level": "warning", "message": str(msg)[:500]})

    def error(self, msg):
        send({"type": "log", "level": "error", "message": str(msg)[:500]})


def cmd_download(msg):
    url = msg.get("url") or ""
    mode = msg.get("mode", "video")
    if not url.startswith(("http://", "https://")):
        return send({"type": "error", "message": "Adresse invalide"})
    if is_drm(url):
        return send({"type": "error", "message": "Ce service est protégé par DRM : téléchargement impossible"})

    try:
        import yt_dlp
    except ImportError:
        return send({"type": "error", "message": "yt-dlp n'est pas installé : relancez l'installateur du module"})

    last = {"t": 0.0}

    def progress_hook(d):
        now = time.time()
        if d.get("status") == "downloading" and now - last["t"] < 0.3:
            return
        last["t"] = now
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            percent = None
            if total:
                percent = done / total
            elif d.get("fragment_count"):
                percent = (d.get("fragment_index") or 0) / d["fragment_count"]
            send({
                "type": "progress",
                "stage": "download",
                "percent": percent,
                "bytes": done,
                "speed": d.get("speed"),
                "eta": d.get("eta"),
                "part": (d.get("info_dict") or {}).get("format_id"),
            })
        elif d.get("status") == "finished":
            send({"type": "progress", "stage": "downloaded", "percent": 1})

    def postprocessor_hook(d):
        if d.get("status") == "started":
            name = d.get("postprocessor", "")
            stage = "mp3" if "ExtractAudio" in name else "merge" if "Merger" in name else "process"
            send({"type": "progress", "stage": stage, "percent": None})

    options = {
        "outtmpl": os.path.join(download_dir(), "%(title).150B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": _Logger(),
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "windowsfilenames": True,
        "concurrent_fragment_downloads": 4,
        "retries": 5,
        "fragment_retries": 5,
    }
    ffmpeg = ffmpeg_location()
    if ffmpeg:
        options["ffmpeg_location"] = ffmpeg
    if msg.get("referer"):
        options["http_headers"] = {"Referer": msg["referer"]}

    if mode == "mp3":
        if not ffmpeg:
            return send({"type": "error", "message": "ffmpeg est introuvable : il est nécessaire pour le MP3"})
        options["format"] = "bestaudio/best"
        options["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "FFmpegMetadata"},
        ]
    else:
        # Prefer H.264 + AAC so the MP4 plays everywhere, then the best resolution
        # up to the requested height ("res:720" picks the largest height <= 720).
        quality = msg.get("quality")
        resolution = "res:%d" % int(quality) if str(quality or "").isdigit() else "res"
        options["format"] = "bv*+ba/b" if ffmpeg else "b"
        options["format_sort"] = ["vcodec:h264", resolution, "acodec:aac"]
        options["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise RuntimeError("Aucune vidéo trouvée à cette adresse")
            downloads = info.get("requested_downloads") or []
            path = downloads[-1].get("filepath") if downloads else None
            if not path:
                path = ydl.prepare_filename(info)
                if mode == "mp3":
                    path = os.path.splitext(path)[0] + ".mp3"
        send({"type": "done", "file": path, "title": info.get("title")})
    except Exception as e:  # yt-dlp raises many error types; report them all
        message = str(e)
        if message.startswith("ERROR: "):
            message = message[7:]
        send({"type": "error", "message": message[:600]})


def cmd_reveal(msg):
    path = msg.get("path") or ""
    if not os.path.exists(path):
        return send({"type": "error", "message": "Fichier introuvable"})
    system = platform.system()
    if system == "Windows":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif system == "Darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])
    send({"type": "revealed"})


def cmd_update(_msg):
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp[default]"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return send({"type": "error", "message": (result.stderr or "pip a échoué")[-600:]})
    out = subprocess.run([sys.executable, "-c", "import yt_dlp;print(yt_dlp.version.__version__)"],
                         capture_output=True, text=True)
    send({"type": "updated", "ytdlp": out.stdout.strip() or None})


COMMANDS = {"ping": cmd_ping, "download": cmd_download, "reveal": cmd_reveal, "update": cmd_update}


def main():
    while True:
        try:
            msg = read_message()
        except (ValueError, OSError):
            return
        if msg is None:
            return  # the browser closed the connection
        handler = COMMANDS.get(msg.get("cmd"))
        if not handler:
            send({"type": "error", "message": "Commande inconnue : %s" % msg.get("cmd")})
            continue
        try:
            handler(msg)
        except Exception:
            send({"type": "error", "message": traceback.format_exc()[-600:]})


if __name__ == "__main__":
    main()
