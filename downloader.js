// Page de téléchargement HLS : récupère tous les segments puis les assemble en un fichier.

const params = new URLSearchParams(location.search);
const srcUrl = params.get("url");
const title = params.get("title") || "video";
const label = params.get("label") || "";
const page = params.get("page") || "";

const CONCURRENCY = 6;
const RETRIES = 3;
const MIME = { mp4: "video/mp4", ts: "video/mp2t", aac: "audio/aac" };

const $ = (id) => document.getElementById(id);
const controller = new AbortController();
let ruleId = null;
let busy = false;

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function addNote(text) {
  $("notes").append(Object.assign(document.createElement("p"), { className: "note", textContent: text }));
}

function updateProgress(done, total, bytes) {
  $("bar").style.width = ((done / total) * 100).toFixed(1) + "%";
  $("count").textContent = `${done} / ${total} segments · ${Util.formatBytes(bytes)}`;
}

// Certains serveurs refusent les requêtes sans le Referer de la page d'origine.
// On l'ajoute uniquement aux requêtes de cet onglet.
async function setupReferer() {
  if (!/^https?:/i.test(page)) return;
  try {
    const tab = await chrome.tabs.getCurrent();
    ruleId = tab.id;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: page },
              { header: "origin", operation: "set", value: new URL(page).origin },
            ],
          },
          condition: { tabIds: [ruleId], resourceTypes: ["xmlhttprequest"] },
        },
      ],
    });
  } catch (e) {
    console.warn("Referer non appliqué :", e);
    ruleId = null;
  }
}

async function clearReferer() {
  if (ruleId == null) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch {}
  ruleId = null;
}

async function fetchSegment(seg) {
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = seg.range
        ? { Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}` }
        : undefined;
      const r = await fetch(seg.url, { credentials: "include", headers, signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} sur un segment`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (controller.signal.aborted || attempt >= RETRIES) throw e;
      await new Promise((res) => setTimeout(res, 800 * attempt));
    }
  }
}

async function pool(items, size, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  } catch (e) {
    controller.abort();
    throw e;
  }
  if (controller.signal.aborted) throw new DOMException("Annulé", "AbortError");
}

function guessExt(segs, parts) {
  if (segs.some((s) => s.init)) return "mp4";
  const b = parts[segs.findIndex((s) => !s.init)] || new Uint8Array();
  if (b[0] === 0x47) return "ts";
  const isId3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
  const isAdts = b[0] === 0xff && (b[1] & 0xf0) === 0xf0;
  if (isId3 || isAdts) return "aac";
  const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (["ftyp", "styp", "moof"].includes(box)) return "mp4";
  return "ts";
}

async function main() {
  const name = label ? `${title} (${label})` : title;
  document.title = "Téléchargement · " + name;
  $("title").textContent = name;
  if (!srcUrl) throw new Error("Aucune adresse de flux reçue.");

  busy = true;
  await setupReferer();

  setStatus("Lecture de la playlist…");
  let pl = HLS.parse(await HLS.fetchText(srcUrl, controller.signal), srcUrl);

  if (pl.type === "master") {
    if (pl.encrypted) throw new Error("Ce flux est protégé : il n'est pas pris en charge.");
    if (!pl.variants.length) throw new Error("Aucune qualité trouvée dans la playlist.");
    const v = pl.variants[0];
    addNote("Qualité choisie automatiquement : " + HLS.variantLabel(v));
    pl = HLS.parse(await HLS.fetchText(v.url, controller.signal), v.url);
  }

  if (pl.encrypted) {
    throw new Error("Ce flux est chiffré (DRM ou clé de protection) : l'extension ne prend pas en charge les contenus protégés.");
  }
  if (!pl.segments.length) throw new Error("Aucun segment trouvé dans la playlist.");
  if (pl.live) addNote("Flux en direct : seuls les segments disponibles en ce moment seront enregistrés.");

  const segs = pl.segments;
  const total = segs.length;
  const parts = new Array(total);
  let done = 0;
  let bytes = 0;

  setStatus(`Téléchargement de ${total} segments…`);
  updateProgress(0, total, 0);
  await pool(segs, CONCURRENCY, async (seg, i) => {
    const data = await fetchSegment(seg);
    parts[i] = data;
    done++;
    bytes += data.byteLength;
    updateProgress(done, total, bytes);
  });

  setStatus("Assemblage du fichier…");
  const ext = guessExt(segs, parts);
  const blob = new Blob(parts, { type: MIME[ext] });
  const blobUrl = URL.createObjectURL(blob);
  const filename = Util.safeName(label ? `${title} - ${label}` : title) + "." + ext;

  const id = await chrome.downloads.download({ url: blobUrl, filename });
  busy = false;
  $("cancel").hidden = true;
  setStatus(`Terminé : ${filename} (${Util.formatBytes(blob.size)})`, "ok");
  if (ext === "ts") {
    addNote("Le fichier .ts se lit avec VLC. Pour le convertir en .mp4 sans perte : ffmpeg -i fichier.ts -c copy fichier.mp4");
  }

  chrome.downloads.onChanged.addListener((d) => {
    if (d.id !== id || !d.state) return;
    if (d.state.current === "complete") {
      URL.revokeObjectURL(blobUrl);
      addNote("Fichier enregistré. Vous pouvez fermer cet onglet.");
    } else if (d.state.current === "interrupted") {
      addNote("L'enregistrement du fichier a été interrompu.");
    }
  });
}

$("cancel").addEventListener("click", () => controller.abort());

window.addEventListener("beforeunload", (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});

main()
  .catch((e) => {
    busy = false;
    $("cancel").hidden = true;
    if (e.name === "AbortError") setStatus("Téléchargement annulé.", "error");
    else setStatus("Erreur : " + e.message, "error");
  })
  .finally(clearReferer);
