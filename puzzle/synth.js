/*
 * Incastri al Buio — synthetic puzzle generator.
 * Builds a classic grid-cut puzzle with random knobs and wavy sides, and
 * renders "scanner images" of black pieces on a white lid. Used for the
 * built-in example and for the automated accuracy tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PuzzleSynth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const R = (lo, hi) => lo + (hi - lo) * next();
    R.next = next;
    return R;
  }

  function cubic(p0, p1, p2, p3, n, out, skipFirst) {
    for (let k = skipFirst ? 1 : 0; k <= n; k++) {
      const t = k / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
  }

  // One knobbed edge in a unit frame from (0,0) to (1,0); the knob points to +y.
  function knobEdge(R, wave, variety) {
    const v = variety == null ? 1 : variety; // 1 = varied knobs, ~0.3 = very uniform cut
    const V = (mid, half) => R(mid - half * v, mid + half * v);
    const c = 0.5 + V(0, 0.07);
    const nw = V(0.09, 0.015);
    const hw = V(0.1375, 0.0225);
    const h = V(0.245, 0.045);
    const nh = h * V(0.48, 0.08);
    const tilt = V(0, 0.045);
    const j = () => V(0, 0.012);
    const w1 = R(-wave, wave), w2 = R(-wave, wave), w3 = R(-wave, wave), w4 = R(-wave, wave);
    const pts = [];
    const seg = (p0, p1, p2, p3, first) => cubic(p0, p1, p2, p3, 22, pts, !first);
    const nl = [c - nw, j()], nr = [c + nw, j()];
    const hl = [c - hw + tilt * 0.7, nh], hr = [c + hw + tilt * 0.7, nh];
    const top = [c + tilt, h];
    seg([0, 0], [0.18, w1], [nl[0] - 0.12, w2 - 0.01], nl, true);
    seg(nl, [nl[0] + 0.035 + j(), nh * 0.45 + j()], [hl[0] - tilt * 0.2 + j(), nh * 0.55 + j()], hl);
    seg(hl, [hl[0] + tilt * 0.3, nh + (h - nh) * 0.65], [c - hw * 0.55 + tilt + j(), h], top);
    seg(top, [c + hw * 0.55 + tilt + j(), h], [hr[0] + tilt * 0.3, nh + (h - nh) * 0.65], hr);
    seg(hr, [hr[0] - tilt * 0.2 + j(), nh * 0.55 + j()], [nr[0] - 0.035 + j(), nh * 0.45 + j()], nr);
    seg(nr, [nr[0] + 0.12, w3 - 0.01], [0.82, w4], [1, 0]);
    return pts;
  }

  function straightEdge() {
    const pts = [];
    for (let k = 0; k <= 30; k++) pts.push([k / 30, 0]);
    return pts;
  }

  // Map a unit-frame edge onto the chord A->B; +y goes to the left of A->B.
  function placeEdge(unit, A, B, sign) {
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    return unit.map(([u, v]) => [A[0] + u * dx + v * L * sign * nx, A[1] + u * dy + v * L * sign * ny]);
  }

  /**
   * opts: cols, rows, pw, ph (mm), seed, jitter (fraction), wave
   * Returns { cols, rows, pieces: [{ id, row, col, poly (Float64Array, mm, y up, CCW), corners, neighbours }] }
   * Piece sides: 0 = left, 1 = bottom, 2 = right, 3 = top (counter-clockwise from the top-left corner).
   */
  function generatePuzzle(opts) {
    opts = opts || {};
    const cols = opts.cols || 10, rows = opts.rows || 9;
    const pw = opts.pw || 21, ph = opts.ph || 18;
    const R = rng(opts.seed || 7);
    const jit = opts.jitter == null ? 0.07 : opts.jitter;
    const wave = opts.wave == null ? 0.035 : opts.wave;
    const P = [];
    for (let i = 0; i <= rows; i++) {
      P.push([]);
      for (let j = 0; j <= cols; j++) {
        let x = j * pw, y = -i * ph;
        const border = { l: j === 0, r: j === cols, t: i === 0, b: i === rows };
        if (!border.l && !border.r) x += R(-jit, jit) * pw;
        if (!border.t && !border.b) y += R(-jit, jit) * ph;
        P[i].push([x, y]);
      }
    }
    const V = [], H = [];
    for (let i = 0; i < rows; i++) {
      V.push([]);
      for (let j = 0; j <= cols; j++) {
        const border = j === 0 || j === cols;
        V[i].push(placeEdge(border ? straightEdge() : knobEdge(R, wave, opts.variety), P[i][j], P[i + 1][j], R.next() < 0.5 ? 1 : -1));
      }
    }
    for (let i = 0; i <= rows; i++) {
      H.push([]);
      for (let j = 0; j < cols; j++) {
        const border = i === 0 || i === rows;
        H[i].push(placeEdge(border ? straightEdge() : knobEdge(R, wave, opts.variety), P[i][j], P[i][j + 1], R.next() < 0.5 ? 1 : -1));
      }
    }
    const pieces = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const pts = [];
        const add = (arr) => { for (let k = 0; k < arr.length - 1; k++) pts.push(arr[k]); };
        add(V[i][j]);
        add(H[i + 1][j]);
        add(V[i][j + 1].slice().reverse());
        add(H[i][j].slice().reverse());
        const poly = new Float64Array(pts.length * 2);
        pts.forEach((p, k) => { poly[2 * k] = p[0]; poly[2 * k + 1] = p[1]; });
        const id = i * cols + j;
        const nb = [
          j > 0 ? [id - 1, 2] : null,
          i < rows - 1 ? [id + cols, 3] : null,
          j < cols - 1 ? [id + 1, 0] : null,
          i > 0 ? [id - cols, 1] : null,
        ];
        pieces.push({ id, row: i, col: j, poly, corners: [P[i][j], P[i + 1][j], P[i + 1][j + 1], P[i][j + 1]], neighbours: nb });
      }
    }
    return { cols, rows, pw, ph, pieces };
  }

  /**
   * Render pieces as a scanner would see them: black pieces on a light lid.
   * opts: dpi, pageW, pageH (mm), seed, faceDown (default true), noise, blur
   * Returns { canvas, width, height, placements: [{ id, angle, tx, ty, mirrored }] }
   * Placement maps the piece's front-view coordinates (mm, y up) to scan
   * millimetres with y up (row = -Y / mmPerPx).
   */
  function renderScan(list, opts) {
    opts = opts || {};
    const dpi = opts.dpi || 300;
    const pageW = opts.pageW || 216, pageH = opts.pageH || 297;
    const R = rng(opts.seed || 11);
    const faceDown = opts.faceDown !== false;
    const mmpp = 25.4 / dpi;
    const W = Math.round(pageW / mmpp), Hh = Math.round(pageH / mmpp);
    const canvas = opts.canvas || document.createElement('canvas');
    canvas.width = W; canvas.height = Hh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const g = ctx.createLinearGradient(0, 0, W, Hh);
    g.addColorStop(0, '#efefea');
    g.addColorStop(1, '#e2e3df');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Hh);
    // layout grid
    let maxR = 0;
    for (const p of list) {
      let cx = 0, cy = 0;
      const n = p.poly.length / 2;
      for (let k = 0; k < n; k++) { cx += p.poly[2 * k]; cy += p.poly[2 * k + 1]; }
      cx /= n; cy /= n;
      p._c = [cx, cy];
      for (let k = 0; k < n; k++) maxR = Math.max(maxR, Math.hypot(p.poly[2 * k] - cx, p.poly[2 * k + 1] - cy));
    }
    const cell = 2 * maxR + (opts.gap || 5);
    const margin = 14;
    const ncols = Math.max(1, Math.floor((pageW - 2 * margin) / cell));
    const placements = [];
    ctx.save();
    if (opts.blur !== 0) ctx.filter = 'blur(' + (opts.blur || 0.7) + 'px)';
    const perturb = opts.perturb || 0; // mm, smooth random outline error per piece
    const shadow = opts.shadow || 0; // mm, soft shadow cast towards the bottom of the page
    const rows = Math.max(1, Math.ceil(list.length / ncols));
    const cellY = Math.min(cell, (pageH - 2 * margin) / rows);
    list.forEach((p, k) => {
      const col = k % ncols, row = Math.floor(k / ncols);
      const X = margin + cell * (col + 0.5) + R(-1, 1);
      const Y = -(margin + cellY * (row + 0.5) + R(-1, 1));
      const ang = R(0, Math.PI * 2);
      const c = Math.cos(ang), s = Math.sin(ang);
      const n = p.poly.length / 2;
      // smooth per-piece outline error along the normal
      let poly = p.poly;
      if (perturb > 0) {
        poly = new Float64Array(p.poly.length);
        const waves = [];
        for (let w = 1; w <= 8; w++) waves.push([w * R(1, 3), R(0, 6.283), R(-1, 1) / Math.sqrt(w)]);
        let per = 0;
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; per += Math.hypot(p.poly[2 * j] - p.poly[2 * i], p.poly[2 * j + 1] - p.poly[2 * i + 1]); }
        let acc = 0;
        for (let i = 0; i < n; i++) {
          const a = (i - 1 + n) % n, b = (i + 1) % n;
          const tx = p.poly[2 * b] - p.poly[2 * a], ty = p.poly[2 * b + 1] - p.poly[2 * a + 1];
          const tl = Math.hypot(tx, ty) || 1;
          let d = 0;
          for (const [f, ph, amp] of waves) d += amp * Math.sin((acc / per) * f * 6.283 + ph);
          d *= perturb * 0.6;
          poly[2 * i] = p.poly[2 * i] + (ty / tl) * d;
          poly[2 * i + 1] = p.poly[2 * i + 1] - (tx / tl) * d;
          const j = (i + 1) % n;
          acc += Math.hypot(p.poly[2 * j] - p.poly[2 * i], p.poly[2 * j + 1] - p.poly[2 * i + 1]);
        }
      }
      const path = (ox, oy) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          let x = poly[2 * i] - p._c[0], y = poly[2 * i + 1] - p._c[1];
          if (!faceDown) x = -x; // the scanner sees the back: mirrored outline
          const sx = c * x - s * y + X, sy = s * x + c * y + Y;
          if (i === 0) ctx.moveTo(sx / mmpp + ox, -sy / mmpp + oy); else ctx.lineTo(sx / mmpp + ox, -sy / mmpp + oy);
        }
        ctx.closePath();
      };
      if (shadow > 0) {
        ctx.save();
        ctx.filter = 'blur(' + (shadow / mmpp / 2).toFixed(1) + 'px)';
        path(0, shadow / mmpp);
        ctx.fillStyle = 'rgba(80,80,80,0.55)';
        ctx.fill();
        ctx.restore();
      }
      path(0, 0);
      ctx.fillStyle = faceDown ? '#1c1c20' : '#8b8f99';
      ctx.fill();
      placements.push({ id: p.id, angle: ang, tx: X, ty: Y, cx: p._c[0], cy: p._c[1], mirrored: !faceDown });
    });
    ctx.restore();
    // dust specks
    ctx.fillStyle = '#333';
    for (let k = 0; k < 25; k++) {
      ctx.beginPath();
      ctx.arc(R(0, W), R(0, Hh), R(0.5, 2.5), 0, Math.PI * 2);
      ctx.fill();
    }
    // sensor noise
    const noise = opts.noise == null ? 7 : opts.noise;
    if (noise > 0) {
      const im = ctx.getImageData(0, 0, W, Hh);
      const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (R.next() + R.next() - 1) * noise;
        d[i] += v; d[i + 1] += v; d[i + 2] += v;
      }
      ctx.putImageData(im, 0, 0);
    }
    return { canvas, width: W, height: Hh, mmPerPx: mmpp, placements };
  }

  // Front-view (piece) coordinates -> scan millimetres for a placement.
  function placeToScan(pl, x, y) {
    let lx = x - pl.cx, ly = y - pl.cy;
    if (pl.mirrored) lx = -lx;
    const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
    return [c * lx - s * ly + pl.tx, s * lx + c * ly + pl.ty];
  }

  return { rng, generatePuzzle, renderScan, placeToScan, knobEdge };
});
