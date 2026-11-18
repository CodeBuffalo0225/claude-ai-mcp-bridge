// ============================================================================
//  Audio transition curves — pure.
//
//  Equal-power crossfade: gain_A = cos(πt/2), gain_B = sin(πt/2). For two
//  UNCORRELATED signals (different shots) the summed power stays constant —
//  no loudness dip in the middle, which is what a linear (equal-gain) fade
//  produces (−3 dB at the midpoint). For correlated material (the same
//  continuous take) an equal-gain fade is the one that stays flat; `curve`
//  lets the caller choose. Standard references: Premiere's own "Constant
//  Power" vs "Constant Gain" crossfades follow the same two laws.
//
//  Gains are planned in dB (Premiere's clip Volume ▸ Level unit in the UI).
//  The floor stands in for −∞ at the silent end of a fade.
// ============================================================================

export const FLOOR_DB = -60;

export const toDb = (g) => (g <= 1e-6 ? FLOOR_DB : Math.max(FLOOR_DB, 20 * Math.log10(g)));

export const GAIN_LAWS = {
  equalPower: { out: (t) => Math.cos((Math.PI / 2) * t), in: (t) => Math.sin((Math.PI / 2) * t) },
  equalGain: { out: (t) => 1 - t, in: (t) => t },
  // Fast-out / slow-in: a fade that clears the outgoing sound early (dialogue).
  exponential: { out: (t) => (1 - t) ** 2, in: (t) => 1 - (1 - t) ** 2 },
};

/**
 * Plan Level keys (dB, relative to each clip's current level) for a fade.
 * @param kind 'out' | 'in'
 * @returns [{t, db}]
 */
export function planFade({ kind, startSec, durationSec, law = 'equalPower', fps = 30, stepFrames = 2, baseDb = 0 }) {
  const L = GAIN_LAWS[law];
  if (!L) throw new Error(`unknown gain law ${law}`);
  const g = kind === 'out' ? L.out : L.in;
  const n = Math.max(2, Math.round((durationSec * fps) / stepFrames));
  const keys = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    keys.push({ t: round(startSec + t * durationSec), db: round(baseDb + toDb(g(t)), 2) });
  }
  return keys;
}

/** Crossfade between A (out) and B (in) over a shared window. */
export function planCrossfade({ startSec, durationSec, law = 'equalPower', fps = 30, stepFrames = 2, baseDbA = 0, baseDbB = 0 }) {
  return {
    A: planFade({ kind: 'out', startSec, durationSec, law, fps, stepFrames, baseDb: baseDbA }),
    B: planFade({ kind: 'in', startSec, durationSec, law, fps, stepFrames, baseDb: baseDbB }),
  };
}

/** Summed power (dB) of two uncorrelated unit signals under a law — for tests and reports. */
export function summedPowerDb(law, t) {
  const L = GAIN_LAWS[law];
  return 10 * Math.log10(L.out(t) ** 2 + L.in(t) ** 2);
}

function round(x, d = 6) { return Math.round(x * 10 ** d) / 10 ** d; }
