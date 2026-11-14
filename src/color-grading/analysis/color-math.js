// ============================================================================
//  Color math — pure, deterministic, no I/O. Shared by analysis, recommend,
//  and the preview/LUT transform. All RGB inputs are display-encoded
//  (gamma-encoded, "R'G'B'") in [0,1], full range — i.e. what an 8-bit PNG
//  frame export holds. Measurements are made in that encoded domain on
//  purpose: it is the domain Premiere's Lumetri scopes display.
//
//  Sources:
//   - ITU-R BT.709-6 §3 (luma coefficients 0.2126/0.7152/0.0722 and the
//     Cb/Cr scale factors 1.8556 / 1.5748).
//   - Vectorscope skin-tone ("I") line: NTSC YIQ I axis at ~123° measured
//     counter-clockwise from +Cb (B−Y). Kdenlive docs, "Vectorscope I and Q
//     lines": https://docs.kdenlive.org/en/tips_and_tricks/scopes/vectorscope_i_and_q_lines.html
//     Boris FX scope docs note real skin sits a few degrees off the line —
//     it is a diagnostic guide, never a target this code forces skin onto.
// ============================================================================

export const REC709 = Object.freeze({ kr: 0.2126, kg: 0.7152, kb: 0.0722 });
export const REC601 = Object.freeze({ kr: 0.299, kg: 0.587, kb: 0.114 });

/** Skin-tone (I) line angle on a Cb/Cr vectorscope, degrees from +Cb. */
export const SKIN_LINE_DEG = 123;

export function luma(r, g, b, m = REC709) {
  return m.kr * r + m.kg * g + m.kb * b;
}

/**
 * Encoded R'G'B' → Y'CbCr (Cb/Cr in [-0.5, 0.5]).
 */
export function rgbToYCbCr(r, g, b, m = REC709) {
  const y = luma(r, g, b, m);
  const cb = (b - y) / (2 * (1 - m.kb));
  const cr = (r - y) / (2 * (1 - m.kr));
  return { y, cb, cr };
}

/**
 * Vectorscope position of a colour: angle (deg, 0..360, CCW from +Cb) and
 * chroma (distance from centre, 0..~0.5).
 */
export function vectorscope(r, g, b, m = REC709) {
  const { y, cb, cr } = rgbToYCbCr(r, g, b, m);
  let angle = (Math.atan2(cr, cb) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { y, cb, cr, angle, chroma: Math.hypot(cb, cr) };
}

/** Smallest signed difference a−b between two angles, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** HSV-style hue (deg 0..360), saturation, value. Hue is NaN for greys. */
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = NaN;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h, s, v) {
  if (!(s > 0) || Number.isNaN(h)) return [v, v, v];
  const hh = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Percentile (0..100) of a sorted numeric array, linear interpolation. */
export function percentileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function median(values) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  return percentileSorted(s, 50);
}

/**
 * Circular mean + spread of angles (deg). Spread is the circular standard
 * deviation in degrees; large spread = the region is not one hue family.
 */
export function circularStats(anglesDeg, weights) {
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < anglesDeg.length; i++) {
    const w = weights ? weights[i] : 1;
    const a = (anglesDeg[i] * Math.PI) / 180;
    sx += Math.cos(a) * w;
    sy += Math.sin(a) * w;
    sw += w;
  }
  if (!sw) return { mean: NaN, spread: NaN, resultantLength: 0 };
  const R = Math.hypot(sx, sy) / sw;
  let mean = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (mean < 0) mean += 360;
  const spread = R > 0 ? (Math.sqrt(-2 * Math.log(Math.min(1, R))) * 180) / Math.PI : 180;
  return { mean, spread, resultantLength: R };
}

/**
 * Smooth, overlapping tonal weights for shadows / midtones / highlights.
 * They always sum to 1, overlap deliberately (as editor wheels do), and are
 * C¹-continuous so wheel corrections never produce a visible tonal seam.
 */
export function tonalWeights(y) {
  const t = clamp01(y);
  const sh = (1 - smoothstep(0, 0.5, t));
  const hi = smoothstep(0.5, 1, t);
  const mid = 1 - sh - hi;
  return { shadows: sh, midtones: mid, highlights: hi };
}

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * Raised-cosine hue window: 1 at `center`, smoothly to 0 at center±width/2.
 * C¹-continuous — the falloff that prevents abrupt hue boundaries.
 */
export function hueWindow(hueDeg, centerDeg, widthDeg) {
  if (Number.isNaN(hueDeg)) return 0;
  const d = Math.abs(angleDiff(hueDeg, centerDeg));
  const half = widthDeg / 2;
  if (d >= half) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / half));
}
