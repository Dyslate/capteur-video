// Log viewer: merges every context's log, with filters, copy, export and the helper's log file.

import { readLog, clearLog, formatEntry } from "./lib/log.js";
import { HELPER_HOST, BUILD } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let entries = [];
let helperText = "";

function visible() {
  const min = LEVELS[$("level").value];
  const q = $("filter").value.trim().toLowerCase();
  return entries.filter((e) => LEVELS[e.level] >= min && (!q || formatEntry(e).toLowerCase().includes(q)));
}

function render() {
  const list = visible();
  $("count").textContent = `${list.length} entrée(s) affichée(s) sur ${entries.length}`;
  $("entries").replaceChildren(
    ...list.map((e) => {
      const div = document.createElement("div");
      div.className = "entry " + e.level;
      div.textContent = formatEntry(e);
      return div;
    })
  );
}

async function load() {
  entries = await readLog();
  render();
}

function reportText() {
  const header = [
    `Capteur vidéo ${chrome.runtime.getManifest().version} — ${new Date().toISOString()}`,
    `Navigateur : ${navigator.userAgent}`,
    "",
  ];
  const ext = visible().map(formatEntry);
  const helper = helperText ? ["", "===== helper.log (fin) =====", helperText] : [];
  return [...header, ...ext, ...helper].join("\n");
}

$("level").addEventListener("change", render);
$("filter").addEventListener("input", render);

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportText());
  $("copy").textContent = "Copié ✓";
  setTimeout(() => ($("copy").textContent = "Copier"), 1500);
});

$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([reportText()], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `capteur-video-journal-${Date.now()}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$("clear").addEventListener("click", async () => {
  await clearLog();
  load();
});

async function loadHelperLog() {
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { cmd: "tail", lines: 300 });
    helperText = res?.text || "";
    $("helper-log").textContent = helperText || "(vide)";
    if (res?.path) $("helper-path").textContent = "Fin du fichier " + res.path;
  } catch (e) {
    helperText = "";
    $("helper-log").textContent = "Module local injoignable : " + (e?.message || e);
  }
}
$("helper-refresh").addEventListener("click", loadHelperLog);

// The store build has no local helper: hide its section.
if (BUILD === "store") {
  for (const id of ["helper-path", "helper-refresh", "helper-log"]) $(id).closest("p, div, pre").hidden = true;
  document.querySelector("h2").hidden = true;
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith("log:"))) load();
});

load();
if (BUILD !== "store") loadHelperLog();
