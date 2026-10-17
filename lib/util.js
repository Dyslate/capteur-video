// Small shared helpers.

export function safeName(s) {
  const n = String(s || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return n || "video";
}

export function asciiName(s) {
  return safeName(
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\x20-\x7e]/g, " ")
  );
}

// Strips site suffixes from tab titles (" • Instagram", " | Facebook"…)
export function cleanTitle(s) {
  return String(s || "")
    .replace(/\s*[•|·\-–—]\s*(Instagram|Facebook|X|Twitter|TikTok|Vimeo|Dailymotion)\b.*$/i, "")
    .replace(/^\(\d+\)\s*/, "")
    .trim() || "video";
}

// Starts a download; if Chrome rejects the file name, retries without accents, then with a generic name.
export async function download(url, base, ext) {
  const names = [...new Set([safeName(base), asciiName(base), "video"])];
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
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(sec) {
  const s = Math.round(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// "efg" parameter of Instagram / Facebook CDN URLs: base64 JSON identifying the asset.
export function decodeEfg(url) {
  try {
    const efg = new URL(url).searchParams.get("efg");
    if (!efg) return null;
    const b64 = efg.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return {
      asset: json.xpv_asset_id ?? json.video_id ?? null,
      tag: String(json.vencode_tag || ""),
    };
  } catch {
    return null;
  }
}

export function qualityLabel(height, bandwidth) {
  const parts = [];
  if (height) parts.push(`${height}p`);
  if (bandwidth) parts.push(`${(bandwidth / 1e6).toFixed(1)} Mb/s`);
  return parts.join(" · ");
}
