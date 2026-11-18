// ============================================================================
//  Motion verification — measured from Premiere's own renders, not assumed.
//
//  Video: a frame series across the transition window →
//    luma curve (dip / flash), frame-to-frame change (a smooth transition
//    spreads change over many frames; a hidden hard cut concentrates it in
//    one), sharpness (blur actually applied?), and a labelled contact sheet.
//  Audio: the mixed WAV of the window → short-term RMS envelope (dip / bump
//  at the cut) and a click detector (sample jumps far above the local level).
//
//  Frames are composited over black first (QE PNGs are RGBA, see image-io).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { decodeRGB } from '../color-grading/analysis/image-io.js';

const lumaOf = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

/** Per-frame stats on a decoded RGB image. */
export function frameStats(img) {
  const { width: w, height: h, data } = img;
  let sum = 0, grad = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, l = lumaOf(data, i);
      sum += l; n++;
      if (x + 1 < w && y + 1 < h) grad += Math.abs(lumaOf(data, i + 3) - l) + Math.abs(lumaOf(data, i + w * 3) - l);
    }
  }
  return { meanLuma: sum / n, sharpness: (grad / n) * 100 };
}

/** Mean absolute luma difference between two same-size images. */
export function frameDiff(a, b) {
  let s = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) s += Math.abs(lumaOf(a.data, p * 3) - lumaOf(b.data, p * 3));
  return s / n;
}

/**
 * Judge a transition from its frame series.
 * @param frames [{t, img}] in time order (first/last = outside the window)
 */
export function judgeTransition(frames, { kind = 'dissolve' } = {}) {
  const stats = frames.map((f) => ({ t: f.t, ...frameStats(f.img) }));
  const diffs = [];
  for (let i = 1; i < frames.length; i++) diffs.push(frameDiff(frames[i - 1].img, frames[i].img));
  const L = stats.map((s) => s.meanLuma);
  const ends = Math.min(L[0], L[L.length - 1]);
  const endsMax = Math.max(L[0], L[L.length - 1]);
  const minL = Math.min(...L.slice(1, -1)), maxL = Math.max(...L.slice(1, -1));
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const peak = Math.max(...diffs);
  const total = diffs.reduce((a, b) => a + b, 0);
  const report = {
    samples: stats.map((s, i) => ({ t: round(s.t, 3), meanLuma: round(s.meanLuma, 4), sharpness: round(s.sharpness, 2), changeFromPrev: i ? round(diffs[i - 1], 4) : null })),
    lumaDipRatio: round(ends > 0 ? minL / ends : 1, 3),
    flashRatio: round(endsMax > 0 ? maxL / endsMax : 1, 3),
    // Share of all frame-to-frame change that happens in the single biggest
    // step: ~1 = a hard cut hiding inside the "transition", low = spread out.
    peakChangeShare: round(total > 0 ? peak / total : 0, 3),
    peakToMedianChange: round(median > 0 ? peak / median : 0, 2),
    minSharpness: round(Math.min(...stats.map((s) => s.sharpness)), 2),
    endSharpness: round(Math.min(stats[0].sharpness, stats[stats.length - 1].sharpness), 2),
  };
  const issues = [];
  if (kind === 'fadeIn' || kind === 'fadeOut') {
    // Edge fade: one end must be black, and the luma must move one way only.
    const seq = kind === 'fadeIn' ? L : [...L].reverse();
    report.blackEndLuma = round(seq[0], 4);
    report.reversals = seq.slice(1).filter((v, i) => v < seq[i] - 0.02).length;
    if (report.blackEndLuma > 0.03) issues.push(`${kind}: the black end only gets to luma ${report.blackEndLuma}`);
    if (report.reversals) issues.push(`${kind}: luma reverses direction ${report.reversals}× (pumping)`);
    report.issues = issues;
    report.smooth = issues.length === 0;
    return report;
  }
  if (kind !== 'dip' && report.lumaDipRatio < 0.85) issues.push(`luma dips to ${Math.round(report.lumaDipRatio * 100)}% of the shots around it (unintended darkening)`);
  if (kind === 'dip' && report.lumaDipRatio > 0.25) issues.push(`dip to black only reaches ${Math.round(report.lumaDipRatio * 100)}% — the dip is not happening`);
  if (report.flashRatio > 1.12) issues.push(`flash: brightest frame is ${Math.round((report.flashRatio - 1) * 100)}% above both shots`);
  if (kind === 'masked') {
    // Zoom push / whip pan: the cut is real but must be hidden by blur —
    // the frames around the cut should be much softer than the shots.
    report.blurAtCutRatio = round(report.endSharpness > 0 ? report.minSharpness / report.endSharpness : 1, 3);
    if (report.blurAtCutRatio > 0.5) issues.push(`cut is not masked: softest frame keeps ${Math.round(report.blurAtCutRatio * 100)}% of the shots' detail`);
  } else if (report.peakChangeShare > 0.6 && frames.length >= 6) issues.push(`${Math.round(report.peakChangeShare * 100)}% of the change happens in one step — reads as a cut, not a transition`);
  report.issues = issues;
  report.smooth = issues.length === 0;
  return report;
}

/** Decode a list of PNG paths at analysis size. */
export async function loadFrames(list, { maxWidth = 480 } = {}) {
  const out = [];
  for (const f of list) out.push({ t: f.t, path: f.path, img: await decodeRGB(f.path, { maxWidth }) });
  return out;
}

/** Labelled contact sheet (flattened over black), one row or a grid. */
export async function contactSheet(frames, outPath, { thumbWidth = 320, cols = 5, title, labels } = {}) {
  const meta = await sharp(frames[0].path).metadata();
  const tw = thumbWidth, th = Math.round((meta.height / meta.width) * tw), gap = 6, head = title ? 34 : 0;
  const rows = Math.ceil(frames.length / cols);
  const W = cols * tw + (cols + 1) * gap, H = head + rows * (th + 22) + (rows + 1) * gap;
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const comps = [];
  for (let i = 0; i < frames.length; i++) {
    const x = gap + (i % cols) * (tw + gap), y = head + gap + Math.floor(i / cols) * (th + 22 + gap);
    const buf = await sharp(frames[i].path).flatten({ background: '#000' }).resize({ width: tw, height: th }).png().toBuffer();
    comps.push({ input: buf, left: x, top: y });
    const label = labels?.[i] ?? `${frames[i].t.toFixed(2)}s`;
    comps.push({ input: Buffer.from(`<svg width="${tw}" height="20" xmlns="http://www.w3.org/2000/svg"><text x="2" y="15" font-family="Helvetica" font-size="13" fill="#ddd">${esc(label)}</text></svg>`), left: x, top: y + th + 2 });
  }
  if (title) comps.push({ input: Buffer.from(`<svg width="${W}" height="30" xmlns="http://www.w3.org/2000/svg"><text x="${gap}" y="22" font-family="Helvetica" font-weight="bold" font-size="17" fill="#fff">${esc(title)}</text></svg>`), left: 0, top: 4 });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#161616' } }).composite(comps).png().toFile(outPath);
  return outPath;
}

// ── audio ───────────────────────────────────────────────────────────────

/** Minimal WAV reader: PCM 16/24/32-bit and float32. Returns mono-mixed samples + channels. */
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') { data = { start: off + 8, size: Math.min(size, b.length - off - 8) }; break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`);
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.channels));
  const ch = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = data.start + (i * fmt.channels + c) * bps;
      let v;
      if (fmt.format === 3) v = b.readFloatLE(p);
      else if (fmt.bits === 16) v = b.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = b.readIntLE(p, 3) / 8388608;
      else if (fmt.bits === 32) v = b.readInt32LE(p) / 2147483648;
      else throw new Error(`unsupported bit depth ${fmt.bits}`);
      ch[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: ch };
}

/**
 * RMS envelope + clicks for a WAV whose t=0 is `offsetSec` in sequence time.
 * @param events [{label, t}] sequence times to report the level around
 */
export function analyzeAudio(wav, { offsetSec = 0, windowMs = 20, events = [] } = {}) {
  const sr = wav.sampleRate, n = wav.channels[0].length, C = wav.channels.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < C; c++) for (let i = 0; i < n; i++) mono[i] += wav.channels[c][i] / C;
  const win = Math.max(1, Math.round((windowMs / 1000) * sr));
  const env = [];
  for (let s = 0; s + win <= n; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += mono[i] * mono[i];
    env.push({ t: offsetSec + (s + win / 2) / sr, db: 10 * Math.log10(e / win + 1e-12) });
  }
  // Clicks: a one-sample jump much larger than the jumps around it.
  const clicks = [];
  const blk = Math.round(0.01 * sr);
  for (let s = blk; s + blk < n; s += blk) {
    let maxJ = 0, at = s, sumJ = 0;
    for (let i = s; i < s + blk; i++) { const j = Math.abs(mono[i] - mono[i - 1]); sumJ += j; if (j > maxJ) { maxJ = j; at = i; } }
    const meanJ = sumJ / blk;
    if (maxJ > 0.08 && maxJ > 12 * meanJ) clicks.push({ t: round(offsetSec + at / sr, 4), jump: round(maxJ, 3), ratio: round(maxJ / (meanJ || 1e-9), 1) });
  }
  const levelAt = (t, halfMs = 60) => {
    const sel = env.filter((e) => Math.abs(e.t - t) <= halfMs / 1000);
    return sel.length ? round(10 * Math.log10(sel.reduce((a, e) => a + 10 ** (e.db / 10), 0) / sel.length), 1) : null;
  };
  const evs = events.map((e) => ({
    ...e, before: levelAt(e.t - 0.5, 150), at: levelAt(e.t, 60), after: levelAt(e.t + 0.5, 150),
  }));
  return {
    durationSec: round(n / sr, 3),
    envelope: env.filter((_, i) => i % Math.max(1, Math.round(50 / windowMs)) === 0).map((e) => ({ t: round(e.t, 3), db: round(e.db, 1) })),
    peakDb: round(Math.max(...env.map((e) => e.db)), 1),
    clicks,
    events: evs,
  };
}

function round(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }
