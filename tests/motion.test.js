// Motion (transitions / text / audio fades / SFX) — focused tests. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { easing, cubicBezier, planKeys, EASINGS } from '../src/motion/easing.js';
import { transitionRecipe, textRecipe, lowerThirdRecipe, planAnims, TRANSITIONS, TEXT_ANIMATIONS, FX } from '../src/motion/recipes.js';
import { planFade, planCrossfade, summedPowerDb, toDb, FLOOR_DB } from '../src/motion/audio-curves.js';
import { synthWhoosh, writeWav } from '../src/motion/sfx.js';
import { renderTitle, renderLowerThird } from '../src/motion/titles.js';
import { readWav, analyzeAudio, judgeTransition } from '../src/motion/motion-verify.js';
import { seqToMedia, dbToLevel, levelToDb, PremiereMotionActions } from '../src/motion/motion-actions.js';
import { findNext, freeTrack, flipForAOnTop, clipAt } from '../src/motion/motion-workflow.js';
import { rgbImage } from '../src/color-grading/analysis/image-io.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'motion-test-'));

// ── easing ──────────────────────────────────────────────────────────────
test('every easing starts at 0, ends at 1, and the S-curves are symmetric', () => {
  for (const name of Object.keys(EASINGS)) {
    const f = easing(name);
    assert.ok(Math.abs(f(0)) < 1e-6, `${name}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-6, `${name}(1)`);
  }
  const s = easing('smooth');
  assert.ok(Math.abs(s(0.5) - 0.5) < 1e-3);
  assert.ok(Math.abs(s(0.25) + s(0.75) - 1) < 1e-3);
});

test('cubicBezier(0,0,1,1) is linear; ease-out front-loads progress', () => {
  const lin = cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.4, 0.8]) assert.ok(Math.abs(lin(t) - t) < 1e-3);
  assert.ok(easing('settle')(0.3) > 0.5);
});

test('planKeys bakes one key per frame (linear interp) or two bezier keys', () => {
  const b = planKeys({ from: 0, to: 100, startSec: 1, durationSec: 1, curve: 'smooth', fps: 30, mode: 'baked' });
  assert.equal(b.interp, 0);
  assert.equal(b.keys.length, 31);
  assert.equal(b.keys[0].v, 0);
  assert.equal(b.keys.at(-1).v, 100);
  for (let i = 1; i < b.keys.length; i++) assert.ok(b.keys[i].v >= b.keys[i - 1].v - 1e-9, 'monotone');
  const z = planKeys({ from: [0.5, 0.5], to: [1, 0.5], startSec: 0, durationSec: 0.5, curve: 'easeInQuint', fps: 30, mode: 'bezier' });
  assert.equal(z.interp, 5);
  assert.deepEqual(z.keys.map((k) => k.v), [[0.5, 0.5], [1, 0.5]]);
});

// ── recipes ─────────────────────────────────────────────────────────────
test('every transition recipe is well-formed and uses only calibrated effect params', () => {
  for (const n of TRANSITIONS) {
    const r = transitionRecipe(n, { durationSec: 0.8, height: 1080 });
    assert.ok(['overlap', 'same_track'].includes(r.arrangement), n);
    assert.ok(r.anims.length > 0, n);
    for (const e of r.effects) assert.ok(FX[e.fx], `${n}: ${e.fx}`);
    for (const a of r.anims) {
      assert.ok(['A', 'B'].includes(a.layer));
      const fx = Object.values(FX).find((f) => f.name === a.component);
      if (fx) assert.ok(fx.params[a.param], `${n}: ${a.component}.${a.param} not mapped`);
      // Anims stay inside the transition window around the cut.
      assert.ok(a.startRel >= -0.4 - 1e-9 && a.startRel + a.durationSec <= 0.4 + 1e-9, `${n} anim outside window`);
    }
  }
  assert.throws(() => transitionRecipe('starWipe', { durationSec: 1 }), /unknown transition/);
});

test('no recipe uses Linear Wipe (does not attach by script on 26.5.2)', () => {
  assert.equal(FX.linearWipe, undefined);
  const r = transitionRecipe('featheredWipe', { durationSec: 1, height: 720 });
  assert.equal(r.effects[0].fx, 'crop');
  assert.ok(r.effects[0].set.feather > 0);
});

test('feathers and offsets scale with frame height', () => {
  const a = transitionRecipe('featheredWipe', { durationSec: 1, height: 1080 }).effects[0].set.feather;
  const b = transitionRecipe('featheredWipe', { durationSec: 1, height: 2160 }).effects[0].set.feather;
  assert.equal(b, a * 2);
});

test('text recipes animate in from the layer start and out before its end', () => {
  for (const n of TEXT_ANIMATIONS) {
    const r = textRecipe(n, { height: 1080, inSec: 0.6, outSec: 0.4 });
    for (const a of r.in) assert.ok(a.startRel >= 0, n);
    for (const a of r.out) assert.ok(a.startRel < 0 && a.startRel + a.durationSec <= 1e-9, n);
  }
  const lt = lowerThirdRecipe({ stagger: 0.1 });
  assert.deepEqual(lt.layers.map((l) => l.layer), ['bar', 'name', 'role']);
  assert.ok(lt.layers[1].inDelay > lt.layers[0].inDelay && lt.layers[2].inDelay > lt.layers[1].inDelay);
  assert.ok(lt.layers[2].outLead > lt.layers[1].outLead, 'role leaves first');
});

test('flipForAOnTop: B opacity reveal becomes the inverse fade on A (same composite)', () => {
  const r = flipForAOnTop(transitionRecipe('crossDissolve', { durationSec: 1 }));
  assert.equal(r.anims[0].layer, 'A');
  assert.equal(r.anims[0].from, 100);
  assert.equal(r.anims[0].to, 0);
  const w = flipForAOnTop(transitionRecipe('featheredWipe', { durationSec: 1, height: 720 }));
  assert.equal(w.effects[0].layer, 'A');
  assert.equal(w.anims[0].param, 'right');
  assert.deepEqual([w.anims[0].from, w.anims[0].to], [0, 100]);
  // Composite identity at every t: B·α + A·(1−α) == A·β + B·(1−β), β = 1−α.
  const [p] = planAnims([transitionRecipe('crossDissolve', { durationSec: 1 }).anims[0]], { fps: 10 });
  const [q] = planAnims([r.anims[0]], { fps: 10 });
  p.keys.forEach((k, i) => assert.ok(Math.abs(k.v / 100 - (1 - q.keys[i].v / 100)) < 1e-6));
});

// ── audio ───────────────────────────────────────────────────────────────
test('equal-power crossfade keeps summed power flat; equal-gain dips 3 dB', () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(summedPowerDb('equalPower', t)) < 1e-9);
  assert.ok(Math.abs(summedPowerDb('equalGain', 0.5) + 3.01) < 0.02);
});

test('planFade ends at the floor and starts at the base level', () => {
  const out = planFade({ kind: 'out', startSec: 2, durationSec: 1, fps: 30, stepFrames: 1, baseDb: -3 });
  assert.equal(out[0].db, -3);
  assert.equal(out.at(-1).db, -3 + FLOOR_DB);
  const x = planCrossfade({ startSec: 0, durationSec: 1 });
  assert.equal(x.A.length, x.B.length);
  assert.equal(toDb(0), FLOOR_DB);
});

test('Premiere Level units: 0 dB = 0.17782794 linear, +15 dB = 1.0', () => {
  assert.ok(Math.abs(dbToLevel(0) - 0.17782794) < 1e-7);
  assert.ok(Math.abs(dbToLevel(15) - 1) < 1e-12);
  assert.ok(Math.abs(levelToDb(dbToLevel(-6.5)) + 6.5) < 1e-9);
});

test('whoosh: deterministic, peaks near peakAt, pans left to right, round-trips through WAV', () => {
  const a = synthWhoosh({ durationSec: 0.5, seed: 3 }), b = synthWhoosh({ durationSec: 0.5, seed: 3 });
  assert.deepEqual(Array.from(a.samples[0].slice(0, 50)), Array.from(b.samples[0].slice(0, 50)));
  const [L, R] = a.samples, n = L.length;
  const energy = (arr, s, e) => arr.slice(s, e).reduce((x, v) => x + v * v, 0);
  assert.ok(energy(L, 0, n / 4) > energy(R, 0, n / 4), 'starts left');
  assert.ok(energy(R, (3 * n) / 4, n) > energy(L, (3 * n) / 4, n), 'ends right');
  const env = analyzeAudio({ sampleRate: a.sampleRate, channels: a.samples }, { windowMs: 20 }).envelope;
  const loudest = env.reduce((m, e) => (e.db > m.db ? e : m));
  assert.ok(Math.abs(loudest.t - 0.62 * 0.5) < 0.08, `peak at ${loudest.t}`);
  const f = path.join(tmp(), 'w.wav');
  writeWav(f, a);
  const back = readWav(f);
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.channels.length, 2);
  assert.ok(Math.abs(back.channels[0][1000] - L[1000]) < 1e-4);
});

test('click detector flags a single-sample spike and nothing on smooth audio', () => {
  const sr = 48000, n = sr;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / sr);
  assert.equal(analyzeAudio({ sampleRate: sr, channels: [s] }).clicks.length, 0);
  s[24000] = 0.9;
  const c = analyzeAudio({ sampleRate: sr, channels: [s] }, { offsetSec: 10 }).clicks;
  assert.ok(c.some((x) => Math.abs(x.t - 10.5) < 0.01));
});

// ── verification of renders ─────────────────────────────────────────────
const flat = (w, h, v) => rgbImage(w, h, new Uint8Array(w * h * 3).fill(v));

test('judgeTransition: a smooth ramp passes, a hidden hard cut and a flash are flagged', () => {
  const ramp = [100, 100, 110, 120, 130, 140, 150, 150].map((v, i) => ({ t: i, img: flat(16, 9, v) }));
  assert.equal(judgeTransition(ramp).smooth, true);
  const cut = [100, 100, 100, 100, 150, 150, 150, 150].map((v, i) => ({ t: i, img: flat(16, 9, v) }));
  assert.match(judgeTransition(cut).issues.join(), /reads as a cut/);
  const flash = [100, 100, 130, 100, 100, 100].map((v, i) => ({ t: i, img: flat(16, 9, v) }));
  assert.match(judgeTransition(flash).issues.join(), /flash/);
  const dip = [120, 60, 20, 60, 120, 120].map((v, i) => ({ t: i, img: flat(16, 9, v) }));
  assert.match(judgeTransition(dip).issues.join(), /dips/);
  assert.equal(judgeTransition(dip, { kind: 'dip' }).smooth, true);
});

test('edge fades: black end and one-way ramp required', () => {
  const fin = [0, 40, 80, 120, 120].map((v, i) => ({ t: i, img: flat(8, 8, v) }));
  assert.equal(judgeTransition(fin, { kind: 'fadeIn' }).smooth, true);
  const pump = [0, 80, 40, 120, 120].map((v, i) => ({ t: i, img: flat(8, 8, v) }));
  assert.match(judgeTransition(pump, { kind: 'fadeIn' }).issues.join(), /reverses/);
  assert.match(judgeTransition(fin.slice().reverse(), { kind: 'fadeIn' }).issues.join(), /black end/);
});

// ── layout helpers ──────────────────────────────────────────────────────
const seq = {
  sequence: '_WORKING_x',
  video: [
    { trackIndex: 0, clips: [{ clipIndex: 0, name: 'A', startSec: 0, endSec: 6, inSec: 10, components: ['Opacity', 'Motion'] }, { clipIndex: 1, name: 'C', startSec: 11, endSec: 17, inSec: 4 }] },
    { trackIndex: 1, clips: [{ clipIndex: 0, name: 'B', startSec: 5.2, endSec: 11, inSec: 8 }] },
  ],
  audio: [],
};

test('findNext: overlap on another track, butt cut on any track', () => {
  const A = clipAt(seq, 'video', 0, 0);
  assert.equal(findNext(seq, A, 'overlap').relation, 'overlap');
  assert.equal(findNext(seq, A, 'overlap').clip.name, 'B');
  const B = clipAt(seq, 'video', 1, 0);
  const n = findNext(seq, B, 'same_track');
  assert.equal(n.relation, 'butt');
  assert.equal(n.clip.name, 'C');
});

test('freeTrack finds the lowest track free over a range', () => {
  assert.equal(freeTrack(seq, 'video', 1, 4, 1), 1);
  assert.equal(freeTrack(seq, 'video', 6, 9, 1), 2);
  assert.equal(freeTrack(seq, 'video', 6, 9, 0), 0, 'touching A’s end is not an overlap');
  assert.equal(freeTrack(seq, 'video', 5, 9, 0), 2);
  assert.equal(freeTrack(seq, 'video', 12, 14, 1), 1);
  assert.equal(seqToMedia({ startSec: 5, inSec: 8 }, 6), 9);
});

test('motion writes refuse sequences that are not _WORKING_ copies', () => {
  const a = new PremiereMotionActions({ send: async () => ({}) });
  assert.throws(() => a.guardWorkingCopy('YT Final'), /Refusing to animate/);
  assert.doesNotThrow(() => a.guardWorkingCopy('_WORKING_YT'));
  assert.doesNotThrow(() => a.guardWorkingCopy('YT Final', true));
});

test('titles and lower thirds render transparent PNGs at sequence size', async () => {
  const d = tmp();
  const t = await renderTitle({ text: 'Opening Day & Co', style: 'hero', width: 640, height: 360, y: 0.25, scrim: 0.4, outPath: path.join(d, 't.png') });
  const sharp = (await import('sharp')).default;
  const m = await sharp(t).metadata();
  assert.deepEqual([m.width, m.height, m.hasAlpha], [640, 360, true]);
  const lt = await renderLowerThird({ name: 'Jane Doe', role: 'Guide', width: 640, height: 360, outDir: d, prefix: 'lt' });
  for (const f of [lt.bar, lt.name, lt.role]) assert.ok(fs.statSync(f).size > 0);
  const { data, info } = await sharp(t).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, 'corner is transparent');
  assert.equal(info.channels, 4);
});
