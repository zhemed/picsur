// QOI chunked-parallel encoder prototype: validates that independently encoded
// pixel chunks can be concatenated into one valid QOI stream, and measures cost.
import { createRequire } from 'module';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import fs from 'fs';

const require = createRequire('/picsur/backend/package.json');
const sharp = require('sharp');
const { QOIencode, QOIdecode } = require('qoi-img');

const hash = (r, g, b, a) => (r * 3 + g * 5 + b * 7 + a * 11) % 64;

function header(w, h, ch) {
  const b = Buffer.alloc(14);
  b.write('qoif', 0, 'ascii');
  b.writeUInt32BE(w, 4); b.writeUInt32BE(h, 8);
  b[12] = ch; b[13] = 0;
  return b;
}
const tail = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);

// Real encoder: sequential over range, taking an explicit start state.
function encodeRange2(pixels, ch, startPx, endPx, indexIn, pxPrevIn, moreFollows) {
  const index = indexIn.map((v) => (v ? { ...v } : null));
  let bx = [];
  const push = (x) => bx.push(x);
  const pushN = (px) => { push(px.r); push(px.g); push(px.b); if (ch === 4) push(px.a); };

  let run = 0;
  let prevHash = 64;
  let pxPrev = { ...pxPrevIn };
  let px = { r: 0, g: 0, b: 0, a: 255 };

  const flushRun = () => {
    if (run === 0) return;
    while (run >= 62) { push(0xc0 | 61); run -= 62; }
    if (run > 1) { push(0xc0 | (run - 1)); run = 0; }
    else if (run === 1) { push(0xc0); run = 0; }
  };

  for (let p = startPx; p < endPx; p++) {
    const o = p * ch;
    px = ch === 4
      ? { r: pixels[o], g: pixels[o + 1], b: pixels[o + 2], a: pixels[o + 3] }
      : { r: pixels[o], g: pixels[o + 1], b: pixels[o + 2], a: 255 };

    if (px.r === pxPrev.r && px.g === pxPrev.g && px.b === pxPrev.b && px.a === pxPrev.a) {
      run++;
      continue;
    }
    flushRun();
    const ip = hash(px.r, px.g, px.b, px.a);
    prevHash = ip;
    const cur = index[ip];
    if (cur && cur.r === px.r && cur.g === px.g && cur.b === px.b && cur.a === px.a) {
      push(0x00 | ip);
      pxPrev = px;
      continue;
    }
    index[ip] = { ...px };
    if (ch === 4 && px.a !== pxPrev.a) { push(0xff); pushN(px); pxPrev = px; continue; }
    const vr = px.r - pxPrev.r + 2, vg = px.g - pxPrev.g + 2, vb = px.b - pxPrev.b + 2;
    if ((((vr | vg | vb) & 0xff) < 4)) { push(0x40 | (vr << 4) | (vg << 2) | vb); pxPrev = px; continue; }
    const vgR = vr - vg + 8, vgB = vb - vg + 8, g2 = vg + 30;
    if ((((vgR | vgB) & 0xf0) === 0) && ((g2 & 0xc0) === 0)) { push(0x80 | g2); push((vgR << 4) | vgB); pxPrev = px; continue; }
    push(0xfe); pushN(px); pxPrev = px;
  }
  // flush a still-open run unless the rest of the image continues this chunk's
  // final pixel (the next chunk will encode the continuation as its own run).
  if (run > 0) {
    flushRun();
  }
  return { ops: Buffer.from(bx), prevPix: px, index: index };
}

// Compute last-occurrence-per-slot inside a chunk (phase A).
function scanChunk(pixels, ch, startPx, endPx) {
  const last = new Array(64).fill(null);
  for (let p = startPx; p < endPx; p++) {
    const o = p * ch;
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2], a = ch === 4 ? pixels[o + 3] : 255;
    last[hash(r, g, b, a)] = { r, g, b, a };
  }
  return last;
}

export function encodeChunked(pixels, w, h, ch, K, opts = {}) {
  const total = w * h;
  const bounds = [];
  let prev = 0;
  for (let i = 1; i <= K; i++) { const b = Math.round((i * total) / K); bounds.push([prev, b]); prev = b; }
  bounds[K - 1][1] = total;

  // Phase A: local last-occurrence tables (parallelizable per chunk)
  const tA0 = process.hrtime.bigint();
  const locals = bounds.map(([s, e]) => scanChunk(pixels, ch, s, e));
  const tA1 = process.hrtime.bigint();

  // Phase B: prefix-merge into per-chunk start states (serial, 64 slots × K)
  const tB0 = process.hrtime.bigint();
  const starts = [];
  let state = new Array(64).fill(null);
  for (let i = 0; i < K; i++) {
    starts.push(state.map((v) => (v ? { ...v } : null)));
    const next = state.slice();
    for (let s = 0; s < 64; s++) if (locals[i][s]) next[s] = locals[i][s];
    state = next;
  }
  const tB1 = process.hrtime.bigint();

  // Phase C: encode each chunk with its inherited state
  const tC0 = process.hrtime.bigint();
  const parts = [];
  for (let i = 0; i < K; i++) {
    const [s, e] = bounds[i];
    const pxPrev = s === 0 ? { r: 0, g: 0, b: 0, a: 255 } : pixelAt(pixels, ch, s - 1);
    const r = encodeRange2(pixels, ch, s, e, starts[i], pxPrev, i < K - 1);
    parts.push(r.ops);
  }
  const tC1 = process.hrtime.bigint();

  const body = Buffer.concat(parts);
  const out = Buffer.concat([header(w, h, ch), body, tail]);
  return {
    data: out,
    phaseA_ms: Number(tA1 - tA0) / 1e6,
    phaseB_ms: Number(tB1 - tB0) / 1e6,
    phaseC_ms: Number(tC1 - tC0) / 1e6,
    bounds,
    starts,
  };
}
function pixelAt(pixels, ch, p) {
  const o = p * ch;
  return ch === 4 ? { r: pixels[o], g: pixels[o + 1], b: pixels[o + 2], a: pixels[o + 3] } : { r: pixels[o], g: pixels[o + 1], b: pixels[o + 2], a: 255 };
}

function encodePlain(pixels, w, h, ch) {
  const r = encodeRange2(pixels, ch, 0, w * h, new Array(64).fill(null), { r: 0, g: 0, b: 0, a: 255 }, false);
  return Buffer.concat([header(w, h, ch), r.ops, tail]);
}
const eq = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0;

if (!isMainThread) {
  // Worker: encode one chunk from shared pixel buffer + inherited state.
  const { sab, ch, startPx, endPx, startState, pxPrev } = workerData;
  const pixels = Buffer.from(sab);
  const r = encodeRange2(pixels, ch, startPx, endPx, startState, pxPrev, true);
  parentPort.postMessage(r.ops, [r.ops.buffer]);
} else {
  const results = {};
  // -- correctness on small synthetic images, including runs crossing boundaries
  const W = 301, H = 200, CH = 3;
  const mk = (fn) => { const b = Buffer.allocUnsafe(W * H * CH); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * CH; const px = fn(x, y); b[o] = px[0]; b[o + 1] = px[1]; b[o + 2] = px[2]; } return b; };
  const cases = {
    gradient: mk((x, y) => [(x * 255 / W) | 0, (y * 255 / H) | 0, ((x + y) * 127 / (W + H)) | 0]),
    runsCrossingChunks: mk((x, y) => [Math.floor(x / 37) * 17 % 256, Math.floor(x / 37) * 23 % 256, 100]),
  };
  for (const [name, pixels] of Object.entries(cases)) {
    const srcNativeDecode = QOIdecode(QOIencode(pixels, { width: W, height: H, channels: CH }));
    const jsPlain = encodePlain(pixels, W, H, CH);
    const nativeFromJs = QOIdecode(jsPlain);
    const entry = { js_plain_eq_native_pixels: eq(nativeFromJs.pixels, pixels), native_encode_pixels_ok: eq(srcNativeDecode.pixels, pixels) };
    for (const K of [2, 3, 4, 7]) {
      const res = encodeChunked(pixels, W, H, CH, K);
      const dec = QOIdecode(res.data);
      entry[`chunked_K${K}_pixels_eq_source`] = eq(dec.pixels, pixels);
      entry[`chunked_K${K}_bytes`] = res.data.length;
    }
    const nativeBytes = QOIencode(pixels, { width: W, height: H, channels: CH }).length;
    entry.native_bytes = nativeBytes;
    results[name] = entry;
  }
  console.log('## correctness (small images)');
  console.log(JSON.stringify(results, null, 2));

  // -- real image: 24MP JPEG decoded to raw
  const raw = await sharp('/bench/fixtures/24mp.jpg').raw().toBuffer({ resolveWithObject: true });
  const pixels = raw.data, w = raw.info.width, h = raw.info.height, ch = raw.info.channels;
  const native = QOIencode(pixels, { width: w, height: h, channels: ch });
  const decNative = QOIdecode(native);
  const nativeOk = eq(decNative.pixels, pixels);
  const t0 = process.hrtime.bigint();
  const jsPlain = encodePlain(pixels, w, h, ch);
  const t1 = process.hrtime.bigint();
  const jsOk = eq(QOIdecode(jsPlain).pixels, pixels);
  console.log(`\n## 24mp jpg raw ${w}x${h}x${ch}`);
  console.log(`native encode: pixels_ok=${nativeOk} bytes=${native.length}`);
  console.log(`js plain encode: ${(Number(t1 - t0) / 1e6).toFixed(1)}ms pixels_ok=${jsOk} bytes=${jsPlain.length}`);

  for (const K of [4, 8]) {
    const c = encodeChunked(pixels, w, h, ch, K);
    const dec = QOIdecode(c.data);
    console.log(`chunked K=${K}: phaseA=${c.phaseA_ms.toFixed(1)}ms phaseB=${c.phaseB_ms.toFixed(2)}ms phaseC=${c.phaseC_ms.toFixed(1)}ms total=${(c.phaseA_ms + c.phaseB_ms + c.phaseC_ms).toFixed(1)}ms bytes=${c.data.length} pixels_ok=${eq(dec.pixels, pixels)}`);
  }

  // -- parallel phase C with 4 worker threads (phase A/B still main thread)
  {
    const K = 4;
    const total = w * h;
    const bounds = []; let prev = 0;
    for (let i = 1; i <= K; i++) { const b = Math.round((i * total) / K); bounds.push([prev, b]); prev = b; }
    bounds[K - 1][1] = total;
    const tA0 = process.hrtime.bigint();
    const locals = bounds.map(([s, e]) => scanChunk(pixels, ch, s, e));
    const tA1 = process.hrtime.bigint();
    const starts = []; let state = new Array(64).fill(null);
    for (let i = 0; i < K; i++) { starts.push(state.map((v) => (v ? { ...v } : null))); const next = state.slice(); for (let s = 0; s < 64; s++) if (locals[i][s]) next[s] = locals[i][s]; state = next; }
    const tB1 = process.hrtime.bigint();
    const tc0 = process.hrtime.bigint();
    const sab = new SharedArrayBuffer(pixels.length);
    Buffer.from(sab).set(pixels);
    const tc1 = process.hrtime.bigint();
    const tw0 = process.hrtime.bigint();
    const workers = [];
    const chunks = await Promise.all(bounds.map(([s, e], i) => new Promise((resolve, reject) => {
      const wk = new Worker(new URL(import.meta.url), {
        workerData: { sab, ch, startPx: s, endPx: e, startState: starts[i], pxPrev: s === 0 ? { r: 0, g: 0, b: 0, a: 255 } : pixelAt(pixels, ch, s - 1) },
      });
      workers.push(wk);
      wk.once('message', resolve); wk.once('error', reject);
    })));
    const tw1 = process.hrtime.bigint();
    for (const wk of workers) await wk.terminate();
    const out = Buffer.concat([header(w, h, ch), ...chunks, tail]);
    const ok = eq(QOIdecode(out).pixels, pixels);
    const totalMs = Number(tA1 - tA0) / 1e6 + Number(tB1 - tA1) / 1e6 + Number(tc1 - tc0) / 1e6 + Number(tw1 - tw0) / 1e6;
    console.log(`chunked K=4 with 4 workers: phaseA=${(Number(tA1 - tA0) / 1e6).toFixed(1)}ms phaseB=${(Number(tB1 - tA1) / 1e6).toFixed(2)}ms sab_copy=${(Number(tc1 - tc0) / 1e6).toFixed(1)}ms workers=${(Number(tw1 - tw0) / 1e6).toFixed(1)}ms total=${totalMs.toFixed(1)}ms pixels_ok=${ok}`);
  }
}
