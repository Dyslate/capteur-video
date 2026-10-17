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

// Whether a DRM service rule applies (used to explain why a page is excluded).
export function isDrmService(url) {
  const host = hostname(url);
  return DRM_SERVICES.some((s) => matches(host, s.domains));
}
