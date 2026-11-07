/*
 * Accuracy test: generate a synthetic puzzle, render scanner images, run the
 * full pipeline in headless Chromium and compare with the ground truth.
 *
 *   node puzzle/test/run-tests.js [--seed 7] [--cols 10] [--rows 9] [--dpi 300] [--faceup] [--wave 0.035]
 */
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : isNaN(+v) ? v : +v;
};

const cfg = {
  seed: opt('seed', 7),
  cols: opt('cols', 10),
  rows: opt('rows', 9),
  dpi: opt('dpi', 300),
  faceDown: !opt('faceup', false),
  wave: opt('wave', 0.035),
  jitter: opt('jitter', 0.07),
  perScan: opt('perscan', 30),
  blur: opt('blur', 0.7),
  noise: opt('noise', 7),
  perturb: opt('perturb', 0),
  shadow: opt('shadow', 0),
  variety: opt('variety', 1),
  log: opt('log', false),
  maxCost: opt('maxcost', 0),
  r1: opt('r1', 0), t1: opt('t1', 0),
  blob: opt('blob', 0), // >0: take a connected blob of this many pieces from a bigger puzzle
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'solver.js') });
  await page.addScriptTag({ path: path.join(__dirname, '..', 'synth.js') });
  const t0 = Date.now();
  const res = await page.evaluate(async (cfg) => {
    const S = PuzzleSolver, Y = PuzzleSynth;
    const puzzle = Y.generatePuzzle({ cols: cfg.cols, rows: cfg.rows, seed: cfg.seed, wave: cfg.wave, jitter: cfg.jitter, variety: cfg.variety });
    const R = Y.rng(cfg.seed * 13 + 1);
    let subset = puzzle.pieces;
    if (cfg.blob > 0) {
      const inSet = new Set();
      const start = Math.floor(puzzle.rows / 2) * puzzle.cols + Math.floor(puzzle.cols / 2);
      const front = [start];
      inSet.add(start);
      while (inSet.size < cfg.blob && front.length) {
        const k = Math.floor(R.next() * front.length);
        const id = front[k];
        const nbs = puzzle.pieces[id].neighbours.filter(Boolean).map((n) => n[0]).filter((x) => !inSet.has(x));
        if (!nbs.length) { front.splice(k, 1); continue; }
        const nx = nbs[Math.floor(R.next() * nbs.length)];
        inSet.add(nx); front.push(nx);
      }
      subset = puzzle.pieces.filter((p) => inSet.has(p.id));
    }
    const subsetIds = new Set(subset.map((p) => p.id));
    const order = subset.slice().sort(() => R.next() - 0.5);
    const scans = [];
    for (let k = 0; k < order.length; k += cfg.perScan) scans.push(order.slice(k, k + cfg.perScan));
    const det = []; // { truthId, geo, contour }
    const timing = { extract: 0, analyze: 0, match: 0, assemble: 0 };
    let missing = 0, warnings = [];
    for (let si = 0; si < scans.length; si++) {
      const r = Y.renderScan(scans[si], { dpi: cfg.dpi, seed: cfg.seed * 7 + si, faceDown: cfg.faceDown, blur: cfg.blur, noise: cfg.noise, perturb: cfg.perturb, shadow: cfg.shadow });
      const im = r.canvas.getContext('2d').getImageData(0, 0, r.width, r.height);
      let t = performance.now();
      const ex = await S.extractPieces(im.data, r.width, r.height, { dpi: cfg.dpi });
      timing.extract += performance.now() - t;
      warnings.push(...ex.warnings.map((w) => w.kind));
      const used = new Set();
      for (const p of ex.pieces) {
        // nearest placement by centre
        let best = null, bd = Infinity;
        for (const pl of r.placements) {
          const px = pl.tx / r.mmPerPx, py = -pl.ty / r.mmPerPx;
          const d = Math.hypot(px - p.centroidPx[0], py - p.centroidPx[1]);
          if (d < bd) { bd = d; best = pl; }
        }
        used.add(best.id);
        t = performance.now();
        const front = S.frontView(p.contour, cfg.faceDown);
        const geo = S.analyzePiece(front, 0.1);
        timing.analyze += performance.now() - t;
        // truth corners in front-view coordinates
        const tp = puzzle.pieces[best.id];
        const tc = tp.corners.map(([x, y]) => {
          const [X, Yy] = Y.placeToScan(best, x, y);
          return cfg.faceDown ? [X, Yy] : [-X, Yy];
        });
        det.push({ truthId: best.id, geo, tc });
      }
      missing += scans[si].length - used.size;
    }
    // corner accuracy and side mapping
    let cornerOk = 0, cornerErr = [], typeFlatOk = 0, typeFlatTot = 0;
    const sideMap = new Map(); // "truthId:s" -> detected side id
    det.forEach((d, idx) => {
      const m = d.geo.cornerPts.map(([x, y]) => {
        let bi = 0, bd = Infinity;
        d.tc.forEach(([tx, ty], k) => { const e = Math.hypot(tx - x, ty - y); if (e < bd) { bd = e; bi = k; } });
        cornerErr.push(bd);
        return { k: bi, e: bd };
      });
      const allGood = m.every((o) => o.e < 1.0) && new Set(m.map((o) => o.k)).size === 4;
      if (allGood) {
        cornerOk++;
        for (let s = 0; s < 4; s++) {
          const ts = m[s].k; // detected side s runs from detected corner s, = truth corner ts
          if (m[(s + 1) & 3].k !== ((ts + 1) & 3)) continue;
          sideMap.set(d.truthId + ':' + ts, idx * 4 + s);
          const tp = puzzle.pieces[d.truthId];
          const isBorder = !tp.neighbours[ts];
          typeFlatTot++;
          if ((d.geo.sides[s].type === 0) === isBorder) typeFlatOk++;
        }
      }
    });
    cornerErr.sort((a, b) => a - b);
    let t = performance.now();
    const pieces = det.map((d) => ({ geo: d.geo }));
    const M = S.buildMatches(pieces);
    timing.match = performance.now() - t;
    // rank of the true partner
    let pairs = 0, top1 = 0, top3 = 0, complementary = 0;
    const costsTrue = [], costsBestWrong = [];
    for (const tp of puzzle.pieces) {
      for (let s = 0; s < 4; s++) {
        const nb = tp.neighbours[s];
        if (!nb || nb[0] < tp.id || !subsetIds.has(tp.id) || !subsetIds.has(nb[0])) continue;
        const a = sideMap.get(tp.id + ':' + s), b = sideMap.get(nb[0] + ':' + nb[1]);
        if (a == null || b == null) continue;
        pairs++;
        const ta = M.side(a).type, tb = M.side(b).type;
        if (ta * tb === -1) complementary++; else continue;
        const list = M.ranked(a);
        const rank = list.findIndex((e) => e.side === b);
        if (rank === 0) top1++;
        if (rank >= 0 && rank < 3) top3++;
        costsTrue.push(M.cost(a, b));
        const wrong = list.find((e) => e.side !== b);
        if (wrong) costsBestWrong.push(wrong.cost);
      }
    }
    t = performance.now();
    const ao = {};
    if (cfg.maxCost) ao.maxCost = cfg.maxCost;
    if (cfg.r1) ao.r1 = cfg.r1;
    if (cfg.t1) ao.t1 = cfg.t1 * M.calib.joint;
    const asm = S.assemble(pieces, M, ao);
    timing.assemble = performance.now() - t;
    const truthPair = new Set();
    for (const tp of puzzle.pieces) for (let s = 0; s < 4; s++) {
      const nb = tp.neighbours[s];
      if (!nb) continue;
      const a = sideMap.get(tp.id + ':' + s), b = sideMap.get(nb[0] + ':' + nb[1]);
      if (a != null && b != null) truthPair.add(S.pairKey(a, b));
    }
    let jOk = 0;
    for (const j of asm.joints) if (truthPair.has(S.pairKey(j.a, j.b))) jOk++;
    const evLog = asm.events.map((e, k) => {
      const js = e.joints || [];
      const ok = js.every((j) => truthPair.has(S.pairKey(j.a, j.b)));
      return (e.seed ? 'S' : '') + (ok ? '+' : '-') + (e.nbs || 0) + (e.ratio != null ? '@' + e.ratio.toFixed(2) : '') + (e.cost != null ? '/' + e.cost.toFixed(3) : '') + (e.nbs > 1 ? '[' + e.jc.toFixed(3) + ',' + e.disc.toFixed(2) + ']' : '');
    });
    const q = (arr, f) => (arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * f))].toFixed(3) : null);
    costsTrue.sort((a, b) => a - b); costsBestWrong.sort((a, b) => a - b);
    return {
      pieces: subset.length, detected: det.length, missing, warnings,
      cornersAllOk: cornerOk, cornerErrMedian: q(cornerErr, 0.5), cornerErrP90: q(cornerErr, 0.9),
      flatClassOk: typeFlatOk + '/' + typeFlatTot,
      truePairs: pairs, complementary, top1, top3,
      costTrue: { p50: q(costsTrue, 0.5), p90: q(costsTrue, 0.9), max: q(costsTrue, 1) },
      costBestWrong: { p10: q(costsBestWrong, 0.1), p50: q(costsBestWrong, 0.5) },
      assembly: {
        clusters: asm.clusters.length,
        sizes: asm.clusters.map((c) => c.pieces.length).sort((a, b) => b - a).slice(0, 8),
        joints: asm.joints.length, jointsCorrect: jOk, unplaced: asm.unplaced.length,
      },
      events: cfg.log ? evLog.join(' ') : undefined,
      calib: M.calib,
      precision: asm.joints.length ? +(jOk / asm.joints.length).toFixed(3) : null,
      coverage: pairs ? +(jOk / pairs).toFixed(3) : null,
      timingMs: Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])),
    };
  }, cfg);
  console.log(JSON.stringify({ cfg, ...res, wallMs: Date.now() - t0 }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
