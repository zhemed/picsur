#!/usr/bin/env node
/**
 * Generates the video fixtures used by `support/regression-video-api.sh`.
 *
 * Why this script exists: the regression has to be reproducible on a fresh
 * checkout, and there is no local video encoder. The HTTP contract does not
 * need a playable video either - `file-type` only looks at the container
 * header, so a well formed MP4 / WebM / MOV header plus deterministic filler is
 * enough for the upload, direct-link and byte-identity assertions.
 *
 * The bytes are deterministic (no timestamps, no randomness), so running the
 * generator twice produces identical files.
 *
 * Usage:
 *   node support/make-video-fixtures.cjs [output-dir]
 *
 *   output-dir   defaults to $PICSUR_FIXTURES, else /tmp/bugs-fx
 *
 * Produces:
 *   base.mp4    ftyp isom + 1 MiB filler  (positive case, direct link)
 *   base.webm   EBML header, DocType webm + 1 MiB filler (positive case)
 *   base.mov    ftyp qt   + 512 B filler   (recognised but unsupported -> 400)
 *   too-big.mp4 only when PICSUR_VIDEO_TOO_BIG_BYTES is set (413 case)
 *
 * Exit code 0 = every fixture is in place, 1 = could not write it.
 */
const fs = require('fs');
const path = require('path');

const FIXTURES = {
  // 20 byte ISO base media header: size, 'ftyp', major brand 'isom',
  // minor version 0x00000200, compatible brand 'isom'. `file-type` reads the
  // brand at offset 8 and reports video/mp4.
  'base.mp4': {
    header: Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex'),
    filler: 1024 * 1024,
  },
  // Same shape with the QuickTime brand: `file-type` reports video/quicktime,
  // which the instance deliberately does not accept.
  'base.mov': {
    header: Buffer.from('0000001466747970717420200000020071742020', 'hex'),
    filler: 512,
  },
  // Minimal EBML header: root element 0x1A45DFA3, then a DocType element
  // (0x4282) whose payload is "webm". That is all `file-type` needs to answer
  // video/webm; the rest is filler so the file has a non-trivial length.
  'base.webm': {
    header: Buffer.from('1a45dfa3844282847765626d', 'hex'),
    filler: 1024 * 1024,
  },
};

/** Deterministic, non-trivially patterned filler (content is irrelevant). */
function filler(size) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buffer[i] = (i * 37 + 11) & 0xff;
  }
  return buffer;
}

function main() {
  const outDir =
    process.argv[2] || process.env.PICSUR_FIXTURES || '/tmp/bugs-fx';
  fs.mkdirSync(outDir, { recursive: true });

  for (const [name, spec] of Object.entries(FIXTURES)) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, Buffer.concat([spec.header, filler(spec.filler)]));
    console.log(`wrote ${target} (${fs.statSync(target).size} bytes)`);
  }

  // Optional: the over-limit fixture for the 413 case. It is only generated
  // when the caller says how big the instance's `PICSUR_MAX_FILE_SIZE` is,
  // because 128 MB of filler is not something a default run should write.
  const tooBigBytes = Number(process.env.PICSUR_VIDEO_TOO_BIG_BYTES);
  if (Number.isFinite(tooBigBytes) && tooBigBytes > 0) {
    const header = FIXTURES['base.mp4'].header;
    const total = Math.max(tooBigBytes, header.length + 1024);
    const target = path.join(outDir, 'too-big.mp4');
    fs.writeFileSync(
      target,
      Buffer.concat([header, filler(total - header.length)]),
    );
    console.log(`wrote ${target} (${fs.statSync(target).size} bytes)`);
  }
}

try {
  main();
} catch (error) {
  console.error(`FATAL: could not write the video fixtures: ${error.message}`);
  process.exit(1);
}
