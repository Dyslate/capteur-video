#!/usr/bin/env python3
"""Capteur vidéo - local helper (Chrome native messaging host).

The extension talks to this program through Chrome's native messaging:
each message is a 4-byte little-endian length followed by UTF-8 JSON.

Commands received from the extension:
  {"cmd": "ping"}
      -> {"type": "pong", "version", "ytdlp", "ffmpeg", "jsRuntime", "downloadDir"}
  {"cmd": "download", "url", "format": "mp4"|"mkv"|"mp3"|"m4a"|"opus"|"flac"|"wav",
   "quality"?: max height (video), "abr"?: kb/s (audio), "referer"?, "title"?}
      ("mode": "video"|"mp3" is still accepted instead of "format")
      -> {"type": "progress", ...} (many), then {"type": "done", "file"} or {"type": "error", "message"}
  {"cmd": "reveal", "path"}       -> opens the file manager on the file
  {"cmd": "update"}               -> updates yt-dlp, then {"type": "updated", "ytdlp"}

DRM-protected services are refused, both here and in the extension.
"""

import json
import logging
import logging.handlers
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
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

# Output formats: audio ones map to their default bitrate (kb/s; "0" = lossless).
AUDIO_FORMATS = {"mp3": "192", "m4a": "192", "opus": "128", "flac": "0", "wav": "0"}
VIDEO_FORMATS = ("mp4", "mkv")

# Native messaging owns stdout: keep the real binary stream for the protocol and send
# anything a library might print to stderr instead.
_PROTO_OUT = sys.stdout.buffer
_PROTO_IN = sys.stdin.buffer
sys.stdout = sys.stderr
if os.name == "nt":
    import msvcrt

    msvcrt.setmode(_PROTO_OUT.fileno(), os.O_BINARY)
    msvcrt.setmode(_PROTO_IN.fileno(), os.O_BINARY)

# ---------- log file ----------
# Everything (commands, yt-dlp verbose output, errors) goes to helper.log in the app folder.

def _log_path():
    if os.name == "nt":
        base = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), APP_DIR_NAME)
    else:
        base = os.path.join(os.path.expanduser("~"), APP_DIR_NAME)
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "helper.log")


LOG_FILE = _log_path()
log = logging.getLogger("capteur")
log.setLevel(logging.DEBUG)
_handler = logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
log.addHandler(_handler)

_send_lock = threading.Lock()
_connected = True


def send(message):
    """Sends one message to the extension. Ignores a closed pipe so a download
    keeps going if the browser side goes away."""
    global _connected
    if not _connected:
        return
    if message.get("type") != "progress":
        log.debug("-> %s", json.dumps(message, ensure_ascii=False)[:800])
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


def probe_duration(path, ffmpeg):
    # Real duration of the file on disk, parsed from ffmpeg's own report.
    # This reflects what was actually written, which can be far shorter than the
    # duration advertised in a manifest (e.g. a site that serves a short decoy clip).
    if not ffmpeg or not path or not os.path.exists(path):
        return None
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", path],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30,
        ).stderr.decode("utf-8", "replace")
    except Exception:
        return None
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not m:
        return None
    h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return h * 3600 + mn * 60 + s


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


def unique_path(path):
    """path, or "name (2).ext", "name (3).ext"… so an existing file is never replaced."""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists("%s (%d)%s" % (base, n, ext)):
        n += 1
    return "%s (%d)%s" % (base, n, ext)


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
        "logFile": LOG_FILE,
    })


class _Logger:
    """Forwards yt-dlp warnings and errors to the extension, drops the rest."""

    def debug(self, msg):
        log.debug("yt-dlp: %s", msg)

    def info(self, msg):
        log.info("yt-dlp: %s", msg)

    def warning(self, msg):
        log.warning("yt-dlp: %s", msg)
        send({"type": "log", "level": "warning", "message": str(msg)[:500]})

    def error(self, msg):
        log.error("yt-dlp: %s", msg)
        send({"type": "log", "level": "error", "message": str(msg)[:500]})


def cmd_download(msg):
    url = msg.get("url") or ""
    mode = msg.get("mode", "video")
    if not url.startswith(("http://", "https://")):
        return send({"type": "error", "message": "Invalid URL"})
    if is_drm(url):
        return send({"type": "error", "message": "This service is DRM-protected: it cannot be downloaded"})

    try:
        import yt_dlp
    except ImportError:
        return send({"type": "error", "message": "yt-dlp is not installed: run install-helper.bat again"})

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
            stage = "audio" if "ExtractAudio" in name else "merge" if "Merger" in name else "remux" if "Remux" in name else "process"
            send({"type": "progress", "stage": stage, "percent": None})

    # For a direct stream URL (manifest or file) yt-dlp only knows the file name,
    # so the page title sent by the extension makes a better file name.
    template = "%(title).150B [%(id)s].%(ext)s"
    path_part = urlparse(url).path.lower()
    if msg.get("title") and re.search(r"\.(m3u8|mpd|mp4|m4a|m4v|webm|mov|ts|mp3)$", path_part):
        safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", str(msg["title"])).strip()[:150] or "video"
        template = safe.replace("%", "%%") + ".%(ext)s"
        log.debug("direct stream URL: file named after the page title %r", safe)

    # Each job works in its own folder, then moves the result next to the user's files.
    # Without this, extracting audio deletes an intermediate video that has the same name
    # as an MP4 downloaded earlier, and a second download of the same title is skipped.
    work_root = os.path.join(download_dir(), ".capteur-tmp")
    os.makedirs(work_root, exist_ok=True)
    work = tempfile.mkdtemp(prefix="job-", dir=work_root)

    options = {
        "outtmpl": os.path.join(work, template),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "verbose": True,  # the details only go to helper.log, through the logger
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

    # Output format: explicit "format", or derived from the older "mode" field.
    fmt = (msg.get("format") or ("mp3" if mode in ("mp3", "audio") else "mp4")).lower()
    abr = msg.get("abr")
    if fmt in AUDIO_FORMATS:
        if not ffmpeg:
            return send({"type": "error", "message": "ffmpeg not found: it is required for audio formats"})
        if fmt in ("mp3", "m4a", "opus"):
            bitrate = str(int(abr)) if str(abr or "").isdigit() else AUDIO_FORMATS[fmt]
        else:
            bitrate = "0"  # lossless formats (FLAC, WAV)
        options["format"] = "bestaudio/best"
        options["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": bitrate},
            {"key": "FFmpegMetadata"},
        ]
    elif fmt in VIDEO_FORMATS:
        # MP4: prefer H.264 + AAC so it plays everywhere. MKV: best quality, any codec.
        # "res:720" picks the largest height <= 720.
        quality = msg.get("quality")
        resolution = "res:%d" % int(quality) if str(quality or "").isdigit() else "res"
        options["format"] = "bv*+ba/b" if ffmpeg else "b"
        options["format_sort"] = ["vcodec:h264", resolution, "acodec:aac"] if fmt == "mp4" else [resolution]
        options["merge_output_format"] = fmt
        if ffmpeg:
            # Single-file sources (no merge needed) still end up in the chosen container.
            options["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": fmt}]
    else:
        return send({"type": "error", "message": "Unknown format: %s" % fmt})

    log.info("download: url=%s format=%s quality=%s abr=%s ffmpeg=%s", url, fmt, msg.get("quality"), abr, ffmpeg)
    log.debug("yt-dlp options: %s", {k: v for k, v in options.items() if k not in ("logger", "progress_hooks", "postprocessor_hooks")})
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise RuntimeError("No video found at this address")
            downloads = info.get("requested_downloads") or []
            path = downloads[-1].get("filepath") if downloads else None
            if not path:
                path = os.path.splitext(ydl.prepare_filename(info))[0] + "." + fmt
        if not path or not os.path.exists(path):
            raise RuntimeError("final file not found after the download")
        final = unique_path(os.path.join(download_dir(), os.path.basename(path)))
        shutil.move(path, final)
        # Prefer the real duration of the written file over the manifest's advertised one.
        real_seconds = probe_duration(final, ffmpeg)
        seconds = real_seconds if real_seconds is not None else info.get("duration")
        log.info("done: %s (%s bytes, %ss real / %ss advertised)", final, os.path.getsize(final), real_seconds, info.get("duration"))
        send({"type": "done", "file": final, "title": info.get("title"), "seconds": seconds})
    except Exception as e:  # yt-dlp raises many error types; report them all
        log.exception("download failed")
        message = str(e)
        if message.startswith("ERROR: "):
            message = message[7:]
        send({"type": "error", "message": message[:600]})
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cmd_reveal(msg):
    path = msg.get("path") or ""
    if not os.path.exists(path):
        return send({"type": "error", "message": "File not found"})
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
        return send({"type": "error", "message": (result.stderr or "pip failed")[-600:]})
    out = subprocess.run([sys.executable, "-c", "import yt_dlp;print(yt_dlp.version.__version__)"],
                         capture_output=True, text=True)
    send({"type": "updated", "ytdlp": out.stdout.strip() or None})


def cmd_tail(msg):
    """Returns the end of helper.log (shown on the extension's log page)."""
    lines = max(1, min(int(msg.get("lines") or 200), 2000))
    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            text = "".join(f.readlines()[-lines:])
    except OSError:
        text = ""
    send({"type": "tail", "path": LOG_FILE, "text": text})


COMMANDS = {"ping": cmd_ping, "download": cmd_download, "reveal": cmd_reveal, "update": cmd_update, "tail": cmd_tail}


def main():
    while True:
        try:
            msg = read_message()
        except (ValueError, OSError):
            return
        if msg is None:
            return  # the browser closed the connection
        log.info("<- %s", json.dumps(msg, ensure_ascii=False)[:800])
        handler = COMMANDS.get(msg.get("cmd"))
        if not handler:
            send({"type": "error", "message": "Unknown command: %s" % msg.get("cmd")})
            continue
        try:
            handler(msg)
        except Exception:
            log.exception("command %s failed", msg.get("cmd"))
            send({"type": "error", "message": traceback.format_exc()[-600:]})


if __name__ == "__main__":
    log.info("helper %s started (python %s, %s)", VERSION, platform.python_version(), platform.platform())
    try:
        main()
    finally:
        log.info("helper exiting")
