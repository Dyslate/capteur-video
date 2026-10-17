// Panel-side access to the local yt-dlp helper (native messaging).
// Downloads themselves run in the service worker so they survive the panel closing.

import { HELPER_HOST } from "./config.js";

let lastPing = null;
let lastPingAt = 0;

export function friendlyError(message) {
  if (/not found|introuvable/i.test(message || "")) return "Module local non installé";
  if (/forbidden|access/i.test(message || "")) return "Le module refuse cette extension (identifiant inattendu)";
  if (/exited/i.test(message || "")) return "Le module s'est arrêté de façon inattendue";
  return message || "Module local indisponible";
}

// Returns { ok, ytdlp, ffmpeg, jsRuntime, downloadDir } or { ok:false, error }.
export async function pingHelper({ force = false } = {}) {
  if (!force && lastPing && Date.now() - lastPingAt < 30000) return lastPing;
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { cmd: "ping" });
    lastPing = res?.type === "pong" ? { ok: true, ...res } : { ok: false, error: "Réponse inattendue du module" };
  } catch (e) {
    lastPing = { ok: false, error: friendlyError(e?.message) };
  }
  lastPingAt = Date.now();
  return lastPing;
}

export function startHelperJob({ url, mode, format, referer, title, quality, abr }) {
  return chrome.runtime.sendMessage({ type: "helper-start", url, mode, format, referer, title, quality, abr });
}

// Updates yt-dlp inside the helper's environment (can take a minute).
export async function updateHelper() {
  try {
    return await chrome.runtime.sendNativeMessage(HELPER_HOST, { cmd: "update" });
  } catch (e) {
    return { type: "error", message: friendlyError(e?.message) };
  }
}

export function cancelHelperJob(id) {
  return chrome.runtime.sendMessage({ type: "helper-cancel", id });
}

export async function revealFile(path) {
  try {
    await chrome.runtime.sendNativeMessage(HELPER_HOST, { cmd: "reveal", path });
  } catch {
    // nothing useful to do: the file is in the download folder anyway
  }
}
