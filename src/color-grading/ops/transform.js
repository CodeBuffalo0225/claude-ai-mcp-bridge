// ============================================================================
//  Pixel transform engine — exact implementation of the pixel-domain grade
//  ops (curves, hue curves, wheels, masked secondaries). Used for:
//    - engine previews (before/after of what WE compute — labelled as such,
//      never presented as a Premiere render),
//    - baking global ops into a .cube LUT (cube-lut.js),
//    - safety checks: clipping, crush, slope (banding), hue-boundary smoothness.
//
//  Curves use monotone cubic Hermite interpolation (Fritsch & Carlson, 1980,
//  "Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 17(2)) so a
//  curve through increasing points can never overshoot, fold or invert.
// ============================================================================

import { clamp01, rgbToHsv, hsvToRgb, hueWindow, luma, tonalWeights, smoothstep, vectorscope, REC709 } from '../analysis/color-math.js';
import { percentileSorted } from '../analysis/color-math.js';
import { CLIP_HIGH, CLIP_LOW } from '../analysis/frame-stats.js';

// ── monotone curve ─────────────────────────────────────────────────────

export function monotoneCurve(points) {
  const pts = [...points].map(([x, y]) => [clamp01(x), clamp01(y)]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] < 1e-6) throw new Error('curve points must have distinct x values');
    if (pts[i][1] < pts[i - 1][1]) throw new Error('curve must be non-decreasing (an inverted curve solarises the image)');
  }
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const f = (x) => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]) * m[0];
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]) * m[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
  return (x) => clamp01(f(x));
}

/** Max local slope of a curve (banding risk on 8-bit when steep). */
export function maxSlope(fn, samples = 256) {
  let mx = 0;
  for (let i = 0; i < samples; i++) {
    const a = i / samples, b = (i + 1) / samples;
    mx = Math.max(mx, (fn(b) - fn(a)) * samples);
  }
  return mx;
}

/**
 * Design a gentle S-curve FROM THE FRAME, not from fixed numbers:
 *  - pivots at `pivot` (skin median luma if faces are reliable, else scene
 *    median) so midtone/skin brightness is unchanged;
 *  - the toe/shoulder push is bounded so the frame's own p1 is not crushed
 *    below the information-loss threshold, p99 does not clip, and the toe
 *    keeps at least `minToeSlope` of its original shadow separation;
 *  - strength is reduced by bisection until every constraint holds, and the
 *    constraint values are returned as evidence.
 * Returns null curve (with reasons) when the frame has no headroom.
 */
export function designSCurve({ pivot, strength = 0.35, lumaP1, lumaP99, minToeSlope = 0.6, maxShoulderSlope = 1.6 }) {
  if (!(pivot > 0.05 && pivot < 0.95)) return { points: null, reasons: [`pivot ${pivot} is outside the usable range`] };
  const build = (s) => {
    const lo = pivot * 0.45, hi = pivot + (1 - pivot) * 0.55;
    return [[0, 0], [lo, lo - s * 0.35 * lo], [pivot, pivot], [hi, Math.min(1, hi + s * 0.35 * (1 - hi))], [1, 1]];
  };
  const check = (pts) => {
    const fn = monotoneCurve(pts);
    const outP1 = fn(lumaP1), outP99 = fn(lumaP99);
    const toeSlope = (fn(lumaP1 + 0.02) - fn(Math.max(0, lumaP1 - 0.02))) / (lumaP1 + 0.02 - Math.max(0, lumaP1 - 0.02));
    const slope = maxSlope(fn);
    const fails = [];
    // Crush = shadow detail that was above the information-loss floor is
    // pushed onto it. (A frame whose p1 already sits on the floor is not
    // made worse by a curve pinned at (0,0).)
    if (lumaP1 > 2 * CLIP_LOW && outP1 < 2 * CLIP_LOW) fails.push(`shadows: p1 ${lumaP1.toFixed(3)}→${outP1.toFixed(3)} would crush`);
    if (outP99 >= CLIP_HIGH && lumaP99 < CLIP_HIGH) fails.push(`highlights: p99 ${lumaP99.toFixed(3)}→${outP99.toFixed(3)} would clip`);
    if (toeSlope < minToeSlope) fails.push(`toe slope ${toeSlope.toFixed(2)} < ${minToeSlope} loses shadow separation`);
    if (slope > maxShoulderSlope) fails.push(`max slope ${slope.toFixed(2)} > ${maxShoulderSlope} risks banding`);
    return { fn, outP1, outP99, toeSlope, slope, fails };
  };
  let s = strength, res = check(build(s)), iters = 0;
  if (res.fails.length) {
    let lo = 0, hi = strength;
    while (iters++ < 20) {
      s = (lo + hi) / 2;
      res = check(build(s));
      if (res.fails.length) hi = s; else lo = s;
    }
    s = lo;
    res = check(build(s));
  }
  if (s < 0.02) return { points: null, strength: 0, reasons: ['no headroom: the frame already spans its range — an S-curve here would crush or clip', ...res.fails] };
  return {
    points: build(s).map(([x, y]) => [round(x), round(y)]),
    strength: round(s),
    requestedStrength: strength,
    reduced: s < strength - 1e-6,
    evidence: { pivot: round(pivot), lumaP1In: round(lumaP1), lumaP1Out: round(res.outP1), lumaP99In: round(lumaP99), lumaP99Out: round(res.outP99), toeSlope: round(res.toeSlope), maxSlope: round(res.slope) },
    reasons: [],
  };
}

// ── pixel pipeline ──────────────────────────────────────────────────────

/** Compile pixel-domain ops into a single (r,g,b)→[r,g,b] function. */
export function compilePixelOps(ops) {
  const stages = ops.map((op) => {
    switch (op.op) {
      case 'curve': {
        const fn = monotoneCurve(op.points);
        if (op.channel === 'master') return ([r, g, b]) => [fn(r), fn(g), fn(b)];
        const ch = { red: 0, green: 1, blue: 2 }[op.channel];
        return (rgb) => { const o = rgb.slice(); o[ch] = fn(rgb[ch]); return o; };
      }
      case 'hueVsSat':
        // Scale chroma around BT.709 luma: a saturation change must not
        // change brightness. (Scaling HSV S at constant V lifts the lower
        // channels, so desaturated skin would also get brighter — measured
        // +0.019 luma on the live validation frame before this fix.)
        return ([r, g, b]) => {
          const { h } = rgbToHsv(r, g, b);
          const w = hueWindow(h, op.center, op.width);
          if (!w) return [r, g, b];
          const y = luma(r, g, b);
          const k = Math.max(0, 1 + op.amount * w);
          return [clamp01(y + (r - y) * k), clamp01(y + (g - y) * k), clamp01(y + (b - y) * k)];
        };
      case 'hueVsHue':
        return ([r, g, b]) => {
          const { h, s, v } = rgbToHsv(r, g, b);
          const w = hueWindow(h, op.center, op.width);
          if (!w) return [r, g, b];
          return hsvToRgb(h + op.shiftDeg * w, s, v);
        };
      case 'hueVsLuma':
        return ([r, g, b]) => {
          const { h, s } = rgbToHsv(r, g, b);
          const w = hueWindow(h, op.center, op.width) * s; // neutrals untouched
          if (!w) return [r, g, b];
          const d = op.amount * w;
          return [clamp01(r + d), clamp01(g + d), clamp01(b + d)];
        };
      case 'wheels': {
        const vec = (wh) => {
          if (!wh) return null;
          const c = hsvToRgb(wh.hueDeg, 1, 1);
          const y = luma(c[0], c[1], c[2]);
          return [c[0] - y, c[1] - y, c[2] - y].map((x) => x * wh.amount + (wh.luma || 0));
        };
        const sv = vec(op.shadows), mv = vec(op.midtones), hv = vec(op.highlights);
        return ([r, g, b]) => {
          const t = tonalWeights(luma(r, g, b));
          const o = [r, g, b];
          for (let k = 0; k < 3; k++) {
            o[k] += (sv ? t.shadows * sv[k] : 0) + (mv ? t.midtones * mv[k] : 0) + (hv ? t.highlights * hv[k] : 0);
            o[k] = clamp01(o[k]);
          }
          return o;
        };
      }
      case 'hslSecondary': {
        const q = op.qualifier, c = op.correction;
        const soft = q.softness ?? 0.06;
        const lr = q.lumaRange || [0, 1];
        const inRange = (x, lo, hi) => smoothstep(lo - soft, lo, x) * (1 - smoothstep(hi, hi + soft, x));
        // Cb/Cr push → RGB offset (BT.709 inverse, luma-neutral).
        const dR = 1.5748 * (c.cr || 0);
        const dB = 1.8556 * (c.cb || 0);
        const dG = -(0.2126 * dR + 0.0722 * dB) / 0.7152;
        return ([r, g, b]) => {
          const { h, s } = rgbToHsv(r, g, b);
          const y = luma(r, g, b);
          const w = hueWindow(h, q.hueCenter, q.hueWidth) * inRange(s, q.satRange[0], q.satRange[1]) * inRange(y, lr[0], lr[1]);
          if (!w) return [r, g, b];
          let o = [r, g, b];
          if (c.hueShiftDeg) { const hv = rgbToHsv(...o); o = hsvToRgb(hv.h + c.hueShiftDeg * w, hv.s, hv.v); }
          if (c.saturation) { const yy = luma(...o); const k = Math.max(0, 1 + c.saturation * w); o = o.map((v) => yy + (v - yy) * k); }
          o = [o[0] + dR * w, o[1] + dG * w, o[2] + dB * w];
          return o.map(clamp01);
        };
      }
      default:
        throw new Error(`not a pixel op: ${op.op}`);
    }
  });
  return (rgb) => stages.reduce((acc, st) => st(acc), rgb);
}

/**
 * Apply pixel ops to an image. Secondary ops blend through their mask
 * (Float32 matte, 0..1). Masks are supplied by the caller (skin.js) —
 * this function never invents one.
 */
export function applyOpsToImage(img, ops, { masks = {} } = {}) {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  const globalOps = ops.filter((o) => o.op !== 'secondary' && o.op !== 'lumetri');
  const secondaries = ops.filter((o) => o.op === 'secondary');
  const g = globalOps.length ? compilePixelOps(globalOps) : null;
  const secs = secondaries.map((s) => {
    const key = `${s.mask.kind}:${s.mask.faceIndex}`;
    const matte = masks[key];
    if (!matte) throw new Error(`secondary needs a mask "${key}" — run analysis with keepMasks and pass it in`);
    return { fn: compilePixelOps(s.ops), matte: featherMask(matte, width, height, s.mask.featherPx) };
  });
  for (let p = 0, i = 0; p < width * height; p++, i += 3) {
    let rgb = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    if (g) rgb = g(rgb);
    for (const s of secs) {
      const a = s.matte[p];
      if (a > 0) {
        const t = s.fn(rgb);
        rgb = [rgb[0] + (t[0] - rgb[0]) * a, rgb[1] + (t[1] - rgb[1]) * a, rgb[2] + (t[2] - rgb[2]) * a];
      }
    }
    out[i] = Math.round(clamp01(rgb[0]) * 255);
    out[i + 1] = Math.round(clamp01(rgb[1]) * 255);
    out[i + 2] = Math.round(clamp01(rgb[2]) * 255);
  }
  return { ...img, data: out };
}

/** Separable box-blur feather of a 0/1 mask → Float32 matte in 0..1. */
export function featherMask(mask, width, height, radius) {
  let m = Float32Array.from(mask);
  const r = Math.round(radius);
  if (r < 1) return m;
  const tmp = new Float32Array(m.length);
  for (let pass = 0; pass < 2; pass++) { // two box passes ≈ triangle falloff
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += m[y * width + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        tmp[y * width + x] = acc / (2 * r + 1);
        acc += m[y * width + Math.min(width - 1, x + r + 1)] - m[y * width + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        m[y * width + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(height - 1, y + r + 1) * width + x] - tmp[Math.max(0, y - r) * width + x];
      }
    }
  }
  return m;
}

/**
 * Safety report for a set of global pixel ops evaluated on a frame:
 * clipping/crush introduced, hue-boundary steepness, neighbour leakage.
 */
export function safetyReport(img, ops) {
  const fn = compilePixelOps(ops.filter((o) => o.op !== 'secondary' && o.op !== 'lumetri'));
  let newClip = 0, newCrush = 0, n = 0;
  const shifts = [];
  for (let i = 0; i < img.data.length; i += 3 * 4) {
    const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
    const o = fn([r, g, b]);
    const inMax = Math.max(r, g, b), outMax = Math.max(...o);
    const inMin = Math.min(r, g, b), outMin = Math.min(...o);
    if (outMax >= CLIP_HIGH && inMax < CLIP_HIGH) newClip++;
    if (outMin <= CLIP_LOW && inMin > CLIP_LOW) newCrush++;
    shifts.push(Math.abs(luma(...o) - luma(r, g, b)));
    n++;
  }
  const sorted = Float64Array.from(shifts).sort();
  const curveOps = ops.filter((o) => o.op === 'curve');
  const slopes = curveOps.map((o) => maxSlope(monotoneCurve(o.points)));
  // Hue windows: steepest gradient of the effect across hue (per degree).
  const hueSteep = ops.filter((o) => ['hueVsSat', 'hueVsHue', 'hueVsLuma'].includes(o.op)).map((o) => {
    const peak = Math.abs(o.amount ?? o.shiftDeg / 30);
    return round((peak * Math.PI) / o.width); // max |d/dh| of the raised cosine
  });
  const warnings = [];
  if (newClip / n > 0.001) warnings.push(`introduces highlight clipping on ${(100 * newClip / n).toFixed(2)}% of pixels`);
  if (newCrush / n > 0.001) warnings.push(`crushes ${(100 * newCrush / n).toFixed(2)}% of pixels to black`);
  if (slopes.some((s) => s > 1.6)) warnings.push(`curve slope up to ${Math.max(...slopes).toFixed(2)} — banding risk on 8-bit`);
  if (hueSteep.some((s) => s > 0.03)) warnings.push('hue window is narrow for its strength — risk of visible hue boundaries; widen it or lower the amount');
  return {
    newlyClippedFraction: round(newClip / n, 5),
    newlyCrushedFraction: round(newCrush / n, 5),
    lumaShiftP50: round(percentileSorted(sorted, 50), 4),
    lumaShiftP99: round(percentileSorted(sorted, 99), 4),
    curveMaxSlopes: slopes.map((s) => round(s)),
    hueWindowSteepness: hueSteep,
    warnings,
    ok: warnings.length === 0,
  };
}

function round(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }
