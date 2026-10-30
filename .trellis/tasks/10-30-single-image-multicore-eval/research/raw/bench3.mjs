import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/picsur/backend/package.json');
const sharp = require('sharp');
const { QOIencode, QOIdecode } = require('qoi-img');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const round = (x) => +x.toFixed(2);
function measureSync(fn, iters = 4) {
  for (let i = 0; i < 2; i++) fn();
  if (global.gc) global.gc();
  const walls = [], cpus = [];
  for (let i = 0; i < iters; i++) {
    const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint(); const c1 = process.cpuUsage(c0);
    if (global.gc) global.gc();
    walls.push(Number(t1 - t0) / 1e6); cpus.push((c1.user + c1.system) / 1000);
  }
  const w = med(walls), c = med(cpus);
  return { wall_ms: round(w), cpu_ms: round(c), ratio: round(c / w) };
}
const jpg24 = fs.readFileSync('/bench/fixtures/24mp.jpg');
const png24 = fs.readFileSync('/bench/fixtures/24mp.png');
const rawJ = await sharp(jpg24).raw().toBuffer({ resolveWithObject: true });
const rawP = await sharp(png24).raw().toBuffer({ resolveWithObject: true });
const qoi12 = fs.readFileSync('/bench/fixtures/12mp.qoi');
const out = { default_concurrency: sharp.concurrency() };
for (const k of [1, 16]) {
  sharp.concurrency(k);
  out['qoi_encode 24mp jpg-raw c=' + k] = measureSync(() => { globalThis.sink = QOIencode(rawJ.data, { width: rawJ.info.width, height: rawJ.info.height, channels: rawJ.info.channels }); });
  out['qoi_encode 24mp png-raw c=' + k] = measureSync(() => { globalThis.sink = QOIencode(rawP.data, { width: rawP.info.width, height: rawP.info.height, channels: rawP.info.channels }); });
  out['qoi_decode 12mp c=' + k] = measureSync(() => { globalThis.sink = QOIdecode(qoi12); });
  out['decode 24mp.jpg c=' + k] = null;
}
sharp.concurrency(16);
const dec = async () => { const { data, info } = await sharp(jpg24).raw().toBuffer({ resolveWithObject: true }); globalThis.sink = { data, info }; };
for (let i = 0; i < 2; i++) await dec();
const walls = [], cpus = [];
for (let i = 0; i < 4; i++) { const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint(); await dec(); const t1 = process.hrtime.bigint(); const c1 = process.cpuUsage(c0); walls.push(Number(t1 - t0) / 1e6); cpus.push((c1.user + c1.system) / 1000); }
out['decode 24mp.jpg default-c=16'] = { wall_ms: round(med(walls)), cpu_ms: round(med(cpus)), ratio: round(med(cpus) / med(walls)) };
delete out['decode 24mp.jpg c=1']; delete out['decode 24mp.jpg c=16'];
console.log(JSON.stringify(out, null, 2));
