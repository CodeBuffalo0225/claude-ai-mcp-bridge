// Unit tests for the speed-ramp recipe math — runs with Premiere closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSlowmoSpeed,
  designRamp,
  validateKeys,
  scaleKeys,
  inferValueScale,
} from '../src/recipes/speed-ramp.js';

// ── cleanSlowmoSpeed: the frame-rate math table from the skill ────────────
test('clean slow-mo ratios match the skill table', () => {
  assert.equal(cleanSlowmoSpeed(60, 24), 0.4);
  assert.equal(cleanSlowmoSpeed(59.94, 23.976), 0.4);
  assert.equal(cleanSlowmoSpeed(60, 30), 0.5);
  assert.equal(cleanSlowmoSpeed(59.94, 29.97), 0.5);
  assert.equal(cleanSlowmoSpeed(120, 24), 0.2);
  assert.equal(cleanSlowmoSpeed(120, 30), 0.25);
});

test('cleanSlowmoSpeed returns null when source cannot go slower', () => {
  assert.equal(cleanSlowmoSpeed(24, 24), null);
  assert.equal(cleanSlowmoSpeed(24, 60), null);
  assert.equal(cleanSlowmoSpeed(0, 24), null);
  assert.equal(cleanSlowmoSpeed(60, null), null);
});

// ── punch_in ──────────────────────────────────────────────────────────────
test('punch_in: 5 keys, flat lead-in, drop on the beat, ease back', () => {
  const { keys, decision } = designRamp({
    shape: 'punch_in',
    clipDuration: 6,
    slowSpeed: 0.25,
    beatStart: 1.5,
    beatEnd: 2.3,
    easeDuration: 0.3,
  });
  assert.equal(keys.length, 5);
  assert.deepEqual(keys[0], { time: 0, speed: 1.0 });
  assert.deepEqual(keys[1], { time: 1.2, speed: 1.0 }); // flat until just before
  assert.deepEqual(keys[2], { time: 1.5, speed: 0.25 }); // the payoff
  assert.deepEqual(keys[3], { time: 2.3, speed: 0.25 }); // hold
  assert.equal(keys[4].speed, 1.0);                      // ease back
  assert.ok(keys[4].time <= 6);
  assert.match(decision, /punch_in/);
  const v = validateKeys(keys, 6);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.warnings.length, 0);
});

test('punch_in defaults land the beat in the middle third', () => {
  const { keys } = designRamp({ shape: 'punch_in', clipDuration: 10 });
  const v = validateKeys(keys, 10);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(keys[2].speed, 0.4); // default = 60→24 clean ratio
});

test('punch_in rejects a beat too early for the lead-in flat key', () => {
  assert.throws(
    () => designRamp({ shape: 'punch_in', clipDuration: 6, beatStart: 0.1 }),
    /leaves no room/
  );
});

// ── open_slow_rampout (the signature move) ────────────────────────────────
test('open_slow_rampout: opens slow, holds, over-cranks at the tail', () => {
  const { keys, decision } = designRamp({
    shape: 'open_slow_rampout',
    clipDuration: 4,
    slowSpeed: 0.4,
    fastSpeed: 2.0,
    beatEnd: 1.0,
  });
  assert.equal(keys.length, 4);
  assert.deepEqual(keys[0], { time: 0, speed: 0.4 });   // land in slow-mo
  assert.deepEqual(keys[1], { time: 1.0, speed: 0.4 }); // hold the beat
  assert.equal(keys[2].speed, 1.0);                     // back to real time
  assert.deepEqual(keys[3], { time: 4, speed: 2.0 });   // over-crank at the cut
  assert.match(decision, /transition/);
  const v = validateKeys(keys, 4);
  assert.equal(v.ok, true, v.errors.join('; '));
  // over-crank tail intentionally has no flat tail — warning, not error
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /over-crank/);
});

test('open_slow_rampout rejects a hold that leaves no ramp-out room', () => {
  assert.throws(
    () => designRamp({ shape: 'open_slow_rampout', clipDuration: 2, beatEnd: 1.9 }),
    /no room to ramp out/
  );
});

// ── ramp_into_slow ────────────────────────────────────────────────────────
test('ramp_into_slow: fast head, lands in held slow-mo', () => {
  const { keys } = designRamp({
    shape: 'ramp_into_slow',
    clipDuration: 5,
    slowSpeed: 0.4,
    fastSpeed: 2.0,
    beatStart: 2.0,
    easeDuration: 0.5,
  });
  assert.equal(keys.length, 4);
  assert.deepEqual(keys[0], { time: 0, speed: 2.0 });
  assert.deepEqual(keys[1], { time: 1.5, speed: 2.0 }); // flat before the drop
  assert.deepEqual(keys[2], { time: 2.0, speed: 0.4 }); // the landing
  assert.deepEqual(keys[3], { time: 5, speed: 0.4 });   // hold to end
  const v = validateKeys(keys, 5);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.warnings.length, 0); // flat both sides
});

// ── validateKeys ──────────────────────────────────────────────────────────
test('validateKeys blocks non-monotonic, negative-speed, and out-of-range keys', () => {
  const v = validateKeys(
    [
      { time: 0, speed: 1 },
      { time: 0, speed: -0.5 },  // not after previous + bad speed
      { time: 99, speed: 1 },    // past clip end
    ],
    5
  );
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 3);
});

test('validateKeys requires at least 2 keys', () => {
  const v = validateKeys([{ time: 0, speed: 1 }], 5);
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /at least 2/);
});

test('validateKeys warns (not errors) on missing flat lead-in', () => {
  const v = validateKeys(
    [
      { time: 0, speed: 1 },
      { time: 1, speed: 0.4 },
      { time: 2, speed: 0.4 },
    ],
    5
  );
  assert.equal(v.ok, true);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /lead-in/);
});

// ── calibration helpers ───────────────────────────────────────────────────
test('scaleKeys converts multiplier keys to percent DOM', () => {
  const scaled = scaleKeys(
    [
      { time: 0, speed: 1 },
      { time: 1.5, speed: 0.4 },
    ],
    100
  );
  assert.deepEqual(scaled, [
    { time: 0, speed: 100 },
    { time: 1.5, speed: 40 },
  ]);
});

test('inferValueScale reads the probe correctly', () => {
  assert.equal(inferValueScale(1), 1);       // multiplier DOM
  assert.equal(inferValueScale(1.0001), 1);
  assert.equal(inferValueScale(100), 100);   // percent DOM
  assert.equal(inferValueScale(99.9), 100);
  assert.equal(inferValueScale(0), null);
  assert.equal(inferValueScale(NaN), null);
  assert.equal(inferValueScale(undefined), null);
});
