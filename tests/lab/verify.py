#!/usr/bin/env python3
"""Checks the files downloaded from the test lab.

  python verify.py               files downloaded since serve.py was started
  python verify.py --since 30    files from the last 30 minutes
  python verify.py --dir PATH    also look in another folder (repeatable)
  python verify.py -v            print the full ffprobe data of every file

For every file named "Lab NN …" (browser downloads) or containing "Lab NN"
(local helper downloads) it checks: tracks, codec matching the extension,
duration (the lab clips last 8 s), resolution, and decoding errors.
Exit code 1 when something is wrong.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLIP_SECONDS = 8.0
VIDEO_EXT = {".mp4", ".mkv", ".webm", ".ts", ".mov"}
AUDIO_CODEC = {".mp3": {"mp3"}, ".m4a": {"aac"}, ".aac": {"aac"}, ".opus": {"opus"}, ".flac": {"flac"}, ".wav": {"pcm_s16le", "pcm_s24le", "pcm_f32le"}}

SCENARIOS = {
    "01": {"name": "MP4 direct", "heights": {720}},
    "02": {"name": "WebM", "heights": {360}},
    "03": {"name": "HLS TS", "heights": {720, 360}},
    "04": {"name": "HLS fMP4", "heights": {720}},
    "05": {"name": "DASH", "heights": {720, 360}},
    "06": {"name": "Pistes séparées", "heights": {720}, "needs_audio": True},
    "07": {"name": "Manifeste intégré", "heights": {720}, "needs_audio": True},
    "08": {"name": "Audio seul", "audio_only": True},
    "09": {"name": "Flux chiffrés", "forbidden": True},
    "10": {"name": "Page yt-dlp", "heights": {720, 360, 480, 1080}},
}


def log(text=""):
    print(text, flush=True)


def helper_ffmpeg():
    """ffmpeg bundled with the local helper (helper/install.py), if installed."""
    if os.name == "nt":
        venv = os.path.join(os.environ.get("LOCALAPPDATA", ""), "CapteurVideo", "venv", "Scripts", "python.exe")
    else:
        venv = os.path.join(os.path.expanduser("~"), ".capteur-video", "venv", "bin", "python")
    if not os.path.exists(venv):
        return None
    out = subprocess.run([venv, "-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
                         capture_output=True, text=True)
    path = out.stdout.strip()
    return path if out.returncode == 0 and os.path.exists(path) else None


def tools():
    """ffprobe for inspection, ffmpeg for the decode check: system, pip package, or the helper's."""
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg

            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            ffmpeg = helper_ffmpeg()
    return ffprobe, ffmpeg


# ---------- built-in inspection (no ffmpeg) ----------
# Reads the container structure only: tracks, codecs, duration, resolution.
# It cannot detect decoding errors inside the media data.

MP4_CODECS = {"avc1": "h264", "avc3": "h264", "hvc1": "hevc", "hev1": "hevc", "vp09": "vp9", "av01": "av1",
              "mp4a": "aac", "Opus": "opus", "fLaC": "flac", "ac-3": "ac3", "ec-3": "eac3", ".mp3": "mp3"}


def _boxes(data, start, end):
    p = start
    while p + 8 <= end:
        size = int.from_bytes(data[p:p + 4], "big")
        kind = data[p + 4:p + 8].decode("latin-1")
        header = 8
        if size == 1:
            size = int.from_bytes(data[p + 8:p + 16], "big")
            header = 16
        elif size == 0:
            size = end - p
        if size < header:
            return
        yield kind, p + header, min(p + size, end)
        p += size


def _child(data, start, end, *path):
    for kind in path:
        found = next(((s, e) for k, s, e in _boxes(data, start, end) if k == kind), None)
        if not found:
            return None
        start, end = found
    return start, end


def builtin_mp4(data):
    moov = _child(data, 0, len(data), "moov")
    if not moov:
        return None, "pas de boîte moov : fichier MP4 incomplet ou invalide"
    mvhd = _child(data, *moov, "mvhd")
    duration = None
    if mvhd:
        s, _ = mvhd
        v1 = data[s] == 1
        ts = int.from_bytes(data[s + (20 if v1 else 12):s + (24 if v1 else 16)], "big")
        du = int.from_bytes(data[s + (24 if v1 else 16):s + (32 if v1 else 20)], "big")
        duration = du / ts if ts else None
    video, audio = [], []
    for kind, s, e in _boxes(data, *moov):
        if kind != "trak":
            continue
        hdlr = _child(data, s, e, "mdia", "hdlr")
        handler = data[hdlr[0] + 8:hdlr[0] + 12].decode("latin-1") if hdlr else ""
        stsd = _child(data, s, e, "mdia", "minf", "stbl", "stsd")
        codec = data[stsd[0] + 12:stsd[0] + 16].decode("latin-1") if stsd else "?"
        mdhd = _child(data, s, e, "mdia", "mdhd")
        if mdhd and not duration:
            ms = mdhd[0]
            v1 = data[ms] == 1
            ts = int.from_bytes(data[ms + (20 if v1 else 12):ms + (24 if v1 else 16)], "big")
            du = int.from_bytes(data[ms + (24 if v1 else 16):ms + (32 if v1 else 20)], "big")
            duration = du / ts if ts else None
        entry = {"codec_name": MP4_CODECS.get(codec, codec)}
        if handler == "vide":
            tkhd = _child(data, s, e, "tkhd")
            if tkhd:
                entry["width"] = int.from_bytes(data[tkhd[1] - 8:tkhd[1] - 4], "big") >> 16
                entry["height"] = int.from_bytes(data[tkhd[1] - 4:tkhd[1]], "big") >> 16
            video.append(entry)
        elif handler == "soun":
            audio.append(entry)
    # Fragmented files: the header says 0, the duration is the end of the last fragment.
    if not duration:
        duration = fragmented_duration(data, moov)
    return {"container": "mp4", "duration": duration, "bitrate": None, "video": video, "audio": audio}, None


def fragmented_duration(data, moov):
    """Longest track end time: max over fragments of tfdt + sum of sample durations."""
    u32 = lambda p: int.from_bytes(data[p:p + 4], "big")
    timescale, default_dur = {}, {}
    for kind, s, e in _boxes(data, *moov):
        if kind == "trak":
            tkhd, mdhd = _child(data, s, e, "tkhd"), _child(data, s, e, "mdia", "mdhd")
            if tkhd and mdhd:
                tid = u32(tkhd[0] + (20 if data[tkhd[0]] == 1 else 12))
                timescale[tid] = u32(mdhd[0] + (20 if data[mdhd[0]] == 1 else 12))
        elif kind == "mvex":
            for k, ts_, te in _boxes(data, s, e):
                if k == "trex":
                    default_dur[u32(ts_ + 4)] = u32(ts_ + 12)
    ends = {}
    for kind, s, e in _boxes(data, 0, len(data)):
        if kind != "moof":
            continue
        for k, ts_, te in _boxes(data, s, e):
            if k != "traf":
                continue
            tid, dur, start, total = None, None, 0, 0
            for kk, bs, be in _boxes(data, ts_, te):
                flags = int.from_bytes(data[bs + 1:bs + 4], "big")
                if kk == "tfhd":
                    tid = u32(bs + 4)
                    p = bs + 8 + (8 if flags & 0x01 else 0) + (4 if flags & 0x02 else 0)
                    dur = u32(p) if flags & 0x08 else default_dur.get(tid, 0)
                elif kk == "tfdt":
                    start = int.from_bytes(data[bs + 4:bs + (12 if data[bs] == 1 else 8)], "big")
                elif kk == "trun":
                    count = u32(bs + 4)
                    p = bs + 8 + (4 if flags & 0x01 else 0) + (4 if flags & 0x04 else 0)
                    per = sum(4 for bit in (0x100, 0x200, 0x400, 0x800) if flags & bit)
                    if flags & 0x100:
                        total += sum(u32(p + i * per) for i in range(count))
                    else:
                        total += count * (dur or 0)
            if tid in timescale and timescale[tid]:
                ends[tid] = max(ends.get(tid, 0), (start + total) / timescale[tid])
    return max(ends.values()) if ends else None


MP3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
MP3_RATES = [44100, 48000, 32000]


def builtin_mp3(data):
    p = 0
    if data[:3] == b"ID3":
        p = 10 + ((data[6] & 0x7f) << 21 | (data[7] & 0x7f) << 14 | (data[8] & 0x7f) << 7 | (data[9] & 0x7f))
    frames, total_bits_rate, samples = 0, 0, 0
    rate = None
    while p + 4 <= len(data):
        h = int.from_bytes(data[p:p + 4], "big")
        if (h >> 21) & 0x7ff != 0x7ff or (h >> 19) & 3 != 3 or (h >> 17) & 3 != 1:
            if frames == 0:
                p += 1
                continue
            break
        kbps = MP3_KBPS[(h >> 12) & 0xf] if (h >> 12) & 0xf < 15 else 0
        rate = MP3_RATES[(h >> 10) & 3] if (h >> 10) & 3 < 3 else 0
        if not kbps or not rate:
            break
        length = 144000 * kbps // rate + ((h >> 9) & 1)
        frames += 1
        total_bits_rate += kbps
        samples += 1152
        p += length
    if not frames:
        return None, "aucune trame MP3 valide"
    return {"container": "mp3", "duration": samples / rate, "bitrate": total_bits_rate // frames * 1000,
            "video": [], "audio": [{"codec_name": "mp3"}]}, None


def builtin_wav(data):
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None, "en-tête WAV invalide"
    p, fmt, size = 12, None, None
    while p + 8 <= len(data):
        kind, length = data[p:p + 4], int.from_bytes(data[p + 4:p + 8], "little")
        if kind == b"fmt ":
            fmt = data[p + 8:p + 8 + length]
        elif kind == b"data":
            size = min(length, len(data) - p - 8)
            break
        p += 8 + length + (length & 1)
    if not fmt or size is None:
        return None, "WAV incomplet (pas de bloc fmt ou data)"
    channels = int.from_bytes(fmt[2:4], "little")
    rate = int.from_bytes(fmt[4:8], "little")
    bits = int.from_bytes(fmt[14:16], "little")
    codec = {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_f32le"}.get(bits, "pcm")
    return {"container": "wav", "duration": size / (rate * channels * bits / 8), "bitrate": rate * channels * bits,
            "video": [], "audio": [{"codec_name": codec}]}, None


def builtin_ts(data):
    if len(data) < 188 * 3 or any(data[i] != 0x47 for i in range(0, 188 * 3, 188)):
        return None, "pas un flux MPEG-TS (octet de synchronisation absent)"
    # Duration from the first and last PES timestamps (PTS) of the stream.
    first = last = None
    for p in range(0, len(data) - 188 + 1, 188):
        pkt = data[p:p + 188]
        if not pkt[1] & 0x40:
            continue  # not the start of a PES packet
        off = 4 + (pkt[4] + 1 if pkt[3] & 0x20 else 0)
        if pkt[off:off + 3] != b"\x00\x00\x01" or not pkt[off + 7] & 0x80:
            continue
        b = pkt[off + 9:off + 14]
        pts = ((b[0] >> 1) & 7) << 30 | b[1] << 22 | (b[2] >> 1) << 15 | b[3] << 7 | b[4] >> 1
        first = pts if first is None else min(first, pts)
        last = pts if last is None else max(last, pts)
    duration = (last - first) / 90000 + 0.04 if first is not None else None
    return {"container": "mpegts", "duration": duration, "bitrate": None,
            "video": [{"codec_name": "h264?"}], "audio": [{"codec_name": "aac?"}]}, None


def builtin_webm(data):
    if data[:4] != b"\x1a\x45\xdf\xa3":
        return None, "en-tête WebM/Matroska invalide"
    i = data.find(b"\x44\x89")  # Duration element
    duration = None
    if i > 0:
        size = data[i + 2] & 0x7f if data[i + 2] & 0x80 else None
        if size in (4, 8):
            import struct
            raw = data[i + 3:i + 3 + size]
            value = struct.unpack(">f" if size == 4 else ">d", raw)[0]
            j = data.find(b"\x2a\xd7\xb1")  # TimecodeScale
            scale = 1_000_000
            if 0 < j < i:
                n = data[j + 3] & 0x7f
                scale = int.from_bytes(data[j + 4:j + 4 + n], "big")
            duration = value * scale / 1e9
    video = [{"codec_name": c} for c, tag in (("vp9", b"V_VP9"), ("vp8", b"V_VP8"), ("av1", b"V_AV1"), ("h264", b"V_MPEG4/ISO/AVC")) if tag in data[:200000]]
    audio = [{"codec_name": c} for c, tag in (("opus", b"A_OPUS"), ("vorbis", b"A_VORBIS"), ("aac", b"A_AAC")) if tag in data[:200000]]
    return {"container": "webm", "duration": duration, "bitrate": None, "video": video, "audio": audio}, None


def builtin_flac(data):
    if data[:4] != b"fLaC":
        return None, "en-tête FLAC invalide"
    info = data[8:8 + 34]  # STREAMINFO is always the first metadata block
    rate = int.from_bytes(info[10:13], "big") >> 4
    samples = int.from_bytes(info[13:18], "big") & 0xFFFFFFFFF
    return {"container": "flac", "duration": samples / rate if rate else None, "bitrate": None,
            "video": [], "audio": [{"codec_name": "flac"}]}, None


def builtin_ogg(data):
    if data[:4] != b"OggS":
        return None, "en-tête Ogg invalide"
    codec = "opus" if b"OpusHead" in data[:200] else "vorbis" if b"\x01vorbis" in data[:200] else "?"
    last = data.rfind(b"OggS")
    granule = int.from_bytes(data[last + 6:last + 14], "little")
    if codec == "opus":
        i = data.find(b"OpusHead")
        pre_skip = int.from_bytes(data[i + 10:i + 12], "little")
        duration = (granule - pre_skip) / 48000
    else:
        i = data.find(b"\x01vorbis")
        rate = int.from_bytes(data[i + 12:i + 16], "little")
        duration = granule / rate if rate else None
    return {"container": "ogg", "duration": duration, "bitrate": None, "video": [], "audio": [{"codec_name": codec}]}, None


def probe_builtin(path):
    with open(path, "rb") as f:
        data = f.read()
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mp4", ".m4a", ".mov"):
        info, err = builtin_mp4(data)
    elif ext == ".mp3":
        info, err = builtin_mp3(data)
    elif ext == ".wav":
        info, err = builtin_wav(data)
    elif ext == ".ts":
        info, err = builtin_ts(data)
    elif ext in (".webm", ".mkv"):
        info, err = builtin_webm(data)
    elif ext == ".flac":
        info, err = builtin_flac(data)
    elif ext in (".opus", ".ogg", ".oga"):
        info, err = builtin_ogg(data)
    else:
        return None, "format %s : inspection impossible sans ffmpeg" % ext
    if info:
        info["raw"] = "(inspection intégrée)"
    return info, err


def download_dirs(extra):
    home = os.path.expanduser("~")
    candidates = [os.path.join(home, "Downloads"), os.path.join(home, "Téléchargements"),
                  os.path.join(os.environ.get("USERPROFILE", home), "Downloads")]
    dirs = []
    for d in candidates + list(extra):
        for sub in (d, os.path.join(d, "Capteur video")):
            if os.path.isdir(sub) and os.path.realpath(sub) not in map(os.path.realpath, dirs):
                dirs.append(sub)
    return dirs


def since_timestamp(minutes):
    if minutes is not None:
        return time.time() - minutes * 60
    marker = os.path.join(HERE, "media", ".lab-started")
    try:
        return float(open(marker).read().strip())
    except (OSError, ValueError):
        return time.time() - 3 * 3600


def probe_ffprobe(ffprobe, path):
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries",
                          "stream=codec_type,codec_name,width,height,channels,sample_rate,bit_rate:format=format_name,duration,bit_rate",
                          "-of", "json", path], capture_output=True, text=True)
    if out.returncode != 0:
        return None, out.stderr.strip()
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    return {
        "container": fmt.get("format_name"),
        "duration": float(fmt["duration"]) if fmt.get("duration") not in (None, "N/A") else None,
        "bitrate": int(fmt["bit_rate"]) if str(fmt.get("bit_rate", "")).isdigit() else None,
        "video": [s for s in streams if s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png")],
        "audio": [s for s in streams if s.get("codec_type") == "audio"],
        "raw": data,
    }, None


def probe_ffmpeg(ffmpeg, path):
    """Fallback without ffprobe: parse `ffmpeg -i` output."""
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True)
    text = out.stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", text)
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    video, audio = [], []
    for line in text.splitlines():
        sm = re.search(r"Stream #\S+.*?: (Video|Audio): (\w+)", line)
        if not sm:
            continue
        if sm.group(1) == "Video":
            wh = re.search(r", (\d{2,5})x(\d{2,5})", line)
            video.append({"codec_name": sm.group(2), "width": int(wh.group(1)) if wh else None, "height": int(wh.group(2)) if wh else None})
        else:
            audio.append({"codec_name": sm.group(2)})
    fm = re.search(r"Input #0, ([\w,]+), from", text)
    return {"container": fm.group(1) if fm else None, "duration": duration, "bitrate": None, "video": video, "audio": audio, "raw": text}, None


def decode_errors(ffmpeg, path):
    out = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-f", "null", "-"], capture_output=True, text=True)
    lines = [l for l in out.stderr.splitlines() if l.strip()]
    return lines


def check(path, info, errors, scenario, name):
    """Returns (status, notes). status: 'ok' | 'warn' | 'fail'."""
    ext = os.path.splitext(path)[1].lower()
    notes, problems, warnings = [], [], []
    if scenario.get("forbidden"):
        return "fail", ["ce flux est chiffré : AUCUN fichier ne devrait exister"]

    if info["duration"] is None:
        warnings.append("durée inconnue")
    elif abs(info["duration"] - CLIP_SECONDS) > 0.6:
        problems.append("durée %.2f s (attendu ~%.0f s : fichier tronqué ou incomplet ?)" % (info["duration"], CLIP_SECONDS))
    else:
        notes.append("%.2f s" % info["duration"])

    if ext in VIDEO_EXT:
        if not info["video"]:
            problems.append("aucune piste vidéo")
        else:
            v = info["video"][0]
            notes.append("%s %sx%s" % (v.get("codec_name"), v["width"], v["height"]) if v.get("width") else str(v.get("codec_name")))
            if scenario.get("heights") and v.get("height") and v["height"] not in scenario["heights"]:
                warnings.append("hauteur %s inattendue (attendu %s)" % (v["height"], sorted(scenario["heights"])))
        silent = "sans son" in name.lower()
        if silent:
            if info["audio"]:
                problems.append("fichier « sans son » qui contient du son")
            else:
                notes.append("sans son (voulu)")
        elif not info["audio"]:
            (problems if scenario.get("needs_audio") else warnings).append("aucune piste audio")
        else:
            notes.append("+ %s" % info["audio"][0].get("codec_name"))
    elif ext in AUDIO_CODEC:
        if info["video"]:
            warnings.append("contient aussi de la vidéo")
        if not info["audio"]:
            problems.append("aucune piste audio")
        else:
            codec = info["audio"][0].get("codec_name")
            if codec not in AUDIO_CODEC[ext]:
                problems.append("codec %s pour une extension %s" % (codec, ext))
            else:
                kbps = " %d kb/s" % round(info["bitrate"] / 1000) if info.get("bitrate") else ""
                notes.append(codec + kbps)
    else:
        warnings.append("extension %s non vérifiée" % ext)

    if scenario.get("audio_only") and ext in VIDEO_EXT:
        problems.append("fichier vidéo pour une source audio seule")
    if errors:
        problems.append("%d erreur(s) de décodage : %s" % (len(errors), errors[0][:120]))

    status = "fail" if problems else "warn" if warnings else "ok"
    return status, problems + warnings + notes


def main():
    parser = argparse.ArgumentParser(description="Vérifie les fichiers téléchargés depuis le labo")
    parser.add_argument("--since", type=float, help="minutes à remonter (défaut : depuis le lancement de serve.py)")
    parser.add_argument("--dir", action="append", default=[], help="autre dossier à inspecter")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    ffprobe, ffmpeg = tools()
    log("Outils : ffprobe=%s  ffmpeg=%s" % (ffprobe or "absent", ffmpeg or "absent"))
    builtin = not ffprobe and not ffmpeg
    if builtin:
        log("Sans ffmpeg : inspection intégrée (pistes, codecs, durée, résolution).")
        log("Les erreurs de décodage ne peuvent pas être détectées ; installez le module local pour un contrôle complet.")

    since = since_timestamp(args.since)
    dirs = download_dirs(args.dir)
    log("Fichiers modifiés depuis : %s" % time.strftime("%d/%m %H:%M:%S", time.localtime(since)))
    log("Dossiers inspectés :")
    for d in dirs:
        log("  - " + d)

    files = []
    for d in dirs:
        for name in sorted(os.listdir(d)):
            path = os.path.join(d, name)
            if not os.path.isfile(path) or name.endswith((".crdownload", ".part", ".tmp")):
                continue
            m = re.search(r"Lab (\d{2})", name)
            if not m:
                continue
            if os.path.getmtime(path) < since:
                log("  (ignoré, trop ancien) " + name)
                continue
            files.append((m.group(1), path))

    if not files:
        log("\nAucun fichier « Lab NN … » récent. Téléchargez depuis les pages du labo, puis relancez.")
        return 1

    log("\n%d fichier(s) à vérifier\n" % len(files))
    counts = {"ok": 0, "warn": 0, "fail": 0}
    icons = {"ok": "OK  ", "warn": "ATTN", "fail": "ÉCHEC"}
    seen = set()
    for sid, path in sorted(files):
        seen.add(sid)
        scenario = SCENARIOS.get(sid, {"name": "?"})
        name = os.path.basename(path)
        if ffprobe:
            info, err = probe_ffprobe(ffprobe, path)
        elif ffmpeg:
            info, err = probe_ffmpeg(ffmpeg, path)
        else:
            info, err = probe_builtin(path)
        if info is None:
            counts["fail"] += 1
            log("[%s] %s · %s\n      illisible : %s" % (icons["fail"], sid, name, err))
            continue
        errors = decode_errors(ffmpeg, path) if ffmpeg else []
        status, notes = check(path, info, errors, scenario, name)
        counts[status] += 1
        log("[%s] %s %s · %s (%s o)" % (icons[status], sid, scenario["name"], name, format(os.path.getsize(path), ",").replace(",", " ")))
        log("      " + " · ".join(notes))
        if args.verbose:
            log("      ffprobe : " + (json.dumps(info["raw"], ensure_ascii=False) if isinstance(info["raw"], dict) else info["raw"].replace("\n", "\n      ")))

    missing = [sid for sid in SCENARIOS if sid not in seen and not SCENARIOS[sid].get("forbidden")]
    log("\nRésumé : %d OK · %d à surveiller · %d en échec" % (counts["ok"], counts["warn"], counts["fail"]))
    if missing:
        log("Scénarios sans aucun fichier : " + ", ".join("%s (%s)" % (s, SCENARIOS[s]["name"]) for s in missing))
    return 1 if counts["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
