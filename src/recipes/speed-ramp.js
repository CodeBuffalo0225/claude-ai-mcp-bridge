// ============================================================================
//  Speed Ramp Recipe — pure keyframe math (no Adobe dependency)
//
//  Encodes the cutpilot-speed-ramp playbook as deterministic functions:
//  clean slow-mo ratios, the three battle-tested ramp shapes, and key
//  validation. The MCP `ramp_clip` tool designs keys here, then hands them
//  to the `edit.speedRamp` JSX handler. Keeping the math in Node makes it
//  unit-testable with Premiere closed.
// ============================================================================

/**
 * The clean slow-mo speed for a source/timeline fps pair: the ratio at which
 * every output frame is a real captured frame (60fps on a 24fps timeline →
 * 0.4). Returns null when the source can't go slower than the timeline.
 */
export function cleanSlowmoSpeed(sourceFps, timelineFps) {
  if (!sourceFps || !timelineFps || sourceFps <= 0 || timelineFps <= 0) return null;
  const ratio = timelineFps / sourceFps;
  return ratio < 1 ? Number(ratio.toFixed(4)) : null;
}

/**
 * Design time-remap keyframes for one of the recipe shapes. All times are
 * clip-relative seconds (0 = first frame of the clip). Returns { keys,
 * decision } — decision is the one-line editorial record the workflow
 * requires.
 *
 * Shapes:
 *  - punch_in:          normal → drop to slow on the beat → hold → ease back
 *  - open_slow_rampout: land in slow-mo, hold, ease up, over-crank at the end
 *                       (place the transition at the over-cranked tail)
 *  - ramp_into_slow:    fast head → ease down → land in slow-mo hold
 */
export function designRamp({
  shape,
  clipDuration,
  slowSpeed = 0.4,
  fastSpeed = 2.0,
  beatStart,
  beatEnd,
  easeDuration = 0.4,
}) {
  if (!clipDuration || clipDuration <= 0) {
    throw new Error('clipDuration (seconds) is required to design a ramp');
  }
  if (slowSpeed <= 0 || fastSpeed <= 0) {
    throw new Error('speeds must be > 0 (use edit_speed_duration for reverse)');
  }

  const dur = clipDuration;
  let keys;
  let decision;

  switch (shape) {
    case 'punch_in': {
      // Beat defaults: land the slow-mo in the middle third
      const bs = beatStart ?? dur * 0.35;
      const be = beatEnd ?? Math.min(bs + dur * 0.3, dur - easeDuration * 1.5);
      if (bs <= easeDuration) {
        throw new Error(`beatStart ${bs.toFixed(2)}s leaves no room for the lead-in flat key (need > ${easeDuration}s)`);
      }
      if (be <= bs) throw new Error('beatEnd must be after beatStart');
      keys = [
        { time: 0, speed: 1.0 },                       // flat lead-in
        { time: round(bs - easeDuration), speed: 1.0 }, // hold normal until just before
        { time: round(bs), speed: slowSpeed },          // drop on the beat — the payoff
        { time: round(be), speed: slowSpeed },          // hold through the moment
        { time: round(Math.min(be + easeDuration * 2, dur)), speed: 1.0 }, // ease back
      ];
      decision = `punch_in: drop to ${pct(slowSpeed)} at ${bs.toFixed(2)}s, hold to ${be.toFixed(2)}s, ease back`;
      break;
    }

    case 'open_slow_rampout': {
      // Signature move: open in slow-mo, hold the beat, ramp up, over-crank
      // out — transition goes AT the over-cranked tail where blur hides the cut.
      const hold = beatEnd ?? dur * 0.45;
      if (hold >= dur - easeDuration * 2) {
        throw new Error(`hold ${hold.toFixed(2)}s leaves no room to ramp out of a ${dur.toFixed(2)}s clip`);
      }
      const backToReal = round(hold + (dur - hold) * 0.5);
      keys = [
        { time: 0, speed: slowSpeed },          // land in slow-mo — the emphasis
        { time: round(hold), speed: slowSpeed },// hold the beat
        { time: backToReal, speed: 1.0 },       // ease back to real time
        { time: round(dur), speed: fastSpeed }, // over-crank into the cut
      ];
      decision = `open_slow_rampout: open at ${pct(slowSpeed)}, hold ${hold.toFixed(2)}s, over-crank to ${pct(fastSpeed)} at the tail — put the transition there`;
      break;
    }

    case 'ramp_into_slow': {
      // Reverse of the signature: come in hot, land in the slow-mo hold.
      const land = beatStart ?? dur * 0.4;
      if (land <= easeDuration) {
        throw new Error(`beatStart ${land.toFixed(2)}s too early to ramp down into (need > ${easeDuration}s)`);
      }
      keys = [
        { time: 0, speed: fastSpeed },              // fast incoming — cut lands here
        { time: round(land - easeDuration), speed: fastSpeed },
        { time: round(land), speed: slowSpeed },    // the landing
        { time: round(dur), speed: slowSpeed },     // hold to the end
      ];
      decision = `ramp_into_slow: enter at ${pct(fastSpeed)}, land at ${pct(slowSpeed)} on ${land.toFixed(2)}s`;
      break;
    }

    default:
      throw new Error(`Unknown ramp shape: ${shape} (punch_in | open_slow_rampout | ramp_into_slow | custom)`);
  }

  return { keys, decision };
}

/**
 * Validate a key array (designed or custom) before it goes anywhere near
 * Premiere. Returns { ok, errors, warnings }. Errors block; warnings ride
 * along in the tool report.
 */
export function validateKeys(keys, clipDuration) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(keys) || keys.length < 2) {
    errors.push('A ramp needs at least 2 keyframes');
    return { ok: false, errors, warnings };
  }

  for (const [i, k] of keys.entries()) {
    if (typeof k.time !== 'number' || typeof k.speed !== 'number') {
      errors.push(`key[${i}] must have numeric time and speed`);
      continue;
    }
    if (k.speed <= 0) errors.push(`key[${i}] speed ${k.speed} must be > 0`);
    if (k.time < 0) errors.push(`key[${i}] time ${k.time} is negative`);
    if (clipDuration && k.time > clipDuration + 1e-6) {
      errors.push(`key[${i}] time ${k.time}s is past the clip end (${clipDuration}s)`);
    }
    if (i > 0 && k.time <= keys[i - 1].time) {
      errors.push(`key[${i}] time ${k.time} not strictly after key[${i - 1}] (${keys[i - 1].time})`);
    }
  }

  // Hard rule 5: a flat key on each side gives the ease room. Flat = the
  // first two keys share a speed, and the last two share a speed.
  if (keys.length >= 2 && errors.length === 0) {
    if (keys[0].speed !== keys[1].speed) {
      warnings.push('no flat lead-in (first two keys differ) — ramp starts easing at frame 0');
    }
    // After the final key Premiere HOLDS its value, so a ramp that finishes
    // easing mid-clip has an implicit flat tail. Only warn when the ramp is
    // still moving as the clip ends.
    const last = keys[keys.length - 1];
    const stillMovingAtEnd = clipDuration && last.time > clipDuration - 0.5;
    if (last.speed !== keys[keys.length - 2].speed && keys.length > 2 && stillMovingAtEnd) {
      warnings.push('ramp is still easing at the clip end — fine when over-cranking into a cut, otherwise give the ease room');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Scale speeds for the host DOM's numeric convention. The probe reads an
 * untouched clip's Speed value: ~1 → multiplier scale (pass 1), ~100 →
 * percent scale (pass 100).
 */
export function scaleKeys(keys, valueScale) {
  return keys.map((k) => ({ time: k.time, speed: round(k.speed * valueScale) }));
}

/** Infer valueScale from a probe's speedCurrentValue reading. */
export function inferValueScale(speedCurrentValue) {
  if (typeof speedCurrentValue !== 'number' || !isFinite(speedCurrentValue)) return null;
  if (speedCurrentValue > 10) return 100; // percent DOM (reads ~100 untouched)
  if (speedCurrentValue > 0) return 1;    // multiplier DOM (reads ~1 untouched)
  return null;
}

function round(n) {
  return Number(n.toFixed(4));
}

function pct(speed) {
  return `${Math.round(speed * 100)}%`;
}
