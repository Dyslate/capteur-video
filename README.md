# Capteur vidéo

[![CI](https://github.com/Dyslate/capteur-video/actions/workflows/ci.yml/badge.svg)](https://github.com/Dyslate/capteur-video/actions/workflows/ci.yml)

A Chrome extension that spots the videos playing on the pages you visit and saves them as **MP4** or **MP3**, from a side panel.

- Works out of the box on Instagram, Facebook, Vimeo and most sites (direct MP4, HLS, DASH, separate audio/video tracks).
- With the optional **local helper** (yt-dlp + ffmpeg), it also handles YouTube and thousands of other sites.
- DRM-protected platforms (Netflix, Disney+, Spotify…) are always excluded: their media are encrypted.

> The user interface is in French. Code, comments and docs are in English.

## Features

| | Built-in (no install) | With the local helper |
|---|---|---|
| Direct files (`.mp4`, `.webm`, `.m4a`…) | ✅ | ✅ |
| HLS (`.m3u8`) and DASH (`.mpd`) streams | ✅ | ✅ |
| Instagram / Facebook (separate video and audio tracks) | ✅ merged into one MP4 | ✅ |
| MP3 conversion | ✅ (in the browser, LAME) | ✅ (ffmpeg) |
| YouTube | ❌ | ✅ (personal build) |
| Thousands of other sites (yt-dlp extractors) | — | ✅ |
| DRM platforms | ❌ | ❌ |

Every card has a **Format** picker and a **Quality** picker that adapts to the format:

| Format | Quality choices | Made by |
|---|---|---|
| MP4 | the stream's own qualities (or best / 2160p … 360p with the helper) | browser; helper for HLS TS streams |
| MP4 without sound | stream qualities | browser (separate tracks only) |
| MKV | best / 2160p … 360p | helper |
| MP3 | 128 / 192 / 256 / 320 kb/s | browser |
| M4A (AAC) | 128 / 192 / 256 kb/s | browser for a separate AAC track (no re-encoding), helper otherwise |
| Opus | 96 / 128 / 160 kb/s | helper |
| WAV, FLAC (lossless) | — | WAV in the browser, FLAC with the helper |

The panel picks the engine itself; formats that need the helper are listed as "(module requis)" when it is missing. The last format and quality are remembered.

Other details:
- **Side panel** with a waiting state, a **Force detection** button that scans the page (`<video>` tags, Open Graph tags, JSON embedded by Instagram/Facebook), and a download list with progress.
- Quality picker for multi-bitrate streams.
- Dependency-free **MP4 muxer** (`lib/mp4.js`) that merges video and audio tracks, regular or fragmented.
- The source page's `Referer` is added to the extension's requests, as some CDNs require it.

## Install the extension

1. Download this repository (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the project folder.
4. Pin the extension, then click its icon to open the side panel.

## Install the local helper (optional, needed for YouTube)

Requires Python 3.9+.

- **Windows**: double-click `helper/install-windows.bat`.
- **macOS / Linux**: `sh helper/install.sh`

The installer creates a private Python environment, installs **yt-dlp** and a bundled **ffmpeg**, and registers the helper with Chrome, Edge, Brave and Chromium. Restart Chrome afterwards.

YouTube also needs a JavaScript runtime for yt-dlp. Install **Deno**:

```
winget install DenoLand.Deno                    # Windows
brew install deno                               # macOS
curl -fsSL https://deno.land/install.sh | sh    # Linux
```

Files saved by the helper go to `Downloads/Capteur video`. When a site changes and downloads start failing, use **Mettre à jour yt-dlp** on the help page (or run the installer again); `python helper/install.py --uninstall` removes everything.

The extension has a fixed ID (`gkbhlagbekepghjaegeolhjkmbnkcjpn`, from the `key` in `manifest.json`) so the helper can trust it.

After updating the files, click **Reload** on the extension in `chrome://extensions`, otherwise Chrome may keep running the previous service worker.

## Builds

```
python3 scripts/build.py           # both zips in dist/
python3 scripts/build.py store     # Chrome Web Store build only
```

| Build | YouTube | Local helper | Publishable on the Chrome Web Store |
|---|---|---|---|
| `personal` (default when loading the folder) | via the helper | yes | no |
| `store` | excluded | removed | yes |

The Chrome Web Store rejects extensions that facilitate YouTube downloads, which is why the store build excludes it. The rules live in `lib/policy.js`; the flavour is set in `lib/config.js`.

## Project structure

| Path | Role |
|---|---|
| `manifest.json` | Manifest V3 |
| `background.js` | Service worker: network detection per tab, helper download jobs |
| `panel.html`, `panel.css`, `panel.js` | Side panel UI, in-browser downloads (fetch, mux, MP3) |
| `help.html`, `help.js` | Helper install guide and status |
| `lib/hls.js`, `lib/dash.js` | HLS and DASH parsers |
| `lib/mp4.js` | MP4 probe and audio/video muxer |
| `lib/mp3.js`, `workers/mp3-worker.js` | MP3 encoding (browser decoding + lamejs in a worker) |
| `lib/fetcher.js` | Segment fetching, retries, `Referer` rules |
| `lib/scan.js` | Page scan for **Force detection** |
| `lib/policy.js`, `lib/config.js` | Site exclusions and build flavour |
| `lib/helper.js` | Panel-side access to the local helper |
| `helper/` | Local helper (Python native messaging host) and installers |
| `tests/` | Unit tests and a yt-dlp test double |
| `scripts/build.py` | Packaging |
| `store/` | Chrome Web Store listing material |

## Troubleshooting

- **Journal** (link at the bottom of the side panel): every detection decision (added / ignored and why), stream analysis, probe, track pairing, request retry, merge, decode and save, with timings. Filter it, then **Copier** or **Exporter** to share it. It also shows the end of the local helper's `helper.log` (yt-dlp verbose output).
- **Test lab**: `tests/lab/` serves synthetic streams of every kind and checks the downloaded files. See [tests/lab/README.md](tests/lab/README.md).

## Development

```
npm test                              # unit tests (Node 18+, ffmpeg for the MP4 tests)
python3 tests/helper_protocol_test.py # helper protocol, offline (yt-dlp test double)
cd tests/lab && python3 serve.py      # manual end-to-end lab, then python3 verify.py
```

GitHub Actions runs both on every push and attaches the built zips as artifacts.

The end-to-end behaviour was checked in headless Chromium against synthetic streams: direct MP4, HLS (TS and fMP4), DASH (SegmentTemplate and SegmentBase), Instagram-style split tracks with `bytestart`/`byteend`/`efg` parameters, manifests embedded in page JSON, encrypted streams (refused), and the local helper over native messaging.

Note: open-source Chromium builds ship without the AAC decoder, so in-browser MP3 conversion of AAC audio only works in Google Chrome (or Edge/Brave), not in plain Chromium.

## Roadmap

See [TODO.md](TODO.md).

## Responsible use

Download only content you own, content under a free licence, or content you are allowed to copy for private use. Respect creators and each site's terms of service.

## License

[MIT](LICENSE). Bundles [lamejs](https://github.com/zhuker/lamejs) (LGPL) in `vendor/`.
