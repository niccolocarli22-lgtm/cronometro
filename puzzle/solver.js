/*
 * Incastri al Buio — geometric engine.
 *
 * Pipeline:
 *   scan image -> dark/light threshold -> connected components -> outer contour
 *   -> sub-pixel edge refinement -> contour in millimetres
 *   -> 4 corners -> 4 sides (flat / tab / blank) -> side curves in local frames
 *   -> tab-vs-blank fit cost for every pair (Procrustes, then ICP on the best)
 *   -> greedy grid assembly with pose (loop) consistency and user constraints.
 *
 * Coordinates: millimetres, y axis pointing UP, contours counter-clockwise
 * (interior on the left of the direction of travel). Sides are numbered in
 * contour order. A side frame has x along the chord from its first corner to
 * its second and y towards the piece interior, so a tab bulges to negative y.
 *
 * Works in the browser (global PuzzleSolver) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PuzzleSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const wrap = (i, n) => ((i % n) + n) % n;
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  // ------------------------------------------------------------------
  // Rigid 2D transforms: [cos, sin, tx, ty]  p' = R p + t
  // ------------------------------------------------------------------
  const Rigid = {
    id: () => [1, 0, 0, 0],
    make: (a, tx, ty) => [Math.cos(a), Math.sin(a), tx || 0, ty || 0],
    apply(t, x, y) { return [t[0] * x - t[1] * y + t[2], t[1] * x + t[0] * y + t[3]]; },
    compose(a, b) { // a ∘ b  (apply b first)
      const c = a[0] * b[0] - a[1] * b[1];
      const s = a[1] * b[0] + a[0] * b[1];
      const n = Math.hypot(c, s) || 1;
      return [c / n, s / n, a[0] * b[2] - a[1] * b[3] + a[2], a[1] * b[2] + a[0] * b[3] + a[3]];
    },
    invert(t) {
      const c = t[0], s = t[1];
      return [c, -s, -(c * t[2] + s * t[3]), -(-s * t[2] + c * t[3])];
    },
    angle: (t) => Math.atan2(t[1], t[0]),
    applyAll(t, P) {
      const out = new Float64Array(P.length);
      for (let i = 0; i < P.length; i += 2) {
        out[i] = t[0] * P[i] - t[1] * P[i + 1] + t[2];
        out[i + 1] = t[1] * P[i] + t[0] * P[i + 1] + t[3];
      }
      return out;
    },
  };

  // ------------------------------------------------------------------
  // Polyline helpers (flat Float64Array [x0,y0,x1,y1,...])
  // ------------------------------------------------------------------
  function signedArea(P) {
    let a = 0;
    const n = P.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += P[2 * i] * P[2 * j + 1] - P[2 * j] * P[2 * i + 1];
    }
    return a / 2;
  }

  function reversePts(P) {
    const n = P.length >> 1;
    const out = new Float64Array(P.length);
    for (let i = 0; i < n; i++) {
      out[2 * i] = P[2 * (n - 1 - i)];
      out[2 * i + 1] = P[2 * (n - 1 - i) + 1];
    }
    return out;
  }

  function centroidOf(P) {
    // area centroid of a closed polygon
    let a = 0, cx = 0, cy = 0;
    const n = P.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cr = P[2 * i] * P[2 * j + 1] - P[2 * j] * P[2 * i + 1];
      a += cr;
      cx += (P[2 * i] + P[2 * j]) * cr;
      cy += (P[2 * i + 1] + P[2 * j + 1]) * cr;
    }
    a /= 2;
    if (Math.abs(a) < 1e-9) return [P[0], P[1]];
    return [cx / (6 * a), cy / (6 * a)];
  }

  function perimeter(P, closed) {
    const n = P.length >> 1;
    let L = 0;
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      L += Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]);
    }
    return L;
  }

  // Resample a closed curve at a uniform arc-length step.
  function resampleClosed(P, step) {
    const n = P.length >> 1;
    const total = perimeter(P, true);
    const m = Math.max(8, Math.round(total / step));
    const st = total / m;
    const out = new Float64Array(2 * m);
    let seg = 0, segStart = 0;
    let ax = P[0], ay = P[1];
    let bx = P[2 % P.length], by = P[3 % P.length];
    let segLen = Math.hypot(bx - ax, by - ay);
    for (let k = 0; k < m; k++) {
      const d = k * st;
      while (segStart + segLen < d && seg < n) {
        segStart += segLen;
        seg++;
        const i = seg % n, j = (seg + 1) % n;
        ax = P[2 * i]; ay = P[2 * i + 1];
        bx = P[2 * j]; by = P[2 * j + 1];
        segLen = Math.hypot(bx - ax, by - ay);
      }
      const t = segLen > 1e-12 ? (d - segStart) / segLen : 0;
      out[2 * k] = ax + (bx - ax) * t;
      out[2 * k + 1] = ay + (by - ay) * t;
    }
    return out;
  }

  // Resample an open polyline to exactly m points (endpoints included).
  function resampleOpen(P, m) {
    const n = P.length >> 1;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]);
    }
    const total = cum[n - 1];
    const out = new Float64Array(2 * m);
    let j = 0;
    for (let k = 0; k < m; k++) {
      const d = (total * k) / (m - 1);
      while (j < n - 2 && cum[j + 1] < d) j++;
      const segLen = cum[j + 1] - cum[j];
      const t = segLen > 1e-12 ? Math.min(1, Math.max(0, (d - cum[j]) / segLen)) : 0;
      out[2 * k] = P[2 * j] + (P[2 * j + 2] - P[2 * j]) * t;
      out[2 * k + 1] = P[2 * j + 1] + (P[2 * j + 3] - P[2 * j + 1]) * t;
    }
    return out;
  }

  function smoothClosed(P, sigma) {
    if (sigma <= 0) return P;
    const n = P.length >> 1;
    const r = Math.max(1, Math.ceil(sigma * 2.5));
    const w = [];
    let ws = 0;
    for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); ws += v; }
    const out = new Float64Array(P.length);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let k = -r; k <= r; k++) {
        const j = wrap(i + k, n);
        sx += P[2 * j] * w[k + r];
        sy += P[2 * j + 1] * w[k + r];
      }
      out[2 * i] = sx / ws;
      out[2 * i + 1] = sy / ws;
    }
    return out;
  }

  // Slice a closed curve from index i0 to i1 (inclusive, forward, wrapping).
  function sliceClosed(P, i0, i1) {
    const n = P.length >> 1;
    const len = wrap(i1 - i0, n) + 1;
    const out = new Float64Array(2 * len);
    for (let k = 0; k < len; k++) {
      const j = wrap(i0 + k, n);
      out[2 * k] = P[2 * j];
      out[2 * k + 1] = P[2 * j + 1];
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 1. Image -> piece contours
  // ------------------------------------------------------------------
  function toGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return g;
  }

  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
    for (let t = 0; t < 256; t++) {
      if (t <= thr) { s0 += t * hist[t]; n0 += hist[t]; } else { s1 += t * hist[t]; n1 += hist[t]; }
    }
    return { thr, darkMean: s0 / Math.max(1, n0), lightMean: s1 / Math.max(1, n1) };
  }

  // 3x3 box blur, used only for sub-pixel edge sampling.
  function boxBlur3(g, w, h) {
    const tmp = new Uint16Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const a = g[o + (x > 0 ? x - 1 : x)], b = g[o + x], c = g[o + (x < w - 1 ? x + 1 : x)];
        tmp[o + x] = a + b + c;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : y) * w, mid = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) out[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 9;
    }
    return out;
  }

  // Two-pass 8-connected labelling of mask (1 = dark).
  function labelComponents(mask, w, h) {
    const labels = new Int32Array(w * h);
    let parent = new Int32Array(1024);
    let next = 1;
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a === b) return a;
      if (a < b) { parent[b] = a; return a; }
      parent[a] = b; return b;
    };
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        if (!mask[o + x]) continue;
        let l = 0;
        const W = x > 0 ? labels[o + x - 1] : 0;
        const N = y > 0 ? labels[o - w + x] : 0;
        const NW = x > 0 && y > 0 ? labels[o - w + x - 1] : 0;
        const NE = x < w - 1 && y > 0 ? labels[o - w + x + 1] : 0;
        if (W) l = W;
        if (N) l = l ? union(l, N) : N;
        if (NW) l = l ? union(l, NW) : NW;
        if (NE) l = l ? union(l, NE) : NE;
        if (!l) {
          if (next >= parent.length) {
            const np = new Int32Array(parent.length * 2);
            np.set(parent);
            parent = np;
          }
          parent[next] = next;
          l = next++;
        }
        labels[o + x] = l;
      }
    }
    // flatten + compact
    const remap = new Int32Array(next);
    let count = 0;
    for (let i = 1; i < next; i++) {
      const r = find(i);
      if (r === i) remap[i] = ++count;
    }
    for (let i = 1; i < next; i++) remap[i] = remap[find(i)];
    const stats = [];
    for (let i = 0; i <= count; i++) stats.push({ label: i, area: 0, minx: w, miny: h, maxx: -1, maxy: -1, sx: 0, sy: 0 });
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l0 = labels[o + x];
        if (!l0) continue;
        const l = remap[l0];
        labels[o + x] = l;
        const s = stats[l];
        s.area++;
        s.sx += x; s.sy += y;
        if (x < s.minx) s.minx = x;
        if (x > s.maxx) s.maxx = x;
        if (y < s.miny) s.miny = y;
        if (y > s.maxy) s.maxy = y;
      }
    }
    stats.shift();
    return { labels, stats };
  }

  // Moore-neighbour tracing of the outer boundary of component `lab`.
  const MDX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const MDY = [0, -1, -1, -1, 0, 1, 1, 1];
  const MDIR = new Int8Array(9).fill(-1);
  for (let d = 0; d < 8; d++) MDIR[(MDY[d] + 1) * 3 + (MDX[d] + 1)] = d;

  function traceBoundary(labels, w, h, st) {
    const lab = st.label;
    let sx = -1, sy = -1;
    outer: for (let y = st.miny; y <= st.maxy; y++) {
      for (let x = st.minx; x <= st.maxx; x++) {
        if (labels[y * w + x] === lab) { sx = x; sy = y; break outer; }
      }
    }
    if (sx < 0) return null;
    const isFg = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === lab;
    const pts = [sx, sy];
    let cx = sx, cy = sy, back = 0; // backtrack points West of the start pixel
    let firstState = null;
    const maxIter = 8 * (st.maxx - st.minx + st.maxy - st.miny + 4) * 4 + 100000;
    for (let iter = 0; iter < maxIter; iter++) {
      let found = false;
      for (let k = 1; k <= 8; k++) {
        const d = (back + k) & 7;
        const nx = cx + MDX[d], ny = cy + MDY[d];
        if (isFg(nx, ny)) {
          const pd = (d + 7) & 7;
          const bx = cx + MDX[pd], by = cy + MDY[pd];
          cx = nx; cy = ny;
          back = MDIR[(by - cy + 1) * 3 + (bx - cx + 1)];
          if (back < 0) back = 0;
          found = true;
          break;
        }
      }
      if (!found) break;
      const state = cx + ',' + cy + ',' + back;
      if (firstState === null) firstState = state;
      else if (state === firstState) { pts.length -= 2; break; }
      pts.push(cx, cy);
    }
    // pts now ends with the start pixel again; drop duplicate closing points
    while (pts.length > 4 && pts[pts.length - 2] === pts[0] && pts[pts.length - 1] === pts[1]) pts.length -= 2;
    return new Float64Array(pts);
  }

  function sampleBilinear(g, w, h, x, y) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    const a = g[i], b = g[i + 1], c = g[i + w], d = g[i + w + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  // Move each contour point along its normal onto the sharpest dark-to-light
  // step. The piece face lies on the glass and is in focus; a shadow on the
  // lid (2 mm higher) is soft, so the steepest step is the real outline.
  function refineEdge(P, g, w, h) {
    const n = P.length >> 1;
    const out = new Float64Array(P.length);
    const ds = 0.25;
    const S = [];
    for (let s = -4; s <= 4.0001; s += ds) S.push(s);
    const m = S.length;
    const vals = new Float64Array(m);
    const der = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const a = wrap(i - 2, n), b = wrap(i + 2, n);
      let tx = P[2 * b] - P[2 * a], ty = P[2 * b + 1] - P[2 * a + 1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const nx = -ty, ny = tx;
      const px = P[2 * i], py = P[2 * i + 1];
      let lo = 255, hi = 0;
      for (let k = 0; k < m; k++) {
        const v = sampleBilinear(g, w, h, px + nx * S[k], py + ny * S[k]);
        vals[k] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[2 * i] = px; out[2 * i + 1] = py;
      if (hi - lo < 30) continue;
      // which way is "outside"? the light end of the profile
      const sign = vals[m - 1] > vals[0] ? 1 : -1;
      let bk = -1, bv = 0;
      for (let k = 1; k < m - 1; k++) {
        der[k] = sign * (vals[k + 1] - vals[k - 1]) / (2 * ds);
        if (Math.abs(S[k]) <= 3 && der[k] > bv) { bv = der[k]; bk = k; }
      }
      if (bk < 2 || bk > m - 3 || bv < 6) continue;
      // parabolic peak interpolation
      const y0 = der[bk - 1], y1 = der[bk], y2 = der[bk + 1];
      const den = y0 - 2 * y1 + y2;
      const off = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
      const s = S[bk] + off * ds;
      out[2 * i] = px + nx * s;
      out[2 * i + 1] = py + ny * s;
    }
    return out;
  }

  /**
   * Extract piece contours from an RGBA scan.
   * opts: { dpi, step (mm), onProgress(fraction, text) }
   * Returns { pieces: [{ contour (mm, image orientation, y up, CCW), areaMM2, bboxPx, centroidPx }], warnings, info }
   */
  async function extractPieces(rgba, w, h, opts) {
    opts = opts || {};
    const dpi = opts.dpi || 300;
    const mmpp = 25.4 / dpi;
    const step = opts.step || 0.1;
    const progress = opts.onProgress || (() => {});
    const warnings = [];

    progress(0.02, 'Converto in scala di grigi');
    await yieldNow();
    const gray = toGray(rgba, w, h);
    const ot = otsu(gray);
    const contrast = ot.lightMean - ot.darkMean;
    if (contrast < 60) {
      warnings.push({ kind: 'contrast', text: 'Contrasto basso tra pezzi e sfondo. Chiudi il coperchio dello scanner o metti un foglio bianco sopra i pezzi.' });
    }
    const thr = ot.thr;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = gray[i] <= thr ? 1 : 0;

    progress(0.1, 'Cerco i pezzi');
    await yieldNow();
    const { labels, stats } = labelComponents(mask, w, h);
    const px2mm2 = mmpp * mmpp;
    let comps = stats.filter((s) => s.area * px2mm2 >= 40);
    const touching = comps.filter((s) => s.minx <= 1 || s.miny <= 1 || s.maxx >= w - 2 || s.maxy >= h - 2);
    comps = comps.filter((s) => !touching.includes(s));
    if (touching.some((s) => s.area * px2mm2 > 150)) {
      warnings.push({ kind: 'border', text: 'Qualcosa di scuro tocca il bordo della scansione ed è stato ignorato. Tieni i pezzi ad almeno 1 cm dal bordo del vetro.' });
    }
    const areas = comps.map((s) => s.area).sort((a, b) => a - b);
    const med = areas.length ? areas[areas.length >> 1] : 0;
    const kept = [];
    for (const s of comps) {
      if (med && s.area > 1.8 * med && comps.length > 2) {
        warnings.push({ kind: 'merged', text: 'Due o più pezzi sembrano attaccati (zona vicino a x=' + Math.round(s.sx / s.area * mmpp) + ' mm, y=' + Math.round(s.sy / s.area * mmpp) + ' mm). Separali di almeno 5 mm e riscansiona.', bboxPx: [s.minx, s.miny, s.maxx, s.maxy] });
        continue;
      }
      if (med && s.area < 0.3 * med && comps.length > 2) continue; // dust, scraps
      kept.push(s);
    }

    const blurred = boxBlur3(gray, w, h);
    const pieces = [];
    for (let k = 0; k < kept.length; k++) {
      const s = kept[k];
      if (k % 4 === 0) {
        progress(0.15 + 0.8 * (k / kept.length), 'Contorno del pezzo ' + (k + 1) + ' di ' + kept.length);
        await yieldNow();
      }
      const raw = traceBoundary(labels, w, h, s);
      if (!raw || raw.length < 40) continue;
      let P = smoothClosed(raw, 1.0);
      P = resampleClosed(P, 1.0);
      P = refineEdge(P, blurred, w, h);
      P = smoothClosed(P, 1.2);
      // to millimetres, y up
      const M = new Float64Array(P.length);
      for (let i = 0; i < P.length; i += 2) { M[i] = P[i] * mmpp; M[i + 1] = -P[i + 1] * mmpp; }
      let C = resampleClosed(M, step);
      if (signedArea(C) < 0) C = reversePts(C);
      pieces.push({
        contour: C,
        areaMM2: signedArea(C),
        bboxPx: [s.minx, s.miny, s.maxx, s.maxy],
        centroidPx: [s.sx / s.area, s.sy / s.area],
      });
    }
    progress(1, 'Fatto');
    return { pieces, warnings, info: { threshold: thr, darkMean: ot.darkMean, lightMean: ot.lightMean, mmPerPx: mmpp, width: w, height: h } };
  }

  // ------------------------------------------------------------------
  // 2. Piece geometry: corners, sides, side types
  // ------------------------------------------------------------------
  function fitLine(P, idxs) {
    let mx = 0, my = 0;
    const n = idxs.length;
    for (const i of idxs) { mx += P[2 * i]; my += P[2 * i + 1]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const i of idxs) {
      const dx = P[2 * i] - mx, dy = P[2 * i + 1] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(ang), uy = Math.sin(ang);
    const first = idxs[0], last = idxs[n - 1];
    if ((P[2 * last] - P[2 * first]) * ux + (P[2 * last + 1] - P[2 * first + 1]) * uy < 0) { ux = -ux; uy = -uy; }
    const tr = sxx + syy;
    const disc = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) + 4 * sxy * sxy));
    const lmin = Math.max(0, (tr - disc) / 2) / n;
    return { mx, my, ux, uy, rms: Math.sqrt(lmin) };
  }

  function angBetween(ax, ay, bx, by) {
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }

  function cornerCandidates(P, step) {
    const N = P.length >> 1;
    const ks = Math.max(2, Math.round(0.6 / step));
    const turnS = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = wrap(i - ks, N), b = wrap(i + ks, N);
      const ax = P[2 * i] - P[2 * a], ay = P[2 * i + 1] - P[2 * a + 1];
      const bx = P[2 * b] - P[2 * i], by = P[2 * b + 1] - P[2 * i + 1];
      turnS[i] = angBetween(ax, ay, bx, by);
    }
    const nms = Math.max(3, Math.round(1.5 / step));
    const a0 = Math.max(1, Math.round(0.35 / step));
    const a1 = Math.max(a0 + 4, Math.round(2.6 / step));
    const cands = [];
    for (let i = 0; i < N; i++) {
      const v = turnS[i];
      if (v < 30 * DEG) continue;
      let isMax = true;
      for (let k = 1; k <= nms && isMax; k++) {
        if (turnS[wrap(i + k, N)] > v || turnS[wrap(i - k, N)] >= v) isMax = false;
      }
      if (!isMax) continue;
      const idx1 = [], idx2 = [];
      for (let k = a0; k <= a1; k++) { idx1.push(wrap(i - k, N)); idx2.push(wrap(i + k, N)); }
      const l1 = fitLine(P, idx1), l2 = fitLine(P, idx2);
      const turnA = angBetween(-l1.ux, -l1.uy, l2.ux, l2.uy);
      // corner location = intersection of the two arm lines
      let cx = P[2 * i], cy = P[2 * i + 1];
      const cr = l1.ux * l2.uy - l1.uy * l2.ux;
      if (Math.abs(cr) > 0.3) {
        const dx = l2.mx - l1.mx, dy = l2.my - l1.my;
        const s = (dx * l2.uy - dy * l2.ux) / cr;
        const ix = l1.mx + s * l1.ux, iy = l1.my + s * l1.uy;
        if (Math.hypot(ix - cx, iy - cy) < 1.5) { cx = ix; cy = iy; }
      }
      // snap index to nearest contour point to the refined corner
      let bi = i, bd = Infinity;
      const win = Math.round(1.0 / step);
      for (let k = -win; k <= win; k++) {
        const j = wrap(i + k, N);
        const d = Math.hypot(P[2 * j] - cx, P[2 * j + 1] - cy);
        if (d < bd) { bd = d; bi = j; }
      }
      const conc = Math.min(1, Math.max(0.05, v / Math.max(turnA, 1e-3)));
      const dev = (turnA - 90 * DEG) / (22 * DEG);
      const score = Math.exp(-dev * dev) * Math.exp(-(l1.rms + l2.rms) / 0.07) * conc;
      cands.push({ i: bi, raw: i, x: cx, y: cy, turnS: v, turnA, u1: [l1.ux, l1.uy], u2: [l2.ux, l2.uy], r1: l1.rms, r2: l2.rms, score });
    }
    return cands;
  }

  function chooseCorners(P, step, cands, area) {
    const N = P.length >> 1;
    let list = cands.slice().sort((a, b) => b.score - a.score).slice(0, 12);
    list.sort((a, b) => a.i - b.i);
    // dedupe candidates that snapped to (almost) the same index
    list = list.filter((c, k) => k === 0 || wrap(c.i - list[k - 1].i, N) > 3);
    const m = list.length;
    if (m < 4) return null;
    let best = null;
    for (let a = 0; a < m - 3; a++) for (let b = a + 1; b < m - 2; b++) for (let c = b + 1; c < m - 1; c++) for (let d = c + 1; d < m; d++) {
      const q = [list[a], list[b], list[c], list[d]];
      const L = [];
      for (let k = 0; k < 4; k++) {
        const p = q[k], r = q[(k + 1) & 3];
        L.push(Math.hypot(r.x - p.x, r.y - p.y));
      }
      const meanL = (L[0] + L[1] + L[2] + L[3]) / 4;
      if (Math.min(...L) < 0.45 * meanL) continue;
      // quad area vs piece area
      let qa = 0;
      for (let k = 0; k < 4; k++) { const p = q[k], r = q[(k + 1) & 3]; qa += p.x * r.y - r.x * p.y; }
      qa /= 2;
      if (qa <= 0) continue;
      const ar = qa / area;
      if (ar < 0.5 || ar > 1.7) continue;
      let cost = 0;
      for (let k = 0; k < 4; k++) {
        const p = q[k], prev = q[(k + 3) & 3], nxt = q[(k + 1) & 3];
        const vx1 = prev.x - p.x, vy1 = prev.y - p.y, vx2 = nxt.x - p.x, vy2 = nxt.y - p.y;
        const inter = Math.abs(angBetween(vx2, vy2, vx1, vy1));
        const da = (inter - 90 * DEG) / (11 * DEG);
        cost += da * da;
        // arms should point along the quad edges
        const l1 = Math.hypot(vx1, vy1) || 1, l2 = Math.hypot(vx2, vy2) || 1;
        const e1 = angBetween(p.u1[0], p.u1[1], vx1 / l1, vy1 / l1) / (13 * DEG);
        const e2 = angBetween(p.u2[0], p.u2[1], vx2 / l2, vy2 / l2) / (13 * DEG);
        cost += e1 * e1 + e2 * e2;
        cost += -2 * Math.log(Math.max(1e-6, p.score));
      }
      const o1 = Math.log(L[0] / L[2]) / 0.11, o2 = Math.log(L[1] / L[3]) / 0.11;
      cost += o1 * o1 + o2 * o2;
      const asp = Math.abs(Math.log((L[0] + L[2]) / (L[1] + L[3])));
      if (asp > 0.45) cost += ((asp - 0.45) / 0.1) ** 2;
      if (!best || cost < best.cost) best = { cost, q };
    }
    return best;
  }

  /**
   * Analyse a front-view contour (mm, CCW). Optional fixedCorners: 4 indices.
   */
  function analyzePiece(P, step, fixedCorners) {
    const N = P.length >> 1;
    const area = signedArea(P);
    const warn = [];
    let corners = null, cornerCost = 0;
    if (fixedCorners && fixedCorners.length === 4) {
      corners = fixedCorners.slice().sort((a, b) => a - b);
    } else {
      const cands = cornerCandidates(P, step);
      const best = chooseCorners(P, step, cands, area);
      if (best) {
        corners = best.q.map((c) => c.i);
        cornerCost = best.cost;
      }
    }
    if (!corners) {
      // fallback: four points extremal along the diagonals of the bounding box
      warn.push('angoli');
      const [cx, cy] = centroidOf(P);
      const dirs = [[-1, 1], [-1, -1], [1, -1], [1, 1]];
      corners = dirs.map(([dx, dy]) => {
        let bi = 0, bv = -Infinity;
        for (let i = 0; i < N; i++) {
          const v = (P[2 * i] - cx) * dx + (P[2 * i + 1] - cy) * dy;
          if (v > bv) { bv = v; bi = i; }
        }
        return bi;
      }).sort((a, b) => a - b);
      cornerCost = 99;
    }
    if (cornerCost > 40) warn.push('angoli');
    const sides = [];
    for (let k = 0; k < 4; k++) {
      const i0 = corners[k], i1 = corners[(k + 1) & 3];
      const seg = sliceClosed(P, i0, i1);
      const ax = seg[0], ay = seg[1];
      const bx = seg[seg.length - 2], by = seg[seg.length - 1];
      const L = Math.hypot(bx - ax, by - ay);
      const alpha = Math.atan2(by - ay, bx - ax);
      // piece -> side frame: rotate by -alpha after moving the first corner to the origin
      const R = Rigid.make(-alpha, 0, 0);
      const t0 = Rigid.apply(R, -ax, -ay);
      const frame = [R[0], R[1], t0[0], t0[1]];
      const local = Rigid.applyAll(frame, seg);
      let minW = Infinity, maxW = -Infinity;
      for (let i = 1; i < local.length; i += 2) { if (local[i] < minW) minW = local[i]; if (local[i] > maxW) maxW = local[i]; }
      const ext = Math.max(-minW, maxW);
      let type;
      if (ext < Math.max(1.0, 0.1 * L)) type = 0;
      else type = -minW > maxW ? 1 : -1; // tab bulges outward = negative w
      const arc = perimeter(seg, false);
      if (ext > 0.7 * L || arc > 3.5 * L) warn.push('lato' + k);
      sides.push({
        type, L, ext, arc,
        frame,
        i0, i1,
        pts: resampleOpen(local, 96),
        dense: resampleOpen(local, Math.max(40, Math.round(arc / 0.1))),
      });
    }
    const cornerPts = corners.map((i) => [P[2 * i], P[2 * i + 1]]);
    return { corners, cornerPts, cornerCost, sides, area, centroid: centroidOf(P), warn };
  }

  // ------------------------------------------------------------------
  // 3. Side matching
  // ------------------------------------------------------------------
  // Rigid least-squares fit mapping point set B onto A (same length, paired).
  function procrustes(A, B, wts) {
    const n = A.length >> 1;
    let sw = 0, ax = 0, ay = 0, bx = 0, by = 0;
    for (let i = 0; i < n; i++) {
      const w = wts ? wts[i] : 1;
      sw += w; ax += w * A[2 * i]; ay += w * A[2 * i + 1]; bx += w * B[2 * i]; by += w * B[2 * i + 1];
    }
    ax /= sw; ay /= sw; bx /= sw; by /= sw;
    let sxx = 0, sxy = 0, ssA = 0, ssB = 0;
    for (let i = 0; i < n; i++) {
      const w = wts ? wts[i] : 1;
      const px = B[2 * i] - bx, py = B[2 * i + 1] - by;
      const qx = A[2 * i] - ax, qy = A[2 * i + 1] - ay;
      sxx += w * (px * qx + py * qy);
      sxy += w * (px * qy - py * qx);
      ssA += w * (qx * qx + qy * qy);
      ssB += w * (px * px + py * py);
    }
    const th = Math.atan2(sxy, sxx);
    const c = Math.cos(th), s = Math.sin(th);
    const res = Math.max(0, ssA + ssB - 2 * Math.hypot(sxx, sxy));
    return { T: [c, s, ax - (c * bx - s * by), ay - (s * bx + c * by)], rms: Math.sqrt(res / sw) };
  }

  // Map blank side B (its own frame) into tab side A's frame for joining.
  function joinInit(LA) { return [-1, 0, LA, 0]; } // (u,w) -> (LA-u, -w)

  function quickCost(sa, sb) {
    const B = Rigid.applyAll(joinInit(sa.L), reversePts(sb.pts));
    const pr = procrustes(sa.pts, B);
    return { rms: pr.rms, T: pr.T };
  }

  // ICP refinement (point-to-point, windowed, trimmed). Returns cost and the
  // correction transform (in A's side frame) applied after joinInit.
  function icpRefine(sa, sb, initT) {
    const A = sa.pts;
    const nA = A.length >> 1;
    const Bd = Rigid.applyAll(joinInit(sa.L), reversePts(sb.dense));
    const nB = Bd.length >> 1;
    let T = initT.slice();
    const skip = 3;
    const win = Math.max(6, Math.round(nB * 0.12));
    const pa = new Float64Array(2 * nA), pb = new Float64Array(2 * nA), dist = new Float64Array(nA);
    let cost = Infinity;
    for (let it = 0; it < 8; it++) {
      const Bt = Rigid.applyAll(T, Bd);
      let m = 0;
      for (let i = skip; i < nA - skip; i++) {
        const x = A[2 * i], y = A[2 * i + 1];
        const center = Math.round((i / (nA - 1)) * (nB - 1));
        let bj = -1, bd = Infinity;
        const j0 = Math.max(0, center - win), j1 = Math.min(nB - 1, center + win);
        for (let j = j0; j <= j1; j++) {
          const dx = Bt[2 * j] - x, dy = Bt[2 * j + 1] - y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; bj = j; }
        }
        pa[2 * m] = x; pa[2 * m + 1] = y;
        pb[2 * m] = Bd[2 * bj]; pb[2 * m + 1] = Bd[2 * bj + 1];
        dist[m] = Math.sqrt(bd);
        m++;
      }
      const sorted = Array.from(dist.subarray(0, m)).sort((a, b) => a - b);
      const keep = sorted[Math.floor(m * 0.9)] || 0;
      let s2 = 0, cnt = 0;
      for (let k = 0; k < m; k++) if (dist[k] <= keep) { s2 += dist[k] * dist[k]; cnt++; }
      cost = Math.sqrt(s2 / Math.max(1, cnt));
      if (it === 7) break;
      const thrD = Math.max(0.25, 3 * sorted[m >> 1]);
      const wts = new Float64Array(m);
      for (let k = 0; k < m; k++) wts[k] = dist[k] <= thrD ? 1 : 0.05;
      const pr = procrustes(pa.subarray(0, 2 * m), pb.subarray(0, 2 * m), wts);
      const dT = Math.hypot(pr.T[2] - T[2], pr.T[3] - T[3]) + Math.abs(Rigid.angle(pr.T) - Rigid.angle(T)) * 10;
      T = pr.T;
      if (dT < 1e-4) {
        // converged: one last evaluation happens on the next loop pass
        it = 6;
      }
    }
    return { cost, T };
  }

  /**
   * Build the match model for analysed pieces.
   * pieces: [{ geo: analyzePiece result }]
   * Returns object with cost(a,b), get(a,b), ranked(a), sideType(a) where side id = pieceIndex*4 + s.
   */
  function buildMatches(pieces, opts) {
    opts = opts || {};
    const K = opts.topK || 6;
    const lenTol = opts.lenTol || 3.0;
    const S = pieces.length * 4;
    const side = (id) => pieces[id >> 2].geo.sides[id & 3];
    const tabs = [], blanks = [];
    for (let id = 0; id < S; id++) {
      const t = side(id).type;
      if (t === 1) tabs.push(id); else if (t === -1) blanks.push(id);
    }
    const nT = tabs.length, nBk = blanks.length;
    const quick = new Float32Array(nT * nBk).fill(Infinity);
    const tabPos = new Int32Array(S).fill(-1), blankPos = new Int32Array(S).fill(-1);
    tabs.forEach((id, k) => (tabPos[id] = k));
    blanks.forEach((id, k) => (blankPos[id] = k));
    const quickT = new Map();
    for (let i = 0; i < nT; i++) {
      const a = tabs[i], sa = side(a);
      for (let j = 0; j < nBk; j++) {
        const b = blanks[j];
        if ((a >> 2) === (b >> 2)) continue;
        const sb = side(b);
        if (Math.abs(sa.L - sb.L) > lenTol) continue;
        const q = quickCost(sa, sb);
        quick[i * nBk + j] = q.rms;
        quickT.set(i * nBk + j, q.T);
      }
    }
    const refined = new Map();
    const key = (i, j) => i * nBk + j;
    function refine(i, j) {
      const k = key(i, j);
      if (refined.has(k)) return refined.get(k);
      if (!isFinite(quick[k])) { const r = { cost: Infinity, T: null }; refined.set(k, r); return r; }
      const a = tabs[i], b = blanks[j];
      const sa = side(a), sb = side(b);
      const r = icpRefine(sa, sb, quickT.get(k));
      // piece transform: B piece -> A piece
      const FA = sa.frame, FB = sb.frame;
      const Tpiece = Rigid.compose(Rigid.invert(FA), Rigid.compose(r.T, Rigid.compose(joinInit(sa.L), FB)));
      const out = { cost: r.cost, T: Tpiece };
      refined.set(k, out);
      return out;
    }
    // refine the top-K candidates of every side
    for (let i = 0; i < nT; i++) {
      const row = [];
      for (let j = 0; j < nBk; j++) if (isFinite(quick[key(i, j)])) row.push(j);
      row.sort((x, y) => quick[key(i, x)] - quick[key(i, y)]);
      for (let k = 0; k < Math.min(K, row.length); k++) refine(i, row[k]);
    }
    for (let j = 0; j < nBk; j++) {
      const col = [];
      for (let i = 0; i < nT; i++) if (isFinite(quick[key(i, j)])) col.push(i);
      col.sort((x, y) => quick[key(x, j)] - quick[key(y, j)]);
      for (let k = 0; k < Math.min(K, col.length); k++) refine(col[k], j);
    }
    function cost(a, b) {
      let i, j;
      if (tabPos[a] >= 0 && blankPos[b] >= 0) { i = tabPos[a]; j = blankPos[b]; }
      else if (tabPos[b] >= 0 && blankPos[a] >= 0) { i = tabPos[b]; j = blankPos[a]; }
      else return Infinity;
      const k = key(i, j);
      const r = refined.get(k);
      return r ? r.cost : quick[k] * 1.0 + 0.02;
    }
    // get(a,b): cost and transform mapping piece(b) coords -> piece(a) coords
    function get(a, b) {
      if (tabPos[a] >= 0 && blankPos[b] >= 0) {
        return refine(tabPos[a], blankPos[b]);
      }
      if (tabPos[b] >= 0 && blankPos[a] >= 0) {
        const r = refine(tabPos[b], blankPos[a]);
        return { cost: r.cost, T: r.T ? Rigid.invert(r.T) : null };
      }
      return { cost: Infinity, T: null };
    }
    const rankCache = new Map();
    function ranked(a, limit) {
      if (!rankCache.has(a)) {
        const t = side(a).type;
        const pool = t === 1 ? blanks : t === -1 ? tabs : [];
        const arr = [];
        for (const b of pool) {
          if ((b >> 2) === (a >> 2)) continue;
          const c = cost(a, b);
          if (isFinite(c)) arr.push({ side: b, cost: c });
        }
        arr.sort((x, y) => x.cost - y.cost);
        // make sure the leading candidates are refined
        for (let k = 0; k < Math.min(arr.length, 10); k++) arr[k].cost = get(a, arr[k].side).cost;
        arr.sort((x, y) => x.cost - y.cost);
        rankCache.set(a, arr);
      }
      const r = rankCache.get(a);
      return limit ? r.slice(0, limit) : r;
    }
    // Calibration: typical cost of a real joint, estimated from mutual best
    // pairs that clearly beat their runner-up. Thresholds scale with it, so
    // the same rules work for clean and for noisy scans.
    const costIJ = (i, j) => { const k = key(i, j); const r = refined.get(k); return r ? r.cost : quick[k] + 0.02; };
    const bT = new Int32Array(nT).fill(-1), c1T = new Float64Array(nT).fill(Infinity), c2T = new Float64Array(nT).fill(Infinity);
    const bB = new Int32Array(nBk).fill(-1), c1B = new Float64Array(nBk).fill(Infinity), c2B = new Float64Array(nBk).fill(Infinity);
    for (let i = 0; i < nT; i++) for (let j = 0; j < nBk; j++) {
      const c = costIJ(i, j);
      if (!isFinite(c)) continue;
      if (c < c1T[i]) { c2T[i] = c1T[i]; c1T[i] = c; bT[i] = j; } else if (c < c2T[i]) c2T[i] = c;
      if (c < c1B[j]) { c2B[j] = c1B[j]; c1B[j] = c; bB[j] = i; } else if (c < c2B[j]) c2B[j] = c;
    }
    const strong = [], all = [];
    for (let i = 0; i < nT; i++) {
      const j = bT[i];
      if (j < 0) continue;
      all.push(c1T[i]);
      if (bB[j] === i && c1T[i] / Math.min(c2T[i], c2B[j]) < 0.75) strong.push(c1T[i]);
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0.05; };
    const calib = { joint: Math.max(0.015, strong.length >= 5 ? med(strong) : med(all) * 0.8), strongPairs: strong.length };
    return { cost, get, ranked, side, S, tabs, blanks, calib };
  }

  // ------------------------------------------------------------------
  // 4. Greedy grid assembly
  // ------------------------------------------------------------------
  // Grid directions (y up): 0=E, 1=N, 2=W, 3=S. A piece with rotation r has
  // its side s facing direction (s + r) % 4.
  const GDX = [1, 0, -1, 0], GDY = [0, 1, 0, -1];
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  function assemble(pieces, matches, opts) {
    opts = opts || {};
    const m = (matches.calib && matches.calib.joint) || 0.05;
    const T1 = opts.t1 || 1.6 * m;        // one-neighbour placement: max joint cost
    const T2 = opts.t2 || 1.8 * m;        // two or more neighbours: max mean joint cost
    const R1 = opts.r1 || 0.8;            // one neighbour: best must clearly beat the runner-up
    const R2 = opts.r2 || 0.92;
    const D2 = opts.d2 || Math.max(0.2, 5 * m); // max junction mismatch (mm)
    const maxCost = opts.maxCost || 3 * m;
    const lambda = opts.lambda == null ? 0.3 : opts.lambda;
    const confirmed = opts.confirmed || new Set();
    const rejected = opts.rejected || new Set();
    const n = pieces.length;
    const sideType = (id) => matches.side(id).type;

    function jointCost(a, b) {
      const k = pairKey(a, b);
      if (rejected.has(k)) return Infinity;
      if (sideType(a) * sideType(b) !== -1) return Infinity;
      if (confirmed.has(k)) return 0;
      return matches.cost(a, b);
    }
    // confirmed partner lookup
    const confPartner = new Map();
    for (const k of confirmed) {
      const [a, b] = k.split('|').map(Number);
      confPartner.set(a, b); confPartner.set(b, a);
    }

    const where = new Array(n).fill(null); // {cl, x, y, r}
    const clusters = [];
    const events = [];

    function cellKey(x, y) { return x + ',' + y; }

    function placeAt(cl, p, x, y, r, pose, info) {
      cl.cells.set(cellKey(x, y), { p, x, y, r, pose });
      cl.pieces.push(p);
      where[p] = { cl: cl.id, x, y, r, pose };
      events.push(Object.assign({ piece: p, cluster: cl.id, x, y, r }, info || {}));
    }

    function neighbours(cl, x, y) {
      const out = [];
      for (let d = 0; d < 4; d++) {
        const c = cl.cells.get(cellKey(x + GDX[d], y + GDY[d]));
        if (c) out.push({ dir: d, cell: c, side: c.p * 4 + wrap(d + 2 - c.r, 4) });
      }
      return out;
    }

    // Evaluate placing piece q with rotation r at a cell with neighbours nbs.
    function evalPlacement(q, r, nbs) {
      let sum = 0;
      const joints = [];
      let poses = [];
      for (const nb of nbs) {
        const sq = q * 4 + wrap(nb.dir - r, 4);
        const c = jointCost(nb.side, sq);
        if (!isFinite(c) || c > maxCost) return null;
        sum += c;
        joints.push({ a: nb.side, b: sq, cost: c });
        const g = matches.get(nb.side, sq);
        if (g.T) poses.push(Rigid.compose(nb.cell.pose, g.T));
      }
      if (!nbs.length) return null;
      let cost = sum / nbs.length;
      const jc = cost;
      let disc = 0;
      let pose = poses[0] || Rigid.id();
      if (poses.length > 1 && poses.length === joints.length) {
        // Compare the poses implied by each neighbour at the junction corner
        // the two joints share: every fit involved is close to that point,
        // so small rotation errors of the side fits do not get amplified.
        const cp = pieces[q].geo.cornerPts;
        let cnt = 0;
        for (let a = 0; a < poses.length; a++) {
          for (let b = a + 1; b < poses.length; b++) {
            const sa = joints[a].b & 3, sb = joints[b].b & 3;
            let pts;
            if (wrap(sb - sa, 4) === 1) pts = [cp[sb]];
            else if (wrap(sa - sb, 4) === 1) pts = [cp[sa]];
            else pts = cp;
            for (const [px, py] of pts) {
              const p0 = Rigid.apply(poses[a], px, py), p1 = Rigid.apply(poses[b], px, py);
              disc += Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
              cnt++;
            }
          }
        }
        disc /= Math.max(1, cnt);
        cost += lambda * disc;
        // average pose
        let ca = 0, sa = 0, tx = 0, ty = 0;
        for (const ps of poses) { ca += ps[0]; sa += ps[1]; tx += ps[2]; ty += ps[3]; }
        const nn = Math.hypot(ca, sa) || 1;
        pose = [ca / nn, sa / nn, tx / poses.length, ty / poses.length];
      }
      return { cost, joints, pose, jc, disc };
    }

    function frontier(cl) {
      const cells = new Map();
      for (const c of cl.cells.values()) {
        for (let d = 0; d < 4; d++) {
          const x = c.x + GDX[d], y = c.y + GDY[d];
          const k = cellKey(x, y);
          if (!cl.cells.has(k) && !cells.has(k)) cells.set(k, { x, y });
        }
      }
      return [...cells.values()];
    }

    function bestForCell(cl, x, y) {
      const nbs = neighbours(cl, x, y);
      if (!nbs.length) return null;
      // a neighbour side facing an empty cell must not be flat
      for (const nb of nbs) if (sideType(nb.side) === 0) return null;
      const cand = new Map();
      for (const nb of nbs) {
        const conf = confPartner.get(nb.side);
        const list = matches.ranked(nb.side, 12).map((e) => e.side);
        if (conf != null) list.unshift(conf);
        for (const s of list) {
          const q = s >> 2;
          if (where[q]) continue;
          const r = wrap(nb.dir - (s & 3), 4);
          const k = q * 4 + r;
          if (cand.has(k)) continue;
          const ev = evalPlacement(q, r, nbs);
          if (ev) cand.set(k, Object.assign({ q, r }, ev));
        }
      }
      const arr = [...cand.values()].sort((a, b) => a.cost - b.cost);
      if (!arr.length) return null;
      const b1 = arr[0];
      const b2 = arr.find((e) => e.q !== b1.q);
      const c2 = b2 ? b2.cost : maxCost * 2;
      return { x, y, nbs: nbs.length, best: b1, second: b2 || null, ratio: b1.cost / Math.max(c2, 1e-3) };
    }

    function growCluster(cl) {
      for (;;) {
        let pick = null;
        for (const f of frontier(cl)) {
          const b = bestForCell(cl, f.x, f.y);
          if (!b) continue;
          const confirmedJoint = b.best.joints.some((j) => confirmed.has(pairKey(j.a, j.b)));
          if (!confirmedJoint) {
            if (b.nbs === 1 && (b.best.cost > T1 || b.ratio > R1)) continue;
            if (b.nbs >= 2 && (b.best.jc > T2 || b.best.disc > D2 || b.ratio > R2)) continue;
          }
          let pr = b.ratio * (b.nbs >= 2 ? 0.75 : 1) + 0.1 * (b.best.jc / m);
          if (confirmedJoint) pr -= 10;
          if (!pick || pr < pick.pr) pick = Object.assign({ pr }, b);
        }
        if (!pick) return;
        const e = pick.best;
        placeAt(cl, e.q, pick.x, pick.y, e.r, e.pose, {
          joints: e.joints, cost: e.cost, ratio: pick.ratio, nbs: pick.nbs, jc: e.jc, disc: e.disc,
          alt: pick.second ? { piece: pick.second.q, cost: pick.second.cost } : null,
        });
      }
    }

    function seedPair() {
      let best = null;
      for (let p = 0; p < n; p++) {
        if (where[p]) continue;
        for (let s = 0; s < 4; s++) {
          const a = p * 4 + s;
          if (sideType(a) === 0) continue;
          let list = matches.ranked(a, 6).filter((e) => !where[e.side >> 2] && isFinite(jointCost(a, e.side)));
          list = list.map((e) => ({ side: e.side, cost: jointCost(a, e.side) })).sort((x, y) => x.cost - y.cost);
          const conf = confPartner.get(a);
          if (conf != null && !where[conf >> 2]) list.unshift({ side: conf, cost: 0 });
          if (!list.length) continue;
          const b = list[0];
          if (b.cost > T1) continue;
          // mutual best?
          const back = matches.ranked(b.side, 6).filter((e) => !where[e.side >> 2]).map((e) => ({ side: e.side, cost: jointCost(b.side, e.side) })).sort((x, y) => x.cost - y.cost);
          const mutual = b.cost === 0 || (back.length && back[0].side === a);
          if (!mutual) continue;
          const c2a = list[1] ? list[1].cost : maxCost * 2;
          const c2b = back[1] ? back[1].cost : maxCost * 2;
          const ratio = b.cost / Math.max(1e-3, Math.min(c2a, c2b));
          if (b.cost > 0 && ratio > R1) continue;
          const pr = b.cost === 0 ? -1 : ratio + 0.1 * (b.cost / m);
          if (!best || pr < best.pr) best = { pr, a, b: b.side, cost: b.cost, ratio };
        }
      }
      return best;
    }

    for (;;) {
      const sp = seedPair();
      if (!sp) break;
      const cl = { id: clusters.length, cells: new Map(), pieces: [] };
      clusters.push(cl);
      const pa = sp.a >> 2, sa = sp.a & 3, pb = sp.b >> 2, sb = sp.b & 3;
      placeAt(cl, pa, 0, 0, 0, Rigid.id(), { seed: true });
      const dir = sa; // rotation 0 -> side sa faces direction sa
      const rb = wrap(dir + 2 - sb, 4);
      const g = matches.get(sp.a, sp.b);
      placeAt(cl, pb, GDX[dir], GDY[dir], rb, g.T || Rigid.id(), {
        joints: [{ a: sp.a, b: sp.b, cost: sp.cost }], cost: sp.cost, ratio: sp.ratio, nbs: 1,
      });
      growCluster(cl);
    }

    // collect joints between adjacent cells
    const joints = [];
    for (const cl of clusters) {
      for (const c of cl.cells.values()) {
        for (const d of [0, 1]) {
          const o = cl.cells.get(cellKey(c.x + GDX[d], c.y + GDY[d]));
          if (!o) continue;
          const a = c.p * 4 + wrap(d - c.r, 4);
          const b = o.p * 4 + wrap(d + 2 - o.r, 4);
          joints.push({ a, b, cluster: cl.id, cost: jointCost(a, b), confirmed: confirmed.has(pairKey(a, b)) });
        }
      }
    }
    const unplaced = [];
    for (let p = 0; p < n; p++) if (!where[p]) unplaced.push(p);
    return {
      clusters: clusters.map((cl) => ({ id: cl.id, pieces: cl.pieces.slice(), cells: [...cl.cells.values()].map((c) => ({ p: c.p, x: c.x, y: c.y, r: c.r, pose: c.pose })) })),
      where, events, joints, unplaced,
    };
  }

  // ------------------------------------------------------------------
  // 5. Compact contour encoding for storage (0.01 mm, int16 deltas, base64)
  // ------------------------------------------------------------------
  function b64FromBytes(bytes) {
    if (typeof Buffer !== 'undefined' && typeof btoa === 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function bytesFromB64(str) {
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function encodeContour(P) {
    const n = P.length >> 1;
    const x0 = Math.round(P[0] * 100), y0 = Math.round(P[1] * 100);
    const buf = new Int16Array(2 * n);
    let px = x0, py = y0;
    for (let i = 1; i < n; i++) {
      const x = Math.round(P[2 * i] * 100), y = Math.round(P[2 * i + 1] * 100);
      buf[2 * i] = Math.max(-32768, Math.min(32767, x - px));
      buf[2 * i + 1] = Math.max(-32768, Math.min(32767, y - py));
      px += buf[2 * i]; py += buf[2 * i + 1];
    }
    return { x0, y0, d: b64FromBytes(new Uint8Array(buf.buffer)) };
  }
  function decodeContour(enc) {
    const bytes = bytesFromB64(enc.d);
    const buf = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const n = buf.length >> 1;
    const P = new Float64Array(2 * n);
    let x = enc.x0, y = enc.y0;
    P[0] = x / 100; P[1] = y / 100;
    for (let i = 1; i < n; i++) {
      x += buf[2 * i]; y += buf[2 * i + 1];
      P[2 * i] = x / 100; P[2 * i + 1] = y / 100;
    }
    return P;
  }

  // Front view of a stored scan contour. Face-down pieces (black side on the
  // glass) are seen by the scanner exactly as from the front.
  function frontView(contour, faceDown) {
    if (faceDown) return contour;
    const out = new Float64Array(contour.length);
    for (let i = 0; i < contour.length; i += 2) { out[i] = -contour[i]; out[i + 1] = contour[i + 1]; }
    return reversePts(out);
  }

  // Map an index on the stored contour to the matching index on the front view.
  function frontIndex(i, n, faceDown) { return faceDown ? i : wrap(n - 1 - i, n); }

  // ------------------------------------------------------------------
  // Image file metadata: DPI from JPEG (JFIF/EXIF) and PNG (pHYs)
  // ------------------------------------------------------------------
  function readDpi(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // PNG
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
      let o = 8;
      while (o + 8 < u8.length) {
        const len = (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
        const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
        if (type === 'pHYs') {
          const ppx = ((u8[o + 8] << 24) | (u8[o + 9] << 16) | (u8[o + 10] << 8) | u8[o + 11]) >>> 0;
          if (u8[o + 16] === 1 && ppx > 0) return Math.round(ppx * 0.0254);
          return null;
        }
        if (type === 'IDAT' || type === 'IEND') break;
        o += 12 + len;
      }
      return null;
    }
    // JPEG
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    let o = 2;
    let jfif = null, exif = null;
    while (o + 4 < u8.length) {
      if (u8[o] !== 0xff) break;
      const marker = u8[o + 1];
      const len = (u8[o + 2] << 8) | u8[o + 3];
      if (marker === 0xda || marker === 0xd9) break;
      const s = o + 4;
      if (marker === 0xe0 && u8[s] === 0x4a && u8[s + 1] === 0x46 && u8[s + 2] === 0x49 && u8[s + 3] === 0x46) {
        const units = u8[s + 7];
        const xd = (u8[s + 8] << 8) | u8[s + 9];
        if (units === 1 && xd > 1) jfif = xd;
        else if (units === 2 && xd > 1) jfif = Math.round(xd * 2.54);
      }
      if (marker === 0xe1 && u8[s] === 0x45 && u8[s + 1] === 0x78 && u8[s + 2] === 0x69 && u8[s + 3] === 0x66) {
        try { exif = readExifDpi(u8, s + 6); } catch (e) { /* ignore */ }
      }
      o += 2 + len;
    }
    return jfif || exif || null;
  }

  function readExifDpi(u8, t) {
    const le = u8[t] === 0x49;
    const r16 = (p) => (le ? u8[p] | (u8[p + 1] << 8) : (u8[p] << 8) | u8[p + 1]);
    const r32 = (p) => (le ? (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0 : ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0);
    const ifd = t + r32(t + 4);
    const count = r16(ifd);
    let xres = null, unit = 2;
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + 12 * k;
      const tag = r16(e);
      if (tag === 0x011a) { const off = t + r32(e + 8); const num = r32(off), den = r32(off + 4); if (den) xres = num / den; }
      if (tag === 0x0128) unit = r16(e + 8);
    }
    if (!xres) return null;
    if (unit === 3) xres *= 2.54;
    return Math.round(xres);
  }

  return {
    Rigid, signedArea, centroidOf, resampleClosed, resampleOpen, reversePts, perimeter,
    extractPieces, analyzePiece, buildMatches, assemble, pairKey,
    encodeContour, decodeContour, frontView, frontIndex, readDpi,
    GDX, GDY,
  };
});
