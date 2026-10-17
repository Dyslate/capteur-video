// Help page: shows the local helper status and install instructions.

import { pingHelper, updateHelper } from "./lib/helper.js";
import { REPO_URL } from "./lib/config.js";

document.getElementById("ext-id").textContent = chrome.runtime.id;
document.getElementById("zip").href = REPO_URL + "/archive/refs/heads/main.zip";

async function check() {
  const out = document.getElementById("status");
  out.textContent = "Vérification…";
  const h = await pingHelper({ force: true });
  document.getElementById("update").hidden = !h.ok;
  if (!h.ok) {
    out.className = "note warn";
    out.textContent = h.error + ". Suivez les étapes ci-dessous, puis redémarrez Chrome.";
    return;
  }
  out.className = "note";
  out.textContent = [
    `Module ${h.version} installé`,
    `yt-dlp ${h.ytdlp || "absent"}`,
    `ffmpeg ${h.ffmpeg ? "OK" : "absent"}`,
    `JavaScript (YouTube) : ${h.jsRuntime || "absent, installez Deno"}`,
    `Dossier : ${h.downloadDir}`,
  ].join(" · ");
}

document.getElementById("check").addEventListener("click", check);

// yt-dlp follows site changes (YouTube in particular): updating fixes most failures.
document.getElementById("update").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const status = document.getElementById("update-status");
  button.disabled = true;
  status.textContent = "Mise à jour en cours, cela peut prendre une minute…";
  const res = await updateHelper();
  status.textContent = res?.type === "updated" ? `yt-dlp est à jour (${res.ytdlp || "?"})` : "Échec : " + (res?.message || "erreur inconnue");
  button.disabled = false;
  check();
});
check();
