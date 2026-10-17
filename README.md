# Capteur vidéo

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

Files saved by the helper go to `Downloads/Capteur video`. Run the installer again to update yt-dlp; `python helper/install.py --uninstall` removes everything.

The extension has a fixed ID (`gkbhlagbekepghjaegeolhjkmbnkcjpn`, from the `key` in `manifest.json`) so the helper can trust it.

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

## Development

```
npm test     # unit tests (Node 18+, ffmpeg for the MP4 tests)
```

The end-to-end behaviour was checked in headless Chromium against synthetic streams: direct MP4, HLS (TS and fMP4), DASH (SegmentTemplate and SegmentBase), Instagram-style split tracks with `bytestart`/`byteend`/`efg` parameters, manifests embedded in page JSON, encrypted streams (refused), and the local helper over native messaging.

Note: open-source Chromium builds ship without the AAC decoder, so in-browser MP3 conversion of AAC audio only works in Google Chrome (or Edge/Brave), not in plain Chromium.

## Roadmap

See [TODO.md](TODO.md).

## Responsible use

Download only content you own, content under a free licence, or content you are allowed to copy for private use. Respect creators and each site's terms of service.

## License

[MIT](LICENSE). Bundles [lamejs](https://github.com/zhuker/lamejs) (LGPL) in `vendor/`.
