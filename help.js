// Help page: shows the local helper status and install instructions.

import { pingHelper, updateHelper } from "./lib/helper.js";
import { REPO_URL } from "./lib/config.js";

document.getElementById("ext-id").textContent = chrome.runtime.id;
document.getElementById("zip").href = REPO_URL + "/archive/refs/heads/main.zip";

async function check() {
  const out = document.getElementById("status");
  out.textContent = "Checking…";
  const h = await pingHelper({ force: true });
  document.getElementById("update").hidden = !h.ok;
  if (!h.ok) {
    out.className = "note warn";
    out.textContent = h.error + ". Follow the steps below, then restart Chrome.";
    return;
  }
  out.className = "note";
  out.textContent = [
    `Helper ${h.version} installed`,
    `yt-dlp ${h.ytdlp || "missing"}`,
    `ffmpeg ${h.ffmpeg ? "OK" : "missing"}`,
    `JavaScript (YouTube): ${h.jsRuntime || "missing, install Deno"}`,
    `Folder: ${h.downloadDir}`,
    `Log: ${h.logFile || "?"}`,
  ].join(" · ");
}

document.getElementById("check").addEventListener("click", check);

// yt-dlp follows site changes (YouTube in particular): updating fixes most failures.
document.getElementById("update").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const status = document.getElementById("update-status");
  button.disabled = true;
  status.textContent = "Updating, this can take a minute…";
  const res = await updateHelper();
  status.textContent = res?.type === "updated" ? `yt-dlp is up to date (${res.ytdlp || "?"})` : "Failed: " + (res?.message || "unknown error");
  button.disabled = false;
  check();
});
check();
