// Unit tests: run with `npm test` (Node 18+). MP4 tests need ffmpeg to build fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseHls } from "../lib/hls.js";
import { probe, mux, sniff } from "../lib/mp4.js";
import { excludedService, helperOnly, isIgnoredRequest } from "../lib/policy.js";
import { safeName, asciiName, cleanTitle, decodeEfg, formatDuration } from "../lib/util.js";

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
  assert.equal(excludedService("https://www.netflix.com/watch/1"), "Netflix");
  assert.equal(excludedService("https://open.spotify.com/track/1"), "Spotify");
  assert.equal(excludedService("https://www.instagram.com/reel/abc/"), null);
  // YouTube: helper in the personal build, excluded in the store build
  assert.equal(excludedService("https://www.youtube.com/watch?v=x", "personal"), null);
  assert.equal(excludedService("https://www.youtube.com/watch?v=x", "store"), "YouTube");
  assert.equal(helperOnly("https://m.youtube.com/watch?v=x", "personal"), true);
  assert.equal(helperOnly("https://m.youtube.com/watch?v=x", "store"), false);
  assert.equal(isIgnoredRequest("https://rr1---sn-x.googlevideo.com/videoplayback?x=1"), true);
});

test("utilities", () => {
  assert.equal(safeName('Ma vidéo: "test" / 2'), "Ma vidéo test 2");
  assert.equal(asciiName("Été à Paris"), "Ete a Paris");
  assert.equal(cleanTitle("(3) Un reel sympa • Instagram"), "Un reel sympa");
  assert.equal(formatDuration(3725), "1:02:05");
  const efg = Buffer.from(JSON.stringify({ vencode_tag: "dash_audio", xpv_asset_id: 42 })).toString("base64url");
  assert.deepEqual(decodeEfg(`https://scontent.cdninstagram.com/v/a.mp4?efg=${efg}`), { asset: 42, tag: "dash_audio" });
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
