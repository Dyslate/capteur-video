// Panel-side access to the local yt-dlp helper (native messaging).
// Downloads themselves run in the service worker so they survive the panel closing.

import { HELPER_HOST } from "./config.js";
import { createLogger } from "./log.js";

const mlog = createLogger("panel").scope("helper");

let lastPing = null;
let lastPingAt = 0;

export function friendlyError(message) {
  if (/not found/i.test(message || "")) return "Local helper not installed";
  if (/forbidden|access/i.test(message || "")) return "The helper rejects this extension (unexpected ID)";
  if (/exited/i.test(message || "")) return "The helper stopped unexpectedly";
  return message || "Local helper unavailable";
}

// Returns { ok, ytdlp, ffmpeg, jsRuntime, downloadDir } or { ok:false, error }.
export async function pingHelper({ force = false } = {}) {
  if (!force && lastPing && Date.now() - lastPingAt < 30000) return lastPing;
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { cmd: "ping" });
    lastPing = res?.type === "pong" ? { ok: true, ...res } : { ok: false, error: "Unexpected reply from the helper" };
  } catch (e) {
    lastPing = { ok: false, error: friendlyError(e?.message) };
  }
  lastPingAt = Date.now();
  mlog.info(lastPing.ok ? "helper reachable" : "helper unavailable", lastPing);
  return lastPing;
}

export function startHelperJob({ url, mode, format, referer, title, quality, abr, advertisedSeconds }) {
  return chrome.runtime.sendMessage({ type: "helper-start", url, mode, format, referer, title, quality, abr, advertisedSeconds });
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
