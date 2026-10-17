// DASH manifest (.mpd) parser: SegmentBase, SegmentList, SegmentTemplate (+ SegmentTimeline).
// Needs DOMParser (extension pages). Node tests can inject their own parser.

export function parseDuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  const [, d, h, mi, se] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + mi * 60 + se;
}

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

function resolveBase(chain, start) {
  let base = start;
  for (const el of chain) {
    const b = kid(el, "BaseURL");
    if (b && b.textContent.trim()) base = new URL(b.textContent.trim(), base).href;
  }
  return base;
}

// Merges the attributes of an element declared at several levels (Period > AdaptationSet > Representation).
function inherited(chain, name) {
  const found = chain.map((el) => kid(el, name)).filter(Boolean);
  if (!found.length) return null;
  const attrs = {};
  for (const el of found) for (const a of el.attributes) attrs[a.name] = a.value;
  const deepest = found[found.length - 1];
  const timeline = found.map((el) => kid(el, "SegmentTimeline")).filter(Boolean).pop() || null;
  const init = found.map((el) => kid(el, "Initialization")).filter(Boolean).pop() || null;
  return { attrs, el: deepest, timeline, init };
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|)(?:%0(\d+)d)?\$/g, (_, key, width) => {
    if (key === "") return "$";
    const v = String(vars[key] ?? "");
    return width ? v.padStart(Number(width), "0") : v;
  });
}

function parseRangeAttr(s) {
  if (!s) return null;
  const [a, b] = s.split("-").map(Number);
  return { offset: a, length: b - a + 1 };
}

function buildSegments(chain, rep, base, periodSeconds) {
  const id = rep.getAttribute("id") || "";
  const bandwidth = rep.getAttribute("bandwidth") || "";

  const tpl = inherited(chain, "SegmentTemplate");
  if (tpl) {
    const a = tpl.attrs;
    const timescale = Number(a.timescale) || 1;
    const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
    const segs = [];
    if (a.initialization) {
      segs.push({ url: new URL(fillTemplate(a.initialization, { RepresentationID: id, Bandwidth: bandwidth }), base).href, init: true });
    }
    if (tpl.timeline) {
      let time = 0;
      let number = startNumber;
      const S = kids(tpl.timeline, "S");
      S.forEach((s, i) => {
        if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
        const d = Number(s.getAttribute("d"));
        let r = Number(s.getAttribute("r") || 0);
        if (r < 0) {
          const next = S[i + 1]?.hasAttribute("t") ? Number(S[i + 1].getAttribute("t")) : periodSeconds * timescale;
          r = Math.max(0, Math.ceil((next - time) / d) - 1);
        }
        for (let k = 0; k <= r; k++) {
          segs.push({ url: new URL(fillTemplate(a.media, { RepresentationID: id, Bandwidth: bandwidth, Number: number, Time: time }), base).href });
          time += d;
          number++;
        }
      });
    } else if (a.duration && a.media) {
      const count = Math.ceil((periodSeconds * timescale) / Number(a.duration));
      for (let k = 0; k < count; k++) {
        const number = startNumber + k;
        const time = k * Number(a.duration);
        segs.push({ url: new URL(fillTemplate(a.media, { RepresentationID: id, Bandwidth: bandwidth, Number: number, Time: time }), base).href });
      }
    }
    return segs;
  }

  const list = inherited(chain, "SegmentList");
  if (list) {
    const segs = [];
    if (list.init) {
      const src = list.init.getAttribute("sourceURL");
      segs.push({ url: src ? new URL(src, base).href : base, range: parseRangeAttr(list.init.getAttribute("range")), init: true });
    }
    for (const s of kids(list.el, "SegmentURL")) {
      const media = s.getAttribute("media");
      segs.push({ url: media ? new URL(media, base).href : base, range: parseRangeAttr(s.getAttribute("mediaRange")) });
    }
    return segs;
  }

  // SegmentBase or nothing: one complete file (Instagram / Facebook style)
  return [{ url: base, range: null }];
}

export function parseMpd(xmlText, mpdUrl, parser = typeof DOMParser !== "undefined" ? new DOMParser() : null) {
  if (!parser) throw new Error("DOMParser indisponible");
  const doc = parser.parseFromString(xmlText, "application/xml");
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD" || doc.getElementsByTagName("parsererror").length) {
    throw new Error("Ce n'est pas un manifeste DASH");
  }
  const live = mpd.getAttribute("type") === "dynamic";
  const total = parseDuration(mpd.getAttribute("mediaPresentationDuration"));
  const period = kid(mpd, "Period");
  if (!period) throw new Error("Manifeste DASH vide");
  const periodSeconds = parseDuration(period.getAttribute("duration")) || total;
  const encrypted = doc.getElementsByTagName("ContentProtection").length > 0;

  const video = [];
  const audio = [];
  for (const as of kids(period, "AdaptationSet")) {
    for (const rep of kids(as, "Representation")) {
      const mime = rep.getAttribute("mimeType") || as.getAttribute("mimeType") || "";
      const type = as.getAttribute("contentType") || mime.split("/")[0];
      if (type !== "video" && type !== "audio") continue;
      const chain = [period, as, rep];
      const base = resolveBase([mpd, period, as, rep], mpdUrl);
      const entry = {
        id: rep.getAttribute("id") || "",
        kind: type,
        mime,
        codecs: rep.getAttribute("codecs") || as.getAttribute("codecs") || "",
        bandwidth: Number(rep.getAttribute("bandwidth")) || 0,
        width: Number(rep.getAttribute("width") || as.getAttribute("width")) || 0,
        height: Number(rep.getAttribute("height") || as.getAttribute("height")) || 0,
        segments: buildSegments(chain, rep, base, periodSeconds),
      };
      (type === "video" ? video : audio).push(entry);
    }
  }
  video.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return { live, duration: total, encrypted, video, audio };
}
