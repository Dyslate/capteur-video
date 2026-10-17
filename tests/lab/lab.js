// Shared script of the lab pages: every request and media event is written to the
// page's own log (and the console), so you can see exactly what the page loaded.

const started = performance.now();
const out = () => document.getElementById("lablog");

export function labLog(text, cls = "") {
  const t = ((performance.now() - started) / 1000).toFixed(2).padStart(6);
  const line = `[${t} s] ${text}`;
  console.log("[lab]", line);
  const el = out();
  if (!el) return;
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = line + "\n";
  el.append(span);
}

// fetch() with a log line: status, size, content type and timing.
export async function labFetch(url, init) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, init);
    const body = await r.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    labLog(`GET ${url} → ${r.status} · ${body.byteLength} B · ${r.headers.get("content-type") || "?"} · ${ms} ms`, r.ok ? "ok" : "err");
    return { response: r, body };
  } catch (e) {
    labLog(`GET ${url} → FAILED ${e.message}`, "err");
    throw e;
  }
}

// Logs the life of a <video> / <audio> element.
export function watchMedia(el) {
  const name = el.tagName.toLowerCase();
  labLog(`<${name}> source: ${el.currentSrc || el.getAttribute("src")}`);
  el.addEventListener("loadedmetadata", () =>
    labLog(`<${name}> metadata: ${el.duration.toFixed(2)} s${el.videoWidth ? ` · ${el.videoWidth}×${el.videoHeight}` : ""}`, "ok"));
  el.addEventListener("playing", () => labLog(`<${name}> playing`, "ok"));
  el.addEventListener("error", () =>
    labLog(`<${name}> error ${el.error?.code} ${el.error?.message || ""} (codec not supported by this browser?)`, "err"));
}

// base64url JSON, like the "efg" parameter of Instagram's CDN URLs.
export function efg(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

labLog(`page ${location.pathname} loaded`);
