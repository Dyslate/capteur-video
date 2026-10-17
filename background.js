// Service worker : observe le trafic réseau des onglets et repère les flux vidéo.
// Les flux trouvés sont rangés par onglet dans chrome.storage.session.

const HLS_PATH = /\.m3u8$/i;
const VIDEO_PATH = /\.(mp4|webm|mov|m4v)$/i;
const SEGMENT_PATH = /\.(ts|m4s|aac|vtt|webvtt|key)$/i;
const MIN_VIDEO_SIZE = 512 * 1024; // en dessous, c'est probablement un segment
const MAX_PER_TAB = 50;

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

// Taille totale du fichier, même pour une requête partielle (Range).
function totalSize(headers) {
  const m = header(headers, "content-range").match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, "content-length"));
  return Number.isFinite(len) && len > 0 ? len : null;
}

function classify(d) {
  if (!/^https?:/i.test(d.url)) return null;
  if (d.statusCode >= 400) return null;
  if (d.initiator?.startsWith("chrome-extension://")) return null;

  let path;
  try {
    path = new URL(d.url).pathname;
  } catch {
    return null;
  }
  const ct = header(d.responseHeaders, "content-type").toLowerCase();

  if (HLS_PATH.test(path) || ct.includes("mpegurl")) return { kind: "hls" };
  if (SEGMENT_PATH.test(path) || ct.includes("mp2t")) return null;

  if (VIDEO_PATH.test(path) || (d.type === "media" && ct.startsWith("video/"))) {
    const size = totalSize(d.responseHeaders);
    if (size !== null && size < MIN_VIDEO_SIZE) return null;
    return { kind: "video", size, mime: ct || null };
  }
  return null;
}

// File d'attente pour éviter que deux requêtes simultanées s'écrasent.
let queue = Promise.resolve();
function editTab(tabId, fn) {
  queue = queue
    .then(async () => {
      const key = "tab:" + tabId;
      const list = (await chrome.storage.session.get(key))[key] || [];
      const next = fn(list);
      if (!next) return;
      await chrome.storage.session.set({ [key]: next });
      await setBadge(tabId, next.length);
    })
    .catch((e) => console.warn(e));
  return queue;
}

async function setBadge(tabId, n) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d9480f" });
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  } catch {
    // l'onglet a pu être fermé entre-temps
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const info = classify(d);
    if (!info) return;
    editTab(d.tabId, (list) => {
      if (list.some((x) => x.url === d.url)) return null;
      list.push({ url: d.url, ...info, time: Date.now() });
      return list.slice(-MAX_PER_TAB);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Nouvelle page dans l'onglet : on repart de zéro.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    editTab(d.tabId, () => []);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("tab:" + tabId);
});
