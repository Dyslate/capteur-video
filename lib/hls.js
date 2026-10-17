// HLS playlist (.m3u8) parser.

function attrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function parseRange(str, defaultOffset) {
  const [len, off] = String(str).split("@");
  return { length: Number(len), offset: off !== undefined ? Number(off) : defaultOffset };
}

// Returns either a master playlist (qualities) or a media playlist (segments).
export function parseHls(text, baseUrl) {
  if (!text.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U")) {
    throw new Error("Not an HLS playlist");
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [];
    const audio = [];
    let encrypted = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("#EXT-X-STREAM-INF:")) {
        const a = attrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith("#")) j++;
        if (j < lines.length) {
          const [w, h] = (a.RESOLUTION || "").split("x").map(Number);
          variants.push({
            url: abs(lines[j]),
            bandwidth: Number(a.BANDWIDTH) || 0,
            width: w || 0,
            height: h || 0,
            audioGroup: a.AUDIO || null,
          });
        }
        i = j;
      } else if (l.startsWith("#EXT-X-MEDIA:")) {
        const a = attrs(l.slice(13));
        if (a.TYPE === "AUDIO" && a.URI) {
          audio.push({ url: abs(a.URI), group: a["GROUP-ID"] || null, name: a.NAME || a.LANGUAGE || "audio", isDefault: a.DEFAULT === "YES" });
        }
      } else if (l.startsWith("#EXT-X-SESSION-KEY:")) {
        const a = attrs(l.slice(19));
        if (a.METHOD && a.METHOD !== "NONE") encrypted = true;
      }
    }
    variants.sort((x, y) => y.bandwidth - x.bandwidth);
    return { type: "master", variants, audio, encrypted };
  }

  const segments = [];
  let encrypted = false;
  let ended = false;
  let duration = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let currentMap = null;
  let lastMapKey = null;
  const lastEnd = {};

  for (const l of lines) {
    if (l.startsWith("#EXT-X-KEY:")) {
      const a = attrs(l.slice(11));
      if (a.METHOD && a.METHOD !== "NONE") encrypted = true;
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = attrs(l.slice(11));
      currentMap = { url: abs(a.URI), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null, init: true };
    } else if (l.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = l.slice(17);
    } else if (l === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!l.startsWith("#")) {
      if (currentMap) {
        const key = currentMap.url + "|" + (currentMap.range ? currentMap.range.offset : "");
        if (key !== lastMapKey) {
          segments.push(currentMap);
          lastMapKey = key;
        }
      }
      const url = abs(l);
      let range = null;
      if (pendingRange) {
        range = parseRange(pendingRange, lastEnd[url] ?? 0);
        lastEnd[url] = range.offset + range.length;
      }
      segments.push({ url, range });
      duration += pendingDuration;
      pendingDuration = 0;
      pendingRange = null;
    }
  }
  return { type: "media", segments, encrypted, duration, live: !ended };
}
