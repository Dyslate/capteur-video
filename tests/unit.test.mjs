// Unit tests: run with `npm test` (Node 18+). MP4 tests need ffmpeg to build fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseHls } from "../lib/hls.js";
import { probe, mux, sniff } from "../lib/mp4.js";
import { excludedService, helperOnly, isIgnoredRequest, isGatedStream } from "../lib/policy.js";
import { safeName, asciiName, cleanTitle, decodeEfg, formatDuration, estimateBytes, download, formatBytes } from "../lib/util.js";
import { engineFor, qualitiesFor } from "../lib/formats.js";
import { progressFromItem, baseName, isUserCancel, decoyNote } from "../lib/downloads.js";

const BASE = "https://cdn.example.com/v/master.m3u8?tok=1";

test("HLS master playlist", () => {
  const pl = parseHls(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",DEFAULT=YES,URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,AUDIO="aud"
https://other.cdn/1080/index.m3u8
`,
    BASE
  );
  assert.equal(pl.type, "master");
  assert.equal(pl.variants[0].height, 1080);
  assert.equal(pl.variants[1].url, "https://cdn.example.com/v/360/index.m3u8");
  assert.equal(pl.audio[0].url, "https://cdn.example.com/v/audio/fr.m3u8");
  assert.equal(pl.audio[0].isDefault, true);
});

test("HLS media playlist: init segment, byte ranges, encryption", () => {
  const pl = parseHls(
    `#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="700@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@700
all.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500
all.mp4
#EXT-X-ENDLIST`,
    BASE
  );
  assert.deepEqual(pl.segments.map((s) => s.range), [{ length: 700, offset: 0 }, { length: 1000, offset: 700 }, { length: 500, offset: 1700 }]);
  assert.equal(pl.duration, 8);
  assert.equal(pl.live, false);
  assert.equal(parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:6,\ns.ts', BASE).encrypted, true);
  assert.throws(() => parseHls("<html>", BASE));
});

test("site policy", () => {
  // DRM_SERVICES in lib/policy.js is a user-editable list; it is currently empty, so no
  // site is pre-excluded by name. Encrypted streams are still refused by the stream-level
  // detection (hls.js / dash.js) and by the helper, which this test does not cover.
  assert.equal(excludedService("https://www.instagram.com/reel/abc/"), null);
  // YouTube: helper in the personal build, excluded in the store build
  assert.equal(excludedService("https://www.youtube.com/watch?v=x", "personal"), null);
  assert.equal(excludedService("https://www.youtube.com/watch?v=x", "store"), "YouTube");
  assert.equal(helperOnly("https://m.youtube.com/watch?v=x", "personal"), true);
  assert.equal(helperOnly("https://m.youtube.com/watch?v=x", "store"), false);
  assert.equal(isIgnoredRequest("https://rr1---sn-x.googlevideo.com/videoplayback?x=1"), true);
});

test("isGatedStream flags hosts that serve a decoy to direct downloads", () => {
  assert.equal(isGatedStream("https://strm3.uqload.vc/hls2/01/0547/index-v1-a1.m3u8?t=x&s=y&e=14400"), true);
  assert.equal(isGatedStream("https://uqload.com/embed-abc.html"), true);
  assert.equal(isGatedStream("https://scontent.cdninstagram.com/v/reel.mp4"), false);
  assert.equal(isGatedStream("not a url"), false);
});

test("utilities", () => {
  assert.equal(safeName('Ma vidéo: "test" / 2'), "Ma vidéo test 2");
  assert.equal(asciiName("Été à Paris"), "Ete a Paris");
  assert.equal(cleanTitle("(3) Un reel sympa • Instagram"), "Un reel sympa");
  assert.equal(cleanTitle("Ma vidéo - YouTube"), "Ma vidéo");
  assert.equal(cleanTitle("Lab 06 · Pistes séparées (style Instagram)"), "Lab 06 · Pistes séparées (style Instagram)");
  assert.equal(formatDuration(3725), "1:02:05");
  const efg = Buffer.from(JSON.stringify({ vencode_tag: "dash_audio", xpv_asset_id: 42 })).toString("base64url");
  assert.deepEqual(decodeEfg(`https://scontent.cdninstagram.com/v/a.mp4?efg=${efg}`), { asset: 42, tag: "dash_audio" });
});

test("formats: engine choice and qualities", () => {
  const split = { kind: "file", variants: [{ video: { type: "file" }, audio: { type: "file" } }] };
  const muxed = { kind: "file", variants: [{ video: { type: "file", direct: true }, audio: null }] };
  const hls = { kind: "hls", variants: [{ video: { type: "hls" }, audio: null }] };
  const audioOnly = { kind: "file", audioOnly: true, variants: [{ video: null, audio: { type: "file" } }] };
  const page = { pageOnly: true };

  assert.equal(engineFor("mp4", split, false), "browser");
  assert.equal(engineFor("mp4-silent", split, false), "browser");
  assert.equal(engineFor("mp4-silent", muxed, true), null);
  assert.equal(engineFor("mp4", hls, true), "helper"); // TS → real MP4 needs ffmpeg
  assert.equal(engineFor("mp4", hls, false), "browser");
  assert.equal(engineFor("m4a", split, false), "browser"); // separate AAC track, saved as is
  assert.equal(engineFor("m4a", muxed, false), null);
  assert.equal(engineFor("m4a", muxed, true), "helper");
  assert.equal(engineFor("mkv", split, false), null);
  assert.equal(engineFor("flac", split, true), "helper");
  assert.equal(engineFor("mp4", audioOnly, true), null);
  assert.equal(engineFor("mp3", audioOnly, false), "browser");
  assert.equal(engineFor("mp3", page, true), "helper");
  assert.equal(engineFor("mp4", page, false), null);

  assert.deepEqual(qualitiesFor("mp3", "browser").map((q) => q.value), ["192", "320", "256", "128"]);
  assert.deepEqual(qualitiesFor("wav", "browser"), []);
  assert.equal(qualitiesFor("mp4", "helper")[0].label, "Best quality");
  assert.deepEqual(qualitiesFor("mp4", "browser", [{ value: "0", label: "720p" }]), [{ value: "0", label: "720p" }]);
  assert.deepEqual(qualitiesFor("mp4", "browser"), []);
});

test("estimateBytes", () => {
  assert.equal(estimateBytes(8_000_000, 10), 10_000_000); // 8 Mb/s × 10 s = 10 MB
  assert.equal(estimateBytes(0, 10), null);
  assert.equal(estimateBytes(8_000_000, 0), null);
  assert.equal(estimateBytes(null, 10), null);
  assert.equal(estimateBytes(-1, 10), null);
});

test("baseName handles both separators", () => {
  assert.equal(baseName("C:\\Users\\x\\Downloads\\v.mp4"), "v.mp4");
  assert.equal(baseName("/home/x/v.mp4"), "v.mp4");
  assert.equal(baseName("v.mp4"), "v.mp4");
  assert.equal(baseName(""), "");
});

test("isUserCancel", () => {
  assert.equal(isUserCancel("Download canceled by the user"), true);
  assert.equal(isUserCancel("USER_CANCELED"), true);
  assert.equal(isUserCancel("Network error"), false);
  assert.equal(isUserCancel(undefined), false);
});

test("decoyNote", () => {
  // actual far shorter than advertised → warning with both durations
  assert.match(decoyNote(1440, 30, formatDuration), /decoy clip \(0:30 of 24:00\)/);
  // actual close to advertised → no warning
  assert.equal(decoyNote(1440, 1400, formatDuration), "");
  // exactly half or more → no warning
  assert.equal(decoyNote(100, 50, formatDuration), "");
  // unknown durations → no warning
  assert.equal(decoyNote(0, 30, formatDuration), "");
  assert.equal(decoyNote(1440, 0, formatDuration), "");
  assert.equal(decoyNote(undefined, undefined, formatDuration), "");
});

test("progressFromItem: in-progress, paused, unknown total", () => {
  const p = progressFromItem({ state: "in_progress", bytesReceived: 50, totalBytes: 200 }, formatBytes);
  assert.equal(p.progress, 0.25);
  assert.match(p.status, /Downloading/);
  assert.match(p.status, /100 KB|B/); // formatted bytes present

  const unknown = progressFromItem({ state: "in_progress", bytesReceived: 50, totalBytes: 0 }, formatBytes);
  assert.equal(unknown.progress, null);

  const paused = progressFromItem({ state: "in_progress", bytesReceived: 10, totalBytes: 100, paused: true }, formatBytes);
  assert.match(paused.status, /Paused/);

  assert.equal(progressFromItem(null, formatBytes), null);
});

test("progressFromItem: complete and interrupted", () => {
  const done = progressFromItem({ state: "complete", id: 7, filename: "C:\\Users\\x\\Downloads\\clip.mp4", fileSize: 2048 }, formatBytes);
  assert.equal(done.done, true);
  assert.equal(done.progress, 1);
  assert.equal(done.downloadId, 7);
  assert.match(done.status, /Saved: clip\.mp4/);

  assert.equal(progressFromItem({ state: "interrupted", error: "USER_CANCELED" }, formatBytes).error, "download cancelled");
  assert.match(progressFromItem({ state: "interrupted", error: "NETWORK_FAILED" }, formatBytes).error, /interrupted.*NETWORK_FAILED/);
});

test("download: passes saveAs and retries a rejected file name", async () => {
  const calls = [];
  global.chrome = {
    downloads: {
      download: async (opts) => {
        calls.push(opts);
        if (/[^\x00-\x7f]/.test(opts.filename)) throw new Error("Invalid filename");
        return 42;
      },
    },
  };
  try {
    const res = await download("blob:x", "Été à Paris", "mp3", { saveAs: true });
    assert.equal(res.id, 42);
    assert.equal(calls[0].saveAs, true);
    assert.equal(calls[0].filename, "Été à Paris.mp3"); // first try keeps accents → rejected
    assert.equal(calls[1].filename, "Ete a Paris.mp3"); // ascii retry succeeds
    assert.equal(res.filename, "Ete a Paris.mp3");
  } finally {
    delete global.chrome;
  }
});

const hasFfmpeg = (() => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("MP4 probe and mux (regular and fragmented)", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capteur-"));
  const run = (args) => execSync(`ffmpeg -y -v error ${args}`, { cwd: dir });
  run("-f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440 -t 4 -c:v libx264 -preset ultrafast -c:a aac -shortest src.mp4");
  const variants = {
    regular: "-movflags +faststart",
    fragmented: "-movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000",
    absolute: "-movflags frag_keyframe+empty_moov -frag_duration 1000000",
  };
  for (const [name, flags] of Object.entries(variants)) {
    run(`-i src.mp4 -an -c copy ${flags} v_${name}.mp4`);
    run(`-i src.mp4 -vn -c copy ${flags} a_${name}.m4a`);
    const v = new Uint8Array(fs.readFileSync(path.join(dir, `v_${name}.mp4`)));
    const a = new Uint8Array(fs.readFileSync(path.join(dir, `a_${name}.m4a`)));
    const pv = probe(v);
    assert.ok(pv.ok && pv.hasVideo && !pv.hasAudio, `${name}: video probe`);
    assert.equal(pv.height, 240);
    assert.ok(probe(a).hasAudio, `${name}: audio probe`);
    const out = mux(v, a);
    assert.equal(sniff(out), "mp4");
    const file = path.join(dir, `out_${name}.mp4`);
    fs.writeFileSync(file, out);
    const streams = execSync(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${file}"`).toString().trim().split("\n");
    assert.deepEqual(streams.sort(), ["audio", "video"], `${name}: two streams`);
    const errors = execSync(`ffmpeg -v error -i "${file}" -f null - 2>&1`).toString().trim();
    assert.equal(errors, "", `${name}: decodes cleanly`);
  }
  assert.equal(probe(new Uint8Array(fs.readFileSync(path.join(dir, "v_regular.mp4"))).subarray(0, 100)).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
