// ============================================================================
//  Closed-loop solver — set a Lumetri control so a MEASURED metric reaches a
//  target, without assuming how Lumetri maps slider units to pixels.
//
//  Lumetri's internal maths is undocumented, so "Temperature +12 removes a
//  0.008 Cb/Cr cast" cannot be computed in advance. Instead:
//    measure at the current value → nudge by probeStep → estimate slope →
//    secant steps (clamped) → stop on tolerance, on a flat response, or when
//    the error stops improving. Every measurement is returned as evidence.
//
//  `measure(x)` is injected: in production it writes x through the bridge,
//  re-exports the frame from Premiere and re-analyses it. In tests it is a
//  plain function. The solver itself never touches the editor.
// ============================================================================

/**
 * @param {object} p
 * @param {number} p.x0           current control value
 * @param {(x:number)=>Promise<number>} p.measure
 * @param {number} p.target       metric value wanted
 * @param {number} p.tolerance    stop when |metric-target| <= tolerance
 * @param {number} p.probeStep    first nudge (control units; sign = first guess)
 * @param {[number,number]} p.bounds  allowed control range
 * @param {number} [p.maxStep]    largest single move (control units)
 * @param {number} [p.maxIters=6] measurements after the first
 */
export async function solveClosedLoop({ x0, measure, target, tolerance, probeStep, bounds, maxStep = Infinity, maxIters = 6 }) {
  const clampX = (x) => Math.min(bounds[1], Math.max(bounds[0], x));
  const log = [];
  const record = async (x) => {
    const m = await measure(x);
    if (!Number.isFinite(m)) throw new Error(`measurement returned ${m} at x=${x}`);
    log.push({ x: round(x), metric: round(m, 5), error: round(m - target, 5) });
    return m;
  };

  let xPrev = clampX(x0);
  let mPrev = await record(xPrev);
  if (Math.abs(mPrev - target) <= tolerance) return result('already_within_tolerance');

  let xCur = clampX(xPrev + probeStep);
  if (xCur === xPrev) xCur = clampX(xPrev - probeStep);
  let mCur = await record(xCur);

  for (let it = 0; it < maxIters; it++) {
    if (Math.abs(mCur - target) <= tolerance) return result('converged');
    const slope = (mCur - mPrev) / (xCur - xPrev);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) return result('no_measurable_response');
    let step = (target - mCur) / slope;
    step = Math.max(-maxStep, Math.min(maxStep, step));
    const xNext = clampX(xCur + step);
    if (Math.abs(xNext - xCur) < 1e-6) return result('hit_bound');
    const mNext = await record(xNext);
    // Guard: if the error got worse, the response is non-monotone or noisy.
    if (Math.abs(mNext - target) > Math.abs(mCur - target) * 1.05 && it > 0) return result('diverging');
    xPrev = xCur; mPrev = mCur; xCur = xNext; mCur = mNext;
  }
  return result(Math.abs(mCur - target) <= tolerance ? 'converged' : 'max_iterations');

  function result(status) {
    const best = log.reduce((a, b) => (Math.abs(b.error) < Math.abs(a.error) ? b : a));
    return {
      status,
      converged: Math.abs(best.error) <= tolerance,
      bestX: best.x,
      bestMetric: best.metric,
      target: round(target, 5),
      tolerance,
      measurements: log,
      // The caller MUST leave the control at bestX (the last measured x may be worse).
      finalWriteNeeded: log[log.length - 1].x !== best.x,
    };
  }
}

function round(x, d = 3) { return Math.round(x * 10 ** d) / 10 ** d; }
