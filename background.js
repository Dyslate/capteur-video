// Service worker: watches tab network traffic and spots media.
// Detected media are stored per tab in chrome.storage.session (key "tab:<id>").

import { isExcluded, isIgnoredRequest } from "./lib/policy.js";
import { HELPER_HOST } from "./lib/config.js";
import { decodeEfg } from "./lib/util.js";
import { createLogger } from "./lib/log.js";

const log = createLogger("bg");
const net = log.scope("detect");
const hlog = log.scope("helper");

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

// Returns { item } for a usable media, { reason } when the request is skipped,
// or null when it is clearly not media (not worth logging).
function classify(d) {
  if (!/^https?:/i.test(d.url)) return null;
  if (d.initiator?.startsWith("chrome-extension://")) return null; // our own downloads

  const { url, ranged } = normalizeUrl(d.url);
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const ct = header(d.responseHeaders, "content-type").toLowerCase().split(";")[0].trim();
  const isMediaType = ct.startsWith("video/") || ct.startsWith("audio/") || ct.includes("mpegurl") || ct === "application/dash+xml";
  const looksLikeMedia = isMediaType || d.type === "media" || HLS_PATH.test(path) || DASH_PATH.test(path) || FILE_PATH.test(path) || SEGMENT_PATH.test(path);
  if (!looksLikeMedia) return null;

  if (d.statusCode >= 400) return { reason: "HTTP " + d.statusCode };
  if (isIgnoredRequest(d.url)) return { reason: "domaine ignoré ou exclu" };
  if ((d.initiator && isExcluded(d.initiator)) || (d.documentUrl && isExcluded(d.documentUrl))) return { reason: "page exclue" };

  if (HLS_PATH.test(path) || ct.includes("mpegurl")) return { item: { kind: "hls", url } };
  if (DASH_PATH.test(path) || ct === "application/dash+xml") return { item: { kind: "dash", url } };
  if (SEGMENT_PATH.test(path) || ct === "video/mp2t") return { reason: "segment (le manifeste suffit)", quiet: true };

  if (FILE_PATH.test(path) || (isMediaType && (d.type === "media" || ranged))) {
    const size = totalSize(d.responseHeaders);
    // The size floor filters segments and animated icons fetched by scripts. A source loaded
    // by a <video>/<audio> element ("media") is what the user is watching: keep it whatever its size.
    if (!ranged && d.type !== "media" && size !== null && size < MIN_FILE_SIZE) return { reason: `trop petit (${size} o)` };
    const efg = decodeEfg(url);
    return { item: { kind: "file", url, size, mime: ct || null, ranged, asset: efg?.asset ?? null, tag: efg?.tag || null } };
  }
  return { reason: `type non géré (${ct || "sans content-type"}, ${d.type})` };
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
    .catch((e) => log.error("échec de mise à jour de la liste", { tabId, error: e }));
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
      net.info(`ajouté (${it.kind}) onglet ${tabId}`, { url: it.url, size: it.size ?? null, from: it.from || "réseau", asset: it.asset ?? null, tag: it.tag ?? null });
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
    const res = classify(d);
    if (!res) return;
    if (res.item) addItems(d.tabId, [res.item]);
    else if (!res.quiet) net.debug("ignoré : " + res.reason, { url: d.url, type: d.type, status: d.statusCode });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// New page: start from scratch.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    net.info(`nouvelle page dans l'onglet ${d.tabId} : liste vidée`, { url: d.url });
    editTab(d.tabId, () => []);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// In-page navigation (Instagram, Facebook… switch reels with history.pushState):
// the URL changes without a new main_frame request, so clear the list here too.
// The hash is ignored: it often changes without loading anything new.
const lastUrl = new Map(); // tabId -> URL without hash
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  const url = info.url.split("#")[0];
  const previous = lastUrl.get(tabId);
  lastUrl.set(tabId, url);
  if (previous && previous !== url) {
    net.info(`navigation interne dans l'onglet ${tabId} : liste vidée`, { from: previous, to: url });
    editTab(tabId, (list) => (list.length ? [] : null));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastUrl.delete(tabId);
  chrome.storage.session.remove("tab:" + tabId);
});

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
  audio: "Conversion audio…",
  remux: "Mise au format…",
  process: "Traitement…",
};

function startHelperJob({ url, mode, format, referer, title, quality, abr }) {
  const id = "h" + Date.now() + Math.random().toString(36).slice(2, 6);
  const job = { id, title: title || url, mode, format, quality, abr, url, status: "Démarrage du module…", progress: null, done: false, error: null, file: null };
  hlog.info(`tâche ${id} : démarrage`, { url, format, quality, abr, mode });
  let port;
  try {
    port = chrome.runtime.connectNative(HELPER_HOST);
  } catch (e) {
    hlog.error(`tâche ${id} : connexion au module impossible`, e);
    job.error = helperError(e.message);
    helperJobs.set(id, { job, port: null });
    saveHelperJobs();
    return id;
  }
  helperJobs.set(id, { job, port });
  let lastLogged = -1;
  port.onMessage.addListener((m) => {
    if (m.type !== "progress") hlog.info(`tâche ${id} : ${m.type}`, m);
    else if (m.stage !== "download" || Math.floor((m.percent || 0) * 4) !== lastLogged) {
      lastLogged = Math.floor((m.percent || 0) * 4); // every 25 % is enough for the log
      hlog.debug(`tâche ${id} : ${m.stage} ${m.percent == null ? "" : Math.round(m.percent * 100) + " %"}`, { bytes: m.bytes, speed: m.speed });
    }
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
    const reason = chrome.runtime.lastError?.message;
    if (!job.done && !job.error) {
      job.error = helperError(reason);
      hlog.error(`tâche ${id} : module déconnecté avant la fin`, { reason });
    } else {
      hlog.debug(`tâche ${id} : connexion fermée`, { reason: reason || null });
    }
    saveHelperJobs();
  });
  port.postMessage({ cmd: "download", url, mode, format, referer, title, quality, abr });
  saveHelperJobs();
  return id;
}

// Messages from the side panel
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "add-items" && Number.isInteger(msg.tabId)) {
    net.info(`« Forcer la détection » : ${(msg.items || []).length} élément(s) reçus de la page`, (msg.items || []).map((i) => ({ kind: i.kind, url: i.url, from: i.from })));
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
      hlog.warn(`tâche ${msg.id} : annulée par l'utilisateur`);
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
chrome.runtime.onInstalled.addListener((details) => {
  log.info("extension installée / mise à jour", { reason: details.reason, version: chrome.runtime.getManifest().version });
  openPanelOnClick();
});
log.debug("service worker démarré", { version: chrome.runtime.getManifest().version });
chrome.runtime.onStartup.addListener(openPanelOnClick);
