// ColorGrader.manualGrade contract: it must surface what the JSX actually
// set and skipped, and fail loudly on a handler error — never a blanket
// { success: true } (the 2026-11-14 stale-Lumetri-names bug hid behind that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColorGrader } from '../src/color-grading/color-grader.js';

function fakeBridge(reply) {
  const calls = [];
  return {
    calls,
    async send(app, command, params) { calls.push({ app, command, params }); return reply; },
  };
}

test('manualGrade forwards settings and returns applied + skipped', async () => {
  const bridge = fakeBridge({ applied: ['basic.temperature=6'], skipped: ['curves: not scriptable in Lumetri DOM'] });
  const g = new ColorGrader(bridge);
  const r = await g.manualGrade({ trackIndex: 0, clipIndex: 2, basic: { temperature: 6 }, curves: { rgb: [] } });
  assert.equal(bridge.calls[0].command, 'color.applyLumetri');
  assert.deepEqual(bridge.calls[0].params.settings, { basic: { temperature: 6 }, curves: { rgb: [] } });
  assert.deepEqual(r, { applied: ['basic.temperature=6'], skipped: ['curves: not scriptable in Lumetri DOM'] });
});

test('manualGrade throws when the JSX handler returns an error', async () => {
  const g = new ColorGrader(fakeBridge({ error: 'Clip not found at V0:9' }));
  await assert.rejects(g.manualGrade({ trackIndex: 0, clipIndex: 9, basic: { tint: 1 } }), /Clip not found/);
});

test('manualGrade treats a reply with no lists as nothing applied', async () => {
  const g = new ColorGrader(fakeBridge({}));
  assert.deepEqual(await g.manualGrade({ basic: { tint: 1 } }), { applied: [], skipped: [] });
});
