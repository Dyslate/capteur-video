// Function injected into the page by the "Force detection" button.
// It must stay self-contained: chrome.scripting serializes it without its imports.

export function scanPage() {
  const found = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.url || seen.has(item.url)) return;
    seen.add(item.url);
    found.push(item);
  };
  const kindOf = (u) => (/\.m3u8(\?|$)/i.test(u) ? "hls" : /\.mpd(\?|$)/i.test(u) ? "dash" : "file");
  const isHttp = (u) => /^https?:\/\//i.test(u);

  // 1. <video>, <audio>, <source> elements
  for (const el of document.querySelectorAll("video, audio, source")) {
    for (const u of [el.currentSrc, el.src, el.getAttribute("src")]) {
      if (u && isHttp(u)) add({ kind: kindOf(u), url: new URL(u, location.href).href, from: "dom" });
    }
  }

  // 2. Open Graph / Twitter metadata
  for (const m of document.querySelectorAll('meta[property^="og:video"], meta[name^="twitter:player:stream"]')) {
    const u = m.getAttribute("content");
    if (u && isHttp(u) && /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(u)) add({ kind: kindOf(u), url: u, from: "meta" });
  }

  // 3. Embedded JSON data (Instagram, Facebook, X…)
  const unescape = (s) => {
    try {
      return JSON.parse('"' + s + '"');
    } catch {
      return s.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    }
  };
  const scripts = Array.from(document.scripts)
    .map((s) => s.textContent || "")
    .filter((t) => t.length > 50 && /video|\.mp4|\.m3u8|MPD/.test(t));
  const URL_RE = /"(?:video_url|playable_url(?:_quality_hd)?|browser_native_(?:hd|sd)_url|contentUrl|url|src)"\s*:\s*"(https?:(?:\\\/|\/)(?:[^"\\]|\\.)+?)"/g;
  // "<" is often escaped as \u003C in embedded JSON.
  const MPD_RE = /"(?:video_dash_manifest|dash_manifest|manifest)"\s*:\s*"((?:<|\\u003[cC])(?:\?xml|MPD)(?:[^"\\]|\\.)+?)"/g;
  for (const text of scripts.slice(0, 200)) {
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      const u = unescape(m[1]);
      if (/\.(mp4|m3u8|mpd|webm|m4a)(\?|$)/i.test(new URL(u).pathname + "?")) add({ kind: kindOf(u), url: u, from: "json" });
    }
    MPD_RE.lastIndex = 0;
    while ((m = MPD_RE.exec(text))) {
      const xml = unescape(m[1]);
      add({ kind: "dash-inline", url: "inline:" + location.href + "#" + found.length, mpd: xml, base: location.href, from: "json" });
    }
  }
  return { url: location.href, title: document.title, items: found.slice(0, 40) };
}
