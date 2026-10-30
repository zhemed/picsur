import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire('/picsur/backend/package.json');
const sharp = require('sharp');
const { QOIencode, QOIdecode } = require('qoi-img');

const FIX = process.argv[2] || '/bench/fixtures';
const OUT = process.argv[3] || '/bench/results.json';
const file = (n) => path.join(FIX, n);

const tryRead = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const env = {
  node: process.version,
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
  libvips_threads_default: sharp.concurrency(),
  cpus: os.cpus().length,
  availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
  cpuModel: os.cpus()[0]?.model,
  container_cpu_max_v2: tryRead('/sys/fs/cgroup/cpu.max'),
  container_cpu_quota_v1: tryRead('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
  container_cpuset: tryRead('/sys/fs/cgroup/cpuset.cpus.effective') ?? tryRead('/sys/fs/cgroup/cpuset/cpuset.cpus'),
  memory_limit: tryRead('/sys/fs/cgroup/memory.max') ?? tryRead('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
};

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const round = (x) => +x.toFixed(2);
function summarize(walls, cpus) {
  const wall = med(walls), cpu = med(cpus);
  return {
    wall_ms: round(wall), cpu_ms: round(cpu), ratio_cpu_wall: round(cpu / wall),
    wall_all: walls.map(round), cpu_all: cpus.map(round),
  };
}
async function measureAsync(fn, iters, warmup = 1) {
  for (let i = 0; i < warmup; i++) await fn();
  if (global.gc) global.gc();
  const walls = [], cpus = [];
  for (let i = 0; i < iters; i++) {
    const c0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    const c1 = process.cpuUsage(c0);
    if (global.gc) global.gc();
    walls.push(Number(t1 - t0) / 1e6);
    cpus.push((c1.user + c1.system) / 1000);
  }
  return summarize(walls, cpus);
}
function measureSync(fn, iters, warmup = 1) {
  for (let i = 0; i < warmup; i++) fn();
  if (global.gc) global.gc();
  const walls = [], cpus = [];
  for (let i = 0; i < iters; i++) {
    const c0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    const c1 = process.cpuUsage(c0);
    if (global.gc) global.gc();
    walls.push(Number(t1 - t0) / 1e6);
    cpus.push((c1.user + c1.system) / 1000);
  }
  return summarize(walls, cpus);
}

const results = { env, fixtures: {}, sections: {} };
for (const f of fs.readdirSync(FIX)) results.fixtures[f] = fs.statSync(file(f)).size;

// Decode to raw, concurrency sweep ------------------------------------------------
results.sections.decode = {};
for (const fx of ['24mp.jpg', '24mp.png', '12mp.jpg']) {
  for (const k of [1, 4, 16]) {
    sharp.concurrency(k);
    results.sections.decode[`${fx} c=${k}`] = await measureAsync(async () => {
      const r = await sharp(file(fx)).raw().toBuffer({ resolveWithObject: true });
      if (!r.data.length) throw new Error('empty decode');
      globalThis.sink = r;
    }, 4);
  }
}

// QOI encode/decode (native, in-process) -----------------------------------------
const raw24 = await sharp(file('24mp.jpg')).raw().toBuffer({ resolveWithObject: true });
const raw12 = await sharp(file('12mp.jpg')).raw().toBuffer({ resolveWithObject: true });
const qoi12 = fs.readFileSync(file('12mp.qoi'));

sharp.concurrency(16);
results.sections.qoi_encode = {
  '24mp.jpg-decoded-raw': measureSync(() => {
    const e = QOIencode(raw24.data, { width: raw24.info.width, height: raw24.info.height, channels: raw24.info.channels });
    globalThis.sink = e; if (!e.length) throw new Error('empty');
  }, 4),
  '12mp.jpg-decoded-raw': measureSync(() => {
    const e = QOIencode(raw12.data, { width: raw12.info.width, height: raw12.info.height, channels: raw12.info.channels });
    globalThis.sink = e; if (!e.length) throw new Error('empty');
  }, 4),
};
results.sections.qoi_decode = {
  '12mp.qoi': measureSync(() => {
    const r = QOIdecode(qoi12);
    globalThis.sink = r; if (!r.pixels.length) throw new Error('empty');
  }, 4),
};

// Full upload-chain emulation: decode + QOI encode --------------------------------
results.sections.full_chain = {};
for (const k of [1, 16]) {
  sharp.concurrency(k);
  results.sections.full_chain[`24mp.jpg c=${k}`] = await measureAsync(async () => {
    const { data, info } = await sharp(file('24mp.jpg')).raw().toBuffer({ resolveWithObject: true });
    const e = QOIencode(data, { width: info.width, height: info.height, channels: info.channels });
    globalThis.sink = e; if (!e.length) throw new Error('empty');
  }, 3);
}

// Reference: which libvips operations DO scale with threads ---------------------
sharp.concurrency(16);
const rawInput = { raw: { width: raw24.info.width, height: raw24.info.height, channels: raw24.info.channels } };
results.sections.libvips_encode = {};
for (const k of [1, 4, 16]) {
  sharp.concurrency(k);
  results.sections.libvips_encode[`webp q80 24mp raw c=${k}`] = await measureAsync(async () => {
    const b = await sharp(raw24.data, rawInput).webp({ quality: 80 }).toBuffer();
    globalThis.sink = b; if (!b.length) throw new Error('empty');
  }, 3);
  results.sections.libvips_encode[`jpeg q90 24mp raw c=${k}`] = await measureAsync(async () => {
    const b = await sharp(raw24.data, rawInput).jpeg({ quality: 90 }).toBuffer();
    globalThis.sink = b; if (!b.length) throw new Error('empty');
  }, 3);
  results.sections.libvips_encode[`resize1600+webp 24mp raw c=${k}`] = await measureAsync(async () => {
    const b = await sharp(raw24.data, rawInput).resize({ width: 1600 }).webp({ quality: 80 }).toBuffer();
    globalThis.sink = b; if (!b.length) throw new Error('empty');
  }, 3);
}

// QOI re-encode chain for a QOI input: QOIdecode -> raw -> QOIencode ------------
sharp.concurrency(16);
results.sections.qoi_chain = {
  '12mp.qoi decode+encode': measureSync(() => {
    const r = QOIdecode(qoi12);
    const e = QOIencode(r.pixels, { width: r.width, height: r.height, channels: r.channels });
    globalThis.sink = e; if (!e.length) throw new Error('empty');
  }, 3),
};

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(env));
for (const [section, entries] of Object.entries(results.sections)) {
  console.log('\n## ' + section);
  for (const [key, v] of Object.entries(entries)) {
    console.log(`${key.padEnd(42)} wall=${String(v.wall_ms).padStart(8)}ms cpu=${String(v.cpu_ms).padStart(8)}ms ratio=${v.ratio_cpu_wall}`);
  }
}
console.log('\nWROTE ' + OUT);
