// Data fetching (whole files or segments) from the panel.

import { createLogger } from "./log.js";

const flog = createLogger("panel").scope("fetch");
const CONCURRENCY = 6;
const RETRIES = 3;
let nextRuleId = 1000;

// Adds the source page's Referer / Origin to the extension's requests to these hosts.
// Some CDNs reject requests without them.
export async function withReferer(pageUrl, urls, fn) {
  let ruleId = null;
  try {
    if (/^https?:/i.test(pageUrl)) {
      const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
      ruleId = nextRuleId++;
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "referer", operation: "set", value: pageUrl },
                { header: "origin", operation: "set", value: new URL(pageUrl).origin },
              ],
            },
            condition: {
              initiatorDomains: [chrome.runtime.id],
              requestDomains: hosts,
              resourceTypes: ["xmlhttprequest"],
            },
          },
        ],
      });
      flog.debug(`Referer rule ${ruleId} added`, { referer: pageUrl, hosts });
    }
  } catch (e) {
    flog.warn("Referer not applied", e);
    ruleId = null;
  }
  try {
    return await fn();
  } finally {
    if (ruleId !== null) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}

async function fetchOnce(url, { range, signal, onBytes }) {
  const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
  const r = await fetch(url, { credentials: "include", headers, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!r.body || !onBytes) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

async function fetchRetry(url, opts) {
  for (let attempt = 1; ; attempt++) {
    let counted = 0;
    try {
      return await fetchOnce(url, {
        ...opts,
        onBytes: (n) => {
          counted += n;
          opts.onBytes?.(n);
        },
      });
    } catch (e) {
      opts.onBytes?.(-counted); // roll back the progress of the failed attempt
      if (opts.signal?.aborted) throw e;
      if (attempt >= RETRIES) {
        flog.error(`giving up after ${attempt} attempts`, { url, range: opts.range || null, error: e.message });
        throw e;
      }
      flog.warn(`attempt ${attempt} failed, retrying`, { url, range: opts.range || null, error: e.message });
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
}

export async function fetchText(url, signal) {
  const r = await fetch(url, { credentials: "include", signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Reads the beginning of a file (to find out what it contains).
export async function fetchHead(url, length, signal) {
  const r = await fetch(url, { credentials: "include", headers: { Range: `bytes=0-${length - 1}` }, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return buf.length > length ? buf.subarray(0, length) : buf;
}

// Fetches a list of segments [{url, range}] and concatenates them.
// onProgress(fraction 0..1, bytes received)
export async function fetchSegments(segments, { signal, onProgress } = {}) {
  const parts = new Array(segments.length);
  let done = 0;
  let bytes = 0;
  const report = () => onProgress?.(segments.length === 1 ? null : done / segments.length, bytes);
  let next = 0;
  // Internal controller: an error on one segment stops the others too.
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const worker = async () => {
    while (next < segments.length && !controller.signal.aborted) {
      const i = next++;
      const seg = segments[i];
      parts[i] = await fetchRetry(seg.url, {
        range: seg.range,
        signal: controller.signal,
        onBytes: (n) => {
          bytes += n;
          report();
        },
      });
      done++;
      report();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));
  } catch (e) {
    controller.abort();
    throw signal?.aborted ? new DOMException("Cancelled", "AbortError") : e;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
