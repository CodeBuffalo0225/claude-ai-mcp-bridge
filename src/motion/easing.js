// ============================================================================
//  Easing + keyframe planning — pure maths, no editor calls.
//
//  Premiere's scripting API exposes keyframe interpolation modes (Linear 0,
//  Hold 4, Bezier 5, Time 6 — Adobe PProPanel sample) but NOT bezier handle
//  influence, so a script cannot shape an "ease-in-out cubic" with two keys.
//  Two modes are offered:
//    baked   dense LINEAR keys every `stepFrames` frames that sample the
//            exact curve — what you plan is what renders (default);
//    bezier  two keys with Premiere's auto-Bezier — fewer keys, Premiere's
//            own (gentler, symmetric) ease.
//  Curves follow the standard Penner / CSS definitions.
// ============================================================================

const c1 = 1.70158;
const c3 = c1 + 1;

export const EASINGS = {
  linear: (t) => t,
  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeInQuint: (t) => t ** 5,
  easeOutQuint: (t) => 1 - (1 - t) ** 5,
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  easeInExpo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeInOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  // Overshoot — a "pop" that settles. Keep for text/graphics, not footage.
  easeOutBack: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  easeInBack: (t) => c3 * t * t * t - c1 * t * t,
};

/** CSS cubic-bezier(x1,y1,x2,y2) as a function of t (Newton + bisection). */
export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dbx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = dbx(t);
      if (Math.abs(d) < 1e-7) break;
      const nt = t - (bx(t) - x) / d;
      if (nt < 0 || nt > 1) break;
      t = nt;
    }
    let lo = 0, hi = 1;
    for (let i = 0; i < 30 && Math.abs(bx(t) - x) > 1e-7; i++) {
      t = (lo + hi) / 2;
      if (bx(t) < x) lo = t; else hi = t;
    }
    return by(t);
  };
}

// Named "editor" curves — the motion-design workhorses.
EASINGS.smooth = cubicBezier(0.45, 0, 0.55, 1);      // gentle in-out (dissolves)
EASINGS.snappy = cubicBezier(0.7, 0, 0.2, 1);        // fast middle (zoom/whip)
EASINGS.settle = cubicBezier(0.16, 1, 0.3, 1);       // decelerate into place (text in)
EASINGS.accelerate = cubicBezier(0.7, 0, 0.84, 0);   // speed away (text out)

export function easing(name) {
  const f = EASINGS[name];
  if (!f) throw new Error(`unknown easing "${name}" — one of ${Object.keys(EASINGS).join(', ')}`);
  return f;
}

/**
 * Plan keys for one property moving `from` → `to`.
 * Values may be numbers or arrays (e.g. Position [x, y]).
 * @returns { keys:[{t, v}], interp: 0|5, mode }
 */
export function planKeys({ from, to, startSec, durationSec, curve = 'smooth', fps = 30, mode = 'baked', stepFrames = 1 }) {
  if (!(durationSec > 0)) throw new Error('durationSec must be > 0');
  const f = easing(curve);
  const lerp = (a, b, k) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * k) : a + (b - a) * k);
  if (mode === 'bezier') {
    return { mode, interp: 5, keys: [{ t: round(startSec), v: from }, { t: round(startSec + durationSec), v: to }] };
  }
  const frames = Math.max(2, Math.round(durationSec * fps));
  const step = Math.max(1, Math.round(stepFrames));
  const keys = [];
  for (let i = 0; i <= frames; i += step) keys.push({ t: round(startSec + (i / frames) * durationSec), v: lerp(from, to, f(i / frames)) });
  if (keys[keys.length - 1].t < round(startSec + durationSec)) keys.push({ t: round(startSec + durationSec), v: to });
  return { mode, interp: 0, keys: keys.map((k) => ({ t: k.t, v: roundV(k.v) })) };
}

/** Concatenate segments (e.g. in → hold → out) into one key list. */
export function joinKeys(...plans) {
  const out = [];
  for (const p of plans) for (const k of p.keys) if (!out.length || k.t > out[out.length - 1].t + 1e-6) out.push(k);
  return { mode: plans[0].mode, interp: plans[0].interp, keys: out };
}

function round(x) { return Math.round(x * 1e6) / 1e6; }
function roundV(v) { return Array.isArray(v) ? v.map((x) => Math.round(x * 1e4) / 1e4) : Math.round(v * 1e4) / 1e4; }
