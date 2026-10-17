#!/usr/bin/env python3
"""Generates the synthetic test media used by the lab pages (tests/lab/media).

Every file comes from ffmpeg's built-in test pattern and a sine tone, so the lab
contains no third-party content. Uses ffmpeg from PATH, or the one bundled with
the local helper (imageio-ffmpeg) if it is installed.

  python make_fixtures.py          generate everything (about 20 MB, under a minute)
  python make_fixtures.py --clean  delete the generated media
"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "media")
SECONDS = 8


def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    # The local helper's private environment (see helper/install.py)
    if os.name == "nt":
        venv = os.path.join(os.environ.get("LOCALAPPDATA", ""), "CapteurVideo", "venv", "Scripts", "python.exe")
    else:
        venv = os.path.join(os.path.expanduser("~"), ".capteur-video", "venv", "bin", "python")
    if os.path.exists(venv):
        out = subprocess.run([venv, "-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
                             capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    sys.exit("ffmpeg introuvable : installez-le, ou installez d'abord le module local (helper/).")


FFMPEG = None


def ff(*args, cwd=OUT):
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], cwd=cwd, check=True)


def mkdir(*parts):
    path = os.path.join(OUT, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def step(text):
    print("  - " + text, flush=True)


def write(path, text):
    with open(os.path.join(OUT, path), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    global FFMPEG
    if "--clean" in sys.argv:
        shutil.rmtree(OUT, ignore_errors=True)
        print("Médias supprimés.")
        return
    FFMPEG = find_ffmpeg()
    print("ffmpeg :", FFMPEG)
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)

    step("source : mire 720p + bip de 440 Hz, %d s" % SECONDS)
    ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
       "-t", str(SECONDS), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "50",
       "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest", "-movflags", "+faststart", "direct.mp4")

    step("WebM (VP9 + Opus)")
    ff("-i", "direct.mp4", "-vf", "scale=640:360", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
       "-b:v", "800k", "-c:a", "libopus", "-b:a", "96k", "direct.webm")

    step("audio seul (M4A)")
    ff("-i", "direct.mp4", "-vn", "-c:a", "copy", "-movflags", "+faststart", "audio.m4a")

    step("HLS en TS, deux qualités")
    for height, scale, rate in ((720, "1280:720", "2500k"), (360, "640:360", "700k")):
        d = mkdir("hls-ts", str(height))
        ff("-i", os.path.join(OUT, "direct.mp4"), "-vf", "scale=" + scale, "-c:v", "libx264", "-preset", "veryfast",
           "-b:v", rate, "-g", "50", "-c:a", "aac", "-b:a", "128k", "-f", "hls", "-hls_time", "2",
           "-hls_list_size", "0", "-hls_segment_filename", "s%03d.ts", "index.m3u8", cwd=d)
    write("hls-ts/master.m3u8", "#EXTM3U\n"
          "#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=1280x720\n720/index.m3u8\n"
          "#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360\n360/index.m3u8\n")

    step("HLS en fMP4")
    d = mkdir("hls-fmp4")
    ff("-i", os.path.join(OUT, "direct.mp4"), "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
       "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "s%03d.m4s",
       "index.m3u8", cwd=d)

    step("DASH : vidéo 720p et 360p séparées de l'audio")
    d = mkdir("dash")
    ff("-i", os.path.join(OUT, "direct.mp4"), "-map", "0:v", "-map", "0:v", "-map", "0:a",
       "-c:v", "libx264", "-preset", "veryfast", "-g", "50", "-s:v:0", "1280x720", "-b:v:0", "2500k",
       "-s:v:1", "640x360", "-b:v:1", "700k", "-c:a", "copy", "-f", "dash", "-seg_duration", "2",
       "-use_template", "1", "-use_timeline", "1", "-adaptation_sets", "id=0,streams=v id=1,streams=a",
       "manifest.mpd", cwd=d)

    step("pistes séparées façon Instagram (vidéo seule + audio seul, fragmentées)")
    d = mkdir("split")
    frag = ["-movflags", "frag_keyframe+empty_moov+default_base_moof+global_sidx", "-frag_duration", "1000000"]
    ff("-i", os.path.join(OUT, "direct.mp4"), "-an", "-c", "copy", *frag, "video.mp4", cwd=d)
    ff("-i", os.path.join(OUT, "direct.mp4"), "-vn", "-c", "copy", *frag, "audio.m4a", cwd=d)

    step("flux chiffrés (doivent être refusés)")
    d = mkdir("encrypted")
    playlist = open(os.path.join(OUT, "hls-ts", "720", "index.m3u8"), encoding="utf-8").read()
    playlist = playlist.replace("#EXT-X-TARGETDURATION", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-TARGETDURATION')
    playlist = "\n".join(("../hls-ts/720/" + l if l.endswith(".ts") else l) for l in playlist.splitlines()) + "\n"
    write("encrypted/hls.m3u8", playlist)
    mpd = open(os.path.join(OUT, "dash", "manifest.mpd"), encoding="utf-8").read()
    mpd = mpd.replace('<AdaptationSet id="0"',
                      '<AdaptationSet id="9" contentType="video"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/></AdaptationSet><AdaptationSet id="0"', 1)
    mpd = mpd.replace('initialization="', 'initialization="../dash/').replace('media="', 'media="../dash/')
    write("encrypted/dash.mpd", mpd)

    size = sum(os.path.getsize(os.path.join(b, f)) for b, _, fs in os.walk(OUT) for f in fs)
    print("Terminé : %d fichiers, %.1f Mo dans %s" % (sum(len(fs) for _, _, fs in os.walk(OUT)), size / 1e6, OUT))


if __name__ == "__main__":
    main()
