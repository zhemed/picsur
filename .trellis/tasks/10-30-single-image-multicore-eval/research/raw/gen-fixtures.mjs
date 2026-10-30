import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire('/picsur/backend/package.json');
const sharp = require('sharp');
const { QOIencode } = require('qoi-img');

function makeRaw(w, h, channels) {
  const buf = Buffer.allocUnsafe(w * h * channels);
  let s = 123456789;
  const rnd = () => {
    s = (Math.imul(1103515245, s) + 12345) >>> 0;
    return (s >>> 16) & 0xff;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const base = (((x * 255) / w) + ((y * 255) / h)) / 2 | 0;
      buf[i] = (base + rnd()) & 255;
      buf[i + 1] = ((base >> 1) + rnd()) & 255;
      buf[i + 2] = (255 - base + rnd()) & 255;
      if (channels > 3) buf[i + 3] = 255;
    }
  }
  return buf;
}

const out = process.argv[2] || '/bench/fixtures';
fs.mkdirSync(out, { recursive: true });

const specs = [
  ['12mp', 4000, 3000],
  ['24mp', 6000, 4000],
];

for (const [name, w, h] of specs) {
  const t0 = Date.now();
  const raw = makeRaw(w, h, 3);
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  await img.clone().jpeg({ quality: 90 }).toFile(path.join(out, name + '.jpg'));
  await img.clone().png({ compressionLevel: 1 }).toFile(path.join(out, name + '.png'));
  console.log(`${name} ${w}x${h} png+jpg done in ${Date.now() - t0}ms`);
}

// QOI fixture (only 12mp: encode is slow, and only needed to time QOIdecode)
{
  const raw = makeRaw(4000, 3000, 3);
  const t0 = Date.now();
  const enc = QOIencode(raw, { width: 4000, height: 3000, channels: 3 });
  fs.writeFileSync(path.join(out, '12mp.qoi'), enc);
  console.log(`12mp.qoi bytes=${enc.length} encode=${Date.now() - t0}ms`);
}

for (const f of fs.readdirSync(out)) {
  const st = fs.statSync(path.join(out, f));
  console.log('fixture', f, st.size, 'bytes');
}
