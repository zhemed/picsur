#!/usr/bin/env node
/**
 * Generates the video fixtures used by `support/regression-video-api.sh`.
 *
 * Why this script exists: the regression has to be reproducible on a fresh
 * checkout, and there is no local video encoder. The HTTP contract does not
 * need a playable video either - `file-type` only looks at the container
 * header, so a well formed container header plus deterministic filler is
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
 *   base.mov    ftyp qt   + 512 B filler  (positive case since more-containers)
 *   base.mkv    EBML header, DocType matroska (Matroska)
 *   base.avi    RIFF....AVI header (AVI)
 *   base.wmv    ASF header with a video stream GUID (WMV)
 *   base.flv    FLV version 1 header (FLV)
 *   base.ts     two 0x47 transport-stream sync bytes 188 bytes apart (MPEG-TS)
 *   base.3gp    ftyp 3gp4 header (3GPP)
 *   base.ogv    OggS page with a Theora codec header (Ogg video)
 *   base.m4v    ftyp M4V header (MPEG-4 video)
 *   base.mpg     MPEG-PS pack header: recognised by file-type but deliberately
 *                not on the whitelist, used for the 400 case
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
  // Same shape with the QuickTime brand: `file-type` reports video/quicktime.
  'base.mov': {
    header: Buffer.from('0000001466747970717420200000020071742020', 'hex'),
    filler: 512,
  },
  // same shape with the M4V brand: `file-type` reports video/x-m4v.
  'base.m4v': {
    header: Buffer.from('00000014667479704d345620000002004d345620', 'hex'),
    filler: 512,
  },
  // same shape with a 3GPP brand: `file-type` reports video/3gpp.
  'base.3gp': {
    header: Buffer.from('0000001466747970336770340000020033677034', 'hex'),
    filler: 512,
  },
  // Minimal EBML header: root element 0x1A45DFA3, then a DocType element
  // (0x4282) whose payload is "webm". That is all `file-type` needs to answer
  // video/webm; the rest is filler so the file has a non-trivial length.
  'base.webm': {
    header: Buffer.from('1a45dfa3844282847765626d', 'hex'),
    filler: 1024 * 1024,
  },
  // Same EBML shape with the "matroska" DocType: video/matroska.
  'base.mkv': {
    header: Buffer.from('1a45dfa38b4282886d6174726f736b61', 'hex'),
    filler: 512,
  },
  // RIFF container whose form type at offset 8 is 'AVI ': video/vnd.avi.
  // `file-type` does not validate the RIFF chunk size, so it can stay filler.
  'base.avi': {
    header: Buffer.from('524946460001000041564920', 'hex'),
    filler: 512,
  },
  // ASF header: 30 byte header-object prelude, then a Stream-Properties-Object
  // carrying the ASF video media GUID, which `file-type` maps to
  // video/x-ms-asf. This is the container family of .wmv files.
  'base.wmv': {
    header: buildAsfHeader(),
    filler: 512,
  },
  // FLV version 1 magic.
  'base.flv': {
    header: Buffer.from('464c5601', 'hex'),
    filler: 512,
  },
  // MPEG-TS: `file-type` requires a 0x47 sync byte at offsets 0 and 188.
  'base.ts': {
    header: buildTsHeader(),
    filler: 512,
  },
  // Ogg page with a Theora identification header at the position `file-type`
  // peeks: "OggS", 24 header bytes, then the 0x80 "theora" codec signature.
  'base.ogv': {
    header: buildOggTheoraHeader(),
    filler: 512,
  },
  // MPEG program stream pack header. `file-type` reports video/mpeg for it,
  // but the whitelist intentionally excludes MPEG-PS: valid files can also
  // come back as video/MP1S or video/MP2P, so the negative case uses it.
  'base.mpg': {
    header: Buffer.from('000001ba', 'hex'),
    filler: 512,
  },
};

/** 30 byte ASF header-object prelude + a video Stream-Properties-Object. */
function buildAsfHeader() {
  const headerObjectGuid = Buffer.from(
    '3026b2758e66cf11a6d900aa0062ce6c',
    'hex',
  );
  const streamPropertiesGuid = Buffer.from(
    '9107dcb7b7a9cf118ee600c00c205365',
    'hex',
  );
  const asfVideoMediaGuid = Buffer.from(
    'c0ef19bc4d5bcf11a8fd00805f5c442b',
    'hex',
  );

  const headerObjectSize = Buffer.alloc(8);
  headerObjectSize.writeBigUInt64LE(BigInt(30 + 40));
  const objectCount = Buffer.alloc(4);
  objectCount.writeUInt32LE(1);
  // Reserved bytes 28 and 29 of the ASF header object.
  const reserved = Buffer.from([0x01, 0x02]);

  const streamObjectSize = Buffer.alloc(8);
  streamObjectSize.writeBigUInt64LE(40n);

  return Buffer.concat([
    headerObjectGuid,
    headerObjectSize,
    objectCount,
    reserved,
    streamPropertiesGuid,
    streamObjectSize,
    asfVideoMediaGuid,
  ]);
}

/** 189 bytes: one 0x47 sync byte, then another at offset 188. */
function buildTsHeader() {
  const header = Buffer.alloc(189);
  header[0] = 0x47;
  header[188] = 0x47;
  return header;
}

/** 36 bytes: "OggS" page start, 24 filler header bytes, Theora signature. */
function buildOggTheoraHeader() {
  const pageHeader = Buffer.alloc(28);
  pageHeader.write('OggS', 0, 'latin1');
  const codecHeader = Buffer.from([0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61]);
  return Buffer.concat([pageHeader, codecHeader]);
}

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
