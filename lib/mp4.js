// Minimal MP4 (ISO BMFF) reader and muxer, dependency-free.
//  - probe(): which tracks a file holds (video, audio), fragmented or not
//  - mux():   merges a video track and an audio track coming from two files
//             (Instagram, Facebook and DASH streams in general)

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "moof", "traf", "dinf"]);
const enc = new TextEncoder();

// ---------- reading ----------

function dv(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function fourcc(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

export function readBoxes(u8, start = 0, end = u8.length) {
  const view = dv(u8);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = fourcc(u8, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    out.push({ type, start: p, size, header, end: p + size, truncated: p + size > end });
    if (p + size > end) break;
    p += size;
  }
  return out;
}

function childrenOf(u8, box) {
  return readBoxes(u8, box.start + box.header, Math.min(box.end, u8.length));
}

function child(u8, box, type) {
  return childrenOf(u8, box).find((b) => b.type === type);
}

function path(u8, box, types) {
  let cur = box;
  for (const t of types) {
    cur = cur && child(u8, cur, t);
  }
  return cur || null;
}

function walk(u8, box, visit) {
  visit(box);
  if (CONTAINERS.has(box.type)) for (const c of childrenOf(u8, box)) walk(u8, c, visit);
}

// "Full box" fields: 1-byte version, then 3 bytes of flags.
function version(u8, box) {
  return u8[box.start + box.header];
}

function flags(u8, box) {
  const p = box.start + box.header;
  return (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
}

// Offset of the track_ID field in tkhd
function tkhdIdPos(u8, tkhd) {
  return tkhd.start + tkhd.header + 4 + (version(u8, tkhd) === 1 ? 16 : 8);
}

function tkhdDurationPos(u8, tkhd) {
  return tkhdIdPos(u8, tkhd) + 8;
}

function readTime(u8, box, offsetV0, offsetV1) {
  const view = dv(u8);
  const v1 = version(u8, box) === 1;
  const p = box.start + box.header + (v1 ? offsetV1 : offsetV0);
  return v1 ? Number(view.getBigUint64(p)) : view.getUint32(p);
}

// mvhd / mdhd: timescale and duration
function timescaleOf(u8, box) {
  const v1 = version(u8, box) === 1;
  return dv(u8).getUint32(box.start + box.header + (v1 ? 20 : 12));
}

function durationOf(u8, box) {
  return readTime(u8, box, 16, 24);
}

function trackInfo(u8, trak) {
  const tkhd = child(u8, trak, "tkhd");
  const mdhd = path(u8, trak, ["mdia", "mdhd"]);
  const hdlr = path(u8, trak, ["mdia", "hdlr"]);
  const view = dv(u8);
  const handler = hdlr ? fourcc(u8, hdlr.start + hdlr.header + 8) : "";
  const id = view.getUint32(tkhdIdPos(u8, tkhd));
  const width = view.getUint32(tkhd.end - 8) / 65536;
  const height = view.getUint32(tkhd.end - 4) / 65536;
  const timescale = mdhd ? timescaleOf(u8, mdhd) : 0;
  const duration = mdhd ? durationOf(u8, mdhd) : 0;
  return {
    id,
    kind: handler === "vide" ? "video" : handler === "soun" ? "audio" : handler,
    width,
    height,
    timescale,
    seconds: timescale ? duration / timescale : 0,
    box: trak,
  };
}

// Inspects a file (or the beginning of one).
// Returns { ok:false, needed } when the moov box is not fully present.
export function probe(u8) {
  const top = readBoxes(u8);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) {
    const last = top[top.length - 1];
    const sawData = top.some((b) => b.type === "mdat");
    return { ok: false, needed: sawData ? null : last ? last.end + 65536 : null };
  }
  if (moov.truncated) return { ok: false, needed: moov.end };
  const mvhd = child(u8, moov, "mvhd");
  const tracks = childrenOf(u8, moov).filter((b) => b.type === "trak").map((t) => trackInfo(u8, t));
  const movieSeconds = mvhd && timescaleOf(u8, mvhd) ? durationOf(u8, mvhd) / timescaleOf(u8, mvhd) : 0;
  return {
    ok: true,
    fragmented: !!child(u8, moov, "mvex"),
    hasVideo: tracks.some((t) => t.kind === "video"),
    hasAudio: tracks.some((t) => t.kind === "audio"),
    width: Math.max(0, ...tracks.filter((t) => t.kind === "video").map((t) => t.width)),
    height: Math.max(0, ...tracks.filter((t) => t.kind === "video").map((t) => t.height)),
    seconds: movieSeconds || Math.max(0, ...tracks.map((t) => t.seconds)),
    tracks: tracks.map(({ box, ...t }) => t),
  };
}

// ---------- writing ----------

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function makeBox(type, ...payload) {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  dv(out).setUint32(0, out.length);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
}

const copy = (u8, box) => u8.slice(box.start, box.end);

// Rewrites the track_ID inside a copied trak (tkhd), traf (tfhd) or trex.
function setTrackId(buf, newId) {
  const root = readBoxes(buf)[0];
  walk(buf, root, (b) => {
    if (b.type === "tkhd") dv(buf).setUint32(tkhdIdPos(buf, b), newId);
    if (b.type === "tfhd" || b.type === "trex") dv(buf).setUint32(b.start + b.header + 4, newId);
  });
}

// Converts durations expressed in the movie timescale (tkhd, elst).
function rescaleMovieTimes(buf, from, to) {
  if (from === to || !from) return;
  const view = dv(buf);
  const scale = (x) => Math.round((x * to) / from);
  walk(buf, readBoxes(buf)[0], (b) => {
    if (b.type === "tkhd") {
      const p = tkhdDurationPos(buf, b);
      if (version(buf, b) === 1) view.setBigUint64(p, BigInt(scale(Number(view.getBigUint64(p)))));
      else view.setUint32(p, Math.min(0xffffffff, scale(view.getUint32(p))));
    }
    if (b.type === "elst") {
      const v1 = version(buf, b) === 1;
      const count = view.getUint32(b.start + b.header + 4);
      let p = b.start + b.header + 8;
      for (let i = 0; i < count; i++) {
        if (v1) view.setBigUint64(p, BigInt(scale(Number(view.getBigUint64(p)))));
        else view.setUint32(p, Math.min(0xffffffff, scale(view.getUint32(p))));
        p += v1 ? 20 : 12;
      }
    }
  });
}

function analyze(u8, label) {
  const top = readBoxes(u8);
  const moov = top.find((b) => b.type === "moov");
  if (!moov || moov.truncated) throw new Error(`${label} file incomplete or not MP4`);
  const mvhd = child(u8, moov, "mvhd");
  const traks = childrenOf(u8, moov).filter((b) => b.type === "trak").map((t) => trackInfo(u8, t));
  return {
    u8,
    top,
    ftyp: top.find((b) => b.type === "ftyp"),
    moov,
    mvhd,
    mvex: child(u8, moov, "mvex"),
    traks,
    movieTimescale: timescaleOf(u8, mvhd),
    movieDuration: durationOf(u8, mvhd),
  };
}

function patchMvhd(buf, duration, nextId) {
  const box = readBoxes(buf)[0];
  const view = dv(buf);
  const v1 = version(buf, box) === 1;
  const p = box.start + box.header + (v1 ? 24 : 16);
  if (v1) view.setBigUint64(p, BigInt(duration));
  else view.setUint32(p, Math.min(0xffffffff, duration));
  view.setUint32(box.end - 4, nextId);
}

// Merges a video track (file V) with an audio track (file A).
export function mux(videoBytes, audioBytes) {
  const V = analyze(videoBytes, "Video");
  const A = analyze(audioBytes, "Audio");
  const vTrak = V.traks.find((t) => t.kind === "video");
  const aTrak = A.traks.find((t) => t.kind === "audio");
  if (!vTrak) throw new Error("No video track in the video file");
  if (!aTrak) throw new Error("No audio track in the audio file");
  if (!!V.mvex !== !!A.mvex) throw new Error("The two tracks use different layouts (fragmented / regular)");

  const vId = vTrak.id;
  const aId = vId === aTrak.id ? vId + 1 : aTrak.id;

  // Copied tracks
  const vTrakBuf = copy(V.u8, vTrak.box);
  const aTrakBuf = copy(A.u8, aTrak.box);
  setTrackId(aTrakBuf, aId);
  rescaleMovieTimes(aTrakBuf, A.movieTimescale, V.movieTimescale);

  const aDuration = Math.round((A.movieDuration * V.movieTimescale) / (A.movieTimescale || 1));
  const mvhdBuf = copy(V.u8, V.mvhd);
  patchMvhd(mvhdBuf, Math.max(V.movieDuration, aDuration), Math.max(vId, aId) + 1);

  const ftyp = V.ftyp ? copy(V.u8, V.ftyp) : makeBox("ftyp", enc.encode("isom"), new Uint8Array(4), enc.encode("isomiso2avc1mp41"));

  return V.mvex
    ? muxFragmented(V, A, { ftyp, mvhdBuf, vTrakBuf, aTrakBuf, vId, aId, aOldId: aTrak.id })
    : muxProgressive(V, A, { ftyp, mvhdBuf, vTrakBuf, aTrakBuf, vId, aId });
}

// --- regular files: moov + mdat ---
function muxProgressive(V, A, { ftyp, mvhdBuf, vTrakBuf, aTrakBuf, vId }) {
  const moov = makeBox("moov", mvhdBuf, vTrakBuf, aTrakBuf);
  const vData = V.top.filter((b) => b.type === "mdat");
  const aData = A.top.filter((b) => b.type === "mdat");

  let pos = ftyp.length + moov.length;
  const map = (boxes) =>
    boxes.map((b) => {
      const m = { oldStart: b.start, oldEnd: b.end, newStart: pos };
      pos += b.size;
      return m;
    });
  const vMap = map(vData);
  const aMap = map(aData);
  const total = pos;

  // Update the sample chunk offsets (stco / co64)
  const view = dv(moov);
  walk(moov, readBoxes(moov)[0], (b) => {
    if (b.type !== "trak") return;
    const tkhd = child(moov, b, "tkhd");
    const ranges = view.getUint32(tkhdIdPos(moov, tkhd)) === vId ? vMap : aMap;
    const stbl = path(moov, b, ["mdia", "minf", "stbl"]);
    for (const t of childrenOf(moov, stbl)) {
      if (t.type !== "stco" && t.type !== "co64") continue;
      const count = view.getUint32(t.start + t.header + 4);
      let p = t.start + t.header + 8;
      for (let i = 0; i < count; i++) {
        const old = t.type === "stco" ? view.getUint32(p) : Number(view.getBigUint64(p));
        const r = ranges.find((m) => old >= m.oldStart && old < m.oldEnd);
        if (!r) throw new Error("Sample offset outside the data");
        const now = r.newStart + (old - r.oldStart);
        if (t.type === "stco") {
          if (now > 0xffffffff) throw new Error("File too large (> 4 GB)");
          view.setUint32(p, now);
          p += 4;
        } else {
          view.setBigUint64(p, BigInt(now));
          p += 8;
        }
      }
    }
  });

  const out = new Uint8Array(total);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  for (const [boxes, maps, src] of [[vData, vMap, V.u8], [aData, aMap, A.u8]]) {
    boxes.forEach((b, i) => out.set(src.subarray(b.start, b.end), maps[i].newStart));
  }
  return out;
}

// --- fragmented files: moov (mvex) + moof/mdat ---
function fragments(F, timescaleById) {
  const units = [];
  let cur = null;
  for (const b of F.top) {
    if (b.type === "moof") {
      cur = { moof: b, data: [] };
      units.push(cur);
    } else if (b.type === "mdat" && cur) {
      cur.data.push(b);
    }
  }
  for (const u of units) {
    const traf = child(F.u8, u.moof, "traf");
    const tfhd = traf && child(F.u8, traf, "tfhd");
    const tfdt = traf && child(F.u8, traf, "tfdt");
    const id = tfhd ? dv(F.u8).getUint32(tfhd.start + tfhd.header + 4) : 0;
    const ts = timescaleById[id] || 1;
    u.time = tfdt ? readTime(F.u8, tfdt, 4, 4) / ts : null;
  }
  return units;
}

function muxFragmented(V, A, { ftyp, mvhdBuf, vTrakBuf, aTrakBuf, vId, aId, aOldId }) {
  const trexOf = (F, id) =>
    childrenOf(F.u8, F.mvex).find((b) => b.type === "trex" && dv(F.u8).getUint32(b.start + b.header + 4) === id);
  const vTrex = trexOf(V, vId);
  const aTrexBox = trexOf(A, aOldId);
  if (!vTrex || !aTrexBox) throw new Error("Missing fragment defaults (trex)");
  const aTrex = copy(A.u8, aTrexBox);
  setTrackId(aTrex, aId);
  const mvex = makeBox("mvex", copy(V.u8, vTrex), aTrex);
  const moov = makeBox("moov", mvhdBuf, vTrakBuf, aTrakBuf, mvex);

  const tsV = Object.fromEntries(V.traks.map((t) => [t.id, t.timescale]));
  const tsA = Object.fromEntries(A.traks.map((t) => [t.id, t.timescale]));
  const units = [
    ...fragments(V, tsV).map((u) => ({ ...u, src: V.u8, newId: null })),
    ...fragments(A, tsA).map((u) => ({ ...u, src: A.u8, newId: aId })),
  ];
  if (units.every((u) => u.time !== null)) units.sort((x, y) => x.time - y.time);

  const parts = [ftyp, moov];
  let pos = ftyp.length + moov.length;
  let seq = 1;
  for (const u of units) {
    const moof = copy(u.src, u.moof);
    const delta = pos - u.moof.start; // how far the data moved in the new file
    const view = dv(moof);
    walk(moof, readBoxes(moof)[0], (b) => {
      if (b.type === "mfhd") view.setUint32(b.start + b.header + 4, seq++);
      if (b.type === "tfhd") {
        if (u.newId) view.setUint32(b.start + b.header + 4, u.newId);
        if (flags(moof, b) & 0x000001) {
          // absolute base_data_offset: shift it
          const p = b.start + b.header + 8;
          view.setBigUint64(p, BigInt(Number(view.getBigUint64(p)) + delta));
        }
      }
    });
    parts.push(moof);
    pos += moof.length;
    // mdat boxes follow their moof in the source file: keep their relative distance
    let last = u.moof.end;
    for (const d of u.data) {
      if (d.start !== last) {
        // a box sits in between (free, sidx…): keep the gap so relative offsets stay valid
        const gap = makeBox("free", new Uint8Array(Math.max(0, d.start - last - 8)));
        parts.push(gap);
        pos += gap.length;
      }
      parts.push(u.src.subarray(d.start, d.end));
      pos += d.size;
      last = d.end;
    }
  }
  return concat(parts);
}

// Container type from the first bytes
export function sniff(u8) {
  if (u8.length < 12) return null;
  if (u8[0] === 0x47) return "ts";
  const t = fourcc(u8, 4);
  if (["ftyp", "styp", "moov", "moof", "sidx", "free", "mdat"].includes(t)) return "mp4";
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return "webm";
  if ((u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0)) return "aac";
  return null;
}
