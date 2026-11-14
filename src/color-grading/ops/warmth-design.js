// ============================================================================
//  Warmth correction design — tonal colour wheels + HSL Secondary, designed
//  from measurements and solved on the engine (pure, exact, no Premiere).
//
//  Lumetri's colour wheels and HSL Secondary key are not scriptable on
//  Premiere 26.5.2 (verified: wheels are blobs; setting the key colour by
//  script stores it but builds no key — Show Mask renders nothing). So the
//  same corrections are expressed as engine ops (ops/transform.js), solved
//  here against the frame's own measurements, previewed, and baked to .cube.
//
//  Wheels: each tonal range's residual cast is pushed back by `strength`
//  (highlights less — practical lights should stay warm). Because the
//  shadows/mids/highlights weights overlap, the wheel amounts are refined by
//  fixed-point iteration: apply → re-measure → correct by the residual.
//  HSL Secondary: keys the dominant saturated warm hue OUTSIDE the faces,
//  with a saturation floor above the measured skin p90 so skin is protected;
//  the protection is measured (footprint inside vs outside skin).
// ============================================================================

import { hsvToRgb, rgbToHsv, vectorscope, tonalWeights, circularStats, percentileSorted, angleDiff } from '../analysis/color-math.js';
import { measureTonalCasts } from '../analysis/warmth.js';
import { compilePixelOps } from './transform.js';

const RANGE_KEY = { shadows: 'shadows', mids: 'midtones', highlights: 'highlights' };
// Highlights are often the practical lights themselves (lamp shade, LED):
// legitimately warm. Correcting them fully clipped the lamp (live).
const RANGE_GAIN = { shadows: 1, mids: 1, highlights: 0.3 };
// Skin guard: the cast axis is not the skin axis (orange cast ~135°, skin
// ~121°), so pushing against the cast rotates skin toward red. The wheel
// solution is scaled down until skin stays inside these limits.
export const SKIN_GUARD = Object.freeze({ maxHueShiftDeg: 3, maxChromaChange: 0.12 });

function skinStats(img, mask) {
  const ang = [], chr = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 3;
    const v = vectorscope(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
    if (v.chroma > 0.01) { ang.push(v.angle); chr.push(v.chroma); }
  }
  if (!ang.length) return null;
  return { angle: circularStats(ang, chr).mean, chroma: chr.reduce((a, c) => a + c, 0) / chr.length };
}

function scaleWheels(op, k) {
  const o = { op: 'wheels' };
  for (const r of ['shadows', 'midtones', 'highlights']) if (op[r]) o[r] = { ...op[r], amount: round(op[r].amount * k, 5) };
  return o;
}

/** HSV hue whose fully-saturated colour points at `angleDeg` on the vectorscope. */
export function hueForVectorscopeAngle(angleDeg) {
  let best = 0, bestErr = Infinity;
  for (let h = 0; h < 360; h += 0.25) {
    const c = hsvToRgb(h, 1, 1);
    const e = Math.abs(angleDiff(vectorscope(c[0], c[1], c[2]).angle, angleDeg));
    if (e < bestErr) { bestErr = e; best = h; }
  }
  return best;
}

/** Wheel {hueDeg, amount} that adds Cb/Cr (cb, cr) at tonal weight 1. */
export function wheelForCbCr(cb, cr) {
  const mag = Math.hypot(cb, cr);
  if (mag < 1e-6) return null;
  let angle = (Math.atan2(cr, cb) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  const hueDeg = hueForVectorscopeAngle(angle);
  const c = hsvToRgb(hueDeg, 1, 1);
  const chroma = vectorscope(c[0], c[1], c[2]).chroma;
  return { hueDeg, amount: mag / chroma };
}

function meanTonalWeight(img, rangeKey, lumaLo, lumaHi, step = 4) {
  let s = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 3 * step) {
    const v = vectorscope(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
    if (v.y < lumaLo || v.y > lumaHi) continue;
    s += tonalWeights(v.y)[rangeKey]; n++;
  }
  return n ? s / n : 0;
}

function applyOps(img, ops) {
  const fn = compilePixelOps(ops);
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 3) {
    const o = fn([img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255]);
    out[i] = Math.round(o[0] * 255); out[i + 1] = Math.round(o[1] * 255); out[i + 2] = Math.round(o[2] * 255);
  }
  return { ...img, data: out };
}

/**
 * Solve tonal wheels so each range's cast is reduced by strength × gain.
 * @returns { op, iterations, before, after, targets }
 */
export function designTonalWheels(img, { strength = 0.5, iterations = 6, skinMasks = [] } = {}) {
  const base = measureTonalCasts(img);
  const before = base.casts;
  const sel = base.selection;
  const targets = {}, push = {};
  for (const r of Object.keys(RANGE_KEY)) {
    const k = strength * RANGE_GAIN[r];
    targets[r] = { cb: before[r].cb * (1 - k), cr: before[r].cr * (1 - k) };
    const w = Math.max(0.15, meanTonalWeight(img, RANGE_KEY[r], before[r].lumaRange[0], before[r].lumaRange[1]));
    push[r] = { cb: (targets[r].cb - before[r].cb) / w, cr: (targets[r].cr - before[r].cr) / w };
  }
  const build = () => {
    const op = { op: 'wheels' };
    for (const r of Object.keys(RANGE_KEY)) {
      const wh = wheelForCbCr(push[r].cb, push[r].cr);
      if (wh) op[RANGE_KEY[r]] = { hueDeg: round(wh.hueDeg, 2), amount: round(Math.min(0.2, wh.amount), 5), luma: 0 };
    }
    return op;
  };
  const log = [];
  let op = build(), after = null;
  for (let it = 0; it < iterations; it++) {
    after = measureTonalCasts(applyOps(img, [op]), { selection: sel }).casts;
    const err = {};
    for (const r of Object.keys(RANGE_KEY)) {
      err[r] = { cb: targets[r].cb - after[r].cb, cr: targets[r].cr - after[r].cr };
      push[r].cb += err[r].cb; push[r].cr += err[r].cr;
    }
    log.push(Object.fromEntries(Object.entries(err).map(([k, v]) => [k, round(Math.hypot(v.cb, v.cr), 5)])));
    op = build();
  }
  // Skin guard: bisect a global scale on the wheels until every face stays
  // within SKIN_GUARD. The scale (and why) is returned as evidence.
  let scale = 1;
  const guard = [];
  const skinBefore = skinMasks.map((m) => skinStats(img, m)).filter(Boolean);
  const violates = (k) => {
    const out = applyOps(img, [scaleWheels(op, k)]);
    return skinMasks.some((m, i) => {
      const s0 = skinBefore[i], s1 = skinStats(out, m);
      if (!s0 || !s1) return false;
      const dh = Math.abs(angleDiff(s1.angle, s0.angle)), dc = Math.abs(s1.chroma - s0.chroma) / s0.chroma;
      guard.push({ scale: round(k, 3), hueShiftDeg: round(dh, 2), chromaChange: round(dc, 3) });
      return dh > SKIN_GUARD.maxHueShiftDeg || dc > SKIN_GUARD.maxChromaChange;
    });
  };
  if (skinBefore.length && violates(1)) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2; if (violates(mid)) hi = mid; else lo = mid; }
    scale = lo;
    op = scaleWheels(op, scale);
  }
  after = measureTonalCasts(applyOps(img, [op]), { selection: sel }).casts;
  return { op, before, after, targets, residualByIteration: log, skinGuard: { scale: round(scale, 3), limits: SKIN_GUARD, trials: guard.slice(-4) }, selection: sel };
}

/**
 * HSL Secondary on the dominant saturated warm hue outside the faces.
 * @param skinMasks Uint8Array[] (from analyzeFrames keepMasks) — protected
 */
export function designWarmHslSecondary(img, skinMasks, { saturation = -0.15 } = {}) {
  const warm = [], skinSats = [];
  const n = img.width * img.height;
  for (let p = 0, i = 0; p < n; p += 2, i += 6) {
    const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
    const hsv = rgbToHsv(r, g, b);
    if (skinMasks.some((m) => m[p])) { skinSats.push(hsv.s); continue; }
    const v = vectorscope(r, g, b);
    if (v.angle >= 95 && v.angle <= 185 && hsv.s > 0.15 && v.chroma > 0.04) warm.push({ h: hsv.h, s: hsv.s, c: v.chroma });
  }
  if (warm.length < 100) return { op: null, reasons: ['no dominant saturated warm colour outside the faces'] };
  const center = circularStats(warm.map((x) => x.h), warm.map((x) => x.c)).mean;
  const skinP90 = skinSats.length ? percentileSorted(Float64Array.from(skinSats).sort(), 90) : 0.35;
  const satLo = Math.min(0.9, skinP90 + 0.06);
  const op = {
    op: 'hslSecondary',
    qualifier: { hueCenter: round(center, 1), hueWidth: 50, satRange: [round(satLo, 3), 1], lumaRange: [0, 1], softness: 0.06 },
    correction: { saturation, hueShiftDeg: 0, cb: 0, cr: 0 },
  };
  // Measured protection: mean qualifier weight inside vs outside the skin.
  const fn = compilePixelOps([{ ...op, correction: { saturation: -1, hueShiftDeg: 0, cb: 0, cr: 0 } }]);
  let inS = 0, inN = 0, outS = 0, outN = 0;
  for (let p = 0, i = 0; p < n; p += 2, i += 6) {
    const rgb = [img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255];
    const o = fn(rgb);
    const before = rgbToHsv(...rgb).s, after = rgbToHsv(...o).s;
    const w = before > 0 ? 1 - after / before : 0; // fraction removed at full strength = qualifier weight
    if (skinMasks.some((m) => m[p])) { inS += w; inN++; } else { outS += w; outN++; }
  }
  return {
    op,
    evidence: { warmPixelsSampled: warm.length, keyHueCenter: round(center, 1), skinSatP90: round(skinP90, 3), satFloor: round(satLo, 3),
      meanKeyWeightInsideSkin: round(inN ? inS / inN : 0, 4), meanKeyWeightOutsideSkin: round(outN ? outS / outN : 0, 4) },
  };
}

function round(x, d = 4) { return Math.round(x * 10 ** d) / 10 ** d; }
