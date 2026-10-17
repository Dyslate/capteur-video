# Test lab

A local website with synthetic media (ffmpeg test pattern + 440 Hz tone, 8 s) covering every kind of stream the extension handles, plus a script that checks what you downloaded. No real site and no third-party content involved.

## Quick start

Requires Python 3.9+. ffmpeg is only needed to (re)generate the media; the local helper's bundled ffmpeg is used if there is none on the PATH.

```
cd tests/lab
python serve.py        # generates the media if missing, serves http://127.0.0.1:8765 and opens it
```

1. Open the extension's side panel.
2. Open a scenario page and download it in several formats and qualities.
3. Run `python verify.py` (in another terminal): it inspects every "Lab NN …" file downloaded since `serve.py` started.
4. If something fails, open **Journal** in the panel, click **Copier**, and send it together with the output of `verify.py`.

## Scenarios

| # | Page | Stream | Expected |
|---|---|---|---|
| 01 | `s01.html` | Direct MP4 (H.264 + AAC, 720p) in a `<video>` | One "Vidéo" card; MP4 sent as is; MP3/WAV in the browser; M4A/MKV/Opus/FLAC via the helper |
| 02 | `s02.html` | WebM (VP9 + Opus, 360p) | MP4 gives the original `.webm`; MP3/WAV in the browser |
| 03 | `s03.html` | HLS master, TS segments, 720p + 360p | Two qualities; MP4 via the helper (or `.ts` without it) |
| 04 | `s04.html` | HLS with fMP4 segments | Real MP4 |
| 05 | `s05.html` | DASH SegmentTemplate, video 720p/360p + separate audio | Merged MP4 in both qualities, MP4 without sound, M4A |
| 06 | `s06.html` | Instagram-style split tracks (`bytestart`/`byteend`, `efg`) | One card, tracks paired by `efg` id; merged MP4 |
| 07 | `s07.html` | DASH manifest hidden in page JSON (`<`-escaped) | Nothing until **Forcer la détection**, then a card |
| 08 | `s08.html` | Audio-only M4A in an `<audio>` | "Audio" card, no video formats |
| 09 | `s09.html` | Encrypted HLS (AES-128) + protected DASH | "Flux protégé" cards, no download button, no file |
| 10 | `s10.html` | Plain page with a video | "Toute la page avec yt-dlp" card: MKV, FLAC, Opus, MP3… |

Every page shows its own log (requests with status, size, content type, timing; media element events).

## Files

| File | Role |
|---|---|
| `make_fixtures.py` | Generates `media/` (about 15 MB, ~10 s). `--clean` deletes it. |
| `serve.py` | Local server: byte ranges, `bytestart`/`byteend`, no caching, logs every media request with its `Referer`. `--port`, `--no-browser`. |
| `verify.py` | Checks downloads: tracks, codec vs. extension, 8 s duration, resolution, decoding errors, "sans son" files really silent, nothing from scenario 09. `--since MIN`, `--dir PATH`, `-v`. Exit code 1 on failure. |
| `lab.js`, `lab.css` | Shared page script (request log) and style. |

## Notes

- Plain Chromium (not Google Chrome) has no AAC decoder: in-browser MP3/WAV of AAC sources fails there, by design of that build. Use Google Chrome, Edge or Brave.
- Browser downloads keep the page title as file name (`Lab 05 · …`); `verify.py` matches files by the `Lab NN` prefix.
