#!/usr/bin/env python3
"""Generates the test lab pages (index.html and s01.html … s10.html).

Edit the SCENARIOS list below, then run:  python make_pages.py
"""

import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# DASH manifest hidden in the page's JSON data (scenario 07), with "<" escaped as in real pages.
MPD = ('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">'
       '<Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v720" bandwidth="1300000" '
       'width="1280" height="720" codecs="avc1.64001f"><BaseURL>media/split/video.mp4</BaseURL><SegmentBase indexRange="0-1000"/>'
       '</Representation></AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a1" '
       'bandwidth="128000" codecs="mp4a.40.2"><BaseURL>media/split/audio.m4a</BaseURL></Representation></AdaptationSet></Period></MPD>')
INLINE_JSON = json.dumps({"items": [{"media": {"id": "lab07", "video_dash_manifest": MPD}}]}).replace("<", "\\u003C")

# (number, name, description, media markup, page script, expected results)
SCENARIOS = [
    ("01", "Direct MP4", "A complete MP4 file (H.264 + AAC, 1280×720, 8 s) played by a &lt;video&gt; element.",
     '<video id="v" src="media/direct.mp4" controls muted autoplay></video>',
     "watchMedia(document.getElementById('v'));",
     ["One “Video” card · 0:08 · about 2 MB.",
      "MP4: sent as is to Chrome's downloads.",
      "MP3 / WAV: converted in the browser.",
      "M4A, MKV, Opus, FLAC: through the local helper (if installed)."]),
    ("02", "WebM (VP9 + Opus)", "A 640×360 WebM file played by a &lt;video&gt; element.",
     '<video id="v" src="media/direct.webm" controls muted autoplay></video>',
     "watchMedia(document.getElementById('v'));",
     ["One “Video” card.",
      "MP4: the file keeps its original format (.webm).",
      "MP3 / WAV: converted in the browser (Opus can always be decoded)."]),
    ("03", "HLS with TS segments, two qualities", "An HLS master playlist (720p and 360p) with .ts segments, loaded the way a player would.",
     "", """const { body } = await labFetch("media/hls-ts/master.m3u8");
labLog("master playlist:\\n" + new TextDecoder().decode(body));
await labFetch("media/hls-ts/720/index.m3u8");
await labFetch("media/hls-ts/720/s000.ts");""",
     ["One “HLS stream” card with 2 qualities (720p, 360p).",
      "MP4: through the helper if installed (real .mp4), otherwise a .ts file (plays in VLC).",
      "MP3: converted in the browser."]),
    ("04", "HLS with fMP4 segments", "An HLS playlist whose segments are fragmented MP4 (init.mp4 + .m4s).",
     "", """await labFetch("media/hls-fmp4/index.m3u8");
await labFetch("media/hls-fmp4/init.mp4");""",
     ["One “HLS stream” card · 0:08.",
      "MP4: a real .mp4 (assembled in the browser, or through the helper if installed).",
      "MP3 / WAV: converted in the browser."]),
    ("05", "DASH, separate video and audio", "A DASH manifest (SegmentTemplate) with video in 720p and 360p, and audio on its own.",
     "", """const { body } = await labFetch("media/dash/manifest.mpd");
labLog("manifest: " + body.byteLength + " B");
await labFetch("media/dash/init-stream0.m4s");""",
     ["One “DASH stream” card · 0:08 with 720p and 360p.",
      "MP4: video and sound merged in the browser.",
      "MP4 without sound, M4A (original track), MP3, WAV: in the browser."]),
    ("06", "Split tracks (Instagram style)", "Like on Instagram: video and sound are two separate files, requested in chunks with <code>bytestart</code>/<code>byteend</code> and identified by an <code>efg</code> parameter.",
     "", """const asset = 900001;
const v = "media/split/video.mp4?efg=" + efg({ vencode_tag: "dash_baseline_1_v1_720", xpv_asset_id: asset }) + "&_nc_ht=lab";
const a = "media/split/audio.m4a?efg=" + efg({ vencode_tag: "dash_ln_heaac_vbr3_audio", xpv_asset_id: asset }) + "&_nc_ht=lab";
await labFetch(v + "&bytestart=0&byteend=200000");
await labFetch(a + "&bytestart=0&byteend=40000");
await labFetch(v + "&bytestart=200001&byteend=400000");""",
     ["A single “Video” card: both tracks are paired (log: “tracks paired · asset id (efg)”).",
      "MP4: one file with picture AND sound.",
      "MP4 without sound, M4A, MP3, WAV: in the browser."]),
    ("07", "Manifest hidden in the page", "Nothing loads by itself: the DASH manifest is hidden in the page's JSON data, like on some Instagram pages.",
     '<script type="application/json" id="data">' + INLINE_JSON + '</script>',
     """labLog("no media request: open the panel, then click “Force detection”", "warn");""",
     ["At first: “Waiting for media…”.",
      "After “Force detection”: a “Video from the page” card · 0:08.",
      "MP4: video and sound merged."]),
    ("08", "Audio only", "An M4A (AAC) file played by an &lt;audio&gt; element.",
     '<audio id="a" src="media/audio.m4a" controls autoplay muted></audio>',
     "watchMedia(document.getElementById('a'));",
     ["One “Audio” card (no video formats offered).",
      "MP3, WAV, M4A: in the browser."]),
    ("09", "Encrypted streams (must be refused)", "An encrypted HLS stream (AES-128) and a protected DASH stream (ContentProtection). The extension must refuse to download them.",
     "", """await labFetch("media/encrypted/hls.m3u8");
await labFetch("media/encrypted/dash.mpd");""",
     ["Two “Protected stream” cards with the DRM badge.",
      "No download button. No file must appear."]),
    ("10", "Page for the yt-dlp helper", "A regular page with a video: used to test the “Whole page with yt-dlp” card.",
     '<video id="v" src="media/direct.mp4" controls muted></video>',
     "watchMedia(document.getElementById('v'));",
     ["The “Whole page with yt-dlp” card (helper installed).",
      "MKV, MP4, MP3, M4A, Opus, FLAC, WAV: files in Downloads/Capteur video.",
      "The “360p max” quality must give a video of at most 360 lines."]),
]

PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lab {n} · {name}</title>
  <link rel="stylesheet" href="lab.css">
</head>
<body>
<main>
  <div class="crumb"><a href="index.html">← Test lab</a></div>
  <h1><span class="num">{n}</span> {name}</h1>
  <p class="muted">{desc}</p>
  {media}
  <h2>Expected in the panel</h2>
  <ul class="expect">
{expect}
  </ul>
  <h2>Page log</h2>
  <pre id="lablog"></pre>
</main>
<script type="module">
import {{ labLog, labFetch, watchMedia, efg }} from "./lab.js";
{script}
</script>
</body>
</html>
"""

INDEX = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test lab · Capteur vidéo</title>
  <link rel="stylesheet" href="lab.css">
</head>
<body>
<main>
  <h1>Test lab</h1>
  <p class="muted">Synthetic media (test pattern + beep, generated by ffmpeg) to test every kind of stream without relying on a real site.</p>

  <div class="box">
    <ol class="steps">
      <li>Open the extension's side panel (Capteur vidéo icon).</li>
      <li>Open a scenario below, then look at the card that shows up in the panel.</li>
      <li>Download it in several formats and qualities.</li>
      <li>Run <code>verify.bat</code> (or <code>python verify.py</code>): it checks every downloaded file (tracks, duration, codec, decoding errors).</li>
      <li>If something fails: panel → <strong>Log</strong> → “Copy”, plus the output of <code>verify.py</code>.</li>
    </ol>
  </div>

  <h2>Scenarios</h2>
  <div class="grid">
{cards}
  </div>
  <h2>Page log</h2>
  <pre id="lablog"></pre>
</main>
<script type="module">import "./lab.js";</script>
</body>
</html>
"""


def main():
    cards = []
    for n, name, desc, media, script, expect in SCENARIOS:
        with open(os.path.join(HERE, "s%s.html" % n), "w", encoding="utf-8", newline="\n") as f:
            f.write(PAGE.format(n=n, name=name, desc=desc, media=media, script=script,
                                expect="\n".join("    <li>%s</li>" % e for e in expect)))
        summary = html.unescape(desc).split(". ")[0].rstrip(".") + "."
        cards.append('    <a href="s%s.html"><div class="box"><span class="num">%s</span> <strong>%s</strong><br>'
                     '<span class="muted">%s</span></div></a>' % (n, n, name, html.escape(summary, quote=False)))
    with open(os.path.join(HERE, "index.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(INDEX.format(cards="\n".join(cards)))
    print("Generated index.html and %d scenario pages." % len(SCENARIOS))


if __name__ == "__main__":
    main()
