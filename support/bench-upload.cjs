#!/usr/bin/env node
'use strict';
/**
 * Upload benchmark for the picsur conversion pipeline.
 *
 * It drives `POST /api/image/upload` against one instance and reports the
 * end-to-end per-request latency distribution, total wall time, failure count,
 * peak `sharp.worker` child-process count, peak RSS and (when the instance is a
 * docker container) the CPU time consumed by that container. It also fetches
 * one uploaded image back and compares its pixels with the fixture.
 *
 * This is the measurement harness for the "fork-per-conversion" baseline and
 * the "resident worker pool" follow-up: both runs must use the same fixture,
 * the same arguments and the same instance settings.
 *
 * Usage:
 *   node support/bench-upload.cjs --base http://127.0.0.1:18080 --token <JWT> \
 *     --fixtures /tmp/picsur-fx --mode serial --count 10
 *   node support/bench-upload.cjs --base http://127.0.0.1:18080 --token <JWT> \
 *     --fixtures /tmp/picsur-fx --mode concurrent --count 8 --concurrency 4
 *
 * Arguments:
 *   --base           instance base url                 (default http://127.0.0.1:18080)
 *   --token          JWT from POST /api/user/login     (required)
 *   --fixtures       fixture directory                 (default /tmp/picsur-fx)
 *   --file           fixture to upload                 (default base.png)
 *   --mode           serial | concurrent               (default serial)
 *   --count          total number of uploads           (default 10)
 *   --concurrency    parallel uploads (concurrent)     (default 4; serial forces 1)
 *   --container      docker container to observe       (default picsur-bench; '' disables)
 *   --sample-ms      worker/CPU sampling interval      (default 50)
 *   --timeout-ms     per-request timeout               (default 60000)
 *   --no-verify      skip the fetch-back pixel check
 *   --keep           do not delete the uploaded images afterwards
 *   --json-out       write the raw run summary as JSON (path)
 *
 * Notes:
 *   - The upload route is rate limited to 20 requests / 60 s / IP. Keep
 *     --count <= 20 per window or wait ~60 s (or restart the instance)
 *     between runs. A 429 counts as a failure so it cannot pass silently.
 *   - The instance must run in a container for worker/CPU observation. On a
 *     host that is not reachable via docker the sampler falls back to a
 *     host-wide /proc scan (only meaningful when no other picsur runs).
 *   - The script itself runs on the host (it needs /proc and docker), not
 *     inside the picsur container.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.qoi': 'image/qoi',
  '.avif': 'image/avif',
  '.jxl': 'image/jxl',
  '.jp2': 'image/jp2',
  '.heif': 'image/heif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function die(message) {
  console.error(`bench-upload: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    base: 'http://127.0.0.1:18080',
    token: '',
    fixtures: '/tmp/picsur-fx',
    file: 'base.png',
    mode: 'serial',
    count: 10,
    concurrency: 4,
    container: 'picsur-bench',
    sampleMs: 50,
    timeoutMs: 60000,
    verify: true,
    keep: false,
    jsonOut: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) die(`missing value for ${key}`);
      return value;
    };
    switch (key) {
      case '--base': args.base = next(); break;
      case '--token': args.token = next(); break;
      case '--fixtures': args.fixtures = next(); break;
      case '--file': args.file = next(); break;
      case '--mode': args.mode = next(); break;
      case '--count': args.count = Number(next()); break;
      case '--concurrency': args.concurrency = Number(next()); break;
      case '--container': args.container = next(); break;
      case '--sample-ms': args.sampleMs = Number(next()); break;
      case '--timeout-ms': args.timeoutMs = Number(next()); break;
      case '--no-verify': args.verify = false; break;
      case '--keep': args.keep = true; break;
      case '--json-out': args.jsonOut = next(); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 46).join('\n'));
        process.exit(0);
        break;
      default:
        die(`unknown argument ${key}`);
    }
  }
  if (!args.token) die('--token is required');
  if (!['serial', 'concurrent'].includes(args.mode)) die('--mode must be serial or concurrent');
  if (!(args.count > 0)) die('--count must be > 0');
  if (!(args.concurrency > 0)) die('--concurrency must be > 0');
  if (!(args.sampleMs >= 5)) die('--sample-ms must be >= 5');
  args.base = args.base.replace(/\/+$/, '');
  args.concurrency = args.mode === 'serial' ? 1 : args.concurrency;
  return args;
}

// ---------------------------------------------------------------------------
// sharp (decode fixture + response for the pixel assertion)
// ---------------------------------------------------------------------------

function loadSharp() {
  const candidates = [
    process.env.PICSUR_NODE_MODULES,
    path.resolve(__dirname, '..', 'backend', 'node_modules'),
    path.resolve(process.cwd(), 'backend', 'node_modules'),
    path.resolve(process.cwd(), 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return require(require.resolve('sharp', { paths: [dir] }));
    } catch {
      /* keep looking */
    }
  }
  die('cannot load sharp; set PICSUR_NODE_MODULES to a node_modules dir containing it');
}

// ---------------------------------------------------------------------------
// host-side observation: docker container id, /proc scan, container cgroup CPU
// ---------------------------------------------------------------------------

function docker(args, timeoutMs = 5000) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs }).trim();
}

function resolveObservedContainer(name) {
  if (!name) return { name: '', id: '' };
  try {
    const id = docker(['inspect', '-f', '{{.Id}}', name]);
    return { name, id };
  } catch {
    console.error(`bench-upload: WARN cannot inspect docker container "${name}", falling back to host-wide /proc scan`);
    return { name, id: '' };
  }
}

function readProcFile(pid, file) {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Samples the host /proc (container processes are visible there) and keeps the
 * peak counts. Every sample is synchronous and cheap: a readdir plus one
 * cmdline read per numeric pid. Sampling stops before stats are printed.
 */
class ProcSampler {
  constructor({ containerId, sampleMs }) {
    this.containerId = containerId;
    this.sampleMs = sampleMs;
    this.timer = null;
    this.samples = 0;
    this.workerPeak = 0;
    this.workerRssPeak = 0;
    this.mainRssPeak = 0;
    this.mainPid = null;
    this.workerSamples = []; // worker count per sample, for the report
  }

  start() {
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    // Do not keep the process alive only because of the sampler.
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sample() {
    this.samples++;
    let workers = 0;
    let workerRss = 0;
    let mainRss = 0;
    let mainPid = null;
    let pids;
    try {
      pids = fs.readdirSync('/proc');
    } catch {
      return;
    }
    for (const pid of pids) {
      if (pid.charCodeAt(0) < 48 || pid.charCodeAt(0) > 57) continue;
      const cmdline = readProcFile(pid, 'cmdline');
      if (!cmdline) continue;
      const isWorker = cmdline.includes('sharp.worker.js');
      const isMain = cmdline.includes('backend/dist/main.js');
      if (!isWorker && !isMain) continue;
      if (this.containerId) {
        const cgroup = readProcFile(pid, 'cgroup');
        if (!cgroup || !cgroup.includes(this.containerId)) continue;
      }
      const statm = readProcFile(pid, 'statm');
      const rss = statm ? Number(statm.split(' ')[1]) * 4096 : 0;
      if (isWorker) {
        workers++;
        workerRss += rss;
      } else {
        mainRss = Math.max(mainRss, rss);
        mainPid = Number(pid);
      }
    }
    this.workerPeak = Math.max(this.workerPeak, workers);
    this.workerRssPeak = Math.max(this.workerRssPeak, workerRss);
    this.mainRssPeak = Math.max(this.mainRssPeak, mainRss);
    if (mainPid !== null && this.mainPid === null) this.mainPid = mainPid;
    this.workerSamples.push(workers);
  }

  readContainerCpuUsec() {
    if (!this.containerId) return null;
    try {
      const out = docker(['exec', this.containerId, 'cat', '/sys/fs/cgroup/cpu.stat']);
      const match = out.match(/^usage_usec\s+(\d+)$/m);
      return match ? Number(match[1]) : null;
    } catch {
      try {
        const out = docker(['exec', this.containerId, 'cat', '/sys/fs/cgroup/cpuacct/cpuacct.usage']);
        const n = Number(out.trim());
        return Number.isFinite(n) ? Math.round(n / 1000) : null;
      } catch {
        return null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function mimeOf(fileName) {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

async function uploadOne({ base, token, buffer, fileName, timeoutMs }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeOf(fileName) }), fileName);

  const startedAt = performance.now();
  let response;
  let text = '';
  try {
    response = await fetch(`${base}/api/image/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: performance.now() - startedAt,
      id: '',
      error: String(error?.message ?? error),
      body: '',
    };
  }
  const latencyMs = performance.now() - startedAt;

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON (throttler) responses are handled below */
  }
  const id = body?.data?.id ?? '';
  return {
    ok: response.status === 201 && Boolean(id),
    status: response.status,
    latencyMs,
    id,
    body: text.length > 400 ? `${text.slice(0, 400)}…` : text,
  };
}

async function fetchImage(base, token, id, timeoutMs) {
  const response = await fetch(`${base}/i/${id}.png`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', buffer };
}

async function deleteImages(base, token, ids, timeoutMs) {
  if (ids.length === 0) return { ok: true, deleted: 0 };
  const response = await fetch(`${base}/api/image/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: response.status === 201, deleted: ids.length, status: response.status };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function summarizeLatencies(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
    count: sorted.length,
  };
}

const fmtMs = (value) => `${value.toFixed(1)}ms`;
const fmtMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sharp = loadSharp();

  const fixturePath = path.resolve(args.fixtures, args.file);
  if (!fs.existsSync(fixturePath)) die(`fixture not found: ${fixturePath}`);
  const fixture = fs.readFileSync(fixturePath);

  const observed = resolveObservedContainer(args.container);
  const sampler = new ProcSampler({ containerId: observed.id, sampleMs: args.sampleMs });

  const startedAt = new Date().toISOString();
  const uploads = [];
  let nextIndex = 0;
  const tasks = Array.from({ length: args.count }, (_, index) => index);
  const runStart = performance.now();
  const cpuStart = sampler.readContainerCpuUsec();

  sampler.start();
  const runners = Array.from({ length: args.concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      const offsetMs = performance.now() - runStart;
      const result = await uploadOne({
        base: args.base,
        token: args.token,
        buffer: fixture,
        fileName: args.file,
        timeoutMs: args.timeoutMs,
      });
      uploads[index] = { index: index + 1, startOffsetMs: offsetMs, ...result };
      const line = result.ok
        ? `  #${String(index + 1).padStart(2, '0')} 201 ${fmtMs(result.latencyMs)} id=${result.id}`
        : `  #${String(index + 1).padStart(2, '0')} FAIL status=${result.status} ${fmtMs(result.latencyMs)} ${result.error ?? result.body ?? ''}`;
      console.log(line);
    }
  });
  await Promise.all(runners);
  const wallMs = performance.now() - runStart;
  sampler.stop();
  const cpuEnd = sampler.readContainerCpuUsec();

  const ordered = uploads.filter(Boolean);
  const okUploads = ordered.filter((r) => r.ok);
  const failures = ordered.filter((r) => !r.ok);
  const latencies = okUploads.map((r) => r.latencyMs);
  const latencyStats = summarizeLatencies(latencies);
  const peakConcurrencyObserved = (() => {
    // Number of requests in flight at the same time, derived from start offsets
    // and latencies; useful to prove the requested concurrency really happened.
    const events = [];
    for (const r of ordered) {
      events.push([r.startOffsetMs, 1]);
      events.push([r.startOffsetMs + r.latencyMs, -1]);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0;
    let peak = 0;
    for (const [, delta] of events) {
      current += delta;
      peak = Math.max(peak, current);
    }
    return peak;
  })();

  // ---- fetch one image back and compare pixels with the fixture -------------
  let verify = { skipped: true };
  if (args.verify && okUploads.length > 0) {
    const target = okUploads[0];
    try {
      const fetched = await fetchImage(args.base, args.token, target.id, args.timeoutMs);
      if (fetched.status !== 200 || !fetched.contentType.startsWith('image/png')) {
        verify = {
          skipped: false,
          ok: false,
          reason: `fetch returned status ${fetched.status} content-type ${fetched.contentType}`,
        };
      } else {
        const expected = await sharp(fixturePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const actual = await sharp(fetched.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const sameShape =
          expected.info.width === actual.info.width &&
          expected.info.height === actual.info.height &&
          expected.info.channels === actual.info.channels;
        const samePixels = sameShape && expected.data.equals(actual.data);
        verify = {
          skipped: false,
          ok: samePixels,
          width: actual.info.width,
          height: actual.info.height,
          channels: actual.info.channels,
          responseBytes: fetched.buffer.length,
          contentType: fetched.contentType,
          reason: samePixels
            ? 'pixels identical to fixture'
            : sameShape
              ? 'pixel buffers differ'
              : `shape differs: fixture ${expected.info.width}x${expected.info.height}x${expected.info.channels}, response ${actual.info.width}x${actual.info.height}x${actual.info.channels}`,
        };
      }
    } catch (error) {
      verify = { skipped: false, ok: false, reason: `verify failed: ${String(error?.message ?? error)}` };
    }
  }

  // ---- cleanup --------------------------------------------------------------
  let cleanup = { skipped: true };
  if (!args.keep) {
    try {
      cleanup = { skipped: false, ...(await deleteImages(args.base, args.token, okUploads.map((r) => r.id), args.timeoutMs)) };
    } catch (error) {
      cleanup = { skipped: false, ok: false, reason: String(error?.message ?? error) };
    }
  }

  const cpuUsec = cpuStart !== null && cpuEnd !== null ? Math.max(0, cpuEnd - cpuStart) : null;
  const result = {
    tool: 'support/bench-upload.cjs',
    startedAt,
    base: args.base,
    mode: args.mode,
    count: args.count,
    concurrency: args.concurrency,
    fixture: { file: args.file, path: fixturePath, bytes: fixture.length },
    instance: {
      container: observed.name,
      containerId: observed.id,
      cpuUsec,
      cpuSeconds: cpuUsec !== null ? cpuUsec / 1e6 : null,
      cpuCoresAverage: cpuUsec !== null && wallMs > 0 ? cpuUsec / 1e6 / (wallMs / 1000) : null,
    },
    wallMs,
    ok: okUploads.length,
    failed: failures.length,
    throughputPerSecond: wallMs > 0 ? okUploads.length / (wallMs / 1000) : 0,
    latencyMs: latencyStats,
    peakConcurrencyObserved,
    sampling: {
      intervalMs: args.sampleMs,
      samples: sampler.samples,
      workerPeak: sampler.workerPeak,
      workerRssPeakBytes: sampler.workerRssPeak,
      mainRssPeakBytes: sampler.mainRssPeak,
      mainPid: sampler.mainPid,
      workerCounts: sampler.workerSamples,
    },
    requests: ordered,
    verify,
    cleanup,
  };

  // ---- report ---------------------------------------------------------------
  console.log('');
  console.log('== bench-upload summary ==');
  console.log(`base             ${args.base}`);
  console.log(`mode             ${args.mode} (concurrency ${args.concurrency}), fixture ${args.file} (${fixture.length} B)`);
  console.log(`uploads          ${args.count} total, ${okUploads.length} ok, ${failures.length} failed`);
  console.log(`wall             ${fmtMs(wallMs)}`);
  console.log(`latency          min ${fmtMs(latencyStats.min)} / p50 ${fmtMs(latencyStats.p50)} / p90 ${fmtMs(latencyStats.p90)} / p95 ${fmtMs(latencyStats.p95)} / max ${fmtMs(latencyStats.max)} / mean ${fmtMs(latencyStats.mean)}`);
  console.log(`throughput       ${result.throughputPerSecond.toFixed(2)} uploads/s`);
  console.log(`peak concurrency ${peakConcurrencyObserved} in flight`);
  console.log(`worker peak      ${sampler.workerPeak} processes (${sampler.samples} samples @ ${args.sampleMs}ms)`);
  console.log(`worker rss peak  ${fmtMb(sampler.workerRssPeak)}`);
  console.log(`main rss peak    ${fmtMb(sampler.mainRssPeak)}`);
  console.log(
    `container cpu    ${cpuUsec === null ? 'unavailable' : `${(cpuUsec / 1e6).toFixed(2)}s over ${(wallMs / 1000).toFixed(2)}s = ${result.instance.cpuCoresAverage.toFixed(2)} cores`}`,
  );
  console.log(`pixel verify     ${verify.skipped ? 'skipped' : verify.ok ? `PASS ${verify.width}x${verify.height}x${verify.channels} ${verify.reason} (${verify.responseBytes} B, ${verify.contentType})` : `FAIL ${verify.reason}`}`);
  console.log(`cleanup          ${cleanup.skipped ? 'skipped (--keep)' : cleanup.ok ? `deleted ${okUploads.length} images` : `FAILED ${cleanup.reason ?? cleanup.status}`}`);

  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(args.jsonOut), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`json             ${path.resolve(args.jsonOut)}`);
  }

  if (failures.length > 0 || (verify.skipped === false && verify.ok === false) || cleanup.ok === false) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
