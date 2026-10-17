// Output formats and qualities offered on every media card, and which engine
// (the browser or the local yt-dlp helper) produces each one.

export const MP3_BITRATES = [128, 192, 256, 320];
export const OPUS_BITRATES = [96, 128, 160];
export const AAC_BITRATES = [128, 192, 256];
export const HELPER_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

// engine: "browser" (always available), "helper" (local module only), "auto" (decided per media)
export const FORMATS = [
  { id: "mp4", label: "MP4", group: "video", engine: "auto" },
  { id: "mp4-silent", label: "MP4 without sound", group: "video", engine: "browser" },
  { id: "mkv", label: "MKV", group: "video", engine: "helper" },
  { id: "mp3", label: "MP3", group: "audio", engine: "browser", bitrates: MP3_BITRATES, defaultBitrate: 192 },
  { id: "m4a", label: "M4A (AAC)", group: "audio", engine: "auto", bitrates: AAC_BITRATES, defaultBitrate: 192 },
  { id: "opus", label: "Opus", group: "audio", engine: "helper", bitrates: OPUS_BITRATES, defaultBitrate: 128 },
  { id: "wav", label: "WAV (lossless)", group: "audio", engine: "browser" },
  { id: "flac", label: "FLAC (lossless)", group: "audio", engine: "helper" },
];

export const formatById = (id) => FORMATS.find((f) => f.id === id);

// Which engine produces `format` for `media`, or null when it is not possible.
//   media:  { kind, audioOnly, variants:[{ video, audio }] } from the panel, or { pageOnly:true }
//   helper: whether the local module is installed and usable
export function engineFor(format, media, helper) {
  const f = typeof format === "string" ? formatById(format) : format;
  if (!f) return null;
  if (media.pageOnly) return helper && f.id !== "mp4-silent" ? "helper" : null;
  const v = media.variants?.[0] || {};
  const separateAudio = !!v.audio && !!v.video;

  if (media.audioOnly && f.group === "video") return null;

  switch (f.id) {
    case "mp4":
      // The browser cannot turn HLS transport streams into MP4; the module can.
      if (media.kind === "hls" && helper) return "helper";
      return "browser";
    case "mp4-silent":
      return separateAudio ? "browser" : null;
    case "m4a":
      // A separate AAC track can be saved as is; otherwise ffmpeg has to extract it.
      if (v.audio && (v.audio.type === "file" || v.audio.type === "segments") && (!v.video || separateAudio)) return "browser";
      return helper ? "helper" : null;
    default:
      if (f.engine === "helper") return helper ? "helper" : null;
      return "browser";
  }
}

// Quality choices for a format: [{ value, label }]. The first one is the default.
//   videoChoices: the media's own video qualities ([{ value, label }]), if any
export function qualitiesFor(format, engine, videoChoices = []) {
  const f = typeof format === "string" ? formatById(format) : format;
  if (!f) return [];
  if (f.bitrates) {
    return f.bitrates
      .slice()
      .sort((a, b) => (a === f.defaultBitrate ? -1 : b === f.defaultBitrate ? 1 : b - a))
      .map((kbps) => ({ value: String(kbps), label: `${kbps} kb/s` }));
  }
  if (f.group !== "video") return [];
  if (videoChoices.length) return videoChoices;
  if (engine === "helper") {
    return [{ value: "", label: "Best quality" }, ...HELPER_HEIGHTS.map((h) => ({ value: String(h), label: `${h}p max` }))];
  }
  return [];
}
