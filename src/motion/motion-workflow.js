// ============================================================================
//  Motion workflow — recipes → keyframes on real clips → measured result.
//
//  Premiere's scripted transition API (QE addTransition) hangs or renders
//  solid white on this build, so every transition here is built from
//  keyframes on the clips themselves (Opacity / Motion / Gaussian Blur /
//  Directional Blur / Offset / Crop / Volume). That also makes every
//  transition editable afterwards in Effect Controls like hand-made work.
//
//  Layers: A = outgoing clip, B = incoming clip.
//   - Butt cut (A ends where B starts, any video track): same_track recipes
//     (dip, zoom push, whip pan).
//   - Overlap (A and B on different video tracks, overlapping): dissolve,
//     blur dissolve, feathered wipe. The TOP clip carries the opacity/crop
//     animation; when A is on top the animation is inverted onto A, which
//     is visually identical (A·β + B·(1−β) with β = 1 − α).
//   - A butt cut can be turned into an overlap (`lift`): B is re-placed one
//     track up with `durationSec` of head handle. Refused when B carries
//     effects a re-place would lose (grades) — build A/B roll instead.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { PremiereMotionActions, DEFAULT_ASSET_DIR, INTRINSIC_COMPONENTS, seqToMedia, dbToLevel, levelToDb } from './motion-actions.js';
import { FX, transitionRecipe, textRecipe, lowerThirdRecipe, planAnims, TRANSITIONS, TEXT_ANIMATIONS } from './recipes.js';
import { planFade } from './audio-curves.js';
import { synthWhoosh, writeWav } from './sfx.js';
import { renderTitle, renderLowerThird } from './titles.js';
import { loadFrames, judgeTransition, contactSheet, readWav, analyzeAudio } from './motion-verify.js';

const FX_BY_NAME = Object.fromEntries(Object.entries(FX).map(([k, v]) => [v.name, { key: k, ...v }]));
const TOL = 0.02; // seconds: "touching" tolerance (< 1 frame at 50 fps)

export class MotionWorkflow {
  constructor(bridge, { logDir, assetDir = DEFAULT_ASSET_DIR } = {}) {
    this.act = new PremiereMotionActions(bridge, { logDir });
    this.assetDir = assetDir;
  }

  // ── layout ───────────────────────────────────────────────────────────

  /**
   * Lay shots out as an A/B roll ready for the given transitions: overlap
   * transitions put B on the other of two tracks, overlapping A by the
   * transition length; butt transitions keep B on A's track.
   * @param shots       [{mediaPath|projectItemName, inSec, outSec}]
   * @param transitions [{name, durationSec?}] (length shots−1)
   */
  async buildABRoll({ sequenceName, shots, transitions = [], tracks = [0, 1], startSec = 0, clear = true, allowNonWorkingSequence = false }) {
    this.act.guardWorkingCopy(sequenceName, allowNonWorkingSequence);
    const seq = await this.act.listClips(sequenceName);
    if (clear) await this.act.clearTracks({ sequenceName, video: seq.video.map((t) => t.trackIndex), audio: seq.audio.map((t) => t.trackIndex) });
    await this.act.ensureTracks({ sequenceName, video: Math.max(...tracks) + 1, audio: Math.max(...tracks) + 1 });
    let t = startSec, side = 0;
    const placed = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (i > 0) {
        const tr = transitions[i - 1];
        const rec = tr ? transitionRecipe(tr.name, { durationSec: tr.durationSec ?? 1 }) : null;
        if (rec && rec.arrangement === 'overlap') {
          const d = tr.durationSec ?? rec.defaultDuration;
          t -= d;
          side = 1 - side;
        }
      }
      const r = await this.act.placeClip({ sequenceName, mediaPath: s.mediaPath, projectItemName: s.projectItemName, kind: 'video', trackIndex: tracks[side], inSec: s.inSec, outSec: s.outSec, startSec: t });
      placed.push({ shot: i, trackIndex: tracks[side], ...r });
      t = r.endSec;
    }
    return { placed, endSec: t };
  }

  // ── transitions ──────────────────────────────────────────────────────

  /**
   * Apply a transition between clip A (trackIndex/clipIndex) and the clip
   * that follows it (butt on any video track, or overlapping on another).
   */
  async applyTransition({ sequenceName, name, trackIndex = 0, clipIndex, durationSec, audio = true, sfx, sfxGainDb = -14, lift = false, allowNonWorkingSequence = false }) {
    this.act.guardWorkingCopy(sequenceName, allowNonWorkingSequence);
    if (!TRANSITIONS.includes(name)) throw new Error(`unknown transition "${name}" — one of ${TRANSITIONS.join(', ')}`);
    let seq = await this.act.listClips(sequenceName);
    const A = clipAt(seq, 'video', trackIndex, clipIndex);
    const probeRec = transitionRecipe(name, { durationSec: durationSec ?? 1, height: seq.height, fps: seq.fps });
    const d0 = durationSec ?? probeRec.defaultDuration;
    let B = findNext(seq, A, probeRec.arrangement);

    if (probeRec.arrangement === 'overlap' && B.relation === 'butt') {
      if (!lift) throw new Error(`${name} needs the next shot on another track overlapping A by ${d0}s. Pass lift:true to re-place it one track up (uses ${d0}s of its head handle), or lay the shots out with buildABRoll.`);
      B = await this._lift(sequenceName, seq, B.clip, d0);
      seq = await this.act.listClips(sequenceName);
      B = findNext(seq, clipAt(seq, 'video', trackIndex, clipIndex), 'overlap');
    }
    if (!B) throw new Error(`No shot follows ${A.name} (track V${trackIndex + 1}) — need a butt cut or an overlapping clip on another video track.`);

    // Window: centred on the cut for butt cuts; the real overlap for overlaps.
    let cut, d;
    if (B.relation === 'overlap') {
      const ov = A.endSec - B.clip.startSec;
      d = Math.min(d0, ov);
      cut = A.endSec - d / 2;
    } else {
      d = d0;
      cut = A.endSec;
      const handleA = cut - A.startSec, handleB = B.clip.endSec - cut;
      if (handleA < d / 2 || handleB < d / 2) throw new Error(`Shots too short for a ${d}s ${name}: A has ${handleA.toFixed(2)}s before the cut, B ${handleB.toFixed(2)}s after.`);
    }
    const rec = transitionRecipe(name, { durationSec: d, height: seq.height, fps: seq.fps });
    const aOnTop = B.relation === 'overlap' && A.trackIndex > B.clip.trackIndex;
    const { effects, anims } = aOnTop ? flipForAOnTop(rec) : rec;
    const clips = { A, B: B.clip };

    const fx = await this._ensureEffects(sequenceName, clips, effects, anims);
    const plans = planAnims(anims, { fps: seq.fps, mode: 'baked', stepFrames: 1 });
    const writes = [];
    for (const p of plans) writes.push(await this._writePlan(sequenceName, clips[p.layer], p, { offsetSec: cut, height: seq.height }));

    const audioResult = audio ? await this._transitionAudio(sequenceName, seq, A, B.clip, rec.audio, cut, d) : { skipped: true };
    const sfxResult = sfx || rec.sfx ? (sfx === false ? null : await this.addWhoosh({ sequenceName, atSec: cut, durationSec: Math.max(0.6, d + 0.35), gainDb: sfxGainDb, seed: Math.round(cut * 1000) % 9973 })) : null;

    return {
      transition: name, arrangement: rec.arrangement, relation: B.relation, aOnTop,
      cutSec: round(cut), durationSec: d, windowSec: [round(cut - d / 2), round(cut + d / 2)],
      A: { track: A.trackIndex, clip: A.clipIndex, name: A.name }, B: { track: B.clip.trackIndex, clip: B.clip.clipIndex, name: B.clip.name },
      effectsAdded: fx, keyframes: writes, audio: audioResult, sfx: sfxResult,
    };
  }

  /** Fade a clip's head from black or its tail to black (+ its audio). */
  async fadeEdge({ sequenceName, trackIndex = 0, clipIndex, edge = 'head', durationSec = 1, curve, audio = true, allowNonWorkingSequence = false }) {
    this.act.guardWorkingCopy(sequenceName, allowNonWorkingSequence);
    const seq = await this.act.listClips(sequenceName);
    const C = clipAt(seq, 'video', trackIndex, clipIndex);
    const head = edge === 'head';
    const start = head ? C.startSec : C.endSec - durationSec;
    const anims = [{ layer: 'C', component: 'Opacity', param: 'Opacity', from: head ? 0 : 100, to: head ? 100 : 0, startRel: 0, durationSec, curve: curve || (head ? 'easeOutSine' : 'easeInSine') }];
    const [p] = planAnims(anims, { fps: seq.fps, mode: 'baked', stepFrames: 1 });
    const v = await this._writePlan(sequenceName, C, p, { offsetSec: start, height: seq.height });
    let a = null;
    if (audio) {
      a = [];
      for (const L of C.linked.filter((l) => l.kind === 'audio')) {
        const ac = clipAt(seq, 'audio', L.trackIndex, L.clipIndex);
        a.push(await this._levelFade(sequenceName, ac, head ? 'in' : 'out', start, durationSec, 'equalPower', seq.fps));
      }
    }
    return { edge, clip: C.name, windowSec: [round(start), round(start + durationSec)], video: v, audio: a };
  }

  // ── text & graphics ──────────────────────────────────────────────────

  /** Render a title still, place it above the picture, animate it in and out. */
  async addTitle({ sequenceName, text, style = 'hero', animation = 'blurIn', startSec, durationSec = 3, inSec = 0.7, outSec = 0.5, trackIndex, y, scrim = 0.4, allowNonWorkingSequence = false }) {
    this.act.guardWorkingCopy(sequenceName, allowNonWorkingSequence);
    if (!TEXT_ANIMATIONS.includes(animation)) throw new Error(`unknown text animation "${animation}" — one of ${TEXT_ANIMATIONS.join(', ')}`);
    const seq = await this.act.listClips(sequenceName);
    const png = await renderTitle({ text, style, width: seq.width, height: seq.height, y, scrim, outPath: this._asset(`title_${slug(text)}_${seq.width}x${seq.height}_${Date.now()}.png`) });
    const track = trackIndex ?? freeTrack(seq, 'video', startSec, startSec + durationSec, 1);
    const layer = await this._placeStill(sequenceName, png, track, startSec, durationSec);
    const anim = await this._animateLayer(sequenceName, layer, textRecipe(animation, { height: seq.height, inSec, outSec }), { fps: seq.fps, height: seq.height });
    return { text, style, animation, png, track: layer.trackIndex, startSec: layer.startSec, endSec: layer.endSec, ...anim };
  }

  /** Lower third = bar + name + role on three tracks, staggered in and out. */
  async addLowerThird({ sequenceName, name, role = '', startSec, durationSec = 4, inSec = 0.6, outSec = 0.45, accent, allowNonWorkingSequence = false }) {
    this.act.guardWorkingCopy(sequenceName, allowNonWorkingSequence);
    const seq = await this.act.listClips(sequenceName);
    const files = await renderLowerThird({ name, role, width: seq.width, height: seq.height, outDir: this._asset(''), prefix: `lt_${slug(name)}_${Date.now()}`, accent });
    const plan = lowerThirdRecipe({ height: seq.height });
    const out = [];
    let base = freeTrack(seq, 'video', startSec, startSec + durationSec, 1);
    for (const L of plan.layers) {
      const file = files[L.layer];
      if (!file) continue;
      const fresh = await this.act.listClips(sequenceName);
      const track = freeTrack(fresh, 'video', startSec, startSec + durationSec, base);
      const layer = await this._placeStill(sequenceName, file, track, startSec, durationSec);
      const anim = await this._animateLayer(sequenceName, layer, textRecipe(L.recipe, { height: seq.height, inSec, outSec }), { fps: seq.fps, height: seq.height, inDelay: L.inDelay, outLead: L.outLead });
      out.push({ layer: L.layer, recipe: L.recipe, png: file, track: layer.trackIndex, inDelay: L.inDelay, outLead: L.outLead, ...anim });
      base = track + 1;
    }
    return { name, role, startSec, endSec: startSec + durationSec, layers: out };
  }

  // ── audio ────────────────────────────────────────────────────────────

  /** Synthesise a whoosh whose peak lands on `atSec` and lay it on a free audio track. */
  async addWhoosh({ sequenceName, atSec, durationSec = 0.8, peakAt = 0.62, gainDb = -14, seed = 7, trackIndex }) {
    const seq = await this.act.listClips(sequenceName);
    const w = synthWhoosh({ durationSec, peakAt, gainDb, seed });
    const file = writeWav(this._asset(`whoosh_${seed}_${Math.round(durationSec * 1000)}ms_${Date.now()}.wav`), w);
    const start = Math.max(0, atSec - peakAt * durationSec);
    const track = trackIndex ?? freeTrack(seq, 'audio', start, start + durationSec, 2);
    await this.act.ensureTracks({ sequenceName, audio: track + 1 });
    const imp = await this.act.importFiles([file]);
    if (!imp.items?.[0]?.ok) throw new Error(`import failed for ${file}`);
    const r = await this.act.placeClip({ sequenceName, mediaPath: file, kind: 'audio', trackIndex: track, inSec: 0, outSec: durationSec, startSec: start });
    return { file, track, startSec: round(r.startSec), endSec: round(r.endSec), peakSec: round(start + peakAt * durationSec), gainDb };
  }

  // ── verification ─────────────────────────────────────────────────────

  async verifyTransition({ sequenceName, windowSec, samples = 9, kind, outDir, title }) {
    const [w0, w1] = windowSec;
    const pad = Math.min(0.25, (w1 - w0) * 0.3);
    const edge = kind === 'fadeIn' || kind === 'fadeOut';
    const t0 = edge ? (kind === 'fadeIn' ? w0 : w0 - pad) : w0 - pad, t1 = edge ? (kind === 'fadeIn' ? w1 + pad : w1) : w1 + pad;
    const times = Array.from({ length: samples }, (_, i) => Math.max(0, t0 + ((t1 - t0) * i) / (samples - 1)));
    const dir = outDir || this._asset(`verify_${Date.now()}`);
    const list = [];
    for (let i = 0; i < times.length; i++) list.push({ t: times[i], path: await this.act.exportFrame(sequenceName, times[i], path.join(dir, `f${String(i).padStart(2, '0')}_${times[i].toFixed(3)}`)) });
    const frames = await loadFrames(list, { maxWidth: 480 });
    const report = judgeTransition(frames, { kind });
    const sheet = await contactSheet(list, path.join(dir, 'contact_sheet.png'), { title: title || `${sequenceName} ${w0.toFixed(2)}–${w1.toFixed(2)}s`, cols: Math.min(samples, 5), labels: report.samples.map((s) => `${s.t.toFixed(2)}s  Y ${s.meanLuma.toFixed(2)}`) });
    return { ...report, frames: list.map((f) => f.path), contactSheet: sheet };
  }

  async verifyAudio({ sequenceName, startSec, endSec, events = [], outPath }) {
    const file = outPath || this._asset(`audio_${Date.now()}.wav`);
    await this.act.exportAudio(sequenceName, startSec, endSec, file);
    return { file, ...analyzeAudio(readWav(file), { offsetSec: startSec, events }) };
  }

  // ── internals ────────────────────────────────────────────────────────

  async _ensureEffects(sequenceName, clips, effects, anims) {
    const added = [];
    for (const e of effects) {
      const c = clips[e.layer], spec = FX[e.fx];
      const has = c.components.includes(spec.name);
      if (!has) {
        await this.act.addEffect({ sequenceName, kind: 'video', trackIndex: c.trackIndex, clipIndex: c.clipIndex }, spec.name);
        c.components.push(spec.name);
      }
      const animated = new Set(anims.filter((a) => a.layer === e.layer && a.component === spec.name).map((a) => a.param));
      const values = Object.entries(e.set || {}).filter(([k]) => !has || !animated.has(k)).map(([k, v]) => ({ component: spec.name, param: spec.params[k], value: v }));
      if (values.length) {
        const r = await this.act.setValues({ sequenceName, kind: 'video', trackIndex: c.trackIndex, clipIndex: c.clipIndex }, values);
        const bad = r.results.filter((x) => !x.ok);
        if (bad.length) throw new Error(`setting ${spec.name} on ${c.name} failed: ${JSON.stringify(bad)}`);
      }
      added.push({ layer: e.layer, clip: c.name, effect: spec.name, reused: has, set: e.set || {} });
    }
    return added;
  }

  /** Write one planned anim onto a clip. offsetSec = sequence time of the plan's t = 0. */
  async _writePlan(sequenceName, clip, plan, { offsetSec }) {
    let component = plan.component, param = plan.param, conv = (v) => v;
    if (FX_BY_NAME[component]) param = FX_BY_NAME[component].params[plan.param] || plan.param;
    if (component === 'Motion' && (param === 'PositionX' || param === 'PositionY')) {
      const axis = param === 'PositionX' ? 0 : 1;
      const base = await this._staticValue(sequenceName, clip, 'Motion', 'Position', [0.5, 0.5]);
      param = 'Position';
      conv = (v) => { const out = [...base]; out[axis] = base[axis] + v; return out; };
    }
    const lo = clip.inSec, hi = clip.inSec + (clip.endSec - clip.startSec);
    const keys = plan.keys
      .map((k) => ({ t: round(seqToMedia(clip, offsetSec + k.t), 6), v: conv(k.v) }))
      .filter((k) => k.t >= lo - 1e-3 && k.t <= hi + 1e-3);
    if (keys.length < 2) throw new Error(`${component} ▸ ${param}: the animation window falls outside ${clip.name} (${clip.startSec.toFixed(2)}–${clip.endSec.toFixed(2)}s)`);
    const target = { sequenceName, kind: 'video', trackIndex: clip.trackIndex, clipIndex: clip.clipIndex };
    const r = await this.act.setKeys(target, { component, param, keys, interp: plan.interp });
    return { clip: clip.name, component, param, keys: keys.length, from: keys[0], to: keys[keys.length - 1], readBack: r.readBack };
  }

  async _staticValue(sequenceName, clip, component, param, fallback) {
    const p = await this.act.probe({ sequenceName, kind: 'video', trackIndex: clip.trackIndex, clipIndex: clip.clipIndex });
    const c = p.components.find((x) => x.name === component);
    const v = c?.params?.find?.((x) => x.name === param)?.value;
    return v ?? fallback;
  }

  async _transitionAudio(sequenceName, seq, A, B, type, cut, d) {
    const aA = A.linked.filter((l) => l.kind === 'audio').map((l) => clipAt(seq, 'audio', l.trackIndex, l.clipIndex));
    const aB = B.linked.filter((l) => l.kind === 'audio').map((l) => clipAt(seq, 'audio', l.trackIndex, l.clipIndex));
    const out = { type, A: [], B: [] };
    let wa, wb;
    if (type === 'equalPower') { wa = wb = [cut - d / 2, d]; }
    else if (type === 'fadeOutIn') { wa = [cut - d / 2, d / 2]; wb = [cut, d / 2]; }
    else { const s = Math.min(d / 2, 0.1); wa = [cut - s, s]; wb = [cut, s]; } // shortCrossfade: de-click, the SFX carries the cut
    for (const c of aA) out.A.push(await this._levelFade(sequenceName, c, 'out', wa[0], wa[1], 'equalPower', seq.fps));
    for (const c of aB) out.B.push(await this._levelFade(sequenceName, c, 'in', wb[0], wb[1], 'equalPower', seq.fps));
    return out;
  }

  async _levelFade(sequenceName, clip, kind, startSec, durationSec, law, fps) {
    const target = { sequenceName, kind: 'audio', trackIndex: clip.trackIndex, clipIndex: clip.clipIndex };
    const p = await this.act.probe(target);
    const lvl = p.components.find((c) => c.name === 'Volume')?.params?.find?.((x) => x.name === 'Level');
    if (!lvl) throw new Error(`${clip.name}: no Volume ▸ Level`);
    const baseDb = lvl.timeVarying ? 0 : levelToDb(lvl.value);
    const plan = planFade({ kind, startSec, durationSec, law, fps, stepFrames: 1, baseDb });
    const keys = plan.map((k) => ({ t: round(seqToMedia(clip, k.t), 6), v: dbToLevel(k.db) }));
    const r = await this.act.setKeys(target, { component: 'Volume', param: 'Level', keys, interp: 0 });
    return { clip: clip.name, track: clip.trackIndex, kind, law, windowSec: [round(startSec), round(startSec + durationSec)], baseDb: round(baseDb, 2), keys: keys.length, readBack: r.readBack };
  }

  async _placeStill(sequenceName, file, trackIndex, startSec, durationSec) {
    await this.act.ensureTracks({ sequenceName, video: trackIndex + 1 });
    const imp = await this.act.importFiles([file]);
    if (!imp.items?.[0]?.ok) throw new Error(`import failed for ${file}`);
    const r = await this.act.placeClip({ sequenceName, mediaPath: file, kind: 'video', trackIndex, startSec });
    if (Math.abs(r.endSec - (startSec + durationSec)) > 0.04) {
      const e = await this.act.setClipEnd({ sequenceName, kind: 'video', trackIndex, clipIndex: r.clipIndex, endSec: startSec + durationSec });
      if (!e.ok) throw new Error(`could not set ${path.basename(file)} to ${durationSec}s (got ${e.startSec}–${e.endSec})`);
    }
    const seq = await this.act.listClips(sequenceName);
    return clipAt(seq, 'video', trackIndex, r.clipIndex);
  }

  async _animateLayer(sequenceName, layer, recipe, { fps, height, inDelay = 0, outLead = 0 }) {
    const clips = { T: layer };
    const all = [...recipe.in, ...recipe.out];
    const fx = await this._ensureEffects(sequenceName, clips, recipe.effects, all);
    const writes = [];
    for (const p of planAnims(recipe.in, { fps, mode: 'baked', stepFrames: 1 })) writes.push(await this._writePlan(sequenceName, layer, p, { offsetSec: layer.startSec + inDelay, height }));
    for (const p of planAnims(recipe.out, { fps, mode: 'baked', stepFrames: 1 })) writes.push(await this._writePlan(sequenceName, layer, p, { offsetSec: layer.endSec - outLead - 1 / fps, height }));
    return { effectsAdded: fx, keyframes: writes };
  }

  async _lift(sequenceName, seq, B, d) {
    const extra = B.components.filter((c) => !INTRINSIC_COMPONENTS.has(c));
    if (extra.length) throw new Error(`Can't lift ${B.name}: it carries ${extra.join(', ')}, which a re-place would drop. Lay the shots out as an A/B roll (buildABRoll) or move it up by hand.`);
    if (B.inSec < d) throw new Error(`${B.name} has only ${B.inSec.toFixed(2)}s of head handle; ${d}s needed to overlap.`);
    if (!B.mediaPath) throw new Error(`${B.name} has no media path to re-place`);
    const up = B.trackIndex + 1;
    await this.act.ensureTracks({ sequenceName, video: up + 1, audio: up + 1 });
    await this.act.removeClip({ sequenceName, kind: 'video', trackIndex: B.trackIndex, clipIndex: B.clipIndex, withLinked: true });
    return this.act.placeClip({ sequenceName, mediaPath: B.mediaPath, kind: 'video', trackIndex: up, inSec: B.inSec - d, outSec: B.outSec, startSec: B.startSec - d });
  }

  _asset(name) {
    fs.mkdirSync(this.assetDir, { recursive: true });
    return path.join(this.assetDir, name);
  }
}

// ── pure helpers (exported for tests) ──────────────────────────────────

export function clipAt(seq, kind, trackIndex, clipIndex) {
  const tr = seq[kind].find((t) => t.trackIndex === trackIndex);
  const c = tr?.clips.find((x) => x.clipIndex === clipIndex);
  if (!c) throw new Error(`No ${kind} clip ${clipIndex} on track ${trackIndex + 1} of ${seq.sequence}`);
  return { ...c, trackIndex, components: [...(c.components || [])], linked: c.linked || [] };
}

/** The shot after A: butt (any video track, same track preferred) or overlapping on another track. */
export function findNext(seq, A, arrangement) {
  const all = seq.video.flatMap((t) => t.clips.map((c) => ({ ...c, trackIndex: t.trackIndex, components: [...(c.components || [])], linked: c.linked || [] })))
    .filter((c) => !(c.trackIndex === A.trackIndex && c.clipIndex === A.clipIndex));
  const overlap = all.filter((c) => c.trackIndex !== A.trackIndex && c.startSec > A.startSec + TOL && c.startSec < A.endSec - TOL && c.endSec > A.endSec + TOL)
    .sort((a, b) => a.startSec - b.startSec)[0];
  const butts = all.filter((c) => Math.abs(c.startSec - A.endSec) <= TOL).sort((a, b) => (a.trackIndex === A.trackIndex ? -1 : 0) - (b.trackIndex === A.trackIndex ? -1 : 0));
  if (arrangement === 'overlap' && overlap) return { relation: 'overlap', clip: overlap };
  if (butts[0]) return { relation: 'butt', clip: butts[0] };
  if (overlap) return { relation: 'overlap', clip: overlap };
  return null;
}

/** Lowest video/audio track ≥ minTrack with nothing between t0 and t1. */
export function freeTrack(seq, kind, t0, t1, minTrack = 0) {
  for (let i = minTrack; ; i++) {
    const tr = seq[kind].find((t) => t.trackIndex === i);
    if (!tr) return i;
    if (!tr.clips.some((c) => c.startSec < t1 - TOL && c.endSec > t0 + TOL)) return i;
  }
}

/**
 * With A on top, move B's opacity/crop reveal onto A as the inverse
 * (opacity 0→100 on B ≡ 100→0 on A; Crop Left 100→0 on B ≡ Crop Right
 * 0→100 on A). Blur anims stay on their layers.
 */
export function flipForAOnTop(rec) {
  const isReveal = (a) => a.layer === 'B' && (a.component === 'Opacity' || a.component === 'Crop');
  const flipParam = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const anims = rec.anims.map((a) => (isReveal(a)
    ? { ...a, layer: 'A', param: a.component === 'Crop' ? flipParam[a.param] : a.param, from: 100 - a.from, to: 100 - a.to }
    : a));
  const effects = rec.effects.map((e) => (e.layer === 'B' && e.fx === 'crop'
    ? { ...e, layer: 'A', set: Object.fromEntries(Object.entries(e.set || {}).map(([k, v]) => [flipParam[k] || k, flipParam[k] ? 100 - v : v])) }
    : e));
  return { ...rec, anims, effects };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'title';
function round(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }
