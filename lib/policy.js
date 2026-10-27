// Site exclusion rules.
//  - DRM streaming platforms are always excluded: their media are encrypted and cannot
//    (and must not) be downloaded.
//  - YouTube is excluded only in the "store" build: the Chrome Web Store rejects
//    extensions that facilitate YouTube downloads. In the personal build it is
//    handled by the local yt-dlp helper.

import { BUILD } from "./config.js";

const DRM_SERVICES = [

];

const YOUTUBE = { name: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com"] };

// Technical hosts whose requests are never useful to the network detector
// (YouTube streams are scrambled and only the helper can download them).
const IGNORED_HOSTS = ["googlevideo.com", "ytimg.com"];

// Hosts that gate their direct stream: a plain fetch of the manifest URL returns a
// short decoy clip unless the player's signed token is replayed. The manifest still
// advertises the full runtime, so the direct download is unreliable — the yt-dlp
// "whole page" path (a public extractor) is the dependable way to get the real file.
// We never replay the token; we only flag the stream so the UI can steer the user.
const GATED_HOSTS = ["uqload.com", "uqload.vc", "uqload.co", "uqload.io", "uqload.net"];

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const matches = (host, domains) => domains.some((d) => host === d || host.endsWith("." + d));

// Name of the excluded service the URL belongs to, or null.
export function excludedService(url, build = BUILD) {
  const host = hostname(url);
  if (!host) return null;
  for (const s of DRM_SERVICES) if (matches(host, s.domains)) return s.name;
  if (build === "store" && matches(host, [...YOUTUBE.domains, ...IGNORED_HOSTS])) return YOUTUBE.name;
  return null;
}

export function isExcluded(url, build = BUILD) {
  return excludedService(url, build) !== null;
}

// Requests the network detector should skip silently.
export function isIgnoredRequest(url) {
  const host = hostname(url);
  return isExcluded(url) || matches(host, IGNORED_HOSTS);
}

// Pages that only the helper can handle (no usable network detection).
export function helperOnly(url, build = BUILD) {
  return build !== "store" && matches(hostname(url), YOUTUBE.domains);
}

// Whether a stream's host gates the direct download behind a signed token (and so
// serves a short decoy to a plain download). Not an exclusion: the stream is still
// detected and listed, but the UI warns and points to the yt-dlp "whole page" path.
export function isGatedStream(url) {
  return matches(hostname(url), GATED_HOSTS);
}

// Whether a DRM service rule applies (used to explain why a page is excluded).
export function isDrmService(url) {
  const host = hostname(url);
  return DRM_SERVICES.some((s) => matches(host, s.domains));
}
