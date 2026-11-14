// Color-grading upgrade — focused tests. Run with Premiere closed: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vectorscope, angleDiff, circularStats, hueWindow, tonalWeights, SKIN_LINE_DEG } from '../src/color-grading/analysis/color-math.js';
import { computeFrameStats, castAxes } from '../src/color-grading/analysis/frame-stats.js';
import { isolateSkin, qualifierLeakage, pointInPolygon } from '../src/color-grading/analysis/skin.js';
import { trackFaces, iou } from '../src/color-grading/analysis/face-track.js';
import { parseFfmpegVideoStream, inspectSource, logSuspicion } from '../src/color-grading/analysis/source-inspect.js';
import { ffmpegFrameArgs } from '../src/color-grading/analysis/frame-source.js';
import { parseDetectorOutput } from '../src/color-grading/analysis/face-detect.js';
import { monotoneCurve, designSCurve, compilePixelOps, safetyReport, maxSlope, applyOpsToImage } from '../src/color-grading/ops/transform.js';
import { bakeCube, parseCube } from '../src/color-grading/ops/cube-lut.js';
import { validateOps } from '../src/color-grading/ops/grade-ops.js';
import { resolveControl, planLumetriWrites, presetToLumetriOps, capabilityTable, LUMETRI_CONTROLS } from '../src/color-grading/actions/lumetri-controls.js';
import { PremiereColorActions } from '../src/color-grading/actions/premiere-color-actions.js';
import { solveClosedLoop } from '../src/color-grading/recommend/solver.js';
import { recommendPrimary, recommendSCurve, recommendSkinSaturation, recommendMatch, metricOf, skinChangeReport } from '../src/color-grading/recommend/recommender.js';
import { COLOR_PRESETS } from '../src/color-grading/color-grader.js';
import { rgbImage } from '../src/color-grading/analysis/image-io.js';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/lumetri-26.5.2-probe.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));

// ── color math ────────────────────────────────────────────────────────────
test('vectorscope places the primaries where a BT.709 scope does', () => {
  const red = vectorscope(1, 0, 0).angle;
  assert.ok(red > 102 && red < 104, `red at ${red}`);
  const blue = vectorscope(0, 0, 1).angle;
  assert.ok(blue > 350 || blue < 0.1, `blue at ${blue}`);
  assert.equal(vectorscope(0.5, 0.5, 0.5).chroma, 0);
});

test('a typical skin RGB sits near the I line; angleDiff wraps correctly', () => {
  const s = vectorscope(0.78, 0.57, 0.46);
  assert.ok(Math.abs(angleDiff(s.angle, SKIN_LINE_DEG)) < 12, `skin at ${s.angle}`);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(10, 350), 20);
});

test('circular mean handles the 0/360 seam', () => {
  const { mean } = circularStats([355, 5, 0]);
  assert.ok(Math.abs(angleDiff(mean, 0)) < 1e-6);
});

test('tonal weights overlap smoothly and always sum to 1', () => {
  for (let y = 0; y <= 1; y += 0.05) {
    const w = tonalWeights(y);
    assert.ok(Math.abs(w.shadows + w.midtones + w.highlights - 1) < 1e-9);
  }
  const m = tonalWeights(0.4);
  assert.ok(m.shadows > 0 && m.midtones > 0, 'ranges overlap in the lower mids');
});

test('hue window is 1 at centre, 0 outside, continuous', () => {
  assert.equal(hueWindow(30, 30, 40), 1);
  assert.equal(hueWindow(60, 30, 40), 0);
  assert.ok(Math.abs(hueWindow(49.9, 30, 40) - hueWindow(50.1, 30, 40)) < 0.01);
  assert.equal(hueWindow(NaN, 30, 40), 0);
});

// ── frame stats ─────────────────────────────────────────────────────────
function solid(w, h, rgb) {
  const d = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { d[i * 3] = rgb[0]; d[i * 3 + 1] = rgb[1]; d[i * 3 + 2] = rgb[2]; }
  return rgbImage(w, h, d);
}

test('cast axes: a blue-tinted grey reads cool, a magenta grey reads magenta', () => {
  // HSV sat 0.09: still "near neutral" (< 0.12), visibly cool.
  const blue = computeFrameStats(solid(40, 40, [120, 124, 132]), { step: 1 });
  assert.equal(blue.whiteBalance.method, 'near_neutral_pixels');
  assert.ok(blue.whiteBalance.axes.blueYellow > 0.005);
  const mag = castAxes(0.02, 0.02);
  assert.ok(mag.magentaGreen > 0);
});

test('clipping is measured, not guessed', () => {
  const img = solid(10, 10, [255, 255, 255]);
  const s = computeFrameStats(img, { step: 1 });
  assert.equal(s.clipping.highlightsAllChannels, 1);
});

test('frame with no neutrals falls back to grey-world with low confidence', () => {
  const s = computeFrameStats(solid(20, 20, [200, 40, 40]), { step: 1 });
  assert.equal(s.whiteBalance.method, 'grey_world_fallback');
  assert.ok(s.whiteBalance.confidence < 0.5);
});

// ── curves ──────────────────────────────────────────────────────────────
test('monotone curve never overshoots or folds', () => {
  const f = monotoneCurve([[0, 0], [0.2, 0.15], [0.45, 0.45], [0.75, 0.82], [1, 1]]);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.001) {
    const y = f(x);
    assert.ok(y >= prev - 1e-12, `non-monotone at ${x}`);
    assert.ok(y >= 0 && y <= 1);
    prev = y;
  }
  assert.throws(() => monotoneCurve([[0, 0.5], [1, 0.2]]), /non-decreasing/);
});

test('S-curve keeps the pivot (skin) fixed and protects p1/p99', () => {
  const d = designSCurve({ pivot: 0.46, strength: 0.35, lumaP1: 0.05, lumaP99: 0.95 });
  assert.ok(d.points);
  const f = monotoneCurve(d.points);
  assert.ok(Math.abs(f(0.46) - 0.46) < 1e-6);
  assert.ok(f(0.95) < 254 / 255, 'p99 not clipped');
  assert.ok(f(0.05) >= 2 / 255, 'p1 not crushed');
  assert.ok(f(0.2) < 0.2 && f(0.8) > 0.8, 'it is an S');
});

test('S-curve strength is reduced (or refused) when the frame has no headroom', () => {
  const tight = designSCurve({ pivot: 0.5, strength: 0.9, lumaP1: 0.009, lumaP99: 0.985 });
  assert.ok(tight.points === null || tight.reduced, 'must not apply full strength');
});

test('steep curves are flagged as banding risk', () => {
  const f = monotoneCurve([[0, 0], [0.45, 0.2], [0.55, 0.8], [1, 1]]);
  assert.ok(maxSlope(f) > 1.6);
});

// ── hue curves ──────────────────────────────────────────────────────────
test('hue vs sat changes the band and leaves neighbours + neutrals alone', () => {
  const fn = compilePixelOps([{ op: 'hueVsSat', center: 25, width: 40, amount: -0.5 }]);
  const orange = fn([0.8, 0.53, 0.33]); // HSV hue ≈ 25°
  assert.ok(Math.max(...orange) - Math.min(...orange) < 0.8 - 0.33, 'orange desaturated');
  assert.deepEqual(fn([0.2, 0.4, 0.8]), [0.2, 0.4, 0.8], 'blue untouched');
  assert.deepEqual(fn([0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 'grey untouched');
  const lumaOf = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(Math.abs(lumaOf(orange) - lumaOf([0.8, 0.53, 0.33])) < 1e-9, 'saturation change preserves luma');
});

test('hue vs hue / hue vs luma shift only inside the window', () => {
  const h = compilePixelOps([{ op: 'hueVsHue', center: 120, width: 60, shiftDeg: 10 }]);
  assert.deepEqual(h([0.9, 0.1, 0.1]), [0.9, 0.1, 0.1]);
  const l = compilePixelOps([{ op: 'hueVsLuma', center: 220, width: 60, amount: -0.1 }]);
  const sky = l([0.3, 0.5, 0.9]);
  assert.ok(sky[2] < 0.9, 'sky darkened');
});

test('schema gate rejects out-of-range ops instead of passing them on', () => {
  const { ok, rejected } = validateOps([{ op: 'hueVsHue', center: 30, width: 40, shiftDeg: 90 }, { op: 'curve', channel: 'master', points: [[0, 0], [1, 1]] }]);
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
});

// ── LUT ─────────────────────────────────────────────────────────────────
test('.cube bake: identity with no ops, red index fastest, refuses masks', () => {
  const cube = parseCube(bakeCube([], { size: 3 }));
  assert.equal(cube.size, 3);
  assert.equal(cube.table.length, 27);
  assert.deepEqual(cube.table[1], [0.5, 0, 0]);
  assert.throws(() => bakeCube([{ op: 'secondary', mask: { kind: 'skin', faceIndex: 0, featherPx: 1, denoise: 0 }, ops: [] }]), /mask/);
  assert.throws(() => bakeCube([{ op: 'lumetri', control: 'basic.exposure', value: 1 }]), /Premiere/);
});

// ── Lumetri control registry vs the real 26.5.2 probe ────────────────────
test('controls resolve by section — the four "Saturation"s land on the right params', () => {
  const p = FIXTURE.props;
  assert.equal(resolveControl(p, 'basic.saturation').index, 16);
  assert.equal(resolveControl(p, 'creative.saturation').index, 43);
  assert.equal(resolveControl(p, 'hsl.saturation').index, 105);
  assert.equal(resolveControl(p, 'hsl.blur').index, 96, 'numeric Blur, not the boolean group');
  assert.equal(resolveControl(p, 'basic.highlights').index, 21);
  assert.equal(resolveControl(p, 'basic.temperature').index, 14);
  assert.equal(resolveControl(p, 'hsl.temperature').index, 101);
  assert.equal(resolveControl(p, 'vignette.amount').index, 110);
});

test('every implemented control resolves on 26.5.2', () => {
  for (const id of Object.keys(LUMETRI_CONTROLS)) {
    assert.ok(!resolveControl(FIXTURE.props, id).error, id);
  }
});

test('blob controls are refused with their fallback, unknown ids are refused', () => {
  assert.match(resolveControl(FIXTURE.props, 'curves.rgb').error, /not scriptable.*LUT/);
  assert.match(resolveControl(FIXTURE.props, 'wheels.midtones').error, /not scriptable/);
  assert.match(resolveControl(FIXTURE.props, 'basic.nonsense').error, /Unknown/);
});

test('write plan: delta resolves against current value; partial controls need a key; ranges warn', () => {
  const { writes, skipped } = planLumetriWrites(FIXTURE.props, [
    { op: 'lumetri', control: 'basic.temperature', value: 4, mode: 'delta' },
    { op: 'lumetri', control: 'hsl.saturation', value: 80, mode: 'absolute' },
    { op: 'lumetri', control: 'basic.exposure', value: 9, mode: 'absolute' },
    { op: 'lumetri', control: 'curves.hueVsSat', value: 1, mode: 'absolute' },
  ]);
  const t = writes.find((w) => w.control === 'basic.temperature');
  assert.equal(t.value, FIXTURE.props[14].value + 4);
  assert.ok(writes.find((w) => w.control === 'basic.exposure').warning);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((s) => s.control === 'hsl.saturation' && /eyedropper/.test(s.reason)));
});

test('presets: saturation offsets become absolute (100-based); unscriptable groups are reported', () => {
  const { ops, unsupported } = presetToLumetriOps(COLOR_PRESETS.youtube_vibrant);
  assert.equal(ops.find((o) => o.control === 'creative.saturation').value, 110, 'not 10 (= near grayscale)');
  assert.equal(ops.find((o) => o.control === 'basic.contrast').value, 10);
  const fish = presetToLumetriOps(COLOR_PRESETS.fishing_coastal_outdoor_natural);
  const groups = fish.unsupported.map((u) => u.group);
  assert.ok(groups.includes('hsl') && groups.includes('colorWheels'));
  assert.equal(fish.ops.find((o) => o.control === 'vignette.midpoint').value, 55, 'midpoint is absolute');
});

test('capability table lists implemented, partial and unavailable rows', () => {
  const rows = capabilityTable();
  for (const s of ['implemented', 'partial', 'unavailable']) assert.ok(rows.some((r) => r.status === s), s);
});

// ── skin isolation ─────────────────────────────────────────────────────
// Synthetic 200×200: background blaze orange on the left, grey on the right,
// a skin-coloured face ellipse with red lips and dark eyes.
function synthFace({ blaze = true } = {}) {
  const w = 200, h = 200, d = new Uint8Array(w * h * 3);
  const put = (x, y, c) => { const i = (y * w + x) * 3; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, blaze && x < 40 ? [235, 110, 30] : [110, 110, 110]);
  const skin = [200, 150, 120], lips = [170, 60, 70], eye = [30, 25, 25];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (((x - 100) / 45) ** 2 + ((y - 105) / 60) ** 2 <= 1) put(x, y, skin);
    if (((x - 100) / 15) ** 2 + ((y - 140) / 6) ** 2 <= 1) put(x, y, lips);
    if (((x - 82) / 8) ** 2 + ((y - 95) / 4) ** 2 <= 1 || ((x - 118) / 8) ** 2 + ((y - 95) / 4) ** 2 <= 1) put(x, y, eye);
  }
  const ell = (cx, cy, rx, ry, n = 12) => Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)]);
  const contour = Array.from({ length: 9 }, (_, k) => { const t = Math.PI * (k / 8); return [100 - 44 * Math.cos(t), 105 + 58 * Math.sin(t)]; });
  const face = {
    confidence: 1, landmarksConfidence: 0.9, bbox: { x: 55, y: 45, w: 90, h: 120 },
    regions: { faceContour: contour, outerLips: ell(100, 140, 15, 6), leftEye: ell(82, 95, 8, 4), rightEye: ell(118, 95, 8, 4), leftEyebrow: ell(82, 85, 9, 2), rightEyebrow: ell(118, 85, 9, 2) },
  };
  return { img: rgbImage(w, h, d), face };
}

test('skin mask excludes lips, eyes and the background; stats come from skin only', () => {
  const { img, face } = synthFace();
  const s = isolateSkin(img, face);
  assert.equal(s.geometry, 'landmarks');
  assert.ok(s.reliable, JSON.stringify(s.reasons));
  const at = (x, y) => s.mask[y * img.width + x];
  assert.equal(at(100, 140), 0, 'lips excluded');
  assert.equal(at(82, 95), 0, 'eye excluded');
  assert.equal(at(10, 100), 0, 'blaze background excluded');
  assert.equal(at(100, 120), 1, 'cheek included');
  const expect = vectorscope(200 / 255, 150 / 255, 120 / 255).angle;
  assert.ok(Math.abs(angleDiff(s.stats.vectorscopeAngle, expect)) < 1);
});

test('leakage: a skin-hue key would also grab blaze orange outside the face', () => {
  const { img, face } = synthFace();
  const s = isolateSkin(img, face);
  const withBlaze = qualifierLeakage(img, { ...s.qualifier, angleHalfWidth: 35, chromaMax: 0.5 }, [s.mask], { step: 1 });
  const { img: img2, face: f2 } = synthFace({ blaze: false });
  const s2 = isolateSkin(img2, f2);
  const without = qualifierLeakage(img2, { ...s2.qualifier, angleHalfWidth: 35, chromaMax: 0.5 }, [s2.mask], { step: 1 });
  assert.ok(withBlaze.leakageFraction > without.leakageFraction);
});

test('no landmarks → bbox ellipse with a lower, honest confidence', () => {
  const { img, face } = synthFace();
  const s = isolateSkin(img, { ...face, regions: {} });
  assert.equal(s.geometry, 'bbox_ellipse');
  assert.ok(s.confidence < isolateSkin(img, face).confidence);
  assert.ok(s.reasons.some((r) => /no landmarks/.test(r)));
});

test('a tiny face is reported unreliable with a manual fallback', () => {
  const { img } = synthFace();
  const s = isolateSkin(img, { confidence: 1, landmarksConfidence: 0.9, bbox: { x: 98, y: 100, w: 3, h: 3 }, regions: {} });
  assert.equal(s.reliable, false);
  assert.ok(s.manualFallback);
});

test('point in polygon', () => {
  assert.ok(pointInPolygon(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(!pointInPolygon(15, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
});

// ── tracking ──────────────────────────────────────────────────────────
test('tracker keeps two people apart and reports gaps', () => {
  const A = (x) => ({ bbox: { x, y: 10, w: 50, h: 50 }, landmarksConfidence: 0.9 });
  const B = (x) => ({ bbox: { x, y: 200, w: 40, h: 40 }, landmarksConfidence: 0.8 });
  const frames = [{ time: 0, faces: [A(10), B(300)] }, { time: 1, faces: [A(14), B(296)] }, { time: 2, faces: [B(292)] }, { time: 3, faces: [A(22), B(288)] }];
  const tracks = trackFaces(frames);
  assert.equal(tracks.length, 2);
  const a = tracks.find((t) => t.samples[0].bbox.y === 10);
  assert.equal(a.samples.length, 3);
  assert.equal(a.gaps.length, 1);
  assert.equal(a.stable, false);
  assert.ok(iou(A(10).bbox, A(14).bbox) > 0.8);
});

// ── source inspection ─────────────────────────────────────────────────
const IPHONE = '  Stream #0:2[0x3](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 720x1280, 2218 kb/s, 30 fps, 30 tbr, 600 tbn (default)';
const HLG = '  Stream #0:0: Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 60 fps';

test('ffmpeg stream parse: real iPhone line and an HLG line', () => {
  const a = parseFfmpegVideoStream(IPHONE);
  assert.deepEqual([a.codec, a.bitDepth, a.chromaSubsampling, a.range, a.matrix, a.transfer], ['h264', 8, '420', 'limited', 'bt709', 'bt709']);
  const b = parseFfmpegVideoStream(HLG);
  assert.deepEqual([b.bitDepth, b.matrix, b.primaries, b.transfer], [10, 'bt2020nc', 'bt2020', 'hlg']);
});

test('inspect: Rec.709 source is ready; HLG with Input LUT warns double transform; unknown is not ready', () => {
  const rec709 = inspectSource({ premiere: { empty: false, name: 'Rec. 709', primaries: 1, transferCharacteristic: 1, matrixEquation: 1 }, ffmpeg: parseFfmpegVideoStream(IPHONE) });
  assert.equal(rec709.encoding, 'sdr_rec709');
  assert.ok(rec709.readyForCreativeGrade);
  const hlg = inspectSource({ premiere: { empty: false, name: 'Rec. 2100 HLG', primaries: 9, transferCharacteristic: 18, matrixEquation: 9 }, ffmpeg: parseFfmpegVideoStream(HLG), lumetri: { inputLutSelected: true } });
  assert.ok(hlg.warnings.some((w) => /DOUBLE TRANSFORM/.test(w)));
  assert.equal(hlg.readyForCreativeGrade, false);
  const unk = inspectSource({});
  assert.equal(unk.encoding, 'unknown');
  assert.equal(unk.readyForCreativeGrade, false);
});

test('log suspicion is a question, raised only for lifted+compressed+flat frames', () => {
  assert.ok(logSuspicion({ luma: { p1: 0.09, p99: 0.62 }, saturation: { chromaP95: 0.07 } }).suspicious);
  assert.ok(!logSuspicion({ luma: { p1: 0.02, p99: 0.97 }, saturation: { chromaP95: 0.2 } }).suspicious);
});

test('ffmpeg frame extraction passes the matrix explicitly (swscale defaults to BT.601)', () => {
  const args = ffmpegFrameArgs('/m.mov', 2, '/o.png', { matrix: 'bt709', range: 'limited' }).join(' ');
  assert.match(args, /in_color_matrix=bt709:in_range=tv:out_range=pc/);
  assert.throws(() => ffmpegFrameArgs('/m.mov', 0, '/o.png', { matrix: 'weird' }));
});

test('detector output parsing sorts largest face first and rejects junk', () => {
  const out = parseDetectorOutput(JSON.stringify({ engine: 'apple-vision', images: [{ faces: [{ bbox: { x: 0, y: 0, w: 10, h: 10 } }, { bbox: { x: 0, y: 0, w: 50, h: 50 } }, { bbox: { x: 0, y: 0, w: 0, h: 0 } }] }] }));
  assert.equal(out.images[0].faces.length, 2);
  assert.equal(out.images[0].faces[0].bbox.w, 50);
  assert.throws(() => parseDetectorOutput('not json'));
});

// ── solver ──────────────────────────────────────────────────────────────
test('closed loop converges on a linear response and records every measurement', async () => {
  const res = await solveClosedLoop({ x0: 0, measure: async (x) => 0.02 - 0.001 * x, target: 0, tolerance: 0.0005, probeStep: 5, bounds: [-100, 100] });
  assert.equal(res.converged, true);
  assert.ok(Math.abs(res.bestX - 20) < 1);
  assert.ok(res.measurements.length >= 3);
});

test('closed loop reports a control with no effect instead of pretending', async () => {
  const res = await solveClosedLoop({ x0: 0, measure: async () => 0.01, target: 0, tolerance: 0.001, probeStep: 5, bounds: [-100, 100] });
  assert.equal(res.status, 'no_measurable_response');
  assert.equal(res.converged, false);
});

test('closed loop respects bounds', async () => {
  const res = await solveClosedLoop({ x0: 0, measure: async (x) => 1 - 0.001 * x, target: 0, tolerance: 0.001, probeStep: 5, bounds: [-10, 10] });
  assert.equal(res.converged, false);
  assert.ok(res.measurements.every((m) => m.x <= 10 && m.x >= -10));
});

// ── recommender ─────────────────────────────────────────────────────────
const fakeFrame = (over = {}) => ({
  stats: {
    luma: { p1: 0.05, p5: 0.08, p50: 0.45, p95: 0.9, p99: 0.95 },
    clipping: { highlightsAllChannels: 0, shadows: 0 },
    whiteBalance: { confidence: 1, method: 'near_neutral_pixels', sampleFraction: 0.2, axes: { blueYellow: 0.02, magentaGreen: 0.001 } },
    ...over.stats,
  },
  faces: over.faces || [],
});

test('primary: a measured blue cast → closed-loop Temperature warming; tint left alone', () => {
  const r = recommendPrimary(fakeFrame());
  const t = r.recommendations.find((x) => x.id === 'wb.temperature');
  assert.equal(t.route, 'closed_loop');
  assert.ok(t.solve.probeStep > 0);
  assert.ok(!r.recommendations.some((x) => x.id === 'wb.tint'));
});

test('primary: low neutral evidence → no automatic WB; camera clipping is not "fixed"', () => {
  const f = fakeFrame({ stats: { whiteBalance: { confidence: 0.2, method: 'grey_world_fallback', sampleFraction: 0.001, axes: { blueYellow: 0.05, magentaGreen: 0 } }, clipping: { highlightsAllChannels: 0.03, shadows: 0 } } });
  const src = fakeFrame({ stats: { clipping: { highlightsAllChannels: 0.03, shadows: 0 } } });
  const r = recommendPrimary(f, { sourceFrame: src });
  assert.ok(!r.recommendations.some((x) => x.route === 'closed_loop'));
  assert.ok(r.recommendations.some((x) => /in camera/.test(x.title)));
});

test('S-curve recommendation pivots on reliable skin, routes to LUT', () => {
  const face = { skin: { reliable: true, stats: { lumaP50: 0.52 } } };
  const r = recommendSCurve(fakeFrame({ faces: [face] }));
  const rec = r.recommendations[0];
  assert.equal(rec.route, 'lut');
  assert.equal(rec.evidence.pivot, 0.52);
});

test('skin saturation: high leakage forces a masked route, low leakage allows a LUT', () => {
  const face = { bbox: { w: 100 }, skin: { reliable: true, confidence: 0.9, reasons: [], leakage: { leakageFraction: 0.7, outsideHueMean: 128 }, stats: { hsvHue: { center: 22, bandWidth: 12 } } } };
  const hi = recommendSkinSaturation(fakeFrame({ faces: [face] }), { amount: -0.2 }).recommendations[0];
  assert.equal(hi.route, 'manual_mask');
  assert.equal(hi.ops[0].op, 'secondary');
  const lo = recommendSkinSaturation(fakeFrame({ faces: [face] }), { amount: -0.2, footprint: { outsideShare: 0.1 } }).recommendations[0];
  assert.equal(lo.route, 'lut');
  assert.equal(lo.ops[0].op, 'hueVsSat');
});

test('matching only pairs faces the caller says are the same person', () => {
  const sk = (l, c, a) => ({ skin: { reliable: true, confidence: 0.9, stats: { lumaP50: l, chromaP50: c, vectorscopeAngle: a } } });
  const ref = fakeFrame({ faces: [sk(0.5, 0.12, 123)] });
  const tgt = fakeFrame({ faces: [sk(0.4, 0.15, 123)] });
  assert.ok(!recommendMatch(ref, tgt).recommendations.some((r) => /skin/i.test(r.id)), 'no pairs → no skin matching');
  const withPair = recommendMatch(ref, tgt, { pairs: [{ refFace: 0, targetFace: 0 }] });
  const lum = withPair.recommendations.find((r) => r.id === 'match.skinLuma.0');
  assert.equal(lum.solve.target, 0.5);
});

test('metricOf refuses a face that was not isolated', () => {
  assert.throws(() => metricOf(fakeFrame(), 'skin.0.lumaP50'), /not isolated/);
});

test('skin change report flags a step that moved complexion', () => {
  const sk = (l, c, a) => ({ skin: { reliable: true, stats: { lumaP50: l, chromaP50: c, vectorscopeAngle: a } } });
  const rep = skinChangeReport([{ face: 0, lumaP50: 0.5, chromaP50: 0.12, vectorscopeAngle: 123 }], fakeFrame({ faces: [sk(0.5, 0.12, 135)] }));
  assert.equal(rep[0].natural, false);
});

test('engine preview: masked secondary changes only the masked pixels', () => {
  const img = solid(4, 1, [100, 100, 100]);
  const mask = new Uint8Array([1, 1, 0, 0]);
  const out = applyOpsToImage(img, [{ op: 'secondary', mask: { kind: 'skin', faceIndex: 0, featherPx: 0 }, ops: [{ op: 'curve', channel: 'master', points: [[0, 0], [0.5, 0.6], [1, 1]] }] }], { masks: { 'skin:0': mask } });
  assert.ok(out.data[0] > 100);
  assert.equal(out.data[9], 100);
  assert.throws(() => applyOpsToImage(img, [{ op: 'secondary', mask: { kind: 'skin', faceIndex: 3, featherPx: 0 }, ops: [] }]), /needs a mask/);
});

test('safety report catches introduced clipping', () => {
  const img = solid(8, 8, [240, 240, 240]);
  const rep = safetyReport(img, [{ op: 'curve', channel: 'master', points: [[0, 0], [0.8, 1], [1, 1]] }]);
  assert.ok(rep.newlyClippedFraction > 0);
  assert.equal(rep.ok, false);
});

// ── actions against a fake bridge ────────────────────────────────────────
function fakeBridge({ readBackOffset = 0, failCmd } = {}) {
  const props = structuredClone(FIXTURE.props);
  const calls = [];
  return {
    calls, props,
    async send(app, cmd, params) {
      calls.push({ cmd, params });
      if (cmd === failCmd) throw new Error('CEP panel WebSocket not connected');
      if (cmd === 'color.probeLumetri') return { sequence: params.sequenceName, clip: { trackIndex: params.trackIndex, clipIndex: params.clipIndex }, lumetriCount: 1, instance: params.instance || 0, props: structuredClone(props) };
      if (cmd === 'color.setLumetriParams') {
        return { added: false, results: params.writes.map((w) => {
          const p = props[w.index];
          if (p.name !== w.name) return { index: w.index, name: w.name, error: 'name mismatch' };
          const before = p.value; p.value = w.value + readBackOffset;
          return { index: w.index, name: w.name, requested: w.value, before, after: p.value, ok: Math.abs(p.value - w.value) < 1e-3 };
        }) };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
}
const target = { sequenceName: '_WORKING_test', trackIndex: 0, clipIndex: 0, instance: 0 };

test('actions refuse to write to a non-working sequence', async () => {
  const a = new PremiereColorActions(fakeBridge(), { logDir: tmp() });
  await assert.rejects(a.applyLumetri({ ...target, sequenceName: 'Source_Edit_YT' }, []), /Refusing to write/);
});

test('actions write the resolved index, snapshot first, and verify by read-back', async () => {
  const br = fakeBridge();
  const dir = tmp();
  const a = new PremiereColorActions(br, { logDir: dir });
  const r = await a.applyLumetri(target, [{ op: 'lumetri', control: 'creative.saturation', value: 90 }, { op: 'lumetri', control: 'curves.rgb', value: 1 }]);
  assert.equal(r.verified, true);
  assert.equal(r.results[0].index, 43);
  assert.equal(r.skipped[0].control, 'curves.rgb');
  assert.ok(fs.existsSync(r.snapshot));
  // restore puts the original value back
  const back = await a.restore(r.snapshot);
  assert.equal(back.allVerified, true);
  assert.equal(br.props[43].value, FIXTURE.props[43].value);
});

test('a read-back mismatch is reported as not verified', async () => {
  const a = new PremiereColorActions(fakeBridge({ readBackOffset: 3 }), { logDir: tmp() });
  const r = await a.applyLumetri(target, [{ op: 'lumetri', control: 'basic.exposure', value: 0.2 }]);
  assert.equal(r.verified, false);
  assert.equal(r.failed.length, 1);
});

test('bridge failure propagates — no simulated success', async () => {
  const a = new PremiereColorActions(fakeBridge({ failCmd: 'color.probeLumetri' }), { logDir: tmp() });
  await assert.rejects(a.applyLumetri(target, [{ op: 'lumetri', control: 'basic.exposure', value: 0.2 }]), /not connected/);
});

// ── shared-file fixes + MCP wiring ──────────────────────────────────────
import { ColorGrader } from '../src/color-grading/color-grader.js';
import { PremiereProMCPServer } from '../src/mcp-servers/premiere-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('preset scaling sends absolute saturation and keeps vignette shape values', () => {
  const g = new ColorGrader({});
  const s = g._scalePreset(COLOR_PRESETS.fishing_coastal_outdoor_natural, 0.8);
  assert.equal(s.creative.saturation, 100 + 2 * 0.8);
  assert.equal(s.vignette.midpoint, 55, 'midpoint not scaled');
  assert.equal(s.vignette.amount, -0.8 * 0.8);
  assert.ok(s.hsl, 'unsupported hsl group carried through for skip-reporting');
});

test('color_match no longer fabricates a confidence', async () => {
  const g = new ColorGrader({ send: async () => ({}) });
  await assert.rejects(g.colorMatch({ sourceTrack: 0, sourceClip: 1, referenceTrack: 0, referenceClip: 0 }), /color_match_shots/);
});

test('MCP: colour tools are registered; capabilities answer offline; writes refuse source sequences', async () => {
  const bridge = { send: async (app, cmd) => { throw new Error(`bridge should not be reached (${cmd})`); } };
  const srv = new PremiereProMCPServer(bridge, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(b);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ['color_capabilities', 'color_inspect_source', 'color_analyze_frames', 'color_correct_primary', 'color_build_curve_lut', 'color_skin_saturation', 'color_face_lift', 'color_match_shots', 'color_validate_frames', 'color_apply', 'color_restore', 'color_compare', 'color_export_frame']) {
    assert.ok(names.includes(n), n);
  }
  const cap = await c.callTool({ name: 'color_capabilities', arguments: {} });
  assert.match(cap.content[0].text, /unavailable/);
  const w = await c.callTool({ name: 'color_apply', arguments: { sequenceName: 'Source_Edit_YT', ops: [{ control: 'basic.exposure', value: 0.1 }] } });
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /Refusing to write/);
  await c.close();
});
