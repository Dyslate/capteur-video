// Side panel: lists the active tab's media and runs downloads (MP4 / MP3).

import { parseHls } from "./lib/hls.js";
import { parseMpd } from "./lib/dash.js";
import { probe, mux, sniff } from "./lib/mp4.js";
import { decodeAudio, encodeMp3 } from "./lib/mp3.js";
import { fetchText, fetchHead, fetchSegments, withReferer } from "./lib/fetcher.js";
import { scanPage } from "./lib/scan.js";
import { excludedService, helperOnly, isDrmService } from "./lib/policy.js";
import { pingHelper, startHelperJob, cancelHelperJob, revealFile } from "./lib/helper.js";
import { BUILD } from "./lib/config.js";
import * as U from "./lib/util.js";

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
    return showState("Ouvrez une page web", "Le panneau détecte les vidéos des pages que vous visitez.", { waiting: false });
  }
  if (service) {
    renderMedias([]);
    return showState(
      `${service} n'est pas pris en charge`,
      isDrmService(url)
        ? "Ses vidéos sont protégées par DRM : aucun outil ne peut les télécharger légalement."
        : "Ce site est exclu de la version Chrome Web Store.",
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
  renderMedias(medias, { pageCard: useHelper ? pageCard(tab, helper, onlyHelper) : null, pageCardFirst: onlyHelper });
  if (!medias.length && !onlyHelper) {
    showState(
      "En attente de médias…",
      "Lancez la lecture de la vidéo, avec le son, puis revenez ici. Sinon, essayez « Forcer la détection »" + (useHelper ? " ou le module yt-dlp ci-dessous." : ".")
    );
  } else {
    $("state").hidden = true;
  }
}

// Card that sends the whole page to the local yt-dlp helper.
function pageCard(tab, helper, onlyHelper) {
  const title = onlyHelper ? "Cette vidéo YouTube" : "Toute la page avec yt-dlp";
  const sub = onlyHelper ? "Via le module local yt-dlp" : "Secours : fonctionne sur des milliers de sites";
  if (!helper?.ok) {
    return el(
      "article",
      { class: "card helper" },
      el("div", { class: "card-head" }, el("strong", {}, title), el("span", { class: "badge" }, "Module")),
      el("div", { class: "sub" }, sub),
      el("p", { class: "note" }, `${helper?.error || "Module local non installé"}. Il s'installe une seule fois, en deux minutes.`),
      el("div", { class: "row" },
        el("button", { class: onlyHelper ? "" : "ghost", onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL("help.html") }) }, "Installer le module"),
        el("button", { class: "ghost", onclick: async () => { await pingHelper({ force: true }); scheduleRefresh(0); } }, "Revérifier"))
    );
  }
  const start = (mode) => {
    startHelperJob({ url: tab.url, mode, referer: tab.url, title: U.cleanTitle(tab.title) });
    toast("Téléchargement confié au module");
  };
  const warnings = [];
  if (onlyHelper && !helper.jsRuntime) warnings.push("YouTube demande Deno : voir l'aide pour l'installer.");
  if (!helper.ffmpeg) warnings.push("ffmpeg introuvable : MP3 et fusion audio/vidéo indisponibles.");
  return el(
    "article",
    { class: "card helper" },
    el("div", { class: "card-head" }, el("strong", {}, title), el("span", { class: "badge" }, "yt-dlp " + (helper.ytdlp || "?"))),
    el("div", { class: "sub" }, sub),
    el("div", { class: "row" },
      el("button", { class: onlyHelper ? "" : "ghost", onclick: () => start("video") }, "Vidéo MP4"),
      el("button", { class: "ghost", onclick: () => start("mp3") }, "MP3")),
    ...warnings.map((w) => el("p", { class: "note" }, w))
  );
}

// ---------- analysis of detected items ----------

async function cached(key, fn) {
  if (!state.cache.has(key)) state.cache.set(key, fn().catch((e) => ({ error: e })));
  return state.cache.get(key);
}

const stripQuery = (u) => u.split(/[?#]/)[0];

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
    if (res.error) continue;
    const pl = res.pl;
    if (pl.type === "media" && referenced.has(stripQuery(it.url))) continue;
    if (pl.encrypted) {
      medias.push({ key: it.url, kind: "hls", title: "Flux protégé", host: U.hostOf(it.url), protected: true, variants: [] });
      continue;
    }
    if (pl.type === "master") {
      const variants = pl.variants.map((v) => {
        const audio = v.audioGroup ? pl.audio.find((a) => a.group === v.audioGroup && a.isDefault) || pl.audio.find((a) => a.group === v.audioGroup) : null;
        return {
          label: U.qualityLabel(v.height, v.bandwidth) || "Qualité par défaut",
          video: { type: "hls", url: v.url },
          audio: audio ? { type: "hls", url: audio.url } : null,
        };
      });
      medias.push({ key: it.url, kind: "hls", title: "Flux HLS", host: U.hostOf(it.url), variants });
    } else {
      medias.push({
        key: it.url,
        kind: "hls",
        title: pl.live ? "Flux HLS en direct" : "Flux HLS",
        meta: pl.live ? "direct" : U.formatDuration(pl.duration),
        host: U.hostOf(it.url),
        variants: [{ label: "Qualité unique", video: { type: "segments", segments: pl.segments }, audio: null }],
      });
    }
  }

  // DASH
  for (const it of dashItems) {
    const res = await cached("dash:" + it.url, async () => {
      const text = it.mpd || (await fetchText(it.url));
      return { mpd: parseMpd(text, it.base || it.url) };
    });
    if (res.error) continue;
    const mpd = res.mpd;
    const host = U.hostOf(it.base || it.url);
    if (mpd.encrypted) {
      medias.push({ key: it.url, kind: "dash", title: "Flux protégé", host, protected: true, variants: [] });
      continue;
    }
    const bestAudio = mpd.audio[0] ? { type: "segments", segments: mpd.audio[0].segments } : null;
    const seen = new Set();
    const variants = [];
    for (const v of mpd.video) {
      if (seen.has(v.height)) continue;
      seen.add(v.height);
      variants.push({ label: U.qualityLabel(v.height, v.bandwidth) || "Vidéo", video: { type: "segments", segments: v.segments }, audio: bestAudio });
    }
    if (!variants.length && bestAudio) variants.push({ label: "Audio", video: null, audio: bestAudio });
    if (!variants.length) continue;
    medias.push({
      key: it.url,
      kind: "dash",
      title: it.kind === "dash-inline" ? "Vidéo de la page" : "Flux DASH",
      meta: mpd.live ? "direct" : mpd.duration ? U.formatDuration(mpd.duration) : "",
      host,
      variants,
      audioOnly: !mpd.video.length,
    });
  }

  medias.push(...(await mediasFromFiles(files)));
  return medias;
}

// Probes an MP4 file to find out whether it holds video, audio, or both.
async function probeFile(url) {
  return cached("probe:" + url, async () => {
    let head = await fetchHead(url, 256 * 1024);
    if (sniff(head) !== "mp4") return { ok: false, container: sniff(head) };
    let p = probe(head);
    if (!p.ok && p.needed && p.needed <= 8 * 1024 * 1024 && head.length >= 256 * 1024) {
      head = await fetchHead(url, p.needed);
      p = probe(head);
    }
    return { ...p, container: "mp4" };
  });
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
        title: isAudio ? "Audio" : "Vidéo",
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
    g.audio = a;
  }
  for (const g of groups.values()) {
    const vids = g.videos.sort((x, y) => y.p.height - x.p.height);
    const seconds = Math.max(...vids.map((v) => v.p.seconds || 0), g.audio?.p.seconds || 0);
    const audio = g.audio ? { type: "file", url: g.audio.f.url, size: g.audio.f.size } : null;
    medias.push({
      key: vids[0].f.url,
      kind: "file",
      title: "Vidéo",
      meta: [seconds ? U.formatDuration(seconds) : ""].filter(Boolean).join(" · "),
      host: U.hostOf(vids[0].f.url),
      noAudio: !audio,
      variants: vids.map((v) => ({
        label: [v.p.height ? `${v.p.height}p` : "", U.formatBytes(v.f.size)].filter(Boolean).join(" · ") || "Vidéo",
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
      title: "Audio seul",
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

function mediaCard(m) {
  if (m.protected) {
    return el(
      "article",
      { class: "card protected" },
      el("div", { class: "card-head" }, el("strong", {}, m.title), el("span", { class: "badge" }, "DRM")),
      el("div", { class: "sub" }, m.host),
      el("p", { class: "note" }, "Contenu protégé : il n'est pas téléchargeable.")
    );
  }

  const select =
    m.variants.length > 1
      ? el("select", { "aria-label": "Qualité" }, m.variants.map((v, i) => el("option", { value: i }, v.label)))
      : null;
  const pick = () => m.variants[select ? Number(select.value) : 0];

  const buttons = [];
  if (!m.audioOnly) {
    buttons.push(el("button", { onclick: () => startJob(m, pick(), "video") }, m.kind === "hls" && !pick().audio ? "Vidéo" : "Vidéo MP4"));
  }
  buttons.push(el("button", { class: m.audioOnly ? "" : "ghost", onclick: () => startJob(m, pick(), "mp3") }, "MP3"));
  if (m.audioOnly && m.variants[0].audio?.ext === "m4a") {
    buttons.push(el("button", { class: "ghost", onclick: () => startJob(m, pick(), "audio") }, "M4A d'origine"));
  }

  return el(
    "article",
    { class: "card" },
    el("div", { class: "card-head" }, el("strong", {}, m.title), m.meta ? el("span", { class: "meta" }, m.meta) : null),
    el("div", { class: "sub", title: m.key }, m.host),
    el("div", { class: "row" }, select, ...buttons),
    m.noAudio ? el("p", { class: "note" }, "Aucune piste audio trouvée : relancez la lecture avec le son activé.") : null
  );
}

// ---------- downloads ----------

let jobSeq = 0;

// Jobs run by the local helper, kept by the service worker in session storage.
state.helperJobs = [];

function helperJobView(h) {
  return {
    ...h,
    badge: (h.mode === "mp3" ? "MP3" : "Vidéo") + " · yt-dlp",
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
      const actions = [];
      if (!j.done && !j.error) actions.push(el("button", { class: "ghost", onclick: () => (j.cancel ? j.cancel() : j.controller.abort()) }, "Annuler"));
      if (j.done && j.downloadId != null) actions.push(el("button", { class: "ghost", onclick: () => chrome.downloads.show(j.downloadId) }, "Afficher le fichier"));
      if (j.done && j.reveal) actions.push(el("button", { class: "ghost", onclick: j.reveal }, "Afficher le fichier"));
      return el(
        "article",
        { class: cls },
        el("div", { class: "card-head" }, el("strong", {}, j.title), el("span", { class: "badge" }, j.badge)),
        j.done || j.error ? null : el("div", { class: "bar" + (pct == null ? " indeterminate" : "") }, el("div", { style: pct == null ? null : `width:${pct}%` })),
        el("div", { class: "status" }, j.error ? "Erreur : " + j.error : j.status),
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
    if (pl.encrypted) throw new Error("Flux chiffré : non pris en charge");
    segments = pl.segments;
  } else if (src.type === "segments") {
    segments = src.segments;
  } else {
    segments = [{ url: src.url, range: null }];
  }
  return fetchSegments(segments, {
    signal: job.controller.signal,
    onProgress: (frac, bytes) => {
      const f = frac ?? (src.size ? Math.min(1, bytes / src.size) : null);
      update(job, { progress: f == null ? null : from + f * (to - from), status: `Téléchargement… ${U.formatBytes(bytes)}` });
    },
  });
}

async function save(job, blob, ext) {
  const blobUrl = URL.createObjectURL(blob);
  const { id, filename } = await U.download(blobUrl, job.name, ext);
  const onChange = (d) => {
    if (d.id === id && d.state && d.state.current !== "in_progress") {
      URL.revokeObjectURL(blobUrl);
      chrome.downloads.onChanged.removeListener(onChange);
    }
  };
  chrome.downloads.onChanged.addListener(onChange);
  update(job, { done: true, progress: 1, downloadId: id, status: `Enregistré : ${filename} (${U.formatBytes(blob.size)})` });
}

async function jobVideo(job, v) {
  // Complete file that needs no processing: let Chrome download it directly.
  if (v.video.direct && !v.audio) {
    const { id, filename } = await U.download(v.video.url, job.name, v.video.ext || "mp4");
    return update(job, { done: true, downloadId: id, status: `Envoyé aux téléchargements : ${filename}` });
  }
  const video = await fetchSource(v.video, job, 0, v.audio ? 0.8 : 0.95);
  const vType = sniff(video);
  if (!v.audio) {
    const ext = vType === "ts" ? "ts" : vType === "webm" ? "webm" : "mp4";
    return save(job, new Blob([video], { type: ext === "ts" ? "video/mp2t" : `video/${ext}` }), ext);
  }
  const audio = await fetchSource(v.audio, job, 0.8, 0.95);
  if (vType === "mp4" && sniff(audio) === "mp4") {
    update(job, { progress: null, status: "Assemblage de la vidéo et du son…" });
    await new Promise((r) => setTimeout(r, 30));
    return save(job, new Blob([mux(video, audio)], { type: "video/mp4" }), "mp4");
  }
  // Formats we cannot mux (TS): save two files.
  await save(job, new Blob([video], { type: "video/mp2t" }), vType === "ts" ? "ts" : "mp4");
  const audioJob = { ...job, name: job.name + " (audio)" };
  await U.download(URL.createObjectURL(new Blob([audio])), audioJob.name, sniff(audio) === "aac" ? "aac" : sniff(audio) || "m4a");
  update(job, { status: job.status + " — piste audio enregistrée à part" });
}

async function jobMp3(job, v) {
  const src = v.audio || v.video;
  const bytes = await fetchSource(src, job, 0, 0.5);
  update(job, { progress: 0.5, status: "Décodage de l'audio…" });
  const audio = await decodeAudio(bytes);
  update(job, { progress: 0.55, status: "Conversion en MP3…" });
  const blob = await encodeMp3(audio, {
    title: job.name,
    signal: job.controller.signal,
    onProgress: (p) => update(job, { progress: 0.55 + p * 0.45, status: `Conversion en MP3… ${Math.round(p * 100)} %` }),
  });
  return save(job, blob, "mp3");
}

async function jobAudio(job, v) {
  const bytes = await fetchSource(v.audio, job, 0, 1);
  return save(job, new Blob([bytes], { type: "audio/mp4" }), "m4a");
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

async function startJob(media, variant, kind) {
  const job = {
    id: ++jobSeq,
    name: U.cleanTitle(state.tab?.title),
    title: U.cleanTitle(state.tab?.title),
    badge: kind === "mp3" ? "MP3" : kind === "audio" ? "M4A" : "Vidéo",
    status: "Préparation…",
    progress: null,
    controller: new AbortController(),
  };
  state.jobs.unshift(job);
  renderJobs();
  const page = state.tab?.url || "";
  try {
    await withReferer(page, urlsOf(variant), () => (kind === "mp3" ? jobMp3(job, variant) : kind === "audio" ? jobAudio(job, variant) : jobVideo(job, variant)));
  } catch (e) {
    update(job, { error: e.name === "AbortError" ? "téléchargement annulé" : e.message });
  }
}

// ---------- actions ----------

$("scan").addEventListener("click", async () => {
  const tab = state.tab;
  if (!tab) return;
  $("scan").disabled = true;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    const items = results.flatMap((r) => r.result?.items || []);
    const res = await chrome.runtime.sendMessage({ type: "add-items", tabId: tab.id, items });
    toast(items.length ? `${res?.added ?? items.length} élément(s) analysé(s)` : "Rien trouvé dans la page");
  } catch (e) {
    toast("Analyse impossible sur cette page");
  } finally {
    $("scan").disabled = false;
    scheduleRefresh(0);
  }
});

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
refresh();
