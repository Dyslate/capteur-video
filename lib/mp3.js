// MP3 conversion: the browser decodes the audio, lamejs encodes it in a worker.

const SAMPLE_RATE = 44100;

export async function decodeAudio(bytes) {
  const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    return await ctx.decodeAudioData(ab);
  } catch {
    throw new Error("The browser cannot decode the audio of this media");
  }
}

// Minimal ID3v2.3 header holding the title (TIT2), UTF-16 encoded.
function id3(title) {
  if (!title) return new Uint8Array(0);
  const text = [0xff, 0xfe];
  for (const ch of String(title).slice(0, 200)) {
    const c = ch.charCodeAt(0);
    text.push(c & 0xff, c >> 8);
  }
  const frameBody = [1, ...text]; // 1 = UTF-16 with BOM
  const frame = [0x54, 0x49, 0x54, 0x32, ...be32(frameBody.length), 0, 0, ...frameBody];
  const size = frame.length;
  const synchsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  return new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe, ...frame]);
}

function be32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function encodeMp3(audioBuffer, { title, kbps = 192, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/mp3-worker.js", import.meta.url));
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress?.(data.progress);
      else if (data.type === "done") {
        signal?.removeEventListener("abort", stop);
        worker.terminate();
        resolve(new Blob([id3(title), ...data.chunks], { type: "audio/mpeg" }));
      } else if (data.type === "error") {
        worker.terminate();
        reject(new Error("MP3 encoding failed: " + data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error("MP3 encoder unavailable: " + e.message));
    };
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    worker.postMessage({ left, right, sampleRate: audioBuffer.sampleRate, kbps });
  });
}
