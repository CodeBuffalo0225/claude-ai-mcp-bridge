// ============================================================================
//  Warmth assessment — is this shot too warm (or cool), or is the scene just
//  warm-coloured?
//
//  Why this exists: the neutral-pixel white-balance estimate is biased in
//  exactly the case that matters. In a warm image, truly neutral objects
//  render warm, rise above the near-neutral saturation cutoff and drop out of
//  the sample; what remains reads "almost neutral". (Found live 2026-11-14 on
//  a tungsten cabin interview: neutral-pixel cast -0.003, yet an editor
//  correctly judged it too warm.)
//
//  Independent cues, all measured:
//   1. Tonal-range casts — low-chroma pixels in shadows / mids / highlights
//      (by luma rank, so no saturation gate decides WHICH pixels exist).
//      A lighting cast shifts every range the same way; warm OBJECTS sit in
//      one range.
//   2. Skin — reliable faces vs the ~123° skin line (diagnostic only). An
//      orange-red light pulls skin toward red (<123°); a yellow cast toward
//      yellow (>123°).
//   3. Warm dominance — share of all chroma that is red→yellow (95–185°).
//  Verdict needs a consistent cast AND skin or dominance agreeing. Warm scene
//  + neutral skin = warm CONTENT, not corrected.
//  Thresholds are diagnostic, calibrated on: tungsten cabin (warm), overcast
//  ceremony (neutral), autumn-woods daylight (warm content, skin on line).
// ============================================================================

import { vectorscope } from './color-math.js';
import { castAxes, CLIP_HIGH } from './frame-stats.js';

export const WARMTH_THRESHOLDS = Object.freeze({
  midsCastMin: 0.015,     // |blue↔yellow| on mids low-chroma pixels
  slightMax: 0.035,       // above → "warm"/"cool" rather than "slightly_…"
  skinRedDeg: -4,         // skin pulled toward red beyond this
  skinYellowDeg: 6,       // skin pulled toward yellow beyond this
  dominance: 0.9,         // warm share of chroma
});

const RANGES = { shadows: [0.02, 0.25, 0.08], mids: [0.25, 0.75, 0.08], highlights: [0.97, 1, 0.12] };

/**
 * Per-tonal-range cast on low-chroma pixels + warm dominance.
 * Pass `selection` (returned by a previous call on the BEFORE image) to
 * measure an AFTER image on the very same pixels — otherwise a correction
 * that desaturates warm objects moves them into the low-chroma sample and
 * the metric reads warmer although the image got cooler (seen live).
 */
export function measureTonalCasts(img, { step = 2, selection } = {}) {
  const { width, height, data } = img;
  if (selection) return measureOnSelection(img, selection);
  const px = [];
  let warmW = 0, allW = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const mx = Math.max(r, g, b);
      if (mx >= CLIP_HIGH || mx <= 2 / 255) continue;
      const v = vectorscope(r, g, b);
      v.p = y * width + x;
      px.push(v);
      allW += v.chroma;
      if (v.angle >= 95 && v.angle <= 185) warmW += v.chroma;
    }
  }
  if (!px.length) throw new Error('no usable pixels for warmth measurement');
  px.sort((a, b) => a.y - b.y);
  const n = px.length;
  const casts = {};
  const picked = {};
  for (const [name, [lo, hi, maxC]] of Object.entries(RANGES)) {
    const seg = px.slice(Math.floor(lo * n), Math.max(Math.floor(lo * n) + 1, Math.floor(hi * n)));
    let sel = seg.filter((p) => p.chroma < maxC);
    const lowEvidence = sel.length < seg.length * 0.05;
    if (lowEvidence) sel = seg;
    picked[name] = { pixels: Int32Array.from(sel.map((p) => p.p)), lumaRange: [round(seg[0].y, 3), round(seg[seg.length - 1].y, 3)], lowEvidence, sampleFraction: round(sel.length / seg.length, 3) };
    casts[name] = castOf(sel, picked[name]);
  }
  return { casts, dominance: round(allW ? warmW / allW : 0, 3), selection: picked };
}

function castOf(sel, meta) {
  const cb = sel.reduce((a, p) => a + p.cb, 0) / sel.length;
  const cr = sel.reduce((a, p) => a + p.cr, 0) / sel.length;
  const ax = castAxes(cb, cr);
  return { blueYellow: round(ax.blueYellow), magentaGreen: round(ax.magentaGreen), cb: round(cb), cr: round(cr), lumaRange: meta.lumaRange, sampleFraction: meta.sampleFraction, lowEvidence: meta.lowEvidence };
}

function measureOnSelection(img, selection) {
  const casts = {};
  let warmW = 0, allW = 0;
  for (let i = 0; i < img.data.length; i += 6) {
    const v = vectorscope(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
    allW += v.chroma; if (v.angle >= 95 && v.angle <= 185) warmW += v.chroma;
  }
  for (const [name, s] of Object.entries(selection)) {
    const sel = Array.from(s.pixels, (p) => { const i = p * 3; return vectorscope(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255); });
    casts[name] = castOf(sel, s);
  }
  return { casts, dominance: round(allW ? warmW / allW : 0, 3), selection };
}

/**
 * Pure verdict from measurements.
 * @param m   { casts, dominance } from measureTonalCasts
 * @param skin [{ skinLineDeviationDeg }] reliable faces only
 */
export function assessWarmth(m, skin = [], T = WARMTH_THRESHOLDS) {
  const { casts, dominance } = m;
  const by = ['shadows', 'mids', 'highlights'].map((k) => casts[k].blueYellow);
  const warmRanges = by.filter((v) => v < -0.004).length;
  const coolRanges = by.filter((v) => v > 0.004).length;
  const mids = casts.mids.blueYellow;
  const consistentWarm = warmRanges >= 2 && mids <= -T.midsCastMin;
  const consistentCool = coolRanges >= 2 && mids >= T.midsCastMin;
  const devs = skin.map((s) => s.skinLineDeviationDeg).filter((d) => Number.isFinite(d));
  const meanDev = devs.length ? devs.reduce((a, d) => a + d, 0) / devs.length : null;
  const skinWarm = meanDev !== null && (meanDev <= T.skinRedDeg || meanDev >= T.skinYellowDeg);
  const domWarm = dominance >= T.dominance;
  const cues = {
    consistentWarmCast: consistentWarm, consistentCoolCast: consistentCool,
    skinShifted: skinWarm, skinMeanDeviationDeg: meanDev === null ? null : round(meanDev, 1),
    warmDominance: dominance, warmDominant: domWarm,
  };
  let verdict = 'neutral';
  if (consistentWarm && (skinWarm || domWarm)) verdict = Math.abs(mids) <= T.slightMax ? 'slightly_warm' : 'warm';
  else if (consistentWarm) verdict = 'warm_content';
  else if (consistentCool && (skinWarm === false)) verdict = Math.abs(mids) <= T.slightMax ? 'slightly_cool' : 'cool';
  const reasons = [];
  if (consistentWarm) reasons.push(`warm cast in ${warmRanges}/3 tonal ranges (mids blue↔yellow ${mids})`);
  if (skinWarm) reasons.push(`skin ${meanDev.toFixed(1)}° off the skin line (${meanDev < 0 ? 'toward red' : 'toward yellow'})`);
  if (domWarm) reasons.push(`${Math.round(dominance * 100)}% of all colour is red→yellow`);
  if (verdict === 'warm_content') reasons.push('scene is warm-coloured but skin sits on the line and warm share is not extreme → treated as content, not a cast');
  return {
    verdict,
    correct: verdict === 'slightly_warm' || verdict === 'warm' || verdict === 'slightly_cool' || verdict === 'cool',
    cues,
    casts,
    reasons,
    note: 'Cues are measured; thresholds are diagnostic (WARMTH_THRESHOLDS). The verdict says how far, the editor decides how much (strength).',
  };
}

function round(x, d = 4) { return Math.round(x * 10 ** d) / 10 ** d; }
