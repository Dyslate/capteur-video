// Diagnostic log shared by the service worker and the extension pages.
// Each writer keeps its own ring buffer in chrome.storage.session ("log:<key>"), so
// concurrent writers never overwrite each other: the service worker uses "bg", and every
// page instance (a side panel per window, the help page…) gets its own "<context>#<id>" key.
// log.html merges them all by time.

const MAX_ENTRIES = 1500;
const MAX_PAGE_KEYS = 8; // older page-instance logs are dropped beyond this
const MAX_TEXT = 1200;
const buffers = new Map(); // context -> { entries, loaded, timer }

function clip(value) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + "…" : value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: clip(value.stack || "") };
  if (Array.isArray(value)) return value.slice(0, 30).map(clip);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = clip(v);
    return out;
  }
  return value;
}

// Drops the oldest page-instance logs so session storage stays small.
async function pruneOldKeys() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all)
    .filter((k) => k.startsWith("log:") && k.includes("#"))
    .map((k) => ({ k, last: (all[k] || []).at(-1)?.t || 0 }))
    .sort((a, b) => b.last - a.last);
  const stale = keys.slice(MAX_PAGE_KEYS).map((x) => x.k);
  if (stale.length) await chrome.storage.session.remove(stale);
}

function bufferFor(context) {
  if (!buffers.has(context)) {
    const b = { entries: [], loaded: false, timer: null };
    buffers.set(context, b);
    // Keep what an earlier instance of this context wrote (the service worker restarts often).
    chrome.storage.session
      .get("log:" + context)
      .then((r) => {
        b.entries = [...(r["log:" + context] || []), ...b.entries].slice(-MAX_ENTRIES);
        b.loaded = true;
      })
      .catch(() => (b.loaded = true));
  }
  return buffers.get(context);
}

function flush(context) {
  const b = bufferFor(context);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    if (!b.loaded) return flush(context);
    chrome.storage.session.set({ ["log:" + context]: b.entries.slice(-MAX_ENTRIES) }).catch(() => {});
  }, 250);
}

// createLogger("panel") -> { debug, info, warn, error, scope }
// Pages get a per-instance key; the service worker ("bg") is a single instance.
const instanceKeys = new Map();
function storageKey(context) {
  if (context === "bg") return "bg";
  if (!instanceKeys.has(context)) {
    instanceKeys.set(context, context + "#" + Math.random().toString(36).slice(2, 7));
    pruneOldKeys().catch(() => {});
  }
  return instanceKeys.get(context);
}

export function createLogger(context) {
  const key = storageKey(context);
  const write = (level, scope, message, data) => {
    const entry = { t: Date.now(), level, context, scope, message: clip(String(message)) };
    if (data !== undefined) entry.data = clip(data);
    const b = bufferFor(key);
    b.entries.push(entry);
    if (b.entries.length > MAX_ENTRIES * 1.2) b.entries = b.entries.slice(-MAX_ENTRIES);
    flush(key);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.info;
    fn(`[${context}:${scope}] ${message}`, data === undefined ? "" : data);
  };
  const scoped = (scope) => ({
    debug: (m, d) => write("debug", scope, m, d),
    info: (m, d) => write("info", scope, m, d),
    warn: (m, d) => write("warn", scope, m, d),
    error: (m, d) => write("error", scope, m, d),
    scope: (sub) => scoped(scope === "main" ? sub : scope + "/" + sub),
  });
  return scoped("main");
}

// All entries from every context, oldest first.
export async function readLog() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("log:"))
    .flatMap(([, v]) => v || [])
    .sort((a, b) => a.t - b.t);
}

export async function clearLog() {
  const all = await chrome.storage.session.get(null);
  for (const b of buffers.values()) b.entries = [];
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith("log:")));
}

export function formatEntry(e) {
  const d = new Date(e.t);
  const time = d.toLocaleTimeString("fr-FR", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  const data = e.data === undefined ? "" : " " + JSON.stringify(e.data);
  return `${time} ${e.level.toUpperCase().padEnd(5)} [${e.context}:${e.scope}] ${e.message}${data}`;
}
