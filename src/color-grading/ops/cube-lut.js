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
