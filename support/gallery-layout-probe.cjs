#!/usr/bin/env node
/**
 * Gallery layout + sharpness probe.
 *
 * Measures the "your images" page at several viewport widths and asserts what
 * the owner complained about: cards in one row have to be equally tall, no
 * thumbnail may be scaled *up* past its decoded size (that is what made them
 * look blurry), nothing may overflow horizontally, and the touch targets have
 * to be big enough on phones.
 *
 * Usage:
 *   node support/gallery-layout-probe.cjs --base=http://127.0.0.1:8095 \
 *     --token=<jwt> --out=/tmp/gallery [--widths=1440,834,390]
 */

const fs = require('node:fs');
const path = require('node:path');

function loadPlaywright() {
  for (const candidate of [
    'playwright',
    'playwright-core',
    '/usr/lib/node_modules/playwright',
  ]) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found');
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return out;
}

/** Runs in the page. */
function measure() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  const cards = [...document.querySelectorAll('mat-card')].map((card) => {
    const thumb = card.querySelector('picsur-img canvas, picsur-img img');
    const thumbBox = card.querySelector('picsur-img');
    // Video cards have no thumbnail on purpose (there is no poster frame):
    // they must be recognised and excluded from the picture assertions instead
    // of being reported as "unloaded".
    const videoThumb = card.querySelector('[data-media-kind="video"]');
    const title = card.querySelector('mat-card-title');
    const subtitle = card.querySelector('mat-card-subtitle');
    let source = null;
    if (thumb) {
      source =
        thumb.tagName === 'CANVAS'
          ? { w: thumb.width, h: thumb.height }
          : { w: thumb.naturalWidth, h: thumb.naturalHeight };
    }
    const shown = thumb ? rect(thumb) : null;
    const hostBox = thumbBox ? rect(thumbBox) : null;

    // How big the picture is actually *drawn*, which depends on object-fit:
    // `cover` zooms to fill (and can enlarge a small source), `none` keeps the
    // source size, `contain` fits inside. Comparing the element box with the
    // source would call a correctly letterboxed small picture "upscaled".
    const fit = thumb ? getComputedStyle(thumb).objectFit : 'fill';
    let scale = 0;
    if (source && shown && source.w > 0 && source.h > 0 && shown.w > 0) {
      const sx = shown.w / source.w;
      const sy = shown.h / source.h;
      if (fit === 'cover') scale = Math.max(sx, sy);
      else if (fit === 'contain') scale = Math.min(sx, sy);
      else if (fit === 'none') scale = 1;
      else scale = Math.max(sx, sy);
    }
    const density = window.devicePixelRatio || 1;
    const requested =
      Number(thumbBox?.getAttribute('data-requested-width') ?? 0) || 0;

    return {
      card: rect(card),
      mediaKind: videoThumb ? 'video' : 'image',
      hasVideoBadge: videoThumb
        ? videoThumb.querySelector('.video-badge') !== null
        : null,
      title: title ? title.textContent.trim() : null,
      titleBox: title ? rect(title) : null,
      subtitleBox: subtitle ? rect(subtitle) : null,
      thumbTag: thumb ? thumb.tagName.toLowerCase() : null,
      objectFit: fit,
      source,
      thumb: shown,
      thumbHost: hostBox,
      // CSS pixels the picture is drawn at, and the physical pixels the screen
      // needs for them. `upscale` > 1.02 means the browser is inventing pixels.
      drawn: source
        ? { w: Math.round(source.w * scale), h: Math.round(source.h * scale) }
        : null,
      scale: Math.round(scale * 1000) / 1000,
      upscale: Math.round(scale * density * 1000) / 1000,
      dpr: density,
      requested: requested || null,
      // The server clamps to the original, so a picture whose original is
      // smaller than the card can never reach 1:1 on a 2x screen. That is the
      // source's limit, not a sizing bug — but it is worth reporting.
      sourceLimited:
        fit === 'none' ||
        (requested > 0 && source ? source.w + 2 < requested : false),
      buttons: [...card.querySelectorAll('button')].map((b) => ({
        text: b.textContent.trim(),
        ...rect(b),
      })),
    };
  });

  // Cards that start on the same y are one visual row; they must match in height.
  const rows = {};
  for (const card of cards) {
    const key = Math.round(card.card.y / 20) * 20;
    (rows[key] ??= []).push(card.card.h);
  }
  const rowHeights = Object.entries(rows).map(([y, heights]) => ({
    y: Number(y),
    cards: heights.length,
    min: Math.min(...heights),
    max: Math.max(...heights),
    equal: Math.max(...heights) - Math.min(...heights) <= 1,
  }));

  const scrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  );
  const images = [
    ...document.querySelectorAll('picsur-img canvas, picsur-img img'),
  ];
  // Only picture cards take part in the sharpness assertions; a video card has
  // no decoded frame by design (that is what `data-media-kind` is for).
  const imageCards = cards.filter((c) => c.mediaKind !== 'video');
  const videoCards = cards.filter((c) => c.mediaKind === 'video');

  return {
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    cardCount: cards.length,
    cards,
    rowHeights,
    imageCards: imageCards.length,
    videoCards: videoCards.length,
    videoWithoutBadge: videoCards.filter((c) => c.hasVideoBadge !== true)
      .length,
    unloaded: imageCards.filter((c) => !c.source || c.source.w === 0).length,
    // "Upscaled" means the layout stretched a picture past its own pixels
    // (CSS scale > 1) — that is the blurry kind. A picture drawn 1:1 on a 2x
    // screen simply does not have the pixels the screen could show, which is
    // the source's limit, so it is counted separately.
    upscaled: imageCards.filter((c) => (c.scale ?? 0) > 1.05).length,
    upscaledBySource: imageCards.filter(
      (c) => (c.upscale ?? 0) > 1.05 && (c.scale ?? 0) <= 1.05,
    ).length,
    maxScale:
      Math.round(Math.max(0, ...imageCards.map((c) => c.upscale ?? 0)) * 1000) /
      1000,
    overflowX: scrollWidth > window.innerWidth + 1,
    scrollWidth,
    innerWidth: window.innerWidth,
    thumbs: images.length,
    smallTargets: [...document.querySelectorAll('mat-card button')]
      .map((b) => rect(b))
      .filter((r) => r.h < 44 || r.w < 44).length,
  };
}

/**
 * Performance half of the probe (`--perf`).
 *
 * The owner reported the page as "extremely laggy" and "takes forever to show
 * anything". Guessing which part is slow is useless, so this mode records:
 * request counts (image body / HEAD / API), per-picture duration and whether
 * they overlap or run one after another, when the first picture is visible and
 * when the last one is, redundant requests (same picture twice, a HEAD before
 * every GET, a second "correction" request), how many pictures were fetched
 * before anything was visible, and main thread blocking.
 */

/** Installed before any page script runs. */
function installPerfObservers() {
  window.__gp = { longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__gp.longTasks.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask unsupported in this browser */
  }
}

/** Runs in the page: which thumbnails have pixels, and which are on screen. */
function sampleThumbs() {
  const viewportH = window.innerHeight;
  return [...document.querySelectorAll('picsur-img')].map((host) => {
    const media = host.querySelector('canvas, img');
    const ready = media
      ? media.tagName === 'CANVAS'
        ? media.width > 0 && media.height > 0
        : media.naturalWidth > 0
      : false;
    const rect = host.getBoundingClientRect();
    return { ready, onScreen: rect.bottom > 0 && rect.top < viewportH };
  });
}

const medianOf = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
};
const percentileOf = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(
      sorted[
        Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
      ] * 10,
    ) / 10
  );
};

async function runPerfOnce(
  browser,
  { base, token, outDir, run, route, viewportWidth },
) {
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: 900 },
  });
  await context.addInitScript(installPerfObservers);
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('apiKey', t);
      localStorage.setItem('picsur.language', 'zh');
    } catch {
      /* ignore */
    }
  }, token);

  const page = await context.newPage();
  const imageCalls = new Map();
  const inFlight = new Set();
  let maxConcurrent = 0;
  let apiCalls = 0;
  let imageBytes = 0;
  let headBytes = 0;

  page.on('request', (req) => {
    if (req.url().includes('/api/')) apiCalls += 1;
    if (!req.url().includes('/i/')) return;
    const entry = {
      method: req.method(),
      start: Date.now(),
      end: null,
      status: null,
    };
    const list = imageCalls.get(req.url()) ?? [];
    list.push(entry);
    imageCalls.set(req.url(), list);
    inFlight.add(entry);
    maxConcurrent = Math.max(maxConcurrent, inFlight.size);
  });
  let pendingMethods = new Map();
  page.on('request', (req) => {
    if (req.url().includes('/i/')) pendingMethods.set(req, req.method());
  });
  page.on('response', async (res) => {
    if (!res.url().includes('/i/')) return;
    const method = pendingMethods.get(res.request()) ?? res.request().method();
    const length = Number(res.headers()['content-length'] ?? '0');
    let bytes = length;
    if (!bytes) {
      try {
        bytes = (await res.body()).length;
      } catch {
        bytes = 0;
      }
    }
    if (method === 'HEAD') headBytes += bytes;
    else imageBytes += bytes;
    const last = [...imageCalls.values()]
      .flat()
      .filter((c) => c.end !== null)
      .pop();
    if (last) last.bytes = bytes;

    for (const entry of inFlight) {
      if (entry.end === null) {
        entry.end = Date.now();
        entry.status = res.status();
        inFlight.delete(entry);
      }
    }
  });

  const t0 = Date.now();
  await page.goto(`${base}${route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  let firstVisible = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && firstVisible === null) {
    const state = await page.evaluate(sampleThumbs);
    if (state.some((s) => s.onScreen && s.ready))
      firstVisible = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  const loadedBeforeScroll = (await page.evaluate(sampleThumbs)).filter(
    (s) => s.ready,
  ).length;

  // walk the page like a user, note when the last picture is ready
  let allReady = null;
  const scrollDeadline = Date.now() + 60000;
  while (Date.now() < scrollDeadline) {
    await page.evaluate(async () => {
      for (const host of document.querySelectorAll('picsur-img')) {
        host.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
      document
        .querySelectorAll('mat-sidenav-content, .mat-drawer-content')
        .forEach((el) => el.scrollTo?.(0, 0));
    });
    const state = await page.evaluate(sampleThumbs);
    if (state.length > 0 && state.every((s) => s.ready)) {
      allReady = Date.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Revisit: leave the page and come back, like clicking the sidebar twice.
  const firstPassEnd = Date.now();
  const callsBeforeRevisit = [...imageCalls.values()].flat().length;
  await page.goto('about:blank', { waitUntil: 'load', timeout: 30000 });
  const t1 = Date.now();
  await page.goto(`${base}${route}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  let revisitVisible = null;
  const revisitDeadline = Date.now() + 15000;
  while (Date.now() < revisitDeadline && revisitVisible === null) {
    const state = await page.evaluate(sampleThumbs);
    if (state.some((s2) => s2.onScreen && s2.ready))
      revisitVisible = Date.now() - t1;
    await new Promise((r) => setTimeout(r, 60));
  }
  const allCalls = [...imageCalls.values()].flat();
  const revisitCalls = allCalls.slice(callsBeforeRevisit);
  const revisitBytes = revisitCalls.reduce((sum, c) => sum + (c.bytes ?? 0), 0);

  const longTasks = await page.evaluate(() => window.__gp?.longTasks ?? []);
  const calls = [...imageCalls.values()].flat();
  const durations = calls.map((c) => (c.end ?? Date.now()) - c.start);
  const duplicated = [...imageCalls.entries()].filter(
    ([, list]) => list.length > 1,
  );

  const result = {
    run,
    firstVisibleMs: firstVisible,
    allReadyMs: allReady,
    imageRequests: calls.length,
    imageGets: calls.filter((c) => c.method === 'GET').length,
    imageHeads: calls.filter((c) => c.method === 'HEAD').length,
    apiRequests: apiCalls,
    uniqueImageUrls: imageCalls.size,
    duplicatedUrls: duplicated.map(([url, list]) => ({
      path: url.split('/i/')[1],
      count: list.length,
    })),
    maxConcurrentImages: maxConcurrent,
    loadedBeforeScroll,
    perImageMs: {
      median: medianOf(durations),
      p95: percentileOf(durations, 95),
      max: Math.round(Math.max(0, ...durations)),
    },
    imageBytes,
    headBytes,
    totalBytes: imageBytes + headBytes,
    firstPassMs: firstPassEnd - t0,
    revisitVisibleMs: revisitVisible,
    revisitRequests: revisitCalls.length,
    revisitBytes,
    longTasks: longTasks.length,
    longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0),
    longestTaskMs: Math.round(Math.max(0, ...longTasks)),
  };
  await page.screenshot({ path: `${outDir}/perf-run${run}.png` });
  await context.close();
  return result;
}

async function runPerf(args) {
  const base = (args.base || 'http://127.0.0.1:8095').replace(/\/$/, '');
  const cdp = args.cdp || 'http://127.0.0.1:9222';
  const token = args.token || process.env.PICSUR_PROBE_TOKEN || '';
  const runs = Number(args.runs || 3);
  const route = args.route || '/images/1';
  const viewportWidth = Number(args.viewport || 1440);
  const outDir = args.out || '/tmp/gallery-perf';
  fs.mkdirSync(outDir, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(cdp, { timeout: 30000 });
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    const result = await runPerfOnce(browser, {
      base,
      token,
      outDir,
      run,
      route,
      viewportWidth,
    });
    results.push(result);
    console.log(
      `run ${run}: 首图可见 ${result.firstVisibleMs}ms | 全部就绪 ${result.allReadyMs}ms |` +
        ` 图片请求 ${result.imageRequests}（GET ${result.imageGets} / HEAD ${result.imageHeads}）| API ${result.apiRequests}` +
        ` | 并发上限 ${result.maxConcurrentImages} | 滚动前已加载 ${result.loadedBeforeScroll}` +
        ` | 每图 p50 ${result.perImageMs.median}ms p95 ${result.perImageMs.p95}ms` +
        ` | 长任务 ${result.longTasks} 个 / ${result.longTaskTotalMs}ms（最长 ${result.longestTaskMs}ms）` +
        ` | 传输 ${Math.round(result.totalBytes / 1024)}KB（图体 ${Math.round(result.imageBytes / 1024)}KB / HEAD ${Math.round(result.headBytes / 1024)}KB）` +
        ` | 二次进入 首图 ${result.revisitVisibleMs}ms / ${result.revisitRequests} 请求 / ${result.revisitBytes}B`,
    );
    if (result.duplicatedUrls.length > 0) {
      console.log(
        `       重复请求 ${result.duplicatedUrls.length} 个: ${JSON.stringify(result.duplicatedUrls.slice(0, 5))}`,
      );
    }
  }
  await browser.close();

  const summary = {
    firstVisibleMs: medianOf(
      results.map((r) => r.firstVisibleMs).filter((v) => v !== null),
    ),
    allReadyMs: medianOf(
      results.map((r) => r.allReadyMs).filter((v) => v !== null),
    ),
    imageRequests: medianOf(results.map((r) => r.imageRequests)),
    imageGets: medianOf(results.map((r) => r.imageGets)),
    imageHeads: medianOf(results.map((r) => r.imageHeads)),
    apiRequests: medianOf(results.map((r) => r.apiRequests)),
    maxConcurrentImages: medianOf(results.map((r) => r.maxConcurrentImages)),
    loadedBeforeScroll: medianOf(results.map((r) => r.loadedBeforeScroll)),
    perImageMedianMs: medianOf(
      results.map((r) => r.perImageMs.median).filter((v) => v !== null),
    ),
    perImageP95Ms: medianOf(
      results.map((r) => r.perImageMs.p95).filter((v) => v !== null),
    ),
    totalBytes: medianOf(results.map((r) => r.totalBytes)),
    revisitVisibleMs: medianOf(
      results.map((r) => r.revisitVisibleMs).filter((v) => v !== null),
    ),
    revisitRequests: medianOf(results.map((r) => r.revisitRequests)),
    revisitBytes: medianOf(results.map((r) => r.revisitBytes)),
    imageBytes: medianOf(results.map((r) => r.imageBytes)),
    longTaskTotalMs: medianOf(results.map((r) => r.longTaskTotalMs)),
    longestTaskMs: medianOf(results.map((r) => r.longestTaskMs)),
  };
  fs.writeFileSync(
    `${outDir}/perf-report.json`,
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log('\nmedian summary:', JSON.stringify(summary));
  console.log(`report: ${outDir}/perf-report.json`);
}

async function main() {
  const args = parseArgs(process.argv);
  const base = (args.base || 'http://127.0.0.1:8095').replace(/\/$/, '');
  const cdp = args.cdp || 'http://127.0.0.1:9222';
  const token = args.token || process.env.PICSUR_PROBE_TOKEN || '';
  const widths = (args.widths || '1440,834,390').split(',').map(Number);
  const dprs = (args.dprs || '1,2').split(',').map(Number);
  const outDir = args.out || '/tmp/gallery';
  fs.mkdirSync(outDir, { recursive: true });

  if (args.perf) {
    await runPerf(args);
    return;
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(cdp, { timeout: 30000 });
  const report = [];
  let failures = 0;

  for (const width of widths) {
    for (const dpr of dprs) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: dpr,
      });
      await context.addInitScript(
        ([t, l]) => {
          try {
            if (t) localStorage.setItem('apiKey', t);
            localStorage.setItem('picsur.language', l);
          } catch {
            /* ignore */
          }
        },
        [token, 'zh'],
      );
      const page = await context.newPage();
      await page.goto(`${base}/images/1`, {
        waitUntil: 'load',
        timeout: 60000,
      });
      await page.waitForTimeout(1500);

      // thumbnails are lazy: walk the page so every card gets its image
      // The client scrolls an inner container, not the window, so scroll every
      // lazy thumbnail into view by hand and wait until it really has pixels.
      for (let pass = 0; pass < 4; pass += 1) {
        await page.evaluate(async () => {
          for (const host of document.querySelectorAll('picsur-img')) {
            host.scrollIntoView({ block: 'center' });
            await new Promise((r) => setTimeout(r, 400));
          }
          window.scrollTo(0, 0);
          document
            .querySelectorAll(
              'mat-sidenav-content, .mat-drawer-content, .mat-sidenav-content',
            )
            .forEach((el) => el.scrollTo?.(0, 0));
          await new Promise((r) => setTimeout(r, 500));
        });
        const ready = await page.evaluate(() =>
          [...document.querySelectorAll('picsur-img')].every(
            (h) => h.querySelector('canvas, img') !== null,
          ),
        );
        if (ready) break;
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(800);

      const result = await page.evaluate(measure);
      await page.screenshot({
        path: path.join(outDir, `gallery-${width}.png`),
        fullPage: true,
      });

      const bad =
        result.upscaled > 0 ||
        result.unloaded > 0 ||
        result.overflowX ||
        result.smallTargets > 0 ||
        result.videoWithoutBadge > 0 ||
        result.rowHeights.some((r) => r.cards > 1 && !r.equal) ||
        result.cardCount === 0;
      if (bad) failures += 1;

      report.push({ width, dpr, ...result });
      console.log(
        `${bad ? 'FAIL' : 'ok  '} ${String(width).padStart(4)}px @${dpr}x cards=${result.cardCount} (images=${result.imageCards} videos=${result.videoCards}) rows=${result.rowHeights
          .map((r) => `${r.cards}x${r.min}${r.equal ? '' : `-${r.max}✗`}`)
          .join(
            ' ',
          )} upscaled=${result.upscaled} sourceLimited=${result.upscaledBySource} maxScale=${result.maxScale} unloaded=${result.unloaded} videoNoBadge=${result.videoWithoutBadge} overflowX=${result.overflowX} smallTargets=${result.smallTargets}`,
      );
      for (const card of result.cards.slice(0, 6)) {
        console.log(
          `       card ${String(card.card.w).padStart(3)}x${String(card.card.h).padStart(3)} thumb ${String(card.thumb?.w ?? 0).padStart(3)}x${String(card.thumb?.h ?? 0).padStart(3)}` +
            ` src ${String(card.source?.w ?? 0).padStart(4)}x${String(card.source?.h ?? 0).padStart(4)} drawn ${String(card.drawn?.w ?? 0).padStart(4)}x${String(card.drawn?.h ?? 0).padStart(4)} fit=${card.objectFit} upscale@${card.dpr}x=${card.upscale} title="${card.title}"`,
        );
      }
      await context.close();
    }
  }

  await browser.close();
  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nreport: ${path.join(outDir, 'report.json')}`);
  console.log(
    failures === 0
      ? 'PASS: aligned, no upscaling, no overflow, touch targets ok'
      : `FAIL: ${failures} width(s) need work`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
