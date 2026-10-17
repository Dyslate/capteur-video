# TODO

Roadmap. Tick items as they land.

## Done

### v1
- [x] Network detection of direct videos and HLS streams
- [x] HLS quality picker, parallel segment download with retries
- [x] `EXT-X-MAP` and `EXT-X-BYTERANGE` support
- [x] Source page `Referer` on the extension's requests
- [x] Encrypted / DRM streams flagged and refused
- [x] Fallback file names when Chrome rejects accented titles

### v2
- [x] Side panel UI (waiting state, Force detection, download list)
- [x] DASH support (`SegmentBase`, `SegmentList`, `SegmentTemplate` + `SegmentTimeline`)
- [x] Instagram / Facebook split tracks: `bytestart`/`byteend` normalisation, `efg` asset grouping
- [x] Dependency-free MP4 muxer (regular and fragmented files)
- [x] Manifests embedded in page JSON (`video_dash_manifest`)
- [x] MP3 conversion in the browser (lamejs in a worker, ID3 title)
- [x] Local helper (yt-dlp + ffmpeg over native messaging) for YouTube and other sites
- [x] Cross-platform helper installer (Windows registry, macOS, Linux; Chrome, Edge, Brave, Chromium)
- [x] Site policy with `personal` / `store` builds
- [x] Packaging script, unit tests, MIT licence

### v2.1
- [x] Quality choice for helper downloads (best / 1080p / 720p / 480p)
- [x] "Update yt-dlp" button on the help page
- [x] Clear the list on in-page navigation (SPA sites such as Instagram)
- [x] `Referer` rule on probe requests too
- [x] GitHub Actions CI (syntax checks, unit tests, helper protocol tests, zips as artifacts)

### v2.2
- [x] Format and quality pickers on every card (MP4, MP4 without sound, MKV, MP3, M4A, Opus, WAV, FLAC)
- [x] MP3 bitrate choice (128 / 192 / 256 / 320 kb/s), WAV encoding in the browser
- [x] Automatic engine choice (browser or helper), remembered choices
- [x] Helper: `format` and `abr` options, remux to the chosen container

### v2.3
- [x] Diagnostic log (per-instance buffers, log page with filters, copy, export) and `helper.log`
- [x] Test lab: synthetic media for every stream type, local server, `verify.py`
- [x] Detection keeps `<video>`/`<audio>` sources of any size (short clips were dropped)
- [x] Helper jobs run in their own folder: never delete or overwrite an existing file
- [x] Direct-stream helper downloads are named after the page title

### v2.4
- [x] Whole app in English (UI, logs, errors, helper, installers, test lab, store listing)
- [x] Windows launchers at the project root: `install-helper.bat`; lab: `start-lab.bat`, `verify.bat`
- [x] `verify.py` works without ffmpeg (built-in container inspection)

## Next

### Features
- [ ] Record live streams continuously, with a Stop button
- [ ] Subtitles (`.vtt`) download
- [ ] Mux HLS TS segments into MP4 in the browser (TS demuxer)
- [ ] MP3 from HLS TS audio in the browser (needs the TS demuxer above)
- [ ] Playlist downloads through the helper (opt-in)
- [ ] "Copy yt-dlp command" button for power users

### Reliability
- [ ] Stream large downloads to disk (File System Access API) instead of memory
- [ ] Resume interrupted downloads
- [ ] Refresh expired segment URLs by re-reading the playlist
- [ ] Better pairing of audio/video tracks when several reels play at once

### Interface
- [ ] Thumbnails and real video titles in the media cards
- [ ] Options page (download folder, concurrency, MP3 bitrate, file name template)
- [ ] French translation as a second language (`_locales`, `chrome.i18n`)
- [ ] Desktop notification when a long download finishes

### Project
- [ ] Automate the test lab with Playwright in CI
- [ ] Screenshots in the README
- [ ] Publish the store build on the Chrome Web Store
