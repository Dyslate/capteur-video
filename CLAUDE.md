# CLAUDE.md — project memory

Context for Claude sessions working on this repository.

## The project

**Capteur vidéo**: a Manifest V3 Chrome extension that detects the videos of the active tab and saves them as MP4 or MP3 from a side panel. An optional local helper (Python + yt-dlp, over native messaging) covers YouTube and thousands of other sites.

- Owner: Dyslate (GitHub `Dyslate/capteur-video`). Commit as **Dyslate <Dyslate@gmail.com>** only, no co-author trailers.
- **UI text in French. Code comments, README, TODO and this file in English.**
- No build step and no npm dependencies: the folder loads as-is with "Load unpacked". Only vendored file: `vendor/lame.min.js` (lamejs, LGPL).

## Architecture

| File | Role |
|---|---|
| `background.js` | Module service worker. `webRequest.onHeadersReceived` → `classify()` → per-tab list in `chrome.storage.session` (`tab:<id>`). Strips `bytestart`/`byteend`, decodes Instagram `efg`. Runs **helper jobs** (`connectNative`) and stores them in `helper:jobs` so they survive the panel closing. |
| `panel.js` | Side panel. `refresh()` → `buildMedias()` turns raw items into media cards (HLS, DASH, probed MP4 files, paired audio/video tracks). In-browser jobs: `jobVideo` (fetch + `mux`), `jobMp3` (decode + lamejs), `jobAudio`. |
| `lib/mp4.js` | `probe()` and `mux()`; handles regular (stco/co64 rewrite) and fragmented files (interleaves moof/mdat by `tfdt`, renumbers `mfhd`, patches `tfhd` track IDs and absolute base offsets). |
| `lib/dash.js`, `lib/hls.js` | Manifest parsers (DASH needs `DOMParser`). |
| `lib/fetcher.js` | Segment fetching (6 parallel, 3 retries), `withReferer()` DNR session rule. |
| `lib/scan.js` | `scanPage()` injected by "Forcer la détection". Must stay self-contained. |
| `lib/policy.js` + `lib/config.js` | Exclusions and build flavour (`BUILD = "personal" \| "store"`). |
| `helper/capteur_helper.py` | Native messaging host: `ping`, `download`, `reveal`, `update`. stdout is the protocol channel: never print to it. |
| `helper/install.py` | venv + `yt-dlp[default]` + `imageio-ffmpeg`, launcher, host manifest registration. |

Host name: `com.dyslate.capteur_video`. Extension ID: `gkbhlagbekepghjaegeolhjkmbnkcjpn` (from `key` in `manifest.json`; the private key is not in the repo and is not needed).

## Rules

- **Never** add DRM circumvention or decryption (Widevine, FairPlay, PlayReady, HLS AES keys). Encrypted streams are refused in the extension and in the helper.
- DRM platforms are always excluded (`lib/policy.js` and `DRM_DOMAINS` in the helper — keep both lists in sync).
- YouTube is excluded only in the store build (Chrome Web Store policy). It goes through the helper in the personal build.
- No remote code, no `eval`, no inline scripts (MV3 CSP).
- Always download through `U.download()` (it retries rejected file names).
- Keep permissions minimal; justify new ones in `store/README.md`.

## Checking changes

```bash
npm test                         # unit tests (needs ffmpeg for MP4 tests)
python3 tests/helper_protocol_test.py  # helper protocol, offline
for f in *.js lib/*.js; do node --check "$f"; done
python3 -m py_compile helper/*.py
python3 scripts/build.py         # dist/*.zip
```

`tests/fake_yt_dlp/` is a yt-dlp test double for exercising the helper protocol without network access. Plain Chromium has no AAC decoder: test in-browser MP3 with Opus audio, or use Google Chrome.

## Status

Roadmap in [TODO.md](TODO.md).
