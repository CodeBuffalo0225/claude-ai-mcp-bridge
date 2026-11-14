// ============================================================================
//  Color workflow — the repeatable 9-step grading workflow, wired from the
//  three separate layers:
//      analysis/   measure (frames, scopes, faces, skin, tracks)
//      recommend/  decide  (pure: measurements → proposed ops + routes)
//      actions/    act     (Premiere bridge: snapshot → write → read back)
//
//   1 inspect source encoding        → inspect()
//   2 transform pipeline decision    → inspect().transform
//   3 analyse exposure/WB/clip/sat   → analyze()
//   4 primary correction             → correctPrimary()
//   5 faces & skin                   → analyze() faces[].skin
//   6 curves / secondaries           → buildCurveLut(), skinSaturation(), faceLift()
//   7 match related shots            → matchShots()
//   8 validate across the clip       → validate()
//   9 before/after + summary         → compare()  (and every apply step)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { analyzeFrames, summarizeAnalysis } from './analysis/frame-analyzer.js';
import { decodeRGB, writeComparison, writePNG } from './analysis/image-io.js';
import { luma } from './analysis/color-math.js';
import { inspectSource, parseFfmpegVideoStream } from './analysis/source-inspect.js';
import { extractSourceFrame, probeMedia } from './analysis/frame-source.js';
import { recommendPrimary, recommendSCurve, recommendSkinSaturation, recommendFaceLift, recommendMatch, skinBaseline, skinChangeReport } from './recommend/recommender.js';
import { applyOpsToImage, safetyReport, compilePixelOps } from './ops/transform.js';
import { writeCube } from './ops/cube-lut.js';
import { validateOps } from './ops/grade-ops.js';
import { PremiereColorActions, defaultWorkDir } from './actions/premiere-color-actions.js';
import { hueWindow, rgbToHsv } from './analysis/color-math.js';

export class ColorWorkflow {
  constructor(bridge, { logDir } = {}) {
    this.actions = new PremiereColorActions(bridge, { logDir });
  }

  // ── 1–2 ────────────────────────────────────────────────────────────────
  async inspect({ sequenceName, trackIndex = 0, clipIndex = 0, declaredEncoding, timeSec } = {}) {
    const info = await this.actions.sourceInfo({ sequenceName, trackIndex, clipIndex });
    const ffText = info.mediaPath ? await probeMedia(info.mediaPath) : '';
    const ff = parseFfmpegVideoStream(ffText);
    let frameStats = null;
    if (info.mediaPath && ff) {
      const wd = defaultWorkDir();
      const t = timeSec !== undefined ? this._mediaTime(info, timeSec) : Math.min(1, info.clipDurationSec / 2);
      const p = await extractSourceFrame(info.mediaPath, t, path.join(wd, 'source_probe.png'), { matrix: ff.matrix || 'bt709', range: ff.range || 'limited' });
      frameStats = (await analyzeFrames([{ path: p }], { detect: false })).frames[0].stats;
    }
    const verdict = inspectSource({
      premiere: info.colorSpace,
      ffmpeg: ff,
      lumetri: { inputLutSelected: (info.lumetri?.inputLutValues || []).some((v) => v !== 0), hdrMode: info.lumetri?.highDynamicRange },
      sequence: info.sequenceSettings,
      declaredEncoding,
      frameStats,
    });
    return { clip: { sequence: info.sequence, name: info.clip, mediaPath: info.mediaPath }, ...verdict };
  }

  _mediaTime(info, seqTime) {
    return Math.max(0, info.clipInSec + (seqTime - info.clipStartSec));
  }

  // ── 3 + 5 ──────────────────────────────────────────────────────────────
  /**
   * @param frames [{ sequenceName, timeSec, label? }] from Premiere (graded),
   *               or [{ path }] for frames already on disk.
   */
  async analyze(frames, { workDir = defaultWorkDir(), keepMasks = false, detect = true } = {}) {
    const files = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f.path) { files.push({ path: f.path, label: f.label, time: f.timeSec ?? null }); continue; }
      const ex = await this.actions.exportFrame({ sequenceName: f.sequenceName, timeSec: f.timeSec, outPath: path.join(workDir, `${f.label || 'frame'}_${i}`) });
      files.push({ path: ex.path, label: f.label || `${f.sequenceName}@${f.timeSec}s`, time: f.timeSec });
    }
    const analysis = await analyzeFrames(files, { keepMasks, detect });
    const reportPath = path.join(workDir, 'analysis.json');
    fs.writeFileSync(reportPath, JSON.stringify(summarizeAnalysis(analysis), null, 1));
    return { analysis, summary: summarizeAnalysis(analysis), reportPath, workDir };
  }

  async sourceFrameFor({ sequenceName, trackIndex = 0, clipIndex = 0, timeSec }, workDir) {
    const info = await this.actions.sourceInfo({ sequenceName, trackIndex, clipIndex });
    if (timeSec < info.clipStartSec || timeSec > info.clipStartSec + info.clipDurationSec) {
      throw new Error(`timeSec ${timeSec} is outside clip V${trackIndex}:${clipIndex} (${info.clipStartSec.toFixed(2)}–${(info.clipStartSec + info.clipDurationSec).toFixed(2)}s)`);
    }
    const ff = parseFfmpegVideoStream(await probeMedia(info.mediaPath));
    const p = await extractSourceFrame(info.mediaPath, this._mediaTime(info, timeSec), path.join(workDir, 'source_ungraded.png'), { matrix: ff?.matrix || 'bt709', range: ff?.range || 'limited' });
    return (await analyzeFrames([{ path: p, label: 'source_ungraded' }], { detect: false })).frames[0];
  }

  // ── 4 ──────────────────────────────────────────────────────────────────
  async correctPrimary(target, { timeSec, apply = false, preserveMood = false, allowNonWorkingSequence = false } = {}) {
    const workDir = defaultWorkDir();
    const before = await this.analyze([{ sequenceName: target.sequenceName, timeSec, label: 'before' }], { workDir });
    const frame = before.analysis.frames[0];
    let sourceFrame = null;
    try { sourceFrame = await this.sourceFrameFor({ ...target, timeSec }, workDir); } catch (e) { /* reported below */ }
    const rec = recommendPrimary(frame, { preserveMood, sourceFrame });
    rec.sourceFrameUsed = !!sourceFrame;
    if (!apply) return { applied: false, ...rec, analysis: before.summary, workDir };
    return this._applyClosedLoop(target, rec, { timeSec, workDir, beforeFrame: frame, beforePath: frame.path, allowNonWorkingSequence });
  }

  async _applyClosedLoop(target, rec, { timeSec, workDir, beforeFrame, beforePath, allowNonWorkingSequence }) {
    const solved = [];
    const baseline = skinBaseline(beforeFrame);
    for (const r of rec.recommendations.filter((x) => x.route === 'closed_loop')) {
      try {
        solved.push({ id: r.id, ...(await this.actions.solveControl({ ...target, instance: r.solve.instance ?? target.instance ?? 0 }, {
          control: r.solve.control, metric: r.solve.metric, targetValue: r.solve.target, tolerance: r.solve.tolerance,
          probeStep: r.solve.probeStep, bounds: r.solve.bounds, timeSec, workDir, allowNonWorkingSequence,
        })) });
      } catch (e) {
        solved.push({ id: r.id, error: e.message });
      }
    }
    const after = await this.analyze([{ sequenceName: target.sequenceName, timeSec, label: 'after' }], { workDir });
    const cmp = await this.compare(beforePath, after.analysis.frames[0].path, path.join(workDir, 'before_after.png'), { note: `${target.sequenceName} @ ${timeSec}s — Premiere render, before | after` });
    return {
      applied: true,
      recommendations: rec.recommendations,
      solved,
      skinCheck: skinChangeReport(baseline, after.analysis.frames[0]),
      comparison: cmp,
      before: summarizeAnalysis({ faceDetection: null, frames: [beforeFrame], tracks: [] }).frames[0],
      after: after.summary.frames[0],
      workDir,
    };
  }

  // ── 6: curves → LUT (preview + bake) ───────────────────────────────────
  async buildCurveLut({ framePath, strength = 0.35, outDir = defaultWorkDir(), name = 'scurve' }) {
    const a = await analyzeFrames([{ path: framePath }]);
    const rec = recommendSCurve(a.frames[0], { strength });
    const r0 = rec.recommendations[0];
    if (!r0.ops.length) return { built: false, ...rec };
    return { built: true, recommendation: r0, ...(await this.previewAndBake({ framePath, ops: r0.ops, outDir, name })) };
  }

  async previewAndBake({ framePath, ops, outDir = defaultWorkDir(), name = 'grade', masks }) {
    const { ok, rejected } = validateOps(ops);
    if (rejected.length) throw new Error(`invalid ops: ${JSON.stringify(rejected)}`);
    const img = await decodeRGB(framePath);
    const preview = applyOpsToImage(img, ok, { masks });
    const previewPath = await writePNG(preview, path.join(outDir, `${name}_engine_preview.png`));
    const comparison = await writeComparison(img, preview, path.join(outDir, `${name}_before_vs_engine_preview.png`), { labels: ['BEFORE', 'ENGINE PREVIEW (not a Premiere render)'] });
    const global = ok.filter((o) => o.op !== 'secondary');
    const safety = global.length ? safetyReport(img, global) : null;
    const lutPath = global.length && global.length === ok.length ? writeCube(path.join(outDir, `${name}.cube`), global, { title: name }) : null;
    return {
      previewPath, comparison, lutPath, safety,
      howToApply: lutPath
        ? 'Premiere cannot set curves or LUT paths by script (verified 26.5.2). Load this .cube in Lumetri ▸ Creative ▸ Look ▸ Browse… on a SECOND Lumetri instance (so it sits after the existing grade, matching the frame it was designed on). Then run color_compare against the engine preview to verify it was applied.'
        : 'Contains a masked secondary — cannot be a LUT. Apply in Premiere with a masked/keyed second Lumetri (see manual steps).',
    };
  }

  /** Footprint of a hue op: share of affected pixels inside vs outside face skin. */
  measureOpFootprint(img, op, skinMasks) {
    let inside = 0, outside = 0;
    for (let p = 0; p < img.width * img.height; p += 2) {
      const i = p * 3;
      const { h, s } = rgbToHsv(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
      if (s < 0.08 || hueWindow(h, op.center, op.width) < 0.5) continue;
      if (skinMasks.some((m) => m[p])) inside++; else outside++;
    }
    const t = inside + outside;
    return { inside, outside, outsideShare: t ? Math.round((outside / t) * 1000) / 1000 : 0 };
  }

  async skinSaturation({ framePath, faceIndex = 0, amount = -0.15, outDir = defaultWorkDir() }) {
    const a = await analyzeFrames([{ path: framePath }], { keepMasks: true });
    const fr = a.frames[0];
    const masks = fr.faces.filter((f) => f.skin?.mask).map((f) => f.skin.mask);
    const first = recommendSkinSaturation(fr, { faceIndex, amount });
    const op = first.recommendations[0].ops.flatMap((o) => (o.op === 'secondary' ? o.ops : [o])).find((o) => o.op === 'hueVsSat');
    if (!op) return first;
    const footprint = this.measureOpFootprint(fr._img, op, masks);
    const rec = recommendSkinSaturation(fr, { faceIndex, amount, footprint });
    const maskMap = Object.fromEntries(fr.faces.map((f, i) => [`skin:${i}`, f.skin?.mask]).filter(([, m]) => m));
    const preview = await this.previewAndBake({ framePath, ops: rec.recommendations[0].ops, outDir, name: `skin_sat_face${faceIndex}`, masks: maskMap });
    // Isolation evidence on the preview: change inside vs outside the skin mask.
    const before = await decodeRGB(framePath);
    const after = await decodeRGB(preview.previewPath);
    return { ...rec, preview, isolation: regionDelta(before, after, masks) };
  }

  // ── 6: face lift (tracked mask) ────────────────────────────────────────
  async faceLift(target, { timeSec, validateTimes = [], faceIndex = 0, lift = 0.06, instance = 1, confirmMaskTracked = false, allowNonWorkingSequence = false }) {
    const workDir = defaultWorkDir();
    const times = [timeSec, ...validateTimes.filter((t) => t !== timeSec)];
    const before = await this.analyze(times.map((t, i) => ({ sequenceName: target.sequenceName, timeSec: t, label: `before_${i}` })), { workDir, keepMasks: true });
    const fr = before.analysis.frames[0];
    const rec = recommendFaceLift(fr, { faceIndex, lift, instance });
    const track = before.analysis.tracks.find((t) => t.samples.some((s) => s.frameIndex === 0 && s.faceIndex === faceIndex)) || null;
    const trackOut = track && { id: track.id, stable: track.stable, coverage: track.coverage, reasons: track.reasons, samples: track.samples.map((s) => ({ timeSec: s.time, bbox: roundBox(s.bbox), confidence: s.confidence })) };
    // Engine preview of the true masked midtone lift.
    const masks = { [`faceTrack:${faceIndex}`]: fr.faces[faceIndex]?.skin?.mask };
    const preview = rec.recommendations[0].ops.length && masks[`faceTrack:${faceIndex}`]
      ? await this.previewAndBake({ framePath: fr.path, ops: rec.recommendations[0].ops, outDir: workDir, name: `face_lift_${faceIndex}`, masks })
      : null;
    if (!confirmMaskTracked) {
      return { applied: false, ...rec, track: trackOut, preview, workDir, next: 'Draw + track the mask in Premiere (manual steps), then call again with confirmMaskTracked:true.' };
    }
    const s = rec.recommendations[0].solve;
    const solved = await this.actions.solveControl({ ...target, instance }, { control: s.control, metric: s.metric, targetValue: s.target, tolerance: s.tolerance, probeStep: s.probeStep, bounds: s.bounds, timeSec, workDir, allowNonWorkingSequence });
    const after = await this.analyze(times.map((t, i) => ({ sequenceName: target.sequenceName, timeSec: t, label: `after_${i}` })), { workDir });
    const iso = [];
    for (let i = 0; i < times.length; i++) {
      const b = await decodeRGB(before.analysis.frames[i].path), a = await decodeRGB(after.analysis.frames[i].path);
      const m = before.analysis.frames[i].faces[faceIndex]?.skin?.mask;
      iso.push({ timeSec: times[i], ...(m ? regionDelta(b, a, [m]) : { error: 'face not isolated in this frame' }) });
    }
    const cmp = await this.compare(fr.path, after.analysis.frames[0].path, path.join(workDir, 'face_lift_before_after.png'), { note: 'Premiere render, before | after' });
    return { applied: true, ...rec, track: trackOut, solved, isolationByFrame: iso, comparison: cmp, workDir };
  }

  // ── 7 ──────────────────────────────────────────────────────────────────
  async matchShots({ reference, targets, apply = false, allowNonWorkingSequence = false }) {
    const workDir = defaultWorkDir();
    const ref = await this.analyze([{ sequenceName: reference.sequenceName, timeSec: reference.timeSec, label: 'reference' }], { workDir });
    const out = [];
    for (const t of targets) {
      const cur = await this.analyze([{ sequenceName: t.sequenceName, timeSec: t.timeSec, label: `target_${t.clipIndex}` }], { workDir });
      const rec = recommendMatch(ref.analysis.frames[0], cur.analysis.frames[0], { pairs: t.pairs || [] });
      if (!apply) { out.push({ target: t, ...rec }); continue; }
      out.push({ target: t, ...(await this._applyClosedLoop({ sequenceName: t.sequenceName, trackIndex: t.trackIndex ?? 0, clipIndex: t.clipIndex, instance: t.instance ?? 0 }, rec, { timeSec: t.timeSec, workDir, beforeFrame: cur.analysis.frames[0], beforePath: cur.analysis.frames[0].path, allowNonWorkingSequence })) });
    }
    return { reference: ref.summary.frames[0], results: out, workDir };
  }

  // ── 8 ──────────────────────────────────────────────────────────────────
  async validate({ sequenceName, times }) {
    const { analysis, summary, workDir } = await this.analyze(times.map((t, i) => ({ sequenceName, timeSec: t, label: `v${i}` })));
    const f = analysis.frames;
    const sceneP50 = f.map((x) => x.stats.luma.p50);
    const jumps = sceneP50.slice(1).map((v, i) => Math.abs(v - sceneP50[i]));
    const banding = f.map((x) => histogramGaps(x.stats.luma));
    const skinSeries = analysis.tracks.map((t) => {
      const vals = t.samples.map((s) => analysis.frames[s.frameIndex].faces[s.faceIndex]?.skin?.stats).filter(Boolean);
      const lum = vals.map((v) => v.lumaP50), ang = vals.map((v) => v.vectorscopeAngle);
      return { track: t.id, samples: vals.length, lumaRange: rng(lum), angleRangeDeg: rng(ang), stable: t.stable, trackReasons: t.reasons };
    });
    const issues = [];
    jumps.forEach((j, i) => { if (j > 0.06) issues.push(`scene median jumps ${j.toFixed(3)} between ${times[i]}s and ${times[i + 1]}s — check for flicker or a cut`); });
    banding.forEach((b, i) => { if (b.gapFraction > 0.15) issues.push(`frame ${times[i]}s: ${(b.gapFraction * 100).toFixed(0)}% of luma levels in p1–p99 are empty — posterisation/banding risk`); });
    skinSeries.forEach((s) => {
      if (!s.stable) issues.push(`face track ${s.track} unstable: ${s.trackReasons.join('; ')}`);
      if (s.angleRangeDeg > 8) issues.push(`face track ${s.track}: skin hue varies ${s.angleRangeDeg.toFixed(1)}° across samples`);
      if (s.lumaRange > 0.08) issues.push(`face track ${s.track}: skin brightness varies ${s.lumaRange.toFixed(3)} across samples`);
    });
    return { times, frames: summary.frames, sceneLumaP50: sceneP50.map((v) => +v.toFixed(3)), banding, skinConsistency: skinSeries, issues, ok: issues.length === 0, workDir, note: 'Sampled validation: problems between samples are not detected. Skin variation can be real lighting change — review the frames listed.' };
  }

  // ── 9 ──────────────────────────────────────────────────────────────────
  async compare(beforePath, afterPath, outPath, { note } = {}) {
    const b = await decodeRGB(beforePath), a = await decodeRGB(afterPath);
    const image = await writeComparison(b, a, outPath, { note });
    const an = await analyzeFrames([{ path: beforePath }, { path: afterPath }], { keepMasks: true });
    const masks = an.frames[0].faces.filter((f) => f.skin?.mask).map((f) => f.skin.mask);
    const s0 = an.frames[0].stats, s1 = an.frames[1].stats;
    return {
      image,
      meanAbsDiff: meanAbsDiff(b, a),
      lumaP50: [r(s0.luma.p50), r(s1.luma.p50)],
      clipHighlights: [r(s0.clipping.highlightsAllChannels, 4), r(s1.clipping.highlightsAllChannels, 4)],
      cast: [s0.whiteBalance.axes, s1.whiteBalance.axes].map((x) => ({ blueYellow: r(x.blueYellow, 4), magentaGreen: r(x.magentaGreen, 4) })),
      regions: masks.length ? regionDelta(b, a, masks) : null,
      identical: meanAbsDiff(b, a) === 0,
    };
  }
}

/** Mean luma change inside the masks vs outside them — isolation evidence. */
export function regionDelta(before, after, masks) {
  let din = 0, nin = 0, dout = 0, nout = 0;
  for (let p = 0, i = 0; p < before.width * before.height; p++, i += 3) {
    const lb = luma(before.data[i] / 255, before.data[i + 1] / 255, before.data[i + 2] / 255);
    const la = luma(after.data[i] / 255, after.data[i + 1] / 255, after.data[i + 2] / 255);
    if (masks.some((m) => m[p])) { din += la - lb; nin++; } else { dout += Math.abs(la - lb); nout++; }
  }
  return { meanLumaChangeInsideSkin: r(nin ? din / nin : 0, 4), meanAbsLumaChangeOutside: r(nout ? dout / nout : 0, 4), insidePixels: nin };
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return r(s / a.data.length / 255, 5);
}
function histogramGaps(l) {
  const lo = Math.round(l.p1 * 255), hi = Math.round(l.p99 * 255);
  let gaps = 0;
  for (let k = lo; k <= hi; k++) if (!l.histogram[k]) gaps++;
  return { levels: hi - lo + 1, emptyLevels: gaps, gapFraction: r(gaps / Math.max(1, hi - lo + 1)) };
}
function rng(v) { return v.length ? Math.max(...v) - Math.min(...v) : 0; }
function roundBox(b) { return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }; }
function r(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }

export { compilePixelOps };
