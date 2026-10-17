// Service worker: watches tab network traffic and spots media.
// Detected media are stored per tab in chrome.storage.session (key "tab:<id>").

import { isExcluded, isIgnoredRequest } from "./lib/policy.js";
import { HELPER_HOST } from "./lib/config.js";
import { decodeEfg } from "./lib/util.js";

const HLS_PATH = /\.m3u8$/i;
const DASH_PATH = /\.mpd$/i;
const FILE_PATH = /\.(mp4|m4v|m4a|webm|mov|mp3|ogg|oga)$/i;
const SEGMENT_PATH = /\.(ts|m4s|aac|vtt|webvtt|key|cmfv|cmfa)$/i;
const MIN_FILE_SIZE = 256 * 1024; // smaller files are most likely segments or animated icons
const MAX_PER_TAB = 60;

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function totalSize(headers) {
  const m = header(headers, "content-range").match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, "content-length"));
  return Number.isFinite(len) && len > 0 ? len : null;
}

// Instagram / Facebook CDNs split a file into bytestart/byteend requests:
// dropping those parameters gives back the whole file.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("bytestart") || u.searchParams.has("byteend")) {
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      return { url: u.href, ranged: true };
    }
  } catch {}
  return { url, ranged: false };
}

function classify(d) {
  if (!/^https?:/i.test(d.url) || d.statusCode >= 400) return null;
  if (d.initiator?.startsWith("chrome-extension://")) return null;
  if (isIgnoredRequest(d.url) || (d.initiator && isExcluded(d.initiator)) || (d.documentUrl && isExcluded(d.documentUrl))) return null;

  const { url, ranged } = normalizeUrl(d.url);
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const ct = header(d.responseHeaders, "content-type").toLowerCase().split(";")[0].trim();

  if (HLS_PATH.test(path) || ct.includes("mpegurl")) return { kind: "hls", url };
  if (DASH_PATH.test(path) || ct === "application/dash+xml") return { kind: "dash", url };
  if (SEGMENT_PATH.test(path) || ct === "video/mp2t") return null;

  const isMediaType = ct.startsWith("video/") || ct.startsWith("audio/");
  if (FILE_PATH.test(path) || (isMediaType && (d.type === "media" || ranged))) {
    const size = totalSize(d.responseHeaders);
    if (!ranged && size !== null && size < MIN_FILE_SIZE) return null;
    const efg = decodeEfg(url);
    return { kind: "file", url, size, mime: ct || null, ranged, asset: efg?.asset ?? null, tag: efg?.tag || null };
  }
  return null;
}

// Write queue: prevents two concurrent updates from overwriting each other.
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

function addItems(tabId, items) {
  return editTab(tabId, (list) => {
    let changed = false;
    for (const it of items) {
      const existing = list.find((x) => x.url === it.url);
      if (existing) {
        if (it.size && !existing.size) {
          existing.size = it.size;
          changed = true;
        }
        continue;
      }
      list.push({ ...it, time: Date.now() });
      changed = true;
    }
    return changed ? list.slice(-MAX_PER_TAB) : null;
  });
}

async function setBadge(tabId, n) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d9480f" });
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  } catch {
    // the tab was closed in the meantime
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const item = classify(d);
    if (item) addItems(d.tabId, [item]);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// New page: start from scratch.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0) editTab(d.tabId, () => []);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove("tab:" + tabId));

// ---------- local helper jobs (yt-dlp) ----------
// They run here rather than in the panel: the native port keeps the service worker
// alive, and closing the panel does not stop a download.

const helperJobs = new Map(); // id -> { job, port }
let saveTimer = null;

function saveHelperJobs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const jobs = [...helperJobs.values()].map(({ job }) => job).slice(-20);
    chrome.storage.session.set({ "helper:jobs": jobs }).catch(() => {});
  }, 150);
}

function helperError(message) {
  if (/not found/i.test(message || "")) return "Module local non installé (voir l'aide)";
  if (/forbidden/i.test(message || "")) return "Le module refuse cette extension (identifiant inattendu)";
  return message || "Le module local s'est arrêté";
}

const STAGES = {
  download: "Téléchargement…",
  downloaded: "Téléchargé, finalisation…",
  merge: "Assemblage de la vidéo et du son…",
  mp3: "Conversion en MP3…",
  process: "Traitement…",
};

function startHelperJob({ url, mode, referer, title }) {
  const id = "h" + Date.now() + Math.random().toString(36).slice(2, 6);
  const job = { id, title: title || url, mode, url, status: "Démarrage du module…", progress: null, done: false, error: null, file: null };
  let port;
  try {
    port = chrome.runtime.connectNative(HELPER_HOST);
  } catch (e) {
    job.error = helperError(e.message);
    helperJobs.set(id, { job, port: null });
    saveHelperJobs();
    return id;
  }
  helperJobs.set(id, { job, port });
  port.onMessage.addListener((m) => {
    if (m.type === "progress") {
      const bytes = m.bytes ? ` ${(m.bytes / 1048576).toFixed(1)} MB` : "";
      job.status = (STAGES[m.stage] || "Traitement…") + (m.stage === "download" ? bytes : "");
      job.progress = typeof m.percent === "number" ? m.percent : null;
    } else if (m.type === "done") {
      job.done = true;
      job.progress = 1;
      job.file = m.file;
      job.status = "Enregistré : " + (m.file || "").split(/[\\/]/).pop();
      port.disconnect();
    } else if (m.type === "error") {
      job.error = m.message;
      port.disconnect();
    } else if (m.type === "log" && m.level === "warning") {
      job.warning = m.message;
    }
    saveHelperJobs();
  });
  port.onDisconnect.addListener(() => {
    if (!job.done && !job.error) job.error = helperError(chrome.runtime.lastError?.message);
    saveHelperJobs();
  });
  port.postMessage({ cmd: "download", url, mode, referer, title });
  saveHelperJobs();
  return id;
}

// Messages from the side panel
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "add-items" && Number.isInteger(msg.tabId)) {
    const items = (msg.items || []).filter((it) => it && it.url && !isExcluded(it.url));
    addItems(msg.tabId, items).then(() => reply({ added: items.length }));
    return true;
  }
  if (msg?.type === "helper-start") {
    reply({ id: startHelperJob(msg) });
    return;
  }
  if (msg?.type === "helper-cancel") {
    const entry = helperJobs.get(msg.id);
    if (entry && !entry.job.done && !entry.job.error) {
      entry.job.error = "téléchargement annulé";
      entry.port?.disconnect();
      saveHelperJobs();
    }
    reply({ ok: true });
    return;
  }
  if (msg?.type === "clear-tab" && Number.isInteger(msg.tabId)) {
    editTab(msg.tabId, () => []).then(() => reply({ ok: true }));
    return true;
  }
});

// Clicking the toolbar icon opens the side panel.
const openPanelOnClick = () =>
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.warn(e));
chrome.runtime.onInstalled.addListener(openPanelOnClick);
chrome.runtime.onStartup.addListener(openPanelOnClick);
