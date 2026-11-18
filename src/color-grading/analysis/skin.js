// ============================================================================
//  Skin isolation — turns a FACE DETECTION into a SKIN SAMPLE.
//
//  A face bounding box is not a skin mask. It contains eyes, lips, brows,
//  beard, hair, glasses and background corners. This module:
//    1. builds a face region from landmarks (contour, closed over the
//       forehead), falling back to an inner ellipse of the bbox when
//       landmarks are missing (with a confidence penalty);
//    2. cuts out lips, eyes, pupils and eyebrows (dilated);
//    3. applies an ADAPTIVE chroma/luma qualifier centred on THIS face's own
//       robust median — so every complexion is measured against itself,
//       never pulled toward one hue or brightness;
//    4. reports confidence and the reasons behind it.
//
//  `qualifierLeakage` then answers the question an editor-side HSL key or hue
//  curve raises: if this skin qualifier were applied to the whole frame (no
//  spatial mask), how much of what it selects is NOT skin? (blaze orange,
//  deer hide, tan camo, wood.)
// ============================================================================

import { vectorscope, angleDiff, circularStats, median, percentileSorted, rgbToHsv, SKIN_LINE_DEG, REC709 } from './color-math.js';
import { CLIP_HIGH } from './frame-stats.js';

const MIN_RELIABLE_PIXELS = 400;
const MIN_RELIABLE_CONFIDENCE = 0.5;

// ── geometry ────────────────────────────────────────────────────────────

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Grow a polygon outward from its centroid by `margin` pixels. */
export function dilatePolygon(poly, margin) {
  if (!poly || poly.length < 3) return poly;
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x + (dx / d) * margin, y + (dy / d) * margin];
  });
}

function ellipsePolygon(cx, cy, rx, ry, n = 32) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

/**
 * Face region + exclusion polygons, in the coordinates of `img` (detector
 * coords are multiplied by `scale`).
 */
export function faceGeometry(face, scale = 1) {
  const s = (pts) => pts && pts.map(([x, y]) => [x * scale, y * scale]);
  const bb = { x: face.bbox.x * scale, y: face.bbox.y * scale, w: face.bbox.w * scale, h: face.bbox.h * scale };
  const R = face.regions || {};
  const contour = s(R.faceContour);
  const reasons = [];
  let region;
  let geometry;

  if (contour && contour.length >= 5) {
    // faceContour runs cheek → chin → cheek. Close it over the forehead at
    // the brow line raised by a fraction of the face height. Hair that falls
    // inside is rejected later by the chroma/luma qualifier.
    const brows = [...(s(R.leftEyebrow) || []), ...(s(R.rightEyebrow) || [])];
    const browTop = brows.length ? Math.min(...brows.map((p) => p[1])) : bb.y + bb.h * 0.25;
    const top = Math.max(bb.y, browTop - bb.h * 0.12);
    const first = contour[0], last = contour[contour.length - 1];
    region = [...contour, [last[0], top], [first[0], top]];
    geometry = 'landmarks';
  } else {
    region = ellipsePolygon(bb.x + bb.w / 2, bb.y + bb.h * 0.55, bb.w * 0.33, bb.h * 0.4);
    geometry = 'bbox_ellipse';
    reasons.push('no landmarks: using an inner ellipse of the face box (less precise)');
  }

  const m = bb.h;
  const exclusions = [];
  const ex = (pts, margin, name) => { if (pts && pts.length >= 3) exclusions.push({ name, poly: dilatePolygon(pts, margin) }); };
  ex(s(R.outerLips), m * 0.035, 'lips');
  ex(s(R.leftEye), m * 0.04, 'leftEye');
  ex(s(R.rightEye), m * 0.04, 'rightEye');
  ex(s(R.leftEyebrow), m * 0.025, 'leftEyebrow');
  ex(s(R.rightEyebrow), m * 0.025, 'rightEyebrow');
  if (geometry === 'landmarks' && !exclusions.some((e) => e.name === 'lips')) reasons.push('lips landmark missing: lips not excluded');

  return { region, exclusions, bbox: bb, geometry, reasons };
}

// ── skin sample ─────────────────────────────────────────────────────────

/**
 * @param img     decoded RGB image
 * @param face    detector face { bbox, regions, confidence, landmarksConfidence }
 * @param opts    { scale } detector→img scale (img.scale from decodeRGB)
 * @returns { mask: Uint8Array (1 = skin), stats, qualifier, confidence, reliable, reasons }
 */
export function isolateSkin(img, face, { scale = img.scale ?? 1, matrix = REC709 } = {}) {
  const { width, height, data } = img;
  const geo = faceGeometry(face, scale);
  const reasons = [...geo.reasons];
  const x0 = Math.max(0, Math.floor(geo.bbox.x - geo.bbox.w * 0.1));
  const x1 = Math.min(width - 1, Math.ceil(geo.bbox.x + geo.bbox.w * 1.1));
  const y0 = Math.max(0, Math.floor(geo.bbox.y - geo.bbox.h * 0.2));
  const y1 = Math.min(height - 1, Math.ceil(geo.bbox.y + geo.bbox.h * 1.1));

  // Pass 1: geometric candidates.
  const cand = [];
  let excludedByFeatures = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInPolygon(x + 0.5, y + 0.5, geo.region)) continue;
      if (geo.exclusions.some((e) => pointInPolygon(x + 0.5, y + 0.5, e.poly))) { excludedByFeatures++; continue; }
      cand.push(y * width + x);
    }
  }
  const mask = new Uint8Array(width * height);
  if (cand.length < 20) {
    return finalize({ mask, kept: [], cand, reasons: [...reasons, 'face too small in frame to sample skin'], face, geo, excludedByFeatures });
  }

  // Pass 2: this face's own robust centre (median Y, circular-mean angle,
  // median chroma), from candidates that are coloured and not clipped.
  const info = cand.map((p) => {
    const i = p * 3;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const v = vectorscope(r, g, b, matrix);
    v.hsv = rgbToHsv(r, g, b);
    v.clipped = Math.max(r, g, b) >= CLIP_HIGH;
    v.p = p;
    return v;
  });
  const coloured = info.filter((v) => v.chroma > 0.01 && !v.clipped);
  if (coloured.length < 20) {
    return finalize({ mask, kept: [], cand, reasons: [...reasons, 'face region has almost no chroma (B&W, clipped, or not skin)'], face, geo, excludedByFeatures });
  }
  const centreAngle = circularStats(coloured.map((v) => v.angle), coloured.map((v) => v.chroma)).mean;
  const mY = median(coloured.map((v) => v.y));
  const mC = median(coloured.map((v) => v.chroma));
  const angleDevs = coloured.map((v) => Math.abs(angleDiff(v.angle, centreAngle))).sort((a, b) => a - b);
  const mad = percentileSorted(Float64Array.from(angleDevs), 50);
  const qualifier = {
    angleCenter: centreAngle,
    angleHalfWidth: Math.min(35, Math.max(12, 2.5 * mad)),
    chromaMin: Math.max(0.01, 0.35 * mC),
    chromaMax: Math.min(0.5, 2.2 * mC),
    lumaMin: 0.35 * mY,
    lumaMax: Math.min(CLIP_HIGH, 1.9 * mY),
  };

  // Pass 3: keep only pixels that look like THIS face's skin.
  const kept = [];
  let clipped = 0;
  for (const v of info) {
    if (v.clipped) { clipped++; continue; }
    if (passesQualifier(v, qualifier)) { mask[v.p] = 1; kept.push(v); }
  }
  if (clipped / info.length > 0.05) reasons.push(`${(100 * clipped / info.length).toFixed(1)}% of the face is clipped — skin there is unrecoverable from this frame`);
  return finalize({ mask, kept, cand, reasons, face, geo, qualifier, excludedByFeatures, clippedFraction: clipped / info.length });
}

export function passesQualifier(v, q) {
  return (
    v.chroma >= q.chromaMin && v.chroma <= q.chromaMax &&
    v.y >= q.lumaMin && v.y <= q.lumaMax &&
    Math.abs(angleDiff(v.angle, q.angleCenter)) <= q.angleHalfWidth
  );
}

function finalize({ mask, kept, cand, reasons, face, geo, qualifier = null, excludedByFeatures, clippedFraction = 0 }) {
  const keptFraction = cand.length ? kept.length / cand.length : 0;
  let stats = null;
  if (kept.length) {
    const ys = Float64Array.from(kept.map((v) => v.y)).sort();
    const circ = circularStats(kept.map((v) => v.angle), kept.map((v) => v.chroma));
    // HSV hue band of this skin — the axis hue curves (Hue vs Sat/Hue/Luma)
    // are defined on. p5..p95 of the deviation from the circular mean.
    const hsvHues = kept.map((v) => v.hsv.h).filter((h) => !Number.isNaN(h));
    const hc = circularStats(hsvHues).mean;
    const devs = Float64Array.from(hsvHues.map((h) => angleDiff(h, hc))).sort();
    stats = {
      hsvHue: {
        center: hc,
        p5: percentileSorted(devs, 5) + hc,
        p95: percentileSorted(devs, 95) + hc,
        bandWidth: percentileSorted(devs, 95) - percentileSorted(devs, 5),
      },
      hsvSatP50: median(kept.map((v) => v.hsv.s)),
      pixels: kept.length,
      lumaP10: percentileSorted(ys, 10),
      lumaP50: percentileSorted(ys, 50),
      lumaP90: percentileSorted(ys, 90),
      vectorscopeAngle: circ.mean,
      angleSpread: circ.spread,
      chromaP50: median(kept.map((v) => v.chroma)),
      // Diagnostic only. Real skin of every complexion sits near — not on —
      // the I line; distance from centre (chroma) is what varies most.
      skinLineDeviationDeg: angleDiff(circ.mean, SKIN_LINE_DEG),
      clippedFraction,
    };
  }

  // Confidence = detector landmark confidence × how much of the region
  // survived the qualifier × sample size × hue coherence.
  const base = geo.geometry === 'landmarks'
    ? (typeof face.landmarksConfidence === 'number' ? face.landmarksConfidence : 0.6)
    : 0.4;
  const coverage = clamp((keptFraction - 0.2) / 0.4);
  const size = clamp(kept.length / MIN_RELIABLE_PIXELS);
  const coherence = stats ? clamp(1 - (stats.angleSpread - 15) / 30) : 0;
  const confidence = round(base * coverage * size * coherence, 3);
  if (keptFraction < 0.4 && cand.length) reasons.push(`only ${(100 * keptFraction).toFixed(0)}% of the face region passed the skin qualifier (beard, glasses, shadow, hair, or mixed light)`);
  if (kept.length && kept.length < MIN_RELIABLE_PIXELS) reasons.push(`small skin sample (${kept.length} px) — face is small in frame`);
  if (stats && stats.angleSpread > 25) reasons.push(`skin hue spread ${stats.angleSpread.toFixed(0)}° — mixed lighting across the face`);

  return {
    mask,
    geometry: geo.geometry,
    bbox: geo.bbox,
    excludedFeatures: geo.exclusions.map((e) => e.name),
    excludedFeaturePixels: excludedByFeatures,
    candidatePixels: cand.length,
    keptFraction: round(keptFraction, 3),
    qualifier,
    stats,
    confidence,
    reliable: confidence >= MIN_RELIABLE_CONFIDENCE && !!stats,
    reasons,
    manualFallback: confidence >= MIN_RELIABLE_CONFIDENCE ? null
      : 'Isolation is not reliable. In Premiere: add a second Lumetri, HSL Secondary → Set color eyedropper on clean cheek skin, tick "Color/Gray" to inspect the key, refine with Denoise/Blur, then re-run color_analyze_frames with {manualSkinConfirmed:true}. Or draw an ellipse mask on that Lumetri and Track Forward.',
  };
}

/**
 * If `qualifier` were applied to the whole frame with no spatial mask, what
 * fraction of the selected pixels would fall outside the face skin masks?
 */
export function qualifierLeakage(img, qualifier, skinMasks, { step = 2, matrix = REC709 } = {}) {
  const { width, height, data } = img;
  let inside = 0, outside = 0;
  const outsideAngles = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const p = y * width + x;
      const i = p * 3;
      const v = vectorscope(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, matrix);
      if (Math.max(data[i], data[i + 1], data[i + 2]) / 255 >= CLIP_HIGH) continue;
      if (!passesQualifier(v, qualifier)) continue;
      if (skinMasks.some((m) => m[p])) inside++;
      else { outside++; outsideAngles.push(v.angle); }
    }
  }
  const total = inside + outside;
  return {
    selectedSamples: total,
    insideSkin: inside,
    outsideSkin: outside,
    leakageFraction: total ? round(outside / total, 3) : 0,
    // Share of the whole frame the qualifier would touch outside faces.
    frameShareOutside: round(outside / Math.ceil(width / step) / Math.ceil(height / step), 4),
    outsideHueMean: outsideAngles.length ? round(circularStats(outsideAngles).mean, 1) : null,
  };
}

function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }
