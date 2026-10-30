import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire('/picsur/backend/package.json');
const sharp = require('sharp');
const { QOIencode, QOIdecode, IsQOI } = require('qoi-img');
const { fileTypeFromBuffer } = await import('/picsur/backend/node_modules/file-type/core.js');

const FIX = '/bench/fixtures';
const file = (n) => path.join(FIX, n);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const round = (x) => +x.toFixed(2);
function summarize(walls, cpus) {
  const wall = med(walls), cpu = med(cpus);
  return { wall_ms: round(wall), cpu_ms: round(cpu), ratio_cpu_wall: round(cpu / wall), wall_all: walls.map(round) };
}
async function measureAsync(fn, iters, warmup = 1) {
  for (let i = 0; i < warmup; i++) await fn();
  if (global.gc) global.gc();
  const walls = [], cpus = [];
  for (let i = 0; i < iters; i++) {
    const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint(); const c1 = process.cpuUsage(c0);
    if (global.gc) global.gc();
    walls.push(Number(t1 - t0) / 1e6); cpus.push((c1.user + c1.system) / 1000);
  }
  return summarize(walls, cpus);
}
function measureSync(fn, iters, warmup = 1) {
  for (let i = 0; i < warmup; i++) fn();
  if (global.gc) global.gc();
  const walls = [], cpus = [];
  for (let i = 0; i < iters; i++) {
    const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint(); const c1 = process.cpuUsage(c0);
    if (global.gc) global.gc();
    walls.push(Number(t1 - t0) / 1e6); cpus.push((c1.user + c1.system) / 1000);
  }
  return summarize(walls, cpus);
}

const out = { env: { node: process.version, sharp: sharp.versions.sharp, vips: sharp.versions.vips, default_concurrency: sharp.concurrency(), cpus: os.cpus().length }, sections: {} };
const jpg24 = fs.readFileSync(file('24mp.jpg'));
const png24 = fs.readFileSync(file('24mp.png'));

// cache effect check
sharp.cache(true); sharp.concurrency(16);
out.sections.cache_check = {
  'decode 24mp.jpg c=16 cache=true': await measureAsync(async () => { await sharp(jpg24).raw().toBuffer(); }, 3),
};
sharp.cache(false);
out.sections.cache_check['decode 24mp.jpg c=16 cache=false'] = await measureAsync(async () => { await sharp(jpg24).raw().toBuffer(); }, 3);

// type detection + input buffer copy (main process work) -------------------------
out.sections.main_process = {
  'fileTypeFromBuffer 24mp.jpg': await measureAsync(async () => { const r = await fileTypeFromBuffer(jpg24); globalThis.sink = r; }, 5),
  'fileTypeFromBuffer 24mp.png': await measureAsync(async () => { const r = await fileTypeFromBuffer(png24); globalThis.sink = r; }, 5),
  'Buffer copy 24mp.jpg 19.8MB': measureSync(() => { globalThis.sink = Buffer.from(jpg24); }, 5),
  'sharp.metadata() 24mp.jpg c=1': (sharp.concurrency(1), await measureAsync(async () => { globalThis.sink = await sharp(jpg24).metadata(); }, 5)),
};
sharp.concurrency(16);
out.sections.main_process['sharp.metadata() 24mp.jpg c=16'] = await measureAsync(async () => { globalThis.sink = await sharp(jpg24).metadata(); }, 5);

// decode sweep with cache off ---------------------------------------------------
sharp.cache(false);
out.sections.decode_sweep = {};
for (const fx of ['24mp.jpg', '24mp.png']) {
  for (const k of [1, 2, 4, 8, 16]) {
    sharp.concurrency(k);
    out.sections.decode_sweep[`${fx} c=${k}`] = await measureAsync(async () => {
      const r = await sharp(fx.endsWith('.jpg') ? jpg24 : png24).raw().toBuffer({ resolveWithObject: true });
      globalThis.sink = r;
    }, 5);
  }
}

// full chain: decode + QOI encode, plus PNG input variant ------------------------
const raw24jpg = await sharp(jpg24).raw().toBuffer({ resolveWithObject: true });
const raw24png = await sharp(png24).raw().toBuffer({ resolveWithObject: true });
const raw12jpg = await sharp(file('12mp.jpg')).raw().toBuffer({ resolveWithObject: true });
out.sections.full_chain = {};
for (const [name, buf] of [['24mp.jpg', jpg24], ['24mp.png', png24], ['12mp.jpg', fs.readFileSync(file('12mp.jpg'))]]) {
  for (const k of [1, 16]) {
    sharp.concurrency(k);
    out.sections.full_chain[`${name} c=${k}`] = await measureAsync(async () => {
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const e = QOIencode(data, { width: info.width, height: info.height, channels: info.channels });
      globalThis.sink = e;
    }, 3);
  }
}

// libvips operation scaling: resample only (raw in, raw out) --------------------
out.sections.resize_scaling = {};
for (const k of [1, 2, 4, 8, 16]) {
  sharp.concurrency(k);
  out.sections.resize_scaling[`24mp raw -> 1600 raw c=${k}`] = await measureAsync(async () => {
    const b = await sharp(raw24jpg.data, { raw: { width: raw24jpg.info.width, height: raw24jpg.info.height, channels: raw24jpg.info.channels } })
      .resize({ width: 1600 }).raw().toBuffer();
    globalThis.sink = b;
  }, 3);
}
for (const k of [1, 4, 16]) {
  sharp.concurrency(k);
  out.sections.resize_scaling[`jpeg24 -> resize 1600 webp c=${k}`] = await measureAsync(async () => {
    const b = await sharp(jpg24).resize({ width: 1600 }).webp({ quality: 80 }).toBuffer();
    globalThis.sink = b;
  }, 3);
}

fs.writeFileSync('/bench/results2.json', JSON.stringify(out, null, 2));
for (const [sec, entries] of Object.entries(out.sections)) {
  console.log('\n## ' + sec);
  for (const [k, v] of Object.entries(entries)) console.log(`${k.padEnd(46)} wall=${String(v.wall_ms).padStart(8)}ms cpu=${String(v.cpu_ms).padStart(8)}ms ratio=${v.ratio_cpu_wall}`);
}
