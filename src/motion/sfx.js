// ============================================================================
//  Transition SFX — synthesised, original, no licensing.
//
//  whoosh: white noise through a resonant band-pass whose centre frequency
//  sweeps up into the cut and back down, with an amplitude envelope that
//  peaks AT the cut (`peakAt` fraction) and a left→right pan. Sits under a
//  zoom/whip transition the way a library "swoosh" would. 48 kHz / 16-bit
//  stereo WAV. Deterministic (seeded) so renders are reproducible.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @returns { samples: Float32Array[] (L,R), sampleRate, peakSample }
 */
export function synthWhoosh({ durationSec = 0.7, peakAt = 0.62, fLow = 250, fHigh = 4200, q = 1.6, sampleRate = 48000, gainDb = -8, seed = 7 } = {}) {
  const n = Math.round(durationSec * sampleRate);
  const rnd = mulberry32(seed);
  const L = new Float32Array(n), R = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const peak = Math.round(peakAt * n);
  const amp = 10 ** (gainDb / 20);
  let maxAbs = 0;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Frequency: exponential rise to the peak, then a quicker fall.
    const u = i <= peak ? i / peak : 1 - (i - peak) / (n - peak);
    const f = fLow * (fHigh / fLow) ** (u ** 1.4);
    // RBJ band-pass (constant skirt gain), coefficients updated per sample.
    const w0 = (2 * Math.PI * f) / sampleRate, al = Math.sin(w0) / (2 * q), cw = Math.cos(w0);
    const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    const x0 = rnd() * 2 - 1;
    const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    // Envelope: smooth rise (sine²) to the peak, exponential tail after.
    const env = i <= peak ? Math.sin((Math.PI / 2) * (i / peak)) ** 2 : Math.exp(-5 * ((i - peak) / (n - peak)));
    mono[i] = y0 * env;
    maxAbs = Math.max(maxAbs, Math.abs(mono[i]));
    void t;
  }
  for (let i = 0; i < n; i++) {
    const v = (mono[i] / (maxAbs || 1)) * amp;
    const p = i / n; // pan L → R, equal-power
    L[i] = v * Math.cos((Math.PI / 2) * p);
    R[i] = v * Math.sin((Math.PI / 2) * p);
  }
  return { samples: [L, R], sampleRate, peakSample: peak, durationSec };
}

export function writeWav(outPath, { samples, sampleRate }) {
  const ch = samples.length, n = samples[0].length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[c][i] * 32767))), 44 + (i * ch + c) * 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}
