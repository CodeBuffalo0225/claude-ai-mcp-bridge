// ============================================================================
//  Recommender — measurements in, proposed grade ops out. Pure: no editor
//  calls, no I/O. Every recommendation carries:
//    ops        editor-neutral grade ops (ops/grade-ops.js)
//    route      how it can be applied on THIS editor:
//                 'closed_loop'   scriptable Lumetri slider, solved by
//                                 re-measuring rendered frames
//                 'lut'           pixel op baked to .cube, loaded manually
//                 'manual_mask'   needs a mask/key drawn in the UI first,
//                                 then scriptable sliders on that instance
//                 'none'          analysis only / not advisable
//    evidence   the measured numbers that justify it
//    confidence 0..1, and reasons when it is low
//
//  What this file deliberately does NOT do: invent universal exposure
//  targets, fixed curve points or wheel values. Targets come from
//    (a) physics with evidence — a neutral surface should measure neutral
//        (only when near-neutral pixels were actually found),
//    (b) information loss — the grade should not clip/crush what the camera
//        captured (compared against the ungraded source frame when given),
//    (c) the editor's stated intent (amount, strength, lift), or
//    (d) a reference shot (matching).
// ============================================================================

import { designSCurve } from '../ops/transform.js';

// Measurement noise floor for a neutral cast, in Cb/Cr units. 0.004 ≈ one
// 8-bit code value of chroma: below this the "cast" is quantisation noise.
export const CAST_NOISE_FLOOR = 0.004;
// Clipping above this share of pixels is visible as blown areas; below it is
// typically specular glints, which should stay clipped.
export const CLIP_VISIBLE = 0.002;
// If more than this share of what a global skin key/curve selects is NOT a
// detected face, a global hue-curve skin fix will visibly hit the background.
export const LEAKAGE_LIMIT = 0.35;

export function reliableFaces(frame) {
  return (frame.faces || []).filter((f) => f.skin?.reliable);
}

/** Workflow step 4: primary correction (white balance + grade-induced clipping). */
export function recommendPrimary(frame, { preserveMood = false, sourceFrame = null } = {}) {
  const recs = [];
  const st = frame.stats;
  const wb = st.whiteBalance;

  if (preserveMood) {
    recs.push(info('wb', 'White balance left as shot (preserveMood)', { cast: wb.axes }));
  } else if (wb.confidence < 0.5) {
    recs.push(info('wb', 'White balance: not auto-corrected — too few near-neutral pixels to trust the cast estimate', { method: wb.method, neutralFraction: wb.sampleFraction },
      ['Pick a known neutral (white/grey) in Lumetri ▸ Basic ▸ White Balance selector, or give a reference shot to match.']));
  } else {
    const { blueYellow, magentaGreen } = wb.axes;
    if (Math.abs(blueYellow) > CAST_NOISE_FLOOR) {
      recs.push({
        id: 'wb.temperature',
        title: `Neutralise ${blueYellow > 0 ? 'blue (cool)' : 'yellow (warm)'} cast measured on near-neutral pixels`,
        ops: [{ op: 'lumetri', control: 'basic.temperature', value: 0, mode: 'delta' }],
        route: 'closed_loop',
        solve: { control: 'basic.temperature', metric: 'wb.blueYellow', target: 0, tolerance: CAST_NOISE_FLOOR, probeStep: blueYellow > 0 ? 5 : -5 },
        evidence: { blueYellow, method: wb.method, neutralFraction: wb.sampleFraction },
        confidence: wb.confidence,
      });
    }
    if (Math.abs(magentaGreen) > CAST_NOISE_FLOOR) {
      recs.push({
        id: 'wb.tint',
        title: `Neutralise ${magentaGreen > 0 ? 'magenta' : 'green'} cast measured on near-neutral pixels`,
        ops: [{ op: 'lumetri', control: 'basic.tint', value: 0, mode: 'delta' }],
        route: 'closed_loop',
        solve: { control: 'basic.tint', metric: 'wb.magentaGreen', target: 0, tolerance: CAST_NOISE_FLOOR, probeStep: magentaGreen > 0 ? -5 : 5 },
        evidence: { magentaGreen, method: wb.method, neutralFraction: wb.sampleFraction },
        confidence: wb.confidence,
      });
    }
    if (!recs.length) recs.push(info('wb', 'White balance already neutral within measurement noise', { cast: wb.axes }));
  }

  // Clipping/crushing: only correct what the GRADE introduced. With no
  // ungraded source frame we can't tell grade-clipping from camera-clipping,
  // so we recommend but flag it.
  const hiNow = st.clipping.highlightsAllChannels;
  const hiSrc = sourceFrame?.stats.clipping.highlightsAllChannels;
  if (hiNow > CLIP_VISIBLE) {
    const camera = hiSrc !== undefined && hiSrc >= hiNow * 0.8;
    recs.push(camera
      ? info('highlights', `Highlights clipped in camera (${pct(hiSrc)} of source frame) — not recoverable; Highlights/Whites can only soften the edge`, { gradedClip: hiNow, sourceClip: hiSrc })
      : {
        id: 'highlights.whites',
        title: `Recover highlights clipped by the grade (${pct(hiNow)} of pixels${hiSrc !== undefined ? ` vs ${pct(hiSrc)} in the source` : ''})`,
        ops: [{ op: 'lumetri', control: 'basic.whites', value: 0, mode: 'delta' }],
        route: 'closed_loop',
        solve: { control: 'basic.whites', metric: 'clip.highlights', target: Math.max(hiSrc ?? 0, CLIP_VISIBLE / 2), tolerance: CLIP_VISIBLE / 2, probeStep: -5 },
        evidence: { gradedClip: hiNow, sourceClip: hiSrc ?? 'unknown (no source frame given)' },
        confidence: hiSrc !== undefined ? 0.9 : 0.6,
      });
  }
  const loNow = st.clipping.shadows;
  const loSrc = sourceFrame?.stats.clipping.shadows;
  if (loNow > CLIP_VISIBLE && !(loSrc !== undefined && loSrc >= loNow * 0.8)) {
    recs.push({
      id: 'shadows.blacks',
      title: `Lift shadows crushed by the grade (${pct(loNow)} of pixels${loSrc !== undefined ? ` vs ${pct(loSrc)} in the source` : ''})`,
      ops: [{ op: 'lumetri', control: 'basic.blacks', value: 0, mode: 'delta' }],
      route: 'closed_loop',
      solve: { control: 'basic.blacks', metric: 'clip.shadows', target: Math.max(loSrc ?? 0, CLIP_VISIBLE / 2), tolerance: CLIP_VISIBLE / 2, probeStep: 5 },
      evidence: { gradedCrush: loNow, sourceCrush: loSrc ?? 'unknown' },
      confidence: loSrc !== undefined ? 0.9 : 0.6,
    });
  }

  // Subject exposure is reported, not "fixed": there is no universal right
  // face brightness. Intent or a reference shot sets it (faceLift / match).
  const faces = reliableFaces(frame);
  const subject = faces.length ? {
    faces: faces.map((f, i) => ({ face: i, skinLumaP50: f.skin.stats.lumaP50, skinLumaP90: f.skin.stats.lumaP90 })),
    sceneLumaP50: st.luma.p50,
    note: 'Reported for judgement. To brighten a face, use a face lift (masked) with an amount, or match to a reference shot.',
  } : { note: 'No reliable face — subject exposure not assessed.' };

  return { step: 'primary', recommendations: recs, subjectExposure: subject, skinBaseline: skinBaseline(frame) };
}

/** Skin values captured before a change, to check "natural skin preserved" after it. */
export function skinBaseline(frame) {
  return reliableFaces(frame).map((f, i) => ({
    face: i, lumaP50: f.skin.stats.lumaP50, chromaP50: f.skin.stats.chromaP50, vectorscopeAngle: f.skin.stats.vectorscopeAngle,
  }));
}

/**
 * Compare skin after a change to its baseline. Budgets are change limits for
 * a step whose PURPOSE was not to change skin (e.g. a WB fix): big movement
 * means the step altered complexion as a side effect — flag for review.
 */
export function skinChangeReport(before, afterFrame, { maxAngleShiftDeg = 6, maxChromaChange = 0.2, maxLumaChange = 0.12 } = {}) {
  const after = skinBaseline(afterFrame);
  return before.map((b) => {
    const a = after.find((x) => x.face === b.face);
    if (!a) return { face: b.face, error: 'face not reliably isolated after the change' };
    const dAngle = ((a.vectorscopeAngle - b.vectorscopeAngle + 540) % 360) - 180;
    const dChroma = (a.chromaP50 - b.chromaP50) / b.chromaP50;
    const dLuma = (a.lumaP50 - b.lumaP50) / b.lumaP50;
    const flags = [];
    if (Math.abs(dAngle) > maxAngleShiftDeg) flags.push(`skin hue moved ${dAngle.toFixed(1)}°`);
    if (Math.abs(dChroma) > maxChromaChange) flags.push(`skin saturation changed ${(100 * dChroma).toFixed(0)}%`);
    if (Math.abs(dLuma) > maxLumaChange) flags.push(`skin brightness changed ${(100 * dLuma).toFixed(0)}%`);
    return { face: b.face, angleShiftDeg: r(dAngle, 1), chromaChange: r(dChroma), lumaChange: r(dLuma), natural: flags.length === 0, flags };
  });
}

/** Workflow step 6: optional gentle S-curve designed from this frame. */
export function recommendSCurve(frame, { strength = 0.35 } = {}) {
  const faces = reliableFaces(frame);
  const pivot = faces.length
    ? faces.reduce((a, f) => a + f.skin.stats.lumaP50, 0) / faces.length
    : frame.stats.luma.p50;
  const design = designSCurve({ pivot, strength, lumaP1: frame.stats.luma.p1, lumaP99: frame.stats.luma.p99 });
  if (!design.points) return { step: 'curves', recommendations: [info('scurve', 'S-curve not advised for this frame', design, design.reasons)] };
  return {
    step: 'curves',
    recommendations: [{
      id: 'scurve.master',
      title: `Gentle master S-curve pivoting at ${faces.length ? 'skin' : 'scene'} median (${pivot.toFixed(3)})${design.reduced ? ` — strength reduced ${design.requestedStrength}→${design.strength} to protect shadows/highlights` : ''}`,
      ops: [{ op: 'curve', channel: 'master', points: design.points }],
      route: 'lut',
      evidence: design.evidence,
      confidence: 1,
      note: 'Master curve only. Per-channel curves are for cast correction, not contrast — not applied here.',
    }],
  };
}

/**
 * Hue-vs-Sat on one face's measured skin band. Leakage decides the route:
 * low leakage → a global hue curve (LUT) is safe; high → it must be masked.
 * @param footprint optional { insideFaces, outsideFaces } from measureOpFootprint
 */
export function recommendSkinSaturation(frame, { faceIndex = 0, amount = -0.15, footprint } = {}) {
  const face = (frame.faces || [])[faceIndex];
  if (!face?.skin?.stats) return { step: 'skin', recommendations: [info('skinSat', `Face ${faceIndex} not isolated — cannot target its skin hue`, null, face?.skin?.reasons || ['no face'])] };
  const hb = face.skin.stats.hsvHue;
  const width = Math.min(90, Math.max(30, hb.bandWidth * 1.6 + 20));
  const op = { op: 'hueVsSat', center: r(((hb.center % 360) + 360) % 360, 1), width: r(width, 1), amount };
  const leak = footprint ? footprint.outsideShare : face.skin.leakage?.leakageFraction;
  const safeGlobal = typeof leak === 'number' && leak <= LEAKAGE_LIMIT;
  const rec = {
    id: 'skin.hueVsSat',
    title: `${amount < 0 ? 'Reduce' : 'Increase'} saturation ${Math.abs(amount * 100).toFixed(0)}% on face ${faceIndex}'s skin hue band (HSV ${op.center}° ± ${(width / 2).toFixed(0)}°)`,
    ops: safeGlobal ? [op] : [{ op: 'secondary', mask: { kind: 'skin', faceIndex, featherPx: 10 }, ops: [op] }],
    route: safeGlobal ? 'lut' : 'manual_mask',
    evidence: { skinHueBand: hb, leakage: face.skin.leakage, footprint: footprint || null, skinConfidence: face.skin.confidence },
    confidence: face.skin.confidence,
    reasons: face.skin.reliable ? [] : face.skin.reasons,
  };
  if (!safeGlobal) {
    rec.manual = [
      'A global hue curve would also change ' + (typeof leak === 'number' ? `${(100 * leak).toFixed(0)}% of matching pixels outside the face` : 'unmeasured background areas') +
        (face.skin.leakage?.outsideHueMean != null ? ` (mostly around vectorscope ${face.skin.leakage.outsideHueMean}°: wood, leaves, blaze orange, hands/neck)` : '') + '.',
      'In Premiere: add a second Lumetri on the clip → HSL Secondary → Set color eyedropper on the cheek → refine with Denoise/Blur → (optionally) draw an ellipse mask on that Lumetri and Track Forward.',
      `Then run color_apply with control hsl.saturation (≈ ${Math.round(100 * (1 + amount))}) on instance 1 and secondaryKeyConfirmed:true; the tool verifies isolation from re-exported frames.`,
    ];
  }
  return { step: 'skin', recommendations: [rec] };
}

/**
 * Masked midtone lift on one face (track). Premiere can't script masks, so
 * the route is manual_mask + closed-loop Exposure on the masked instance,
 * solved against THIS face's measured skin luma.
 */
export function recommendFaceLift(frame, { faceIndex = 0, lift = 0.06, instance = 1 } = {}) {
  const face = (frame.faces || [])[faceIndex];
  if (!face?.skin?.stats) return { step: 'faceLift', recommendations: [info('faceLift', `Face ${faceIndex} not isolated`, null, face?.skin?.reasons || ['no face'])] };
  const base = face.skin.stats.lumaP50;
  const target = Math.min(base * (1 + lift), face.skin.stats.lumaP90 > 0.9 ? base : 0.95);
  const midLift = [[0, 0], [0.25, 0.25 + lift * 0.25], [0.5, Math.min(0.95, 0.5 + lift * 0.5)], [0.85, Math.min(0.97, 0.85 + lift * 0.1)], [1, 1]];
  return {
    step: 'faceLift',
    recommendations: [{
      id: 'face.midtoneLift',
      title: `Lift face ${faceIndex} midtones ${(lift * 100).toFixed(0)}% (skin luma ${base.toFixed(3)} → ${target.toFixed(3)}) inside a tracked mask`,
      ops: [{ op: 'secondary', mask: { kind: 'faceTrack', faceIndex, featherPx: Math.round(face.bbox.w * 0.08) }, ops: [{ op: 'curve', channel: 'master', points: midLift }] }],
      route: 'manual_mask',
      solve: { control: 'basic.exposure', instance, metric: `skin.${faceIndex}.lumaP50`, target, tolerance: Math.max(0.004, base * 0.01), probeStep: 0.1, bounds: [-1, 1] },
      evidence: { skinLumaP50: base, skinLumaP90: face.skin.stats.lumaP90, skinConfidence: face.skin.confidence },
      confidence: face.skin.confidence,
      manual: [
        `Premiere: duplicate the clip's grade into a SECOND Lumetri (instance ${instance}) → in Effect Controls draw an ellipse mask over face ${faceIndex} (feather ~${Math.round(face.bbox.w * 0.08)} px) → Track Forward.`,
        'Then run color_face_lift with confirmMaskTracked:true — the tool solves Exposure on that instance against measured skin luma and checks the background did not move.',
        'Midtone wheel luma is not scriptable on this Premiere build; Exposure on a masked instance is the scriptable substitute. The engine preview uses a true midtone curve.',
      ],
    }],
  };
}

/**
 * Shot matching (step 7): targets are the REFERENCE shot's measurements.
 * Skin is matched only between faces the caller says are the same person —
 * different people are never pushed toward one complexion.
 * @param pairs [{ refFace, targetFace }] same-person face pairs (optional)
 */
export function recommendMatch(reference, target, { pairs = [], matchWhiteBalance = true } = {}) {
  const recs = [];
  const spread = (f) => f.stats.luma.p95 - f.stats.luma.p5;
  const ev = { referenceSpread: spread(reference), targetSpread: spread(target) };
  const validPairs = pairs.filter((p) => reference.faces?.[p.refFace]?.skin?.reliable && target.faces?.[p.targetFace]?.skin?.reliable);
  const skipped = pairs.filter((p) => !validPairs.includes(p)).map((p) => ({ ...p, reason: 'one side not reliably isolated' }));

  if (matchWhiteBalance && reference.stats.whiteBalance.confidence >= 0.5 && target.stats.whiteBalance.confidence >= 0.5) {
    const d = target.stats.whiteBalance.axes.blueYellow - reference.stats.whiteBalance.axes.blueYellow;
    if (Math.abs(d) > CAST_NOISE_FLOOR) recs.push({ id: 'match.temperature', title: 'Match neutral balance (blue↔yellow) to reference', ops: [], route: 'closed_loop', solve: { control: 'basic.temperature', metric: 'wb.blueYellow', target: reference.stats.whiteBalance.axes.blueYellow, tolerance: CAST_NOISE_FLOOR, probeStep: d > 0 ? 5 : -5 }, evidence: { delta: d }, confidence: Math.min(reference.stats.whiteBalance.confidence, target.stats.whiteBalance.confidence) });
    const t = target.stats.whiteBalance.axes.magentaGreen - reference.stats.whiteBalance.axes.magentaGreen;
    if (Math.abs(t) > CAST_NOISE_FLOOR) recs.push({ id: 'match.tint', title: 'Match neutral balance (green↔magenta) to reference', ops: [], route: 'closed_loop', solve: { control: 'basic.tint', metric: 'wb.magentaGreen', target: reference.stats.whiteBalance.axes.magentaGreen, tolerance: CAST_NOISE_FLOOR, probeStep: t > 0 ? -5 : 5 }, evidence: { delta: t }, confidence: 0.8 });
  }
  for (const p of validPairs) {
    const rs = reference.faces[p.refFace].skin.stats, ts = target.faces[p.targetFace].skin.stats;
    recs.push({ id: `match.skinLuma.${p.targetFace}`, title: `Match skin brightness of face ${p.targetFace} to reference face ${p.refFace}`, ops: [], route: 'closed_loop', solve: { control: 'basic.exposure', metric: `skin.${p.targetFace}.lumaP50`, target: rs.lumaP50, tolerance: Math.max(0.004, rs.lumaP50 * 0.015), probeStep: ts.lumaP50 < rs.lumaP50 ? 0.1 : -0.1, bounds: [-2, 2] }, evidence: { reference: rs.lumaP50, target: ts.lumaP50 }, confidence: Math.min(reference.faces[p.refFace].skin.confidence, target.faces[p.targetFace].skin.confidence) });
    recs.push({ id: `match.skinChroma.${p.targetFace}`, title: `Match skin saturation of face ${p.targetFace} (global Saturation — affects the whole shot)`, ops: [], route: 'closed_loop', solve: { control: 'basic.saturation', metric: `skin.${p.targetFace}.chromaP50`, target: rs.chromaP50, tolerance: rs.chromaP50 * 0.03, probeStep: ts.chromaP50 < rs.chromaP50 ? 5 : -5, bounds: [50, 150] }, evidence: { reference: rs.chromaP50, target: ts.chromaP50 }, confidence: 0.7 });
    const dAng = ((ts.vectorscopeAngle - rs.vectorscopeAngle + 540) % 360) - 180;
    if (Math.abs(dAng) > 4) recs.push(info(`match.skinHue.${p.targetFace}`, `Same person's skin hue still differs by ${dAng.toFixed(1)}° — after WB matching, correct with a masked Hue vs Hue (LUT/secondary), not with global Tint`, { refAngle: rs.vectorscopeAngle, targetAngle: ts.vectorscopeAngle }));
  }
  if (Math.abs(ev.targetSpread - ev.referenceSpread) > 0.02) {
    recs.push({ id: 'match.contrast', title: 'Match tonal spread (p5–p95) to reference', ops: [], route: 'closed_loop', solve: { control: 'basic.contrast', metric: 'luma.spread', target: ev.referenceSpread, tolerance: 0.01, probeStep: ev.targetSpread < ev.referenceSpread ? 8 : -8 }, evidence: ev, confidence: 0.8 });
  }
  return { step: 'match', recommendations: recs, skippedPairs: skipped, order: 'white balance → skin brightness → skin saturation → contrast (each re-measured before the next)' };
}

// Metric extractor shared by the closed loop and validation.
export function metricOf(frame, metric) {
  if (metric === 'wb.blueYellow') return frame.stats.whiteBalance.axes.blueYellow;
  if (metric === 'wb.magentaGreen') return frame.stats.whiteBalance.axes.magentaGreen;
  if (metric === 'clip.highlights') return frame.stats.clipping.highlightsAllChannels;
  if (metric === 'clip.shadows') return frame.stats.clipping.shadows;
  if (metric === 'luma.spread') return frame.stats.luma.p95 - frame.stats.luma.p5;
  if (metric === 'luma.p50') return frame.stats.luma.p50;
  const m = metric.match(/^skin\.(\d+)\.(lumaP50|chromaP50|vectorscopeAngle)$/);
  if (m) {
    const s = frame.faces?.[Number(m[1])]?.skin?.stats;
    if (!s) throw new Error(`face ${m[1]} not isolated in this frame — cannot measure ${metric}`);
    return s[m[2]];
  }
  throw new Error(`unknown metric ${metric}`);
}

function info(id, title, evidence, reasons = []) { return { id, title, ops: [], route: 'none', evidence, confidence: null, reasons }; }
function pct(x) { return `${(100 * x).toFixed(2)}%`; }
function r(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }
