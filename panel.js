// Side panel: lists the active tab's media and runs downloads (MP4 / MP3).

import { parseHls } from "./lib/hls.js";
import { parseMpd } from "./lib/dash.js";
import { probe, mux, sniff } from "./lib/mp4.js";
import { decodeAudio, encodeMp3 } from "./lib/mp3.js";
import { encodeWav } from "./lib/wav.js";
import { FORMATS, formatById, engineFor, qualitiesFor } from "./lib/formats.js";
import { fetchText, fetchHead, fetchSegments, withReferer } from "./lib/fetcher.js";
import { scanPage } from "./lib/scan.js";
import { excludedService, helperOnly, isDrmService, isGatedStream } from "./lib/policy.js";
import { pingHelper, startHelperJob, cancelHelperJob, revealFile } from "./lib/helper.js";
import { BUILD } from "./lib/config.js";
import { progressFromItem, isUserCancel, decoyNote } from "./lib/downloads.js";
import * as U from "./lib/util.js";
import { createLogger } from "./lib/log.js";

const log = createLogger("panel");
const ulog = log.scope("ui");
const alog = log.scope("analyse");

const $ = (id) => document.getElementById(id);
const state = {
  tab: null,
  medias: [],
  jobs: [],
  cache: new Map(), // url -> analysis result (playlist, manifest, probe)
  refreshToken: 0,
};

// ---------- small DOM helpers ----------

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").textContent = ""), 3500);
}

function showState(title, hint, { waiting = true } = {}) {
  $("state").hidden = false;
  $("state").classList.toggle("static", !waiting);
  $("state-title").textContent = title;
  $("state-hint").textContent = hint || "";
}

// ---------- active tab ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// ---------- page thumbnail (dynamic preview) ----------

// Injected into the page: a frame of the playing video, or its poster / og:image.
// Capturing a frame of a cross-origin video taints the canvas and throws, so we fall back.
function capturePoster() {
  for (const v of document.querySelectorAll("video")) {
    if (v.videoWidth && v.readyState >= 2) {
      try {
        const w = 192;
        const h = Math.max(1, Math.round((v.videoHeight * w) / v.videoWidth));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(v, 0, 0, w, h);
        return c.toDataURL("image/jpeg", 0.6);
      } catch {}
    }
  }
  for (const v of document.querySelectorAll("video")) if (v.poster) return v.poster;
  const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
  if (og) return og;
  // Last resort: the largest visible image on the page (often the poster / cover art).
  let best = null;
  let bestArea = 40 * 40; // ignore icons
  for (const img of document.querySelectorAll("img")) {
    const area = (img.naturalWidth || img.width) * (img.naturalHeight || img.height);
    if (area > bestArea && /^https?:/i.test(img.currentSrc || img.src || "")) {
      bestArea = area;
      best = img.currentSrc || img.src;
    }
  }
  return best;
}

async function grabPageThumb(tab) {
  if (!tab || !/^https?:/i.test(tab.url || "")) return null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: capturePoster });
    return results.map((r) => r.result).find(Boolean) || null;
  } catch {
    return null; // some pages can't be scripted (store pages, blocked frames)
  }
}

// Refreshes the thumbnails in place every few seconds, so the preview follows the video.
function startThumbnailLoop() {
  setInterval(async () => {
    if (document.hidden || !document.querySelector("img.thumb")) return;
    const thumb = await grabPageThumb(state.tab);
    if (!thumb) return;
    state.pageThumb = thumb;
    for (const img of document.querySelectorAll("img.thumb")) img.src = thumb;
  }, 3000);
}

let refreshTimer;
function scheduleRefresh(delay = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

async function refresh() {
  const token = ++state.refreshToken;
  const tab = await activeTab();
  if (token !== state.refreshToken) return;
  state.tab = tab;

  const url = tab?.url || "";
  $("page-title").textContent = tab ? U.cleanTitle(tab.title) : "Capteur vidéo";
  $("page-host").textContent = U.hostOf(url);

  const isWeb = /^https?:/i.test(url);
  const service = isWeb ? excludedService(url) : null;
  $("scan").disabled = !isWeb || !!service;
  $("clear").disabled = !isWeb;

  if (!isWeb) {
    renderMedias([]);
    return showState("Open a web page", "The panel detects the videos on the pages you visit.", { waiting: false });
  }
  if (service) {
    renderMedias([]);
    return showState(
      `${service} is not supported`,
      isDrmService(url)
        ? "Its videos are DRM-protected: no tool can legally download them."
        : "This site is excluded from the Chrome Web Store version.",
      { waiting: false }
    );
  }

  // The store build has no local helper at all.
  const useHelper = BUILD !== "store";
  const onlyHelper = useHelper && helperOnly(url);
  const key = "tab:" + tab.id;
  const items = onlyHelper ? [] : (await chrome.storage.session.get(key))[key] || [];
  const [medias, helper] = await Promise.all([buildMedias(items), useHelper ? pingHelper() : null]);
  if (token !== state.refreshToken) return;
  state.helper = helper;
  state.pageThumb = (medias.length || onlyHelper) ? await grabPageThumb(tab) : null;
  if (token !== state.refreshToken) return;
  ulog.info(`tab analysed: ${items.length} raw item(s) → ${medias.length} card(s)`, {
    url,
    title: tab.title,
    helper: helper ? (helper.ok ? { ytdlp: helper.ytdlp, ffmpeg: helper.ffmpeg, js: helper.jsRuntime } : { error: helper.error }) : "disabled",
    medias: medias.map((m) => ({ kind: m.kind, title: m.title, variants: m.variants?.length || 0, protected: !!m.protected })),
  });
  renderMedias(medias, { pageCard: useHelper ? pageCard(tab, helper, onlyHelper) : null, pageCardFirst: onlyHelper });
  if (!medias.length && !onlyHelper) {
    showState(
      "Waiting for media…",
      "Play the video with the sound on, then come back here. Otherwise, try “Force detection”" + (useHelper ? " or the yt-dlp helper below." : ".")
    );
  } else {
    $("state").hidden = true;
  }
}

// Card that sends the whole page to the local yt-dlp helper.
function pageCard(tab, helper, onlyHelper) {
  const title = onlyHelper ? "This YouTube video" : "Whole page with yt-dlp";
  const sub = onlyHelper ? "Through the local yt-dlp helper" : "Fallback: works on thousands of sites";
  if (!helper?.ok) {
    return el(
      "article",
      { class: "card helper" },
      el("div", { class: "card-head" }, el("strong", {}, title), el("span", { class: "badge" }, "Helper")),
      el("div", { class: "sub" }, sub),
      el("p", { class: "note" }, `${helper?.error || "Local helper not installed"}. It is a one-time, two-minute install.`),
      el("div", { class: "row" },
        el("button", { class: onlyHelper ? "" : "ghost", onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL("help.html") }) }, "Install the helper"),
        el("button", { class: "ghost", onclick: async () => { await pingHelper({ force: true }); scheduleRefresh(0); } }, "Check again"))
    );
  }
  const warnings = [];
  if (onlyHelper && !helper.jsRuntime) warnings.push("YouTube needs Deno: see the help page to install it.");
  if (!helper.ffmpeg) warnings.push("ffmpeg not found: conversions and audio/video merging are unavailable.");
  const media = { pageOnly: true, key: tab.url };
  return el(
    "article",
    { class: "card helper" },
    el("div", { class: "card-head" }, el("strong", {}, title), el("span", { class: "badge" }, "yt-dlp " + (helper.ytdlp || "?"))),
    el("div", { class: "sub" }, sub),
    optionsRow(media, { primary: onlyHelper }),
    ...warnings.map((w) => el("p", { class: "note" }, w))
  );
}

// ---------- format and quality pickers ----------

function remembered(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback; // storage can be unavailable (private window, blocked site data)
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

// Video quality choices for a media: browser variants (index) or helper heights.
function videoChoices(media, engine) {
  if (media.pageOnly) return [];
  const variants = media.variants || [];
  if (engine === "helper") {
    const heights = [...new Set(variants.map((v) => v.height).filter(Boolean))];
    return heights.length > 1 ? heights.map((h) => ({ value: String(h), label: `${h}p` })) : [];
  }
  return variants.length > 1 ? variants.map((v, i) => ({ value: String(i), label: v.label || `Quality ${i + 1}` })) : [];
}

// Format + quality selects and a download button, shared by every card.
// getName: returns the file name the user chose (rename field), optional.
function optionsRow(media, { primary = true, getName = null } = {}) {
  const helperOk = BUILD !== "store" && !!state.helper?.ok;
  const options = FORMATS.map((f) => ({ f, engine: engineFor(f, media, helperOk) }))
    // Module-only formats are listed (disabled) when the module is missing, so people know they exist.
    .filter(({ f, engine }) => engine || (BUILD !== "store" && f.engine === "helper" && !media.pageOnly && !(media.audioOnly && f.group === "video")));
  const usable = options.filter((o) => o.engine);
  if (!usable.length) return el("p", { class: "note" }, "No format available for this media.");

  const group = (name, label) => {
    const items = options.filter((o) => o.f.group === name);
    if (!items.length) return null;
    return el("optgroup", { label }, items.map(({ f, engine }) =>
      el("option", { value: f.id, disabled: !engine }, f.label + (engine === "helper" && f.engine !== "helper" ? " · helper" : "") + (!engine ? " (helper required)" : ""))));
  };
  const format = el("select", { "aria-label": "Format", class: "format" }, group("video", "Video"), group("audio", "Audio"));
  const saved = remembered("format");
  format.value = usable.some((o) => o.f.id === saved) ? saved : usable[0].f.id;

  const quality = el("select", { "aria-label": "Quality", class: "quality" });
  const engineOf = () => usable.find((o) => o.f.id === format.value)?.engine;
  const fill = () => {
    const engine = engineOf();
    const qs = qualitiesFor(format.value, engine, videoChoices(media, engine));
    quality.replaceChildren(...qs.map((q) => el("option", { value: q.value }, q.label)));
    quality.hidden = !qs.length;
    const savedQ = remembered("quality:" + format.value + ":" + engine);
    if (qs.some((q) => q.value === savedQ)) quality.value = savedQ;
  };
  format.addEventListener("change", () => {
    remember("format", format.value);
    fill();
  });
  quality.addEventListener("change", () => remember("quality:" + format.value + ":" + engineOf(), quality.value));
  fill();

  const go = el("button", {
    class: primary ? "" : "ghost",
    onclick: () => download(media, { format: format.value, engine: engineOf(), quality: quality.hidden ? "" : quality.value, name: getName ? getName() : null }),
  }, "Download");
  return el("div", { class: "row options" }, format, quality, go);
}

// URL to hand to yt-dlp for a media: the stream itself when yt-dlp can read it,
// otherwise the page (split tracks, manifests embedded in the page).
function helperUrlFor(media) {
  if (media.pageOnly) return media.key;
  if (media.kind === "hls" || media.kind === "dash") return media.key;
  const v = media.variants?.[0];
  if (media.kind === "file" && !(v?.video && v?.audio)) return media.key;
  return state.tab?.url;
}

function download(media, { format, engine, quality, name }) {
  const f = formatById(format);
  if (!f || !engine) return toast("Format unavailable");
  const chosen = U.safeName(name || U.cleanTitle(state.tab?.title));
  if (engine === "helper") {
    const isVideo = f.group === "video";
    startHelperJob({
      url: helperUrlFor(media),
      format,
      mode: isVideo ? "video" : "audio",
      quality: isVideo && quality ? Number(quality) : null,
      abr: !isVideo && quality ? Number(quality) : null,
      referer: state.tab?.url,
      title: chosen,
      advertisedSeconds: media.seconds || 0,
    });
    return toast("Download handed to the helper");
  }
  const variant = f.group === "video" && quality !== "" ? media.variants[Number(quality)] || media.variants[0] : media.variants[0];
  startJob(media, variant, { format, kbps: f.bitrates ? Number(quality) || f.defaultBitrate : null, name: chosen });
}

// ---------- analysis of detected items ----------

async function cached(key, fn) {
  if (!state.cache.has(key)) state.cache.set(key, fn().catch((e) => ({ error: e })));
  return state.cache.get(key);
}

const stripQuery = (u) => u.split(/[?#]/)[0];

// Reads an HLS media playlist for its duration and, when every segment has a byte range, its exact size.
async function hlsMediaInfo(url) {
  return cached("hlsinfo:" + url, async () => {
    const pl = parseHls(await fetchText(url), url);
    if (pl.type !== "media") return { duration: 0, bytes: null };
    return { duration: pl.duration, bytes: hlsExactBytes(pl.segments) };
  });
}

// Sum of byte-range lengths when they cover every segment, else null (we don't know without downloading).
function hlsExactBytes(segments) {
  const ranged = segments.filter((s) => s.range);
  return ranged.length && ranged.length === segments.length ? ranged.reduce((n, s) => n + s.range.length, 0) : null;
}

async function buildMedias(items) {
  const medias = [];
  const hlsItems = items.filter((i) => i.kind === "hls");
  const dashItems = items.filter((i) => i.kind === "dash" || i.kind === "dash-inline");
  const files = items.filter((i) => i.kind === "file");

  // HLS
  const parsedHls = await Promise.all(
    hlsItems.map(async (it) => ({ it, res: await cached("hls:" + it.url, async () => ({ pl: parseHls(await fetchText(it.url), it.url) })) }))
  );
  const referenced = new Set();
  for (const { res } of parsedHls) {
    if (res.pl?.type !== "master") continue;
    for (const x of [...res.pl.variants, ...res.pl.audio]) referenced.add(stripQuery(x.url));
  }
  for (const { it, res } of parsedHls) {
    if (res.error) {
      alog.warn("playlist HLS illisible", { url: it.url, error: res.error });
      continue;
    }
    const pl = res.pl;
    alog.info(`HLS ${pl.type === "master" ? "master" : "media"} playlist`, pl.type === "master"
      ? { url: it.url, variants: pl.variants.map((v) => `${v.height || "?"}p ${v.bandwidth}`), audio: pl.audio.length, encrypted: pl.encrypted }
      : { url: it.url, segments: pl.segments.length, duration: pl.duration, live: pl.live, encrypted: pl.encrypted });
    if (pl.type === "media" && referenced.has(stripQuery(it.url))) {
      alog.debug("sub-playlist hidden (already listed by a master playlist)", { url: it.url });
      continue;
    }
    if (pl.encrypted) {
      medias.push({ key: it.url, kind: "hls", title: "Protected stream", host: U.hostOf(it.url), protected: true, variants: [] });
      continue;
    }
    if (pl.type === "master") {
      // One extra request on the top variant gives the duration (and, with the bitrate, a size estimate).
      const top = pl.variants[0];
      const info = top ? await hlsMediaInfo(top.url) : null;
      const duration = info && !info.error ? info.duration : 0;
      const variants = pl.variants.map((v) => {
        const audio = v.audioGroup ? pl.audio.find((a) => a.group === v.audioGroup && a.isDefault) || pl.audio.find((a) => a.group === v.audioGroup) : null;
        const est = U.estimateBytes(v.bandwidth, duration);
        const label = [U.qualityLabel(v.height, v.bandwidth), est ? "~" + U.formatBytes(est) : ""].filter(Boolean).join(" · ") || "Default quality";
        return { height: v.height, label, video: { type: "hls", url: v.url }, audio: audio ? { type: "hls", url: audio.url } : null };
      });
      const bestEst = top ? U.estimateBytes(top.bandwidth, duration) : null;
      const gated = isGatedStream(it.url);
      const meta = [duration ? (gated ? "advertised " : "") + U.formatDuration(duration) : "", bestEst ? "~" + U.formatBytes(bestEst) : ""].filter(Boolean).join(" · ");
      medias.push({ key: it.url, kind: "hls", title: "HLS stream", host: U.hostOf(it.url), meta, seconds: duration, gated, variants });
    } else {
      const bytes = hlsExactBytes(pl.segments);
      medias.push({
        key: it.url,
        kind: "hls",
        title: pl.live ? "Live HLS stream" : "HLS stream",
        meta: pl.live ? "live" : [U.formatDuration(pl.duration), bytes ? U.formatBytes(bytes) : ""].filter(Boolean).join(" · "),
        host: U.hostOf(it.url),
        seconds: pl.live ? 0 : pl.duration,
        variants: [{ label: "Single quality", video: { type: "segments", segments: pl.segments }, audio: null }],
      });
    }
  }

  // DASH
  for (const it of dashItems) {
    const res = await cached("dash:" + it.url, async () => {
      const text = it.mpd || (await fetchText(it.url));
      return { mpd: parseMpd(text, it.base || it.url) };
    });
    if (res.error) {
      alog.warn("manifeste DASH illisible", { url: it.url, inline: !!it.mpd, error: res.error });
      continue;
    }
    const mpd = res.mpd;
    alog.info("DASH manifest parsed", {
      url: it.url, inline: !!it.mpd, encrypted: mpd.encrypted, live: mpd.live, duration: mpd.duration,
      video: mpd.video.map((v) => `${v.height}p ${v.bandwidth} (${v.segments.length} seg.)`),
      audio: mpd.audio.map((a) => `${a.bandwidth} (${a.segments.length} seg.)`),
    });
    const host = U.hostOf(it.base || it.url);
    if (mpd.encrypted) {
      medias.push({ key: it.url, kind: "dash", title: "Protected stream", host, protected: true, variants: [] });
      continue;
    }
    const bestAudio = mpd.audio[0] ? { type: "segments", segments: mpd.audio[0].segments } : null;
    const seen = new Set();
    const variants = [];
    for (const v of mpd.video) {
      if (seen.has(v.height)) continue;
      seen.add(v.height);
      const est = U.estimateBytes(v.bandwidth + (mpd.audio[0]?.bandwidth || 0), mpd.duration);
      const label = [U.qualityLabel(v.height, v.bandwidth), est ? "~" + U.formatBytes(est) : ""].filter(Boolean).join(" · ") || "Video";
      variants.push({ height: v.height, label, video: { type: "segments", segments: v.segments }, audio: bestAudio });
    }
    if (!variants.length && bestAudio) variants.push({ label: "Audio", video: null, audio: bestAudio });
    if (!variants.length) continue;
    medias.push({
      key: it.url,
      kind: "dash",
      title: it.kind === "dash-inline" ? "Video from the page" : "DASH stream",
      meta: mpd.live ? "live" : mpd.duration ? U.formatDuration(mpd.duration) : "",
      host,
      seconds: mpd.live ? 0 : mpd.duration,
      variants,
      audioOnly: !mpd.video.length,
    });
  }

  medias.push(...(await mediasFromFiles(files)));
  return medias;
}

// Probes an MP4 file to find out whether it holds video, audio, or both.
async function probeFile(url) {
  // Probe requests carry the page's Referer too, like the downloads themselves.
  return cached("probe:" + url, () =>
    withReferer(state.tab?.url || "", [url], async () => {
      let head = await fetchHead(url, 256 * 1024);
      if (sniff(head) !== "mp4") {
        alog.info("sonde : pas un MP4", { url, container: sniff(head), bytes: head.length });
        return { ok: false, container: sniff(head) };
      }
      let p = probe(head);
      if (!p.ok && p.needed && p.needed <= 8 * 1024 * 1024 && head.length >= 256 * 1024) {
        head = await fetchHead(url, p.needed);
        p = probe(head);
      }
      alog.info("sonde MP4", { url, ok: p.ok, video: p.hasVideo, audio: p.hasAudio, height: p.height, seconds: p.seconds, fragmented: p.fragmented, needed: p.needed ?? null });
      return { ...p, container: "mp4" };
    })
  );
}

async function mediasFromFiles(files) {
  const probed = await Promise.all(files.map(async (f) => ({ f, p: await probeFile(f.url) })));
  const videoOnly = [];
  const audioOnly = [];
  const medias = [];

  for (const { f, p } of probed) {
    const ext = U.hostOf(f.url) && (f.url.split(/[?#]/)[0].match(/\.(\w{2,4})$/)?.[1] || "").toLowerCase();
    if (p.error || !p.ok || (p.hasVideo && p.hasAudio)) {
      // Complete file (or a format we cannot inspect): direct download
      const isAudio = !p.hasVideo && (p.hasAudio || /^audio\//.test(f.mime || "") || ["mp3", "m4a", "ogg", "oga"].includes(ext));
      medias.push({
        key: f.url,
        kind: "file",
        title: isAudio ? "Audio" : "Video",
        meta: [p.height ? `${p.height}p` : "", p.seconds ? U.formatDuration(p.seconds) : "", U.formatBytes(f.size)].filter(Boolean).join(" · "),
        host: U.hostOf(f.url),
        audioOnly: isAudio,
        variants: [{ label: "", video: isAudio ? null : { type: "file", url: f.url, size: f.size, direct: true, ext: p.container === "mp4" ? "mp4" : ext || p.container || "mp4" }, audio: isAudio ? { type: "file", url: f.url, size: f.size, ext } : null }],
      });
    } else if (p.hasVideo) {
      videoOnly.push({ f, p });
    } else if (p.hasAudio) {
      audioOnly.push({ f, p });
    }
  }

  // Separate tracks (Instagram, Facebook…): group them by asset id,
  // otherwise by how close in time they were requested.
  const groups = new Map();
  for (const v of videoOnly) {
    const key = v.f.asset ? "asset:" + v.f.asset : "time:" + v.f.time;
    if (!groups.has(key)) groups.set(key, { videos: [], audio: null, time: v.f.time, asset: v.f.asset });
    groups.get(key).videos.push(v);
  }
  const usedAudio = new Set();
  for (const g of groups.values()) {
    let a = g.asset ? audioOnly.find((x) => x.f.asset === g.asset) : null;
    if (!a) {
      a = audioOnly
        .filter((x) => !usedAudio.has(x) && !x.f.asset)
        .sort((x, y) => Math.abs(x.f.time - g.time) - Math.abs(y.f.time - g.time))
        .find((x) => Math.abs(x.f.time - g.time) < 15000);
    }
    if (a) usedAudio.add(a);
    alog.info(a ? "tracks paired" : "video without a matching audio track", {
      by: a ? (g.asset && a.f.asset === g.asset ? "asset id (efg)" : "time proximity") : null,
      asset: g.asset ?? null,
      videos: g.videos.map((v) => v.f.url),
      audio: a?.f.url || null,
      gapMs: a ? Math.abs(a.f.time - g.time) : null,
    });
    g.audio = a;
  }
  for (const g of groups.values()) {
    const vids = g.videos.sort((x, y) => y.p.height - x.p.height);
    const seconds = Math.max(...vids.map((v) => v.p.seconds || 0), g.audio?.p.seconds || 0);
    const audio = g.audio ? { type: "file", url: g.audio.f.url, size: g.audio.f.size } : null;
    medias.push({
      key: vids[0].f.url,
      kind: "file",
      title: "Video",
      meta: [seconds ? U.formatDuration(seconds) : ""].filter(Boolean).join(" · "),
      host: U.hostOf(vids[0].f.url),
      noAudio: !audio,
      variants: vids.map((v) => ({
        height: v.p.height,
        label: [v.p.height ? `${v.p.height}p` : "", U.formatBytes(v.f.size)].filter(Boolean).join(" · ") || "Video",
        video: { type: "file", url: v.f.url, size: v.f.size },
        audio,
      })),
    });
  }
  for (const a of audioOnly) {
    if (usedAudio.has(a)) continue;
    medias.push({
      key: a.f.url,
      kind: "file",
      title: "Audio only",
      meta: [a.p.seconds ? U.formatDuration(a.p.seconds) : "", U.formatBytes(a.f.size)].filter(Boolean).join(" · "),
      host: U.hostOf(a.f.url),
      audioOnly: true,
      variants: [{ label: "", video: null, audio: { type: "file", url: a.f.url, size: a.f.size, ext: "m4a" } }],
    });
  }
  return medias;
}

// ---------- media rendering ----------

function renderMedias(medias, { pageCard = null, pageCardFirst = false } = {}) {
  state.medias = medias;
  const cards = medias.map(mediaCard);
  if (pageCard) pageCardFirst ? cards.unshift(pageCard) : cards.push(pageCard);
  $("medias").replaceChildren(...cards);
}

// An editable file name: label + pencil, swaps to an input while editing.
// Returns the nodes to place and a getter for the current name.
function nameField(defaultName) {
  let name = defaultName;
  const text = el("strong", { class: "name-text", title: defaultName }, name);
  const input = el("input", { class: "rename", type: "text", hidden: true, "aria-label": "File name" });
  const pencil = el("button", { class: "icon ghost pencil", title: "Rename", "aria-label": "Rename" }, "✎");
  const show = () => {
    input.hidden = true;
    text.hidden = false;
    pencil.hidden = false;
  };
  const commit = () => {
    name = input.value.trim() || name;
    text.textContent = name;
    text.title = name;
    show();
  };
  pencil.addEventListener("click", () => {
    input.value = name;
    input.hidden = false;
    text.hidden = true;
    pencil.hidden = true;
    input.focus();
    input.select();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") show();
  });
  input.addEventListener("blur", commit);
  return { nodes: [text, input, pencil], get: () => (input.hidden ? name : input.value.trim() || name) };
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Copy failed");
  }
}

function thumbNode(m) {
  const src = m.thumb || state.pageThumb;
  if (!src) return el("div", { class: "thumb thumb-empty", "aria-hidden": "true" }, "▶");
  return el("img", { class: "thumb", src, alt: "", loading: "lazy" });
}

// Opens a gated HLS master in a new tab so the browser obtains a valid
// signed token. The network detector then picks up the real segments.
// After a short delay we refresh the panel so the user sees the new cards
// when they come back.
async function openGatedPlayer(url) {
  try {
    await chrome.tabs.create({ url, active: true });
    toast("Player opened — re-detecting in a few seconds");
    setTimeout(() => scheduleRefresh(0), 3500);
  } catch {
    toast("Could not open the player");
  }
}

function mediaCard(m) {
  if (m.protected) {
    return el(
      "article",
      { class: "card protected" },
      el("div", { class: "card-head" }, el("strong", {}, m.title), el("span", { class: "badge" }, "DRM")),
      el("div", { class: "sub" }, m.host),
      el("p", { class: "note" }, "Protected content: it cannot be downloaded.")
    );
  }
  const nf = nameField(U.cleanTitle(state.tab?.title));
  return el(
    "article",
    { class: "card" },
    el(
      "div",
      { class: "card-top" },
      thumbNode(m),
      el(
        "div",
        { class: "card-main" },
        el(
          "div",
          { class: "card-head" },
          el("div", { class: "name-wrap" }, ...nf.nodes),
          m.gated ? el("span", { class: "badge locked", title: "This host gates the direct stream behind a signed token: a direct download may return a short decoy, not the full video." }, "🔒 locked") : null,
          m.meta ? el("span", { class: "meta" }, m.meta) : null
        ),
        el("div", { class: "sub", title: m.key }, m.host, m.key && /^https?:/.test(m.key) ? el("button", { class: "link copy", onclick: () => copyLink(m.key) }, "Copy link") : null)
      )
    ),
    optionsRow(m, { getName: nf.get }),
    m.gated
          ? el(
              "div",
              { class: "gated-box" },
              el(
                "p",
                { class: "note warn" },
                "This host gates the direct stream. A plain download may return a short decoy. Open the player so the browser gets a valid token, then download from the new tab (or come back here)."
              ),
              el("button", { class: "ghost", onclick: () => openGatedPlayer(m.key) }, "Open player")
            )
          : null,
    m.noAudio ? el("p", { class: "note" }, "No audio track found: play the video again with the sound on.") : null
  );
}

// ---------- downloads ----------

let jobSeq = 0;

// Jobs run by the local helper, kept by the service worker in session storage.
state.helperJobs = [];

function helperJobView(h) {
  let status = h.status;
  if (h.done && h.seconds) {
    const note = decoyNote(h.advertisedSeconds, h.seconds, U.formatDuration);
    status += " · " + U.formatDuration(h.seconds) + (note ? " " + note : "");
  }
  return {
    ...h,
    status,
    badge: (formatById(h.format)?.label.split(" ")[0] || (h.mode === "mp3" ? "MP3" : "Video")) + (h.abr ? ` · ${h.abr}k` : h.quality ? ` · ${h.quality}p` : "") + " · yt-dlp",
    cancel: () => cancelHelperJob(h.id),
    reveal: h.file ? () => revealFile(h.file) : null,
  };
}

function renderJobs() {
  const all = [...state.helperJobs.map(helperJobView).reverse(), ...state.jobs];
  $("jobs-section").hidden = !all.length;
  $("jobs").replaceChildren(
    ...all.map((j) => {
      const pct = j.progress == null ? null : Math.round(j.progress * 100);
      const cls = ["card", "job", j.done ? "done" : "", j.error ? "failed" : ""].join(" ");
      const jobId = typeof j.id === "number" ? "local-" + j.id : String(j.id); // for tests and the log
      const actions = [];
      if (!j.done && !j.error) actions.push(el("button", { class: "ghost", onclick: () => (j.cancel ? j.cancel() : j.controller.abort()) }, "Cancel"));
      if (j.done && j.downloadId != null) actions.push(el("button", { class: "ghost", onclick: () => chrome.downloads.show(j.downloadId) }, "Show file"));
      if (j.done && j.reveal) actions.push(el("button", { class: "ghost", onclick: j.reveal }, "Show file"));
      return el(
        "article",
        { class: cls, "data-job": jobId },
        el("div", { class: "card-head" }, el("strong", {}, j.title), el("span", { class: "badge" }, j.badge)),
        j.done || j.error ? null : el("div", { class: "bar" + (pct == null ? " indeterminate" : "") }, el("div", { style: pct == null ? null : `width:${pct}%` })),
        el("div", { class: "status" }, j.error ? "Error: " + j.error : j.status),
        actions.length ? el("div", { class: "row" }, ...actions) : null
      );
    })
  );
}

function update(job, patch) {
  Object.assign(job, patch);
  renderJobs();
}

async function fetchSource(src, job, from, to) {
  let segments;
  if (src.type === "hls") {
    let pl = parseHls(await fetchText(src.url, job.controller.signal), src.url);
    if (pl.type === "master") pl = parseHls(await fetchText(pl.variants[0].url, job.controller.signal), pl.variants[0].url);
    if (pl.encrypted) throw new Error("Encrypted stream: not supported");
    segments = pl.segments;
    // Duration actually served now (can differ from what the card advertised: decoy clips).
    if (pl.duration) job.srcSeconds = Math.max(job.srcSeconds || 0, pl.duration);
  } else if (src.type === "segments") {
    segments = src.segments;
  } else {
    segments = [{ url: src.url, range: null }];
  }
  job.log.info(`source ${src.type}: ${segments.length} request(s)`, { first: segments[0]?.url, size: src.size ?? null });
  const t0 = performance.now();
  let quarter = -1;
  const data = await fetchSegments(segments, {
    signal: job.controller.signal,
    onProgress: (frac, bytes) => {
      const f = frac ?? (src.size ? Math.min(1, bytes / src.size) : null);
      if (f != null && Math.floor(f * 4) !== quarter) {
        quarter = Math.floor(f * 4);
        job.log.debug(`progress ${Math.round(f * 100)}%`, { bytes });
      }
      update(job, { progress: f == null ? null : from + f * (to - from), status: `Downloading… ${U.formatBytes(bytes)}` });
    },
  });
  job.log.info(`source received: ${U.formatBytes(data.length)} in ${Math.round(performance.now() - t0)} ms`, { container: sniff(data) });
  return data;
}

// Whether the user asked, in the panel, to be prompted for the folder each time.
function wantSaveAs() {
  try {
    return localStorage.getItem("saveAs") === "1";
  } catch {
    return false;
  }
}

// Follows a Chrome download to completion, showing its real byte progress on the job,
// and lets the job's Cancel button stop it. Resolves once the download is terminal.
function trackChromeDownload(job, id, { revokeUrl = null } = {}) {
  return new Promise((resolve) => {
    const stop = () => chrome.downloads.cancel(id).catch(() => {});
    job.controller.signal.addEventListener("abort", stop, { once: true });
    let timer = null;
    const finish = (patch) => {
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", stop);
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
      update(job, patch);
      resolve(patch);
    };
    const tick = async () => {
      let item;
      try {
        [item] = await chrome.downloads.search({ id });
      } catch {}
      const patch = progressFromItem(item, U.formatBytes);
      if (!patch) {
        timer = setTimeout(tick, 400);
        return;
      }
      if (patch.done || patch.error) return finish(patch);
      update(job, patch);
      timer = setTimeout(tick, 400);
    };
    tick();
  });
}

// Hands a URL (blob or remote) to Chrome, then tracks it to completion.
async function deliverViaChrome(job, url, ext, { revokeUrl = null } = {}) {
  let res;
  try {
    res = await U.download(url, job.name, ext, { saveAs: wantSaveAs() });
  } catch (e) {
    if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    if (isUserCancel(e.message)) {
      job.log.warn("save dialog cancelled");
      update(job, { error: "download cancelled" });
      return null;
    }
    throw e;
  }
  job.log.info(`handed to Chrome: ${res.filename}`, { downloadId: res.id, saveAs: wantSaveAs() });
  await trackChromeDownload(job, res.id, { revokeUrl });
  annotateDuration(job);
  return res;
}

// Appends the real downloaded duration to a finished job, and a decoy warning when it is
// far shorter than what the card advertised (some hosts serve a short placeholder clip).
function annotateDuration(job) {
  if (!job.done || !job.srcSeconds) return;
  const note = decoyNote(job.advertisedSeconds, job.srcSeconds, U.formatDuration);
  const extra = " · " + U.formatDuration(job.srcSeconds) + (note ? " " + note : "");
  if (note) job.log.warn("short download vs advertised", { got: job.srcSeconds, advertised: job.advertisedSeconds });
  update(job, { status: job.status + extra });
}

async function save(job, blob, ext) {
  const blobUrl = URL.createObjectURL(blob);
  await deliverViaChrome(job, blobUrl, ext, { revokeUrl: blobUrl });
}

async function jobVideo(job, v, { silent = false } = {}) {
  const audioSrc = silent ? null : v.audio;
  // Complete file that needs no processing: let Chrome download it and follow its progress.
  if (v.video.direct && !audioSrc) {
    update(job, { status: "Starting download…" });
    await deliverViaChrome(job, v.video.url, v.video.ext || "mp4");
    return;
  }
  const video = await fetchSource(v.video, job, 0, audioSrc ? 0.8 : 0.95);
  const vType = sniff(video);
  job.log.debug("video container detected: " + vType);
  if (!audioSrc) {
    const ext = vType === "ts" ? "ts" : vType === "webm" ? "webm" : "mp4";
    return save(job, new Blob([video], { type: ext === "ts" ? "video/mp2t" : `video/${ext}` }), ext);
  }
  const audio = await fetchSource(audioSrc, job, 0.8, 0.95);
  if (vType === "mp4" && sniff(audio) === "mp4") {
    update(job, { progress: null, status: "Merging video and sound…" });
    await new Promise((r) => setTimeout(r, 30));
    job.log.info("merging audio + video", { video: video.length, audio: audio.length, probeVideo: probe(video), probeAudio: probe(audio) });
    const t0 = performance.now();
    const merged = mux(video, audio);
    job.log.info(`merge done in ${Math.round(performance.now() - t0)} ms`, { bytes: merged.length, result: probe(merged) });
    return save(job, new Blob([merged], { type: "video/mp4" }), "mp4");
  }
  // Formats we cannot mux (TS): save two files.
  await save(job, new Blob([video], { type: "video/mp2t" }), vType === "ts" ? "ts" : "mp4");
  await U.download(URL.createObjectURL(new Blob([audio])), job.name + " (audio)", sniff(audio) === "aac" ? "aac" : sniff(audio) || "m4a");
  update(job, { status: job.status + " — audio track saved separately" });
}

// Decodes the audio in the browser, then encodes it as MP3 or WAV.
async function jobAudioEncode(job, v, { format, kbps }) {
  const src = v.audio || v.video;
  const bytes = await fetchSource(src, job, 0, 0.5);
  update(job, { progress: 0.5, status: "Decoding the audio…" });
  job.log.info("decoding the audio in the browser", { container: sniff(bytes), bytes: bytes.length });
  const audio = await decodeAudio(bytes);
  job.log.info("audio decoded", { seconds: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate });
  if (format === "wav") {
    update(job, { progress: 0.9, status: "Writing the WAV…" });
    return save(job, encodeWav(audio), "wav");
  }
  update(job, { progress: 0.55, status: "Converting to MP3…" });
  const blob = await encodeMp3(audio, {
    title: job.name,
    kbps: kbps || 192,
    signal: job.controller.signal,
    onProgress: (p) => update(job, { progress: 0.55 + p * 0.45, status: `Converting to MP3 (${kbps || 192} kb/s)… ${Math.round(p * 100)}%` }),
  });
  return save(job, blob, "mp3");
}

// Saves a separate audio track as it is (no re-encoding).
async function jobAudio(job, v) {
  const bytes = await fetchSource(v.audio, job, 0, 1);
  const type = sniff(bytes);
  return save(job, new Blob([bytes], { type: "audio/mp4" }), type === "aac" ? "aac" : "m4a");
}

function urlsOf(v) {
  const out = [];
  for (const src of [v.video, v.audio]) {
    if (!src) continue;
    if (src.url) out.push(src.url);
    if (src.segments) out.push(...src.segments.map((s) => s.url));
  }
  return out;
}

async function startJob(media, variant, { format, kbps, name }) {
  const f = formatById(format);
  const chosen = name || U.cleanTitle(state.tab?.title);
  const job = {
    id: ++jobSeq,
    name: chosen,
    title: chosen,
    advertisedSeconds: media.seconds || 0,
    badge: f.label.split(" ")[0] + (kbps ? ` · ${kbps}k` : ""),
    status: "Preparing…",
    progress: null,
    controller: new AbortController(),
  };
  job.log = log.scope("job " + job.id);
  job.log.info(`start: ${format}${kbps ? " " + kbps + " kb/s" : ""}`, {
    media: media.kind,
    variant: variant?.label || null,
    video: variant?.video ? { type: variant.video.type, url: variant.video.url || variant.video.segments?.[0]?.url } : null,
    audio: variant?.audio ? { type: variant.audio.type, url: variant.audio.url || variant.audio.segments?.[0]?.url } : null,
  });
  state.jobs.unshift(job);
  renderJobs();
  const page = state.tab?.url || "";
  const run = () => {
    switch (format) {
      case "mp4":
        return jobVideo(job, variant);
      case "mp4-silent":
        job.name += " (no sound)";
        return jobVideo(job, variant, { silent: true });
      case "m4a":
        return jobAudio(job, variant);
      case "mp3":
      case "wav":
        return jobAudioEncode(job, variant, { format, kbps });
      default:
        throw new Error("Format not handled by the browser");
    }
  };
  try {
    await withReferer(page, urlsOf(variant), run);
  } catch (e) {
    if (e.name === "AbortError") job.log.warn("cancelled");
    else job.log.error("failed: " + e.message, e);
    update(job, { error: e.name === "AbortError" ? "download cancelled" : e.message });
  }
}

// ---------- actions ----------

$("scan").addEventListener("click", async () => {
  const tab = state.tab;
  if (!tab) return;
  $("scan").disabled = true;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    ulog.info(`“Force detection”: ${results.length} frame(s) scanned`, results.map((r) => ({
      frame: r.frameId, url: r.result?.url, found: (r.result?.items || []).map((i) => `${i.kind} ${i.from} ${i.url.slice(0, 120)}`),
    })));
    const items = results.flatMap((r) => r.result?.items || []);
    const res = await chrome.runtime.sendMessage({ type: "add-items", tabId: tab.id, items });
    toast(items.length ? `${res?.added ?? items.length} item(s) analysed` : "Nothing found on the page");
  } catch (e) {
    ulog.error("“Force detection” failed", e);
    toast("This page cannot be scanned");
  } finally {
    $("scan").disabled = false;
    scheduleRefresh(0);
  }
});

$("open-log").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("log.html") }));

const saveAsBox = $("saveas");
if (saveAsBox) {
  saveAsBox.checked = wantSaveAs();
  saveAsBox.addEventListener("change", () => remember("saveAs", saveAsBox.checked ? "1" : "0"));
}

$("clear").addEventListener("click", async () => {
  if (!state.tab) return;
  await chrome.runtime.sendMessage({ type: "clear-tab", tabId: state.tab.id });
  state.cache.clear();
  scheduleRefresh(0);
});

chrome.tabs.onActivated.addListener(() => scheduleRefresh(0));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tab?.id && (info.url || info.title || info.status === "complete")) scheduleRefresh();
});
chrome.windows?.onFocusChanged.addListener(() => scheduleRefresh());
chrome.storage.session.onChanged.addListener((changes) => {
  if (state.tab && changes["tab:" + state.tab.id]) scheduleRefresh(400);
  if (changes["helper:jobs"]) {
    state.helperJobs = changes["helper:jobs"].newValue || [];
    renderJobs();
  }
});

chrome.storage.session.get("helper:jobs").then((r) => {
  state.helperJobs = r["helper:jobs"] || [];
  renderJobs();
});
startThumbnailLoop();
refresh();
