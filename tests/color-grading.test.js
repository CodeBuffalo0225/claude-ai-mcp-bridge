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

// ── fixes found grading the S-Log3 test sequences live (2026-11-14) ─────
import { ColorWorkflow } from '../src/color-grading/color-workflow.js';

const SLOG3 = { empty: false, isSceneReferred: true, matrixEquation: 1, name: 'Sony S-Log3/S-Gamut3.Cine', primaries: 1012, transferCharacteristic: 1001 };

test('inspect recognises Premiere log colour management as the one transform', () => {
  const r = inspectSource({ premiere: SLOG3, ffmpeg: parseFfmpegVideoStream('  Stream #0:0: Video: h264 (High 4:2:2) (avc1), yuv422p10le(pc, progressive), 3840x2160, 23.98 fps'), sequence: { workingColorSpace: 'Rec. 709' } });
  assert.equal(r.encoding, 'log_premiere_managed:Sony S-Log3/S-Gamut3.Cine');
  assert.equal(r.transform.premiereColorManaged, true);
  assert.equal(r.readyForCreativeGrade, true);
  assert.match(r.transform.steps[0], /do NOT add a log→709 LUT/);
  const dbl = inspectSource({ premiere: SLOG3, lumetri: { inputLutSelected: true } });
  assert.ok(dbl.warnings.some((w) => /DOUBLE TRANSFORM/.test(w)));
  assert.equal(dbl.readyForCreativeGrade, false);
});

test('solveControl adds Lumetri to an ungraded clip instead of failing', async () => {
  let added = false;
  const props = structuredClone(FIXTURE.props);
  const br = {
    async send(app, cmd, params) {
      if (cmd === 'color.probeLumetri') return { sequence: params.sequenceName, clip: { trackIndex: 0, clipIndex: 0 }, lumetriCount: added ? 1 : 0, instance: 0, props: added ? structuredClone(props) : null };
      if (cmd === 'color.setLumetriParams') {
        if (params.ensure && !added) added = true;
        return { added: true, results: params.writes.map((w) => { props[w.index].value = w.value; return { index: w.index, name: w.name, requested: w.value, before: 0, after: w.value, ok: true }; }) };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  const a = new PremiereColorActions(br, { logDir: tmp() });
  // No Premiere here: the frame export fails on purpose. What matters is
  // that the missing-Lumetri path is handled BEFORE measuring starts.
  a.exportFrame = async () => { throw new Error('no render in unit test'); };
  const err = await a.solveControl({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0, instance: 0 }, {
    control: 'basic.tint', metric: 'wb.magentaGreen', targetValue: 0, tolerance: 0.004, probeStep: -5, timeSec: 1, workDir: tmp(),
  }).catch((e) => e);
  assert.equal(added, true, 'Lumetri was added before solving');
  assert.match(err.message, /no render in unit test/, 'reached the measuring step instead of failing on "No Lumetri"');
});

test('a closed-loop step whose solves all fail is reported as not applied', async () => {
  const wf = new ColorWorkflow({ send: async () => ({}) });
  wf.actions.solveControl = async () => { throw new Error('boom'); };
  wf.analyze = async () => ({ analysis: { frames: [{ path: '/x', stats: {}, faces: [] }] }, summary: { frames: [{}] } });
  wf.compare = async () => ({ identical: true });
  const r = await wf._applyClosedLoop({ sequenceName: '_WORKING_t' }, { recommendations: [{ id: 'wb.tint', route: 'closed_loop', solve: {} }] }, { timeSec: 1, workDir: tmp(), beforeFrame: { faces: [], stats: { luma: {}, clipping: {}, whiteBalance: { axes: {} }, saturation: {} } }, beforePath: '/x' });
  assert.equal(r.applied, false);
  assert.equal(r.status, 'failed');
  assert.match(r.errors[0], /boom/);
});

test('metricOf covers the editor-intent metrics', () => {
  const f = fakeFrame({ stats: { saturation: { chromaP50: 0.02 } } });
  assert.equal(metricOf(f, 'luma.p99'), 0.95);
  assert.equal(metricOf(f, 'luma.p1'), 0.05);
  assert.equal(metricOf(f, 'chroma.p50'), 0.02);
});

test('MCP: color_solve is registered and demands a reason', async () => {
  const srv = new PremiereProMCPServer({ send: async () => { throw new Error('no bridge'); } }, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(a);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(b);
  assert.ok((await c.listTools()).tools.some((t) => t.name === 'color_solve'));
  const r = await c.callTool({ name: 'color_solve', arguments: { sequenceName: '_WORKING_x', timeSec: 1, control: 'basic.exposure', metric: 'luma.p99', targetValue: 0.85, tolerance: 0.02, probeStep: 0.3, reason: 'short' } });
  assert.equal(r.isError, true);
  await c.close();
});

test('source transform: refused (isError) when Premiere detects no log; logged when applied', async () => {
  const mk = (applied) => ({ async send(app, cmd) { if (cmd === 'color.applyLogColorManagement') return applied ? { applied: true, effective: SLOG3, original: SLOG3 } : { applied: false, reason: 'no log detected' }; throw new Error(cmd); } });
  const dir = tmp();
  const a = new PremiereColorActions(mk(true), { logDir: dir });
  await assert.rejects(a.applyLogColorManagement({ sequenceName: 'Source_Edit_YT' }), /Refusing/);
  const r = await a.applyLogColorManagement({ sequenceName: '_WORKING_x', trackIndex: 0, clipIndex: 0 });
  assert.equal(r.applied, true);
  assert.match(fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8'), /setLogColorManagement\(false\)/);
  const srv = new PremiereProMCPServer(mk(false), {});
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  await srv.server.connect(t1);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(t2);
  const out = await c.callTool({ name: 'color_apply_source_transform', arguments: { sequenceName: '_WORKING_x' } });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no log detected/);
  await c.close();
});

test('comparison writer creates its output folder', async () => {
  const { writeComparison } = await import('../src/color-grading/analysis/image-io.js');
  const img = solid(4, 4, [10, 20, 30]);
  const p = path.join(tmp(), 'nested', 'deeper', 'cmp.png');
  await writeComparison(img, img, p);
  assert.ok(fs.existsSync(p));
});

// ── warmth: determine "too warm", tonal wheels, HSL Secondary (2026-11-14) ─
import { assessWarmth, measureTonalCasts } from '../src/color-grading/analysis/warmth.js';
import { wheelForCbCr, designTonalWheels, designWarmHslSecondary, SKIN_GUARD } from '../src/color-grading/ops/warmth-design.js';
import { stackImages, stackMasks } from '../src/color-grading/color-workflow.js';

const casts = (s, m, h) => ({ shadows: { blueYellow: s }, mids: { blueYellow: m }, highlights: { blueYellow: h } });

test('warmth verdicts match the three live calibration cases', () => {
  // Tungsten cabin interview (live: Test Color 2): cast in all ranges, skin toward red, 97% warm.
  assert.equal(assessWarmth({ casts: casts(-0.0045, -0.0237, -0.0527), dominance: 0.974 }, [{ skinLineDeviationDeg: -6.6 }]).verdict, 'slightly_warm');
  // Overcast ceremony: no consistent cast.
  assert.equal(assessWarmth({ casts: casts(-0.006, -0.0084, -0.0236), dominance: 0.837 }, [{ skinLineDeviationDeg: 0.7 }]).verdict, 'neutral');
  // Autumn woods daylight: warm scene, skin on the line, warm share not extreme → content.
  assert.equal(assessWarmth({ casts: casts(-0.0432, -0.05, -0.0259), dominance: 0.849 }, [{ skinLineDeviationDeg: -0.2 }]).verdict, 'warm_content');
  // No faces: dominance alone can confirm.
  assert.equal(assessWarmth({ casts: casts(-0.01, -0.03, -0.05), dominance: 0.95 }, []).verdict, 'slightly_warm');
});

test('same-pixel measurement: desaturating warm objects cannot make the metric read warmer', () => {
  // Grey wall (low chroma) + saturated orange wood.
  const w = 40, h = 40, d = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) { const c = p % 2 ? [200, 120, 60] : [128, 124, 118]; d.set(c, p * 3); }
  const img = rgbImage(w, h, d);
  const base = measureTonalCasts(img, { step: 1 });
  const desat = compilePixelOps([{ op: 'hueVsSat', center: 25, width: 60, amount: -0.8 }]);
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i += 3) { const o = desat([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]); out[i] = Math.round(o[0] * 255); out[i + 1] = Math.round(o[1] * 255); out[i + 2] = Math.round(o[2] * 255); }
  const same = measureTonalCasts(rgbImage(w, h, out), { selection: base.selection });
  assert.ok(same.casts.mids.blueYellow >= base.casts.mids.blueYellow - 1e-4, 'same pixels: not warmer');
});

test('HSL Secondary: qualifies by hue AND saturation, holds luma, leaves skin-saturation pixels alone', () => {
  const op = { op: 'hslSecondary', qualifier: { hueCenter: 25, hueWidth: 50, satRange: [0.5, 1], lumaRange: [0, 1], softness: 0.04 }, correction: { saturation: -0.5, hueShiftDeg: 0, cb: 0, cr: 0 } };
  assert.equal(validateOps([op]).ok.length, 1);
  const fn = compilePixelOps([op]);
  const wood = [0.8, 0.45, 0.15];   // HSV s ≈ 0.81 → keyed
  const skin = [0.8, 0.62, 0.52];   // HSV s ≈ 0.35 → below floor
  const L = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const w2 = fn(wood);
  assert.ok(Math.max(...w2) - Math.min(...w2) < 0.65 - 0.01, 'wood desaturated');
  assert.ok(Math.abs(L(w2) - L(wood)) < 1e-6, 'luma held');
  assert.deepEqual(fn(skin), skin, 'skin-saturation pixel untouched');
  assert.deepEqual(fn([0.2, 0.4, 0.8]), [0.2, 0.4, 0.8], 'other hues untouched');
});

test('wheel for a Cb/Cr push points the right way and has the right size', () => {
  const wh = wheelForCbCr(0.02, -0.01);
  const c = hsvToRgbForTest(wh.hueDeg);
  const v = vectorscope(...c);
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const pushCb = wh.amount * (c[2] - y) / 1.8556, pushCr = wh.amount * (c[0] - y) / 1.5748;
  assert.ok(Math.abs(pushCb - 0.02) < 0.002 && Math.abs(pushCr + 0.01) < 0.002, `push ${pushCb},${pushCr} at ${v.angle}`);
  assert.equal(wheelForCbCr(0, 0), null);
});

test('tonal wheels reduce a uniform warm cast; the skin guard binds and is reported', () => {
  // Gradient grey ramp with a warm cast + a skin patch.
  const w = 64, h = 64, d = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, v = 30 + Math.round((x / w) * 190);
    d.set([Math.min(255, v + 14), v + 4, Math.max(0, v - 14)], p * 3);
    if (x > 20 && x < 40 && y > 20 && y < 40) { d.set([200, 140, 115], p * 3); mask[p] = 1; }
  }
  const img = rgbImage(w, h, d);
  const free = designTonalWheels(img, { strength: 0.6, iterations: 6 });
  assert.ok(free.after.mids.blueYellow > free.before.mids.blueYellow, 'mids cooled');
  const guarded = designTonalWheels(img, { strength: 0.9, iterations: 6, skinMasks: [mask] });
  assert.ok(guarded.skinGuard.scale <= 1);
  assert.equal(guarded.skinGuard.limits.maxHueShiftDeg, SKIN_GUARD.maxHueShiftDeg);
});

test('HSL design keys warm saturated pixels outside faces, floor above skin saturation', () => {
  const w = 60, h = 20, d = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) { if (p % w < 20) { d.set([200, 145, 120], p * 3); mask[p] = 1; } else d.set([210, 110, 40], p * 3); }
  const r = designWarmHslSecondary(rgbImage(w, h, d), [mask]);
  assert.ok(r.op.qualifier.satRange[0] > r.evidence.skinSatP90);
  assert.ok(r.evidence.meanKeyWeightInsideSkin < 0.1 && r.evidence.meanKeyWeightOutsideSkin > 0.5);
});

test('frames stack into one design sample with masks re-based', () => {
  const a = { _img: rgbImage(2, 1, new Uint8Array(6).fill(1)), faces: [{ skin: { mask: new Uint8Array([1, 0]) } }] };
  const b = { _img: rgbImage(2, 1, new Uint8Array(6).fill(2)), faces: [{ skin: { mask: new Uint8Array([0, 1]) } }] };
  const s = stackImages([a._img, b._img]);
  assert.equal(s.height, 2);
  assert.deepEqual(Array.from(s.data), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
  const m = stackMasks([a, b]);
  assert.deepEqual(m.map((x) => Array.from(x)), [[1, 0, 0, 0], [0, 0, 0, 1]]);
});

test('solveControl over several frames solves on the MEAN metric', async () => {
  const props = structuredClone(FIXTURE.props);
  const br = { async send(app, cmd, params) {
    if (cmd === 'color.probeLumetri') return { sequence: params.sequenceName, clip: { trackIndex: 0, clipIndex: 0 }, lumetriCount: 1, instance: 0, props: structuredClone(props) };
    if (cmd === 'color.setLumetriParams') return { results: params.writes.map((w) => { props[w.index].value = w.value; return { index: w.index, name: w.name, requested: w.value, before: 0, after: w.value, ok: true }; }) };
    throw new Error(cmd);
  } };
  const { writePNG } = await import('../src/color-grading/analysis/image-io.js');
  const dir = tmp();
  const a = new PremiereColorActions(br, { logDir: dir });
  // Rendered brightness = 100 + 2·Exposure-slider units, frame 2 is 40 levels brighter.
  a.exportFrame = async ({ timeSec, outPath }) => {
    const v = Math.round(100 + 20 * props[19].value + (timeSec === 2 ? 40 : 0));
    const p = outPath + '.png';
    await writePNG(solid(16, 16, [v, v, v]), p);
    return { path: p };
  };
  const r = await a.solveControl({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0, instance: 0 }, {
    control: 'basic.exposure', metric: 'luma.p50', targetValue: 160 / 255, tolerance: 0.01, probeStep: 0.5, timeSec: [1, 2], workDir: dir,
  });
  assert.equal(r.solvedOn, 'mean of 2 frames');
  assert.equal(r.converged, true);
  assert.ok(Math.abs(r.bestX - 2) < 0.15, `mean target hit at exposure ≈ 2 (got ${r.bestX})`);
  assert.ok(r.perFrame.every((m) => Object.keys(m.byTime).length === 2), 'every frame measured each time');
});

function hsvToRgbForTest(h) {
  const hh = (((h % 360) + 360) % 360) / 60, i = Math.floor(hh), f = hh - i, q = 1 - f, t = f;
  return [[1, t, 0], [q, 1, 0], [0, 1, t], [0, q, 1], [t, 0, 1], [1, 0, q]][i % 6];
}

// ── LUT verification from renders ─────────────────────────────────────────
import { applyCube } from '../src/color-grading/ops/cube-lut.js';

test('applyCube: identity LUT is a no-op; a baked LUT matches its ops within interpolation error', () => {
  const img = solid(8, 8, [180, 120, 60]);
  assert.deepEqual(Array.from(applyCube(img, parseCube(bakeCube([], { size: 17 }))).data), Array.from(img.data));
  const ops = [{ op: 'hueVsSat', center: 30, width: 60, amount: -0.4 }];
  const viaLut = applyCube(img, parseCube(bakeCube(ops, { size: 33 })));
  const exact = applyOpsToImage(img, ops);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(viaLut.data[i] - exact.data[i]) <= 3, `channel ${i}`);
  assert.throws(() => applyCube(img, { size: 3, table: [] }), /malformed/);
});

function lutRig({ lutInInstance = null } = {}) {
  const inst = [structuredClone(FIXTURE.props), structuredClone(FIXTURE.props)];
  const br = { async send(app, cmd, params) {
    const i = params.instance || 0;
    if (cmd === 'color.probeLumetri') return { sequence: params.sequenceName, clip: { trackIndex: 0, clipIndex: 0 }, lumetriCount: 2, instance: i, props: structuredClone(inst[i]) };
    if (cmd === 'color.setLumetriParams') return { results: params.writes.map((w) => { inst[i][w.index].value = w.value; return { index: w.index, name: w.name, requested: w.value, before: 0, after: w.value, ok: true }; }) };
    throw new Error(cmd);
  } };
  const wf = new ColorWorkflow(br, { logDir: tmp() });
  wf.actions.exportFrame = async ({ outPath }) => {
    const { writePNG } = await import('../src/color-grading/analysis/image-io.js');
    const exp = inst[1][19].value;
    const lut = lutInInstance !== null && inst[lutInInstance][38].value > 0 ? 25 : 0;
    const v = Math.round(90 + 30 * exp + lut);
    const p = outPath + '.png';
    await writePNG(solid(32, 32, [v, v, v]), p);
    return { path: p };
  };
  return { wf, inst };
}

test('verifyLut: no Look active → lutActive:false, with a passing positive control; everything restored', async () => {
  const { wf, inst } = lutRig();
  const r = await wf.verifyLut({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0 }, { timeSec: 1 });
  assert.equal(r.lutActive, false);
  assert.ok(r.control.meanCodeValues > 0.5);
  assert.equal(inst[1][19].value, FIXTURE.props[19].value, 'exposure restored');
  assert.equal(inst[0][38].value, FIXTURE.props[38].value, 'look intensity restored');
});

test('verifyLut: finds the Lumetri holding the Look', async () => {
  const { wf } = lutRig({ lutInInstance: 1 });
  const r = await wf.verifyLut({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0 }, { timeSec: 1 });
  assert.equal(r.lutActive, true);
  assert.equal(r.instance, 1);
});

// ── greys fix + instance guard (2026-11-14, Travis: "the greys look a little green") ─
import { designNeutralBalance } from '../src/color-grading/ops/warmth-design.js';

test('writes refuse an unnamed instance once a clip has several Lumetri effects', async () => {
  const props = structuredClone(FIXTURE.props);
  const br = { async send(app, cmd, params) {
    if (cmd === 'color.probeLumetri') return { sequence: params.sequenceName, clip: { trackIndex: 0, clipIndex: 0 }, lumetriCount: 2, instance: params.instance || 0, props: structuredClone(props) };
    if (cmd === 'color.setLumetriParams') return { results: params.writes.map((w) => ({ index: w.index, name: w.name, requested: w.value, before: 0, after: w.value, ok: true })) };
    throw new Error(cmd);
  } };
  const a = new PremiereColorActions(br, { logDir: tmp() });
  await assert.rejects(a.applyLumetri({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0 }, [{ op: 'lumetri', control: 'basic.tint', value: 1 }]), /2 Lumetri instances — say which one/);
  const ok1 = await a.applyLumetri({ sequenceName: '_WORKING_t', trackIndex: 0, clipIndex: 0, instance: 1 }, [{ op: 'lumetri', control: 'basic.tint', value: 1 }]);
  assert.equal(ok1.verified, true);
});

test('an all-hues HSL key reaches pure greys (which have no hue)', () => {
  const fn = compilePixelOps([{ op: 'hslSecondary', qualifier: { hueCenter: 0, hueWidth: 360, satRange: [0, 0.1], lumaRange: [0, 1], softness: 0.02 }, correction: { saturation: 0, hueShiftDeg: 0, cb: 0, cr: 0.02 } }]);
  const g = fn([0.5, 0.5, 0.5]);
  assert.ok(g[0] > 0.5, 'grey got the push');
  assert.deepEqual(fn([0.8, 0.5, 0.3]), [0.8, 0.5, 0.3], 'saturated colour untouched');
});

test('neutral balance moves green greys to neutral and leaves skin alone', () => {
  const w = 60, h = 20, d = new Uint8Array(w * h * 3), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x < 20) { d.set([200, 145, 120], p * 3); mask[p] = 1; } else { const v = 80 + 3 * (x - 20); d.set([v - 2, v + 3, v - 2], p * 3); }
  }
  const r = designNeutralBalance(rgbImage(w, h, d), [mask]);
  assert.ok(r.evidence.neutralsBefore.magentaGreen < -0.004);
  assert.ok(Math.abs(r.evidence.neutralsAfter.magentaGreen - -0.002) < 0.0015, JSON.stringify(r.evidence.neutralsAfter));
  assert.ok(r.op.qualifier.satRange[1] < r.evidence.skinSatP5);
  assert.ok(r.evidence.meanChangeInsideSkin < r.evidence.meanChangeOutsideSkin / 5);
});
