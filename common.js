// Fonctions partagées par la popup et la page de téléchargement.

const HLS = (() => {
  // Lit une liste d'attributs du type KEY=VALUE,KEY2="VALUE"
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

  async function fetchText(url, signal) {
    const r = await fetch(url, { credentials: "include", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  // Renvoie soit une playlist maître (liste de qualités),
  // soit une playlist de média (liste de segments).
  function parse(text, baseUrl) {
    if (!text.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U")) {
      throw new Error("Ce n'est pas une playlist HLS");
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
            variants.push({
              url: abs(lines[j]),
              bandwidth: Number(a.BANDWIDTH) || 0,
              resolution: a.RESOLUTION || null,
              audioGroup: a.AUDIO || null,
            });
          }
          i = j;
        } else if (l.startsWith("#EXT-X-MEDIA:")) {
          const a = attrs(l.slice(13));
          if (a.TYPE === "AUDIO" && a.URI) {
            audio.push({
              url: abs(a.URI),
              group: a["GROUP-ID"] || null,
              name: a.NAME || a.LANGUAGE || "audio",
            });
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
        currentMap = {
          url: abs(a.URI),
          range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null,
          init: true,
        };
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

  function variantLabel(v) {
    const parts = [];
    if (v.resolution) parts.push(v.resolution.split("x")[1] + "p");
    if (v.bandwidth) {
      parts.push((v.bandwidth / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Mb/s");
    }
    return parts.join(" · ") || "Qualité par défaut";
  }

  return { parse, fetchText, variantLabel };
})();

const Util = {
  safeName(s) {
    const n = String(s || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f~]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 120)
      .trim();
    return n || "video";
  },

  // Variante sans accents ni caractères non ASCII, pour les systèmes qui les refusent.
  asciiName(s) {
    return Util.safeName(
      String(s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^\x20-\x7e]/g, " ")
    );
  },

  // Lance un téléchargement ; si Chrome refuse le nom de fichier,
  // réessaie sans accents, puis avec un nom générique.
  async download(url, base, ext) {
    const names = [...new Set([Util.safeName(base), Util.asciiName(base), "video"])];
    let lastError;
    for (const name of names) {
      const filename = `${name}.${ext}`;
      try {
        return { id: await chrome.downloads.download({ url, filename }), filename };
      } catch (e) {
        lastError = e;
        if (!/filename/i.test(e.message)) throw e;
      }
    }
    throw lastError;
  },

  formatBytes(n) {
    if (n == null) return "";
    const units = ["o", "Ko", "Mo", "Go"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toLocaleString("fr-FR", { maximumFractionDigits: i ? 1 : 0 }) + " " + units[i];
  },

  formatDuration(sec) {
    const s = Math.round(sec || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
  },

  videoExt(url, mime) {
    try {
      const m = new URL(url).pathname.match(/\.(mp4|webm|mov|m4v)$/i);
      if (m) return m[1].toLowerCase();
    } catch {}
    if (mime && mime.includes("webm")) return "webm";
    return "mp4";
  },
};

if (typeof module !== "undefined") module.exports = { HLS, Util };
