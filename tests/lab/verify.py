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


def tools():
    """ffprobe for inspection, ffmpeg for the decode check (system or helper-bundled)."""
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg

            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            pass
    return ffprobe, ffmpeg


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
            notes.append("%s %sx%s" % (v.get("codec_name"), v.get("width"), v.get("height")))
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
    if not ffprobe and not ffmpeg:
        sys.exit("Ni ffprobe ni ffmpeg : impossible d'inspecter les fichiers. Installez ffmpeg ou le module local.")

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
        info, err = probe_ffprobe(ffprobe, path) if ffprobe else probe_ffmpeg(ffmpeg, path)
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
