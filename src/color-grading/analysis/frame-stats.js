// ============================================================================
//  Frame statistics — software scopes over one decoded frame. Pure: takes an
//  { width, height, data } RGB image and returns measurements only. No
//  targets, no recommendations (that is recommend/recommender.js).
//
//  Everything is measured on encoded R'G'B' values normalised to [0,1],
//  the same domain Lumetri's waveform / vectorscope display.
// ============================================================================

import { luma, vectorscope, rgbToHsv, percentileSorted, circularStats, REC709 } from './color-math.js';

// A channel at/above this (in 0..1) is treated as clipped; at/below the low
// value as crushed. 8-bit: 254/255 and 1/255. These are detection thresholds
// for "information is gone", not exposure targets.
export const CLIP_HIGH = 254 / 255;
export const CLIP_LOW = 1 / 255;

// Near-neutral pixel test used for white-balance measurement: low saturation,
// away from the noisy shadows and the clipped top.
const NEUTRAL_MAX_SAT = 0.12;
const NEUTRAL_MIN_Y = 0.2;
const NEUTRAL_MAX_Y = 0.95;

/**
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {{step?:number, matrix?:object, excludeMask?:Uint8Array}} opts
 *   step: sample every Nth pixel in x and y (speed); excludeMask: 1 = ignore
 *   (e.g. burned-in graphics region) — same dims as img.
 */
export function computeFrameStats(img, { step = 2, matrix = REC709, excludeMask } = {}) {
  const { width, height, data } = img;
  const lumas = [];
  const hist = new Uint32Array(256);
  let n = 0, clipHi = 0, clipLo = 0, anyClipHi = 0;
  let sr = 0, sg = 0, sb = 0;
  let nN = 0, nCb = 0, nCr = 0;
  let gCb = 0, gCr = 0;
  const chromas = [];
  const sats = [];
  const hueAngles = [], hueWeights = [];

  for (let yy = 0; yy < height; yy += step) {
    for (let xx = 0; xx < width; xx += step) {
      const p = yy * width + xx;
      if (excludeMask && excludeMask[p]) continue;
      const i = p * 3;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const Y = luma(r, g, b, matrix);
      lumas.push(Y);
      hist[Math.min(255, Math.round(Y * 255))]++;
      n++;
      sr += r; sg += g; sb += b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx >= CLIP_HIGH) anyClipHi++;
      if (r >= CLIP_HIGH && g >= CLIP_HIGH && b >= CLIP_HIGH) clipHi++;
      if (mx <= CLIP_LOW) clipLo++;
      const vs = vectorscope(r, g, b, matrix);
      chromas.push(vs.chroma);
      gCb += vs.cb; gCr += vs.cr;
      const hsv = rgbToHsv(r, g, b);
      sats.push(hsv.s);
      if (vs.chroma > 0.02) { hueAngles.push(vs.angle); hueWeights.push(vs.chroma); }
      if (hsv.s < NEUTRAL_MAX_SAT && Y > NEUTRAL_MIN_Y && Y < NEUTRAL_MAX_Y && mn > CLIP_LOW && mx < CLIP_HIGH) {
        nN++; nCb += vs.cb; nCr += vs.cr;
      }
    }
  }
  if (!n) throw new Error('No pixels sampled (empty frame or everything excluded)');

  const sortedY = Float64Array.from(lumas).sort();
  const sortedC = Float64Array.from(chromas).sort();
  const sortedS = Float64Array.from(sats).sort();
  const neutralFraction = nN / n;

  // White-balance evidence: mean chroma offset of near-neutral pixels. If the
  // frame has almost no neutrals, fall back to grey-world and say so — that
  // estimate is biased by scene content (foliage, sky) and gets low confidence.
  const wb = neutralFraction >= 0.01
    ? { method: 'near_neutral_pixels', cb: nCb / nN, cr: nCr / nN, sampleFraction: neutralFraction, confidence: Math.min(1, neutralFraction / 0.05) }
    : { method: 'grey_world_fallback', cb: gCb / n, cr: gCr / n, sampleFraction: neutralFraction, confidence: 0.2 };
  wb.magnitude = Math.hypot(wb.cb, wb.cr);
  wb.axes = castAxes(wb.cb, wb.cr);

  return {
    samples: n,
    step,
    luma: {
      p1: percentileSorted(sortedY, 1),
      p5: percentileSorted(sortedY, 5),
      p25: percentileSorted(sortedY, 25),
      p50: percentileSorted(sortedY, 50),
      p75: percentileSorted(sortedY, 75),
      p95: percentileSorted(sortedY, 95),
      p99: percentileSorted(sortedY, 99),
      mean: lumas.reduce((a, v) => a + v, 0) / n,
      histogram: Array.from(hist),
    },
    clipping: {
      highlightsAllChannels: clipHi / n,
      highlightsAnyChannel: anyClipHi / n,
      shadows: clipLo / n,
    },
    meanRGB: { r: sr / n, g: sg / n, b: sb / n },
    whiteBalance: wb,
    saturation: {
      hsvP50: percentileSorted(sortedS, 50),
      hsvP95: percentileSorted(sortedS, 95),
      chromaP50: percentileSorted(sortedC, 50),
      chromaP95: percentileSorted(sortedC, 95),
    },
    hue: circularStats(hueAngles, hueWeights),
  };
}

// Directions of the blue and magenta primaries on a BT.709 Cb/Cr plane. A
// cast is decomposed onto these two (non-orthogonal) axes — the same two
// axes Lumetri exposes as Temperature (blue↔yellow) and Tint (green↔magenta).
const BLUE = (() => { const y = REC709.kb; return [(1 - y) / (2 * (1 - REC709.kb)), (0 - y) / (2 * (1 - REC709.kr))]; })();
const MAGENTA = (() => { const y = REC709.kr + REC709.kb; return [(1 - y) / (2 * (1 - REC709.kb)), (1 - y) / (2 * (1 - REC709.kr))]; })();

/**
 * Decompose a Cb/Cr offset into { blueYellow, magentaGreen }.
 * blueYellow > 0: frame leans blue (cool). magentaGreen > 0: leans magenta.
 * Units are Cb/Cr distance — NOT Lumetri slider units. The mapping to slider
 * units is measured closed-loop at apply time (recommend/solver.js).
 */
export function castAxes(cb, cr) {
  const [a1, a2] = BLUE, [b1, b2] = MAGENTA;
  const det = a1 * b2 - a2 * b1;
  const blue = (cb * b2 - cr * b1) / det;
  const mag = (a1 * cr - a2 * cb) / det;
  // Normalise so a pure primary at unit chroma reads ~1.
  return {
    blueYellow: blue * Math.hypot(a1, a2),
    magentaGreen: mag * Math.hypot(b1, b2),
  };
}
