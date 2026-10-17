// Popup : affiche les flux détectés dans l'onglet actif.

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const loadingEl = document.getElementById("loading");

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const name = x.pathname.split("/").filter(Boolean).pop() || "";
    return `${x.hostname} · ${decodeURIComponent(name)}`;
  } catch {
    return u;
  }
}

const stripQuery = (u) => u.split(/[?#]/)[0];

function card(title, meta, url, actions) {
  return el(
    "section",
    { class: "card" },
    el("div", { class: "card-head" }, el("strong", {}, title), meta ? el("span", { class: "meta" }, meta) : null),
    el("div", { class: "url", title: url }, shortUrl(url)),
    el("div", { class: "actions" }, ...actions)
  );
}

function openDownloader(params) {
  const qs = new URLSearchParams(params).toString();
  chrome.tabs.create({ url: chrome.runtime.getURL("downloader.html") + "?" + qs });
  window.close();
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const key = "tab:" + tab.id;
  const items = (await chrome.storage.session.get(key))[key] || [];
  const title = tab.title || "video";
  const page = tab.url || "";

  const hlsItems = items.filter((i) => i.kind === "hls");
  const videoItems = items.filter((i) => i.kind === "video");

  // On lit chaque playlist pour connaître les qualités et repérer les flux protégés.
  const parsed = await Promise.all(
    hlsItems.map(async (it) => {
      try {
        return { it, pl: HLS.parse(await HLS.fetchText(it.url), it.url) };
      } catch (error) {
        return { it, error };
      }
    })
  );

  // Les sous-playlists déjà listées par une playlist maître sont masquées.
  const referenced = new Set();
  for (const p of parsed) {
    if (p.pl?.type !== "master") continue;
    for (const x of [...p.pl.variants, ...p.pl.audio]) {
      referenced.add(x.url);
      referenced.add(stripQuery(x.url));
    }
  }

  let count = 0;

  for (const p of parsed) {
    const url = p.it.url;
    if (p.error) {
      count++;
      listEl.append(
        card("Flux HLS", "non lisible ici", url, [
          el("button", { onclick: () => openDownloader({ url, title, page }) }, "Essayer quand même"),
        ])
      );
      continue;
    }
    const pl = p.pl;
    if (pl.type === "media" && (referenced.has(url) || referenced.has(stripQuery(url)))) continue;
    count++;

    if (pl.encrypted) {
      listEl.append(
        card("Flux HLS protégé", "chiffré", url, [
          el("p", { class: "note" }, "Contenu protégé : non pris en charge."),
        ])
      );
      continue;
    }

    if (pl.type === "master") {
      const actions = pl.variants.map((v) => {
        const label = HLS.variantLabel(v);
        return el("button", { onclick: () => openDownloader({ url: v.url, title, page, label }) }, label);
      });
      const seen = new Set();
      for (const a of pl.audio) {
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        const label = "audio " + a.name;
        actions.push(
          el("button", { class: "secondary", onclick: () => openDownloader({ url: a.url, title, page, label }) }, "Audio · " + a.name)
        );
      }
      const separateAudio = pl.variants.some((v) => v.audioGroup && pl.audio.some((a) => a.group === v.audioGroup));
      if (separateAudio) {
        actions.push(el("p", { class: "note" }, "Le son est dans une piste séparée : téléchargez aussi la piste audio."));
      }
      listEl.append(card("Flux HLS", `${pl.variants.length} qualité(s)`, url, actions));
    } else {
      const meta = pl.live ? "en direct" : Util.formatDuration(pl.duration);
      listEl.append(
        card("Flux HLS", meta, url, [
          el("button", { onclick: () => openDownloader({ url, title, page }) }, "Télécharger"),
        ])
      );
    }
  }

  for (const v of videoItems) {
    count++;
    const ext = Util.videoExt(v.url, v.mime);
    const btn = el(
      "button",
      {
        onclick: async () => {
          try {
            await chrome.downloads.download({ url: v.url, filename: Util.safeName(title) + "." + ext });
            btn.textContent = "Téléchargement lancé ✓";
            btn.disabled = true;
          } catch (e) {
            btn.textContent = "Échec : " + e.message;
          }
        },
      },
      "Télécharger"
    );
    listEl.append(card("Vidéo " + ext.toUpperCase(), Util.formatBytes(v.size), v.url, [btn]));
  }

  loadingEl.hidden = true;
  emptyEl.hidden = count > 0;
}

main().catch((e) => {
  loadingEl.textContent = "Erreur : " + e.message;
});
