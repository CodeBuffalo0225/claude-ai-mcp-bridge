// ============================================================================
//  Frame analyzer — workflow steps 3 and 5 for a set of frames:
//  global scopes + per-face skin isolation + qualifier leakage + tracks.
//  Returns plain JSON (masks stay internal unless keepMasks is set).
// ============================================================================

import { decodeRGB } from './image-io.js';
import { computeFrameStats } from './frame-stats.js';
import { detectFaces } from './face-detect.js';
import { isolateSkin, qualifierLeakage } from './skin.js';
import { trackFaces } from './face-track.js';
import { measureTonalCasts, assessWarmth } from './warmth.js';

const ANALYSIS_MAX_WIDTH = 1920;

/**
 * @param frames [{ path, label?, time? }]
 * @param opts { detect=true, detections? (precomputed detector output), keepMasks=false }
 */
export async function analyzeFrames(frames, { detect = true, detections, keepMasks = false, maxWidth = ANALYSIS_MAX_WIDTH } = {}) {
  let det = detections || null;
  if (!det && detect) det = await detectFaces(frames.map((f) => f.path));
  const faceDetection = !detect
    ? { ran: false, reason: 'detection disabled by caller' }
    : det.available
      ? { ran: true, engine: det.engine, os: det.os }
      : { ran: false, reason: det.reason };

  const results = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const img = await decodeRGB(f.path, { maxWidth });
    const stats = computeFrameStats(img);
    const detImg = det?.available ? det.images[i] : null;
    const faces = [];
    const masks = [];
    if (detImg?.error) faces.push({ error: detImg.error });
    for (const face of detImg?.faces || []) {
      const skin = isolateSkin(img, face, { scale: img.scale });
      masks.push(skin.mask);
      faces.push({
        detectorConfidence: face.confidence,
        landmarksConfidence: face.landmarksConfidence ?? null,
        bbox: face.bbox,
        roll: face.roll ?? null,
        yaw: face.yaw ?? null,
        skin: { ...skin, mask: keepMasks ? skin.mask : undefined },
      });
    }
    // Leakage: per face, how much of the frame its skin qualifier would grab
    // outside every detected face.
    for (const fc of faces) {
      if (fc.skin?.qualifier) fc.skin.leakage = qualifierLeakage(img, fc.skin.qualifier, masks);
    }
    const tonal = measureTonalCasts(img);
    stats.warmth = { casts: tonal.casts, dominance: tonal.dominance };
    const warmth = assessWarmth(tonal, faces.filter((fc) => fc.skin?.reliable).map((fc) => fc.skin.stats));
    results.push({
      label: f.label || `frame${i}`,
      path: f.path,
      time: f.time ?? null,
      size: { width: img.source.width, height: img.source.height, analysedWidth: img.width },
      stats,
      warmth,
      faces,
      _img: keepMasks ? img : undefined,
    });
  }

  const tracks = det?.available && frames.length > 1
    ? trackFaces(results.map((r) => ({ time: r.time, faces: r.faces.filter((x) => x.bbox) })))
    : [];

  return { faceDetection, frames: results, tracks };
}

/** JSON-safe summary (drops histograms + masks) for tool responses. */
export function summarizeAnalysis(a) {
  return {
    faceDetection: a.faceDetection,
    frames: a.frames.map((f) => ({
      label: f.label, time: f.time, size: f.size,
      exposure: f.stats.luma && { p1: r(f.stats.luma.p1), p50: r(f.stats.luma.p50), p99: r(f.stats.luma.p99) },
      clipping: mapR(f.stats.clipping, 4),
      whiteBalance: { method: f.stats.whiteBalance.method, confidence: r(f.stats.whiteBalance.confidence), ...mapR(f.stats.whiteBalance.axes, 4) },
      saturation: mapR(f.stats.saturation),
      warmth: f.warmth && { verdict: f.warmth.verdict, reasons: f.warmth.reasons, cues: f.warmth.cues, casts: Object.fromEntries(Object.entries(f.warmth.casts).map(([k, v]) => [k, { blueYellow: v.blueYellow, magentaGreen: v.magentaGreen, lowEvidence: v.lowEvidence }])) },
      faces: f.faces.map((fc) => fc.error ? fc : ({
        bbox: mapR(fc.bbox, 0),
        landmarksConfidence: fc.landmarksConfidence && r(fc.landmarksConfidence),
        skinConfidence: fc.skin.confidence,
        reliable: fc.skin.reliable,
        geometry: fc.skin.geometry,
        excluded: fc.skin.excludedFeatures,
        keptFraction: fc.skin.keptFraction,
        skin: fc.skin.stats && {
          lumaP50: r(fc.skin.stats.lumaP50), vectorscopeAngle: r(fc.skin.stats.vectorscopeAngle, 1),
          skinLineDeviationDeg: r(fc.skin.stats.skinLineDeviationDeg, 1), chromaP50: r(fc.skin.stats.chromaP50, 4),
          angleSpread: r(fc.skin.stats.angleSpread, 1), pixels: fc.skin.stats.pixels,
        },
        leakage: fc.skin.leakage,
        reasons: fc.skin.reasons,
        manualFallback: fc.skin.manualFallback,
      })),
    })),
    tracks: a.tracks.map((t) => ({ id: t.id, samples: t.samples.length, coverage: t.coverage, stable: t.stable, sizeJitter: t.sizeJitter, reasons: t.reasons })),
  };
}

function r(x, d = 3) { return typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : x; }
function mapR(o, d) { return o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r(v, d)])); }
