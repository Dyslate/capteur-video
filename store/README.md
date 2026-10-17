# Chrome Web Store kit

Everything needed to publish the **store build** (`python3 scripts/build.py store` → `dist/capteur-video-store-<version>.zip`).

The store build excludes YouTube and has no local helper: the Chrome Web Store rejects extensions that facilitate YouTube downloads (violation family "Blue Zinc" / "Blue Copper" in the store's troubleshooting guide).

## Checklist

1. Developer account at the Chrome Web Store Developer Dashboard (one-time registration fee).
2. Upload `dist/capteur-video-store-<version>.zip`.
3. Listing: copy `listing.md`.
4. Images: 128×128 icon (`icons/icon128.png`), at least one 1280×800 screenshot, optional 440×280 promo tile.
5. Privacy: paste the justifications below, declare that no user data is collected, link `privacy-policy.md` (publish it, for example with GitHub Pages).
6. Category: Productivity / Tools. Language: English.

## Permission justifications

| Permission | Why it is needed |
|---|---|
| `webRequest` | Observe (never modify or block) the media requests of the active tab to list the videos being played. |
| `host_permissions: <all_urls>` | Detection must work on any site the user visits; media files and segments are fetched from their CDNs. |
| `downloads` | Save the files the user asks for. |
| `storage` | Keep the list of media detected per tab during the session (`storage.session`). |
| `sidePanel` | The interface is a side panel. |
| `scripting` | The "Force detection" button reads `<video>` tags and embedded data of the current page, only when the user clicks it. |
| `declarativeNetRequestWithHostAccess` | Add the source page's `Referer` to the extension's own media requests, which some CDNs require. Scoped to requests initiated by the extension. |

Single purpose: detect videos on the current page and save them as MP4 or MP3 at the user's request.

Remote code: none. All logic is in the package; `vendor/lame.min.js` is bundled.
