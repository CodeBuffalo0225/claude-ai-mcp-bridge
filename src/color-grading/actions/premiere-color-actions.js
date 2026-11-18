// ============================================================================
//  Premiere colour actions — the ONLY layer that touches the editor.
//
//  Contract:
//   - Writes go only to sequences named `_WORKING_*` (repo naming rule:
//     never edit the source sequence) unless allowNonWorkingSequence is set.
//   - Every write is preceded by a snapshot file (restorable) and followed
//     by a read-back: a control counts as applied only when getValue()
//     returns the value written.
//   - Unsupported controls are returned in `skipped` with the reason.
//   - Nothing is simulated: bridge errors propagate.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { planLumetriWrites, LUMETRI_CONTROLS } from './lumetri-controls.js';
import { waitForFile } from '../analysis/frame-source.js';
import { analyzeFrames } from '../analysis/frame-analyzer.js';
import { metricOf } from '../recommend/recommender.js';
import { solveClosedLoop } from '../recommend/solver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIR = path.resolve(HERE, '../../../logs/color');
export const WORKING_PREFIX = '_WORKING_';

export class PremiereColorActions {
  constructor(bridge, { logDir = DEFAULT_LOG_DIR } = {}) {
    this.bridge = bridge;
    this.logDir = logDir;
  }

  async _send(cmd, params, opts) {
    const r = await this.bridge.send('premiere', cmd, params, opts);
    if (r && r.error) throw new Error(`${cmd}: ${r.error}`);
    return r;
  }

  guardWorkingCopy(sequenceName, allowNonWorkingSequence) {
    if (allowNonWorkingSequence) return;
    if (!sequenceName || !sequenceName.startsWith(WORKING_PREFIX)) {
      throw new Error(`Refusing to write grades to "${sequenceName || '(active sequence)'}". Duplicate it first (timeline_duplicate → "${WORKING_PREFIX}${sequenceName || 'name'}") and target the copy, or pass allowNonWorkingSequence:true if you really mean to grade this sequence.`);
    }
  }

  /**
   * With more than one Lumetri on a clip, "instance 0" is ambiguous: the
   * editor can reorder effects in the UI at any time. Found live: after a
   * reorder, a solve defaulting to instance 0 wrote Tint into the LUT's
   * Lumetri instead of the grade (reverted from its snapshot). Writes must
   * name the instance explicitly once there are several.
   */
  async guardInstance(target) {
    if (target.instance !== undefined && target.instance !== null) return;
    const p = await this.probe({ ...target, instance: 0 });
    if (p.lumetriCount > 1) {
      const summary = [];
      for (let i = 0; i < p.lumetriCount; i++) {
        const q = i === 0 ? p : await this.probe({ ...target, instance: i });
        const v = (name) => q.props?.find((x) => x.name === name && x.type === 'number')?.value;
        summary.push(`#${i}: Exposure ${v('Exposure')}, Temperature ${v('Temperature')}, Tint ${v('Tint')}`);
      }
      throw new Error(`Clip has ${p.lumetriCount} Lumetri instances — say which one to write (instance). Current: ${summary.join(' | ')}`);
    }
  }

  // ── reads ────────────────────────────────────────────────────────────
  probe(target) { return this._send('color.probeLumetri', target); }
  sourceInfo(target) { return this._send('color.sourceInfo', target); }
  listClips(sequenceName) { return this._send('color.listClips', { sequenceName }); }

  /** Step 2 for camera log: Premiere log colour management (project-wide, log media only). */
  async applyLogColorManagement(target, { allowNonWorkingSequence = false } = {}) {
    this.guardWorkingCopy(target.sequenceName, allowNonWorkingSequence);
    const r = await this._send('color.applyLogColorManagement', target);
    this._appendLog({ kind: 'source-transform', at: new Date().toISOString(), target, result: r, revert: 'app.project.setLogColorManagement(false)' });
    return r;
  }

  async exportFrame({ sequenceName, timeSec, outPath }) {
    const base = outPath.replace(/\.png$/i, '');
    fs.mkdirSync(path.dirname(base), { recursive: true });
    if (fs.existsSync(`${base}.png`)) fs.unlinkSync(`${base}.png`); // our own previous export of this exact path
    // 4K colour-managed (log → tone-mapped) renders can exceed the default
    // 30 s request timeout on the first frame (seen live, Premiere 26.5.2).
    const r = await this._send('color.exportFrame', { sequenceName, timeSec, outPath: base }, { timeoutMs: 180000 });
    if (!r.ok) throw new Error(`exportFramePNG returned false at ${r.timecode}`);
    await waitForFile(`${base}.png`);
    return { path: `${base}.png`, timecode: r.timecode, sequence: r.sequence };
  }

  // ── snapshot / restore ───────────────────────────────────────────────
  async snapshot(target, label = 'snapshot') {
    const p = await this.probe(target);
    const snap = {
      kind: 'lumetri-snapshot',
      createdAt: new Date().toISOString(),
      target: { sequenceName: p.sequence, trackIndex: p.clip.trackIndex, clipIndex: p.clip.clipIndex, instance: p.instance },
      clip: p.clip,
      lumetriCount: p.lumetriCount,
      values: (p.props || []).filter((x) => x.type === 'number').map((x) => ({ index: x.index, name: x.name, value: x.value })),
    };
    fs.mkdirSync(path.join(this.logDir, 'snapshots'), { recursive: true });
    const file = path.join(this.logDir, 'snapshots', `${stamp()}_${safe(p.sequence)}_V${p.clip.trackIndex}-${p.clip.clipIndex}_i${p.instance}_${label}.json`);
    fs.writeFileSync(file, JSON.stringify(snap, null, 1));
    return { file, snapshot: snap, probe: p };
  }

  async restore(snapshotFile, { allowNonWorkingSequence = false } = {}) {
    const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    if (snap.kind !== 'lumetri-snapshot') throw new Error('Not a lumetri snapshot file');
    this.guardWorkingCopy(snap.target.sequenceName, allowNonWorkingSequence);
    if (!snap.values.length) {
      return { restored: [], note: 'Snapshot was taken before Lumetri existed on this instance. A script cannot remove the added Lumetri (no remove API); disable it with its fx toggle or delete it in Effect Controls.' };
    }
    const cur = await this.probe(snap.target);
    const now = new Map((cur.props || []).map((x) => [x.index, x.value]));
    const writes = snap.values.filter((v) => now.get(v.index) !== v.value).map((v) => ({ index: v.index, name: v.name, value: v.value }));
    if (!writes.length) return { restored: [], note: 'Already identical to the snapshot.' };
    const r = await this._send('color.setLumetriParams', { ...snap.target, writes });
    return { restored: r.results, allVerified: r.results.every((x) => x.ok) };
  }

  // ── writes ───────────────────────────────────────────────────────────
  /**
   * @param target { sequenceName, trackIndex, clipIndex, instance }
   * @param ops lumetri ops [{ op:'lumetri', control, value, mode }]
   */
  async applyLumetri(target, ops, { allowNonWorkingSequence = false, secondaryKeyConfirmed = false, ensure = true, dryRun = false } = {}) {
    this.guardWorkingCopy(target.sequenceName, allowNonWorkingSequence);
    await this.guardInstance(target);
    let probe = await this.probe(target);
    let added = false;
    if (!probe.props) {
      if (!ensure) throw new Error(`Clip has ${probe.lumetriCount} Lumetri instance(s); instance ${target.instance || 0} missing (pass ensure:true to add it)`);
      // Add the instance with an empty write list, then probe the fresh defaults.
      const addRes = await this._send('color.setLumetriParams', { ...target, ensure: true, writes: [], dryRun });
      added = addRes.added;
      probe = await this.probe(target);
      if (!probe.props) throw new Error('Lumetri instance still missing after add');
    }
    const snap = dryRun ? null : await this.snapshot(target, added ? 'after-add' : 'before');
    const { writes, skipped } = planLumetriWrites(probe.props, ops, { secondaryKeyConfirmed });
    let results = [];
    if (writes.length) {
      const r = await this._send('color.setLumetriParams', { ...target, writes: writes.map(({ index, name, value }) => ({ index, name, value })), dryRun });
      results = r.results.map((res) => ({ ...res, control: writes.find((w) => w.index === res.index)?.control, warning: writes.find((w) => w.index === res.index)?.warning || undefined }));
    }
    const failed = results.filter((x) => x.error || x.ok === false);
    const log = { kind: 'lumetri-apply', at: new Date().toISOString(), target, added, dryRun, snapshot: snap?.file || null, results, skipped };
    this._appendLog(log);
    return { ...log, verified: !dryRun && results.length > 0 && failed.length === 0, failed };
  }

  /**
   * Closed loop: write `control`, re-export the frame from Premiere,
   * re-measure `metric`, repeat (solver.js). Leaves the control at the best
   * measured value and returns every measurement.
   */
  async solveControl(target, { control, metric, targetValue, tolerance, probeStep, bounds, timeSec, workDir, allowNonWorkingSequence = false, detect = true }) {
    this.guardWorkingCopy(target.sequenceName, allowNonWorkingSequence);
    await this.guardInstance(target);
    const def = LUMETRI_CONTROLS[control];
    if (!def) throw new Error(`${control} is not a scriptable control`);
    let probe = await this.probe(target);
    if (!probe.props) {
      // Ungraded clip: add the Lumetri instance first (same ensure path as
      // applyLumetri). Found live: correct_primary on a fresh clip used to
      // fail here while its caller still reported applied:true.
      await this.applyLumetri(target, [], { allowNonWorkingSequence, ensure: true });
      probe = await this.probe(target);
      if (!probe.props) throw new Error(`Lumetri instance ${target.instance || 0} could not be added to the clip`);
    }
    const snap = await this.snapshot(target, `before-solve-${control}`);
    const x0 = (await this._readControl(target, control)) ?? def.neutral;
    // One Lumetri value covers the whole clip, so it may be solved against
    // several frames: the metric is their MEAN (found live: a Temperature
    // solved at the clip's least-warm frame left most of the clip warm).
    const times = Array.isArray(timeSec) ? timeSec : [timeSec];
    let n = 0;
    const perFrame = [];
    const measure = async (x) => {
      const w = await this.applyLumetri(target, [{ op: 'lumetri', control, value: x, mode: 'absolute' }], { allowNonWorkingSequence });
      if (!w.verified) throw new Error(`write of ${control}=${x} not verified: ${JSON.stringify(w.failed)}`);
      const vals = [];
      for (const t of times) {
        const fr = await this.exportFrame({ sequenceName: target.sequenceName, timeSec: t, outPath: path.join(workDir, `solve_${safe(control)}_${n}_${t}`) });
        const a = await analyzeFrames([{ path: fr.path, time: t }], { detect: detect && /^(skin|warmth)\./.test(metric) });
        vals.push(metricOf(a.frames[0], metric));
      }
      n++;
      perFrame.push({ x: Math.round(x * 1000) / 1000, byTime: Object.fromEntries(times.map((t, i) => [t, Math.round(vals[i] * 1e5) / 1e5])) });
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const res = await solveClosedLoop({ x0, measure, target: targetValue, tolerance, probeStep, bounds: bounds || def.uiRange, maxStep: (def.uiRange[1] - def.uiRange[0]) / 8 });
    if (res.finalWriteNeeded) await this.applyLumetri(target, [{ op: 'lumetri', control, value: res.bestX, mode: 'absolute' }], { allowNonWorkingSequence });
    return { control, metric, snapshot: snap.file, solvedOn: times.length > 1 ? `mean of ${times.length} frames` : 'single frame', perFrame, ...res };
  }

  async _readControl(target, control) {
    const p = await this.probe(target);
    const { writes } = planLumetriWrites(p.props || [], [{ op: 'lumetri', control, value: 0, mode: 'delta' }], { secondaryKeyConfirmed: true });
    return writes[0]?.before;
  }

  _appendLog(entry) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'actions.jsonl'), JSON.stringify(entry) + '\n');
    } catch { /* logging must never mask the real result */ }
  }
}

export function defaultWorkDir() {
  const d = path.join(os.tmpdir(), 'claude-ai-editor-color', stamp());
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function safe(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60); }
