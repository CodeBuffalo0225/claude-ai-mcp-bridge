// ============================================================================
//  .cube LUT baking — the fallback for controls Premiere does not expose to
//  scripts (RGB Curves, Hue vs Sat/Hue/Luma, colour wheels). The LUT is the
//  exact same maths as the engine preview, so the preview IS what the LUT
//  does. Only GLOBAL pixel ops can be baked: a LUT cannot hold a mask.
//
//  Format: Adobe/Resolve .cube (LUT_3D_SIZE, red index varies fastest).
//  Load in Premiere: Lumetri ▸ Creative ▸ Look ▸ Browse…  (scripts cannot set
//  the LUT path — verified on 26.5.2: Look/LookAsset are opaque blobs).
// ============================================================================

import fs from 'node:fs';
import { compilePixelOps } from './transform.js';

export function bakeCube(ops, { size = 33, title = 'claude-ai-editor grade' } = {}) {
  if (ops.some((o) => o.op === 'secondary')) throw new Error('A LUT cannot contain a masked secondary — bake only global ops');
  if (ops.some((o) => o.op === 'lumetri')) throw new Error('Lumetri slider ops are applied in Premiere, not baked into a LUT');
  if (size < 2 || size > 65) throw new Error('LUT size must be 2..65');
  const fn = compilePixelOps(ops);
  const lines = [
    `TITLE "${title.replace(/"/g, "'")}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const d = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const o = fn([r / d, g / d, b / d]);
        lines.push(`${o[0].toFixed(6)} ${o[1].toFixed(6)} ${o[2].toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function writeCube(path, ops, opts) {
  fs.writeFileSync(path, bakeCube(ops, opts));
  return path;
}

/**
 * Apply a parsed .cube to an RGB image with trilinear interpolation (what
 * Lumetri / ffmpeg lut3d do). Used to predict a LUT's effect independently
 * of the ops that produced it, e.g. for verifying the Premiere render.
 */
export function applyCube(img, cube) {
  const N = cube.size, t = cube.table, d = N - 1;
  if (!N || t.length !== N * N * N) throw new Error(`malformed .cube: size ${N}, ${t.length} entries`);
  const at = (r, g, b) => t[r + g * N + b * N * N];
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 3) {
    const fr = (img.data[i] / 255) * d, fg = (img.data[i + 1] / 255) * d, fb = (img.data[i + 2] / 255) * d;
    const r0 = Math.min(d - 1, Math.floor(fr)), g0 = Math.min(d - 1, Math.floor(fg)), b0 = Math.min(d - 1, Math.floor(fb));
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0)[c] * (1 - dr) + at(r0 + 1, g0, b0)[c] * dr;
      const c10 = at(r0, g0 + 1, b0)[c] * (1 - dr) + at(r0 + 1, g0 + 1, b0)[c] * dr;
      const c01 = at(r0, g0, b0 + 1)[c] * (1 - dr) + at(r0 + 1, g0, b0 + 1)[c] * dr;
      const c11 = at(r0, g0 + 1, b0 + 1)[c] * (1 - dr) + at(r0 + 1, g0 + 1, b0 + 1)[c] * dr;
      const v = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
      out[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return { ...img, data: out };
}

/** Parse a .cube (for tests / verification). */
export function parseCube(text) {
  const out = { size: 0, table: [] };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('LUT_3D_SIZE')) out.size = Number(t.split(/\s+/)[1]);
    else if (/^[-\d.]/.test(t)) out.table.push(t.split(/\s+/).map(Number));
  }
  return out;
}
