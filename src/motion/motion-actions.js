// ============================================================================
//  Premiere motion actions — the ONLY motion layer that touches the editor.
//
//  Contract (same as the colour actions):
//   - Writes go only to sequences named `_WORKING_*` unless
//     allowNonWorkingSequence is set (never edit the source sequence).
//   - Every keyframe write is read back by the JSX (first/middle/last key).
//   - Nothing is simulated: bridge errors propagate as exceptions.
//   - Every write is appended to logs/motion/actions.jsonl.
//
//  Units verified live on Premiere 26.5.2 (2026-11-17):
//   key time  = media time  = seqT − clip.start + clip.inPoint
//   Opacity % · Scale % · Position normalised [x, y] · Volume ▸ Level is
//   linear amplitude with 1.0 = +15 dB (0 dB = 0.17782794).
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForFile } from '../color-grading/analysis/frame-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIR = path.resolve(HERE, '../../logs/motion');
// Premiere references imported files in place, so generated titles and SFX
// must live somewhere durable (not a temp dir that gets swept).
export const DEFAULT_ASSET_DIR = path.join(os.homedir(), 'Downloads', 'cache', 'claude-ai-editor-motion');
export const WORKING_PREFIX = '_WORKING_';

/** Components every clip has; anything else is an effect a re-place would lose. */
export const INTRINSIC_COMPONENTS = new Set(['Opacity', 'Motion', 'Time Remapping', 'Volume', 'Channel Volume', 'Panner']);

export const seqToMedia = (clip, seqT) => seqT - clip.startSec + clip.inSec;
export const dbToLevel = (db) => 10 ** ((db - 15) / 20);
export const levelToDb = (v) => (v > 0 ? 20 * Math.log10(v) + 15 : -Infinity);

export class PremiereMotionActions {
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
      throw new Error(`Refusing to animate "${sequenceName || '(active sequence)'}". Duplicate it first (timeline_duplicate → "${WORKING_PREFIX}${sequenceName || 'name'}") and target the copy, or pass allowNonWorkingSequence:true if you really mean this sequence.`);
    }
  }

  // ── reads ────────────────────────────────────────────────────────────
  async listClips(sequenceName) {
    const r = await this._send('motion.listClips', { sequenceName });
    r.fps = r.frameDurationSec ? 1 / r.frameDurationSec : 30;
    return r;
  }
  probe(target) { return this._send('motion.probe', target); }

  // ── writes ───────────────────────────────────────────────────────────
  async addEffect(target, effectName) { return this._logged('addEffect', target, await this._send('motion.addEffect', { ...target, effectName })); }
  async setValues(target, values) { return this._logged('setValues', target, await this._send('motion.setValues', { ...target, values })); }
  async setKeys(target, spec) {
    const r = await this._send('motion.setKeys', { ...target, ...spec });
    if (!r.ok) throw new Error(`motion.setKeys read-back mismatch on ${spec.component} ▸ ${spec.param}: ${JSON.stringify(r.readBack)}`);
    return this._logged('setKeys', { ...target, component: spec.component, param: spec.param }, { keysWritten: r.keysWritten, interp: r.interp, readBack: r.readBack });
  }
  clearKeys(target, spec) { return this._send('motion.clearKeys', { ...target, ...spec }); }
  async placeClip(p) { return this._logged('placeClip', p, await this._send('motion.placeClip', p)); }
  async removeClip(p) { return this._logged('removeClip', p, await this._send('motion.removeClip', p)); }
  setClipEnd(p) { return this._send('motion.setClipEnd', p); }
  async clearTracks(p) { return this._logged('clearTracks', p, await this._send('motion.clearTracks', p)); }
  importFiles(paths) { return this._send('motion.importFiles', { paths }); }
  ensureTracks(p) { return this._send('motion.ensureTracks', p); }

  /** Render one Program-monitor frame (QE exportFramePNG) and wait for the file. */
  async exportFrame(sequenceName, timeSec, outBase) {
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    // Heavy blur frames (directional blur at full strength) can take > 30 s
    // to render in software — give the render its own budget.
    const r = await this._send('color.exportFrame', { sequenceName, timeSec, outPath: outBase.replace(/\.png$/i, '') }, { timeoutMs: 180000 });
    await waitForFile(r.path, { timeoutMs: 30000 });
    return r.path;
  }

  /** Mixed sequence audio for a range → 48 kHz WAV (AME, async job). */
  async exportAudio(sequenceName, startSec, endSec, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const r = await this.bridge.sendJob('premiere', 'export.clipAudio', { sequenceName, startSec, endSec, outputPath }, { maxWaitMs: 300000 });
    if (r && r.error) throw new Error(`export.clipAudio: ${r.error}`);
    await waitForFile(outputPath, { timeoutMs: 120000, intervalMs: 400 });
    return outputPath;
  }

  _logged(kind, target, result) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'actions.jsonl'), JSON.stringify({ kind, at: new Date().toISOString(), target, result }) + '\n');
    } catch { /* logging never masks the result */ }
    return result;
  }
}
