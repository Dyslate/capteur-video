// MP3 encoding in a worker (lamejs) so the panel stays responsive.
importScripts("../vendor/lame.min.js");

function toInt16(f32, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i - start] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

self.onmessage = ({ data }) => {
  try {
    const { left, right, sampleRate, kbps } = data;
    const channels = right ? 2 : 1;
    const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps || 192);
    const BLOCK = 1152 * 20;
    const chunks = [];
    let lastReport = 0;
    for (let i = 0; i < left.length; i += BLOCK) {
      const end = Math.min(left.length, i + BLOCK);
      const l = toInt16(left, i, end);
      const buf = channels === 2 ? encoder.encodeBuffer(l, toInt16(right, i, end)) : encoder.encodeBuffer(l);
      if (buf.length) chunks.push(new Uint8Array(buf));
      const progress = end / left.length;
      if (progress - lastReport > 0.02) {
        lastReport = progress;
        self.postMessage({ type: "progress", progress });
      }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    self.postMessage({ type: "done", chunks });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
  }
};
