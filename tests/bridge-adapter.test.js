// Loopback integration test for the adapter seam: a fake CEP panel (WS
// server) in Node proves AdobeBridge's public API works unchanged through
// CepWebSocketAdapter — send, per-call timeouts, sendJob polling, host-
// initiated commands, adapter selection. No Adobe app required.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { AdobeBridge } from '../src/bridge/adobe-bridge.js';

const PORT = 18981; // test-only port; real Premiere panel uses 8081
let wss;
let bridge;
const fakeJobs = {};

before(async () => {
  wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const { id, command, params = {} } = msg;

      if (command === '_ping') {
        ws.send(JSON.stringify({ id, result: { pong: true, app: 'FakePanel', port: PORT } }));
      } else if (command === 'echo.params') {
        ws.send(JSON.stringify({ id, result: { echoed: params } }));
      } else if (command === 'fail.always') {
        ws.send(JSON.stringify({ id, error: 'deliberate failure' }));
      } else if (command === 'slow.never_replies') {
        // no reply — used to exercise the per-call timeout
      } else if (command === 'slow.job' && params._async === undefined) {
        // panel contract: _async flag triggers job mode
        ws.send(JSON.stringify({ id, error: 'expected _async' }));
      } else if (command === 'slow.job') {
        const jobId = 'job_test_1';
        fakeJobs[jobId] = { done: false };
        ws.send(JSON.stringify({ id, result: { jobId, async: true, command } }));
        setTimeout(() => {
          fakeJobs[jobId] = { done: true, result: { finished: true, took: 'a while' } };
        }, 300);
      } else if (command === '_jobStatus') {
        const job = fakeJobs[params.jobId];
        if (!job) ws.send(JSON.stringify({ id, error: `Unknown jobId: ${params.jobId}` }));
        else if (!job.done) ws.send(JSON.stringify({ id, result: { jobId: params.jobId, done: false } }));
        else ws.send(JSON.stringify({ id, result: { jobId: params.jobId, done: true, result: job.result } }));
      }
    });
  });
  await new Promise((r) => wss.on('listening', r));

  bridge = new AdobeBridge({ premierePort: PORT });
  await bridge.connect(['premiere']);
});

after(async () => {
  await bridge.disconnect();
  await new Promise((r) => wss.close(r));
});

test('send() round-trips a command and result', async () => {
  const res = await bridge.send('premiere', '_ping');
  assert.equal(res.pong, true);
  assert.equal(res.app, 'FakePanel');
});

test('send() passes params through untouched', async () => {
  const res = await bridge.send('premiere', 'echo.params', { keys: [{ time: 0, speed: 1 }], valueScale: 100 });
  assert.deepEqual(res.echoed.keys, [{ time: 0, speed: 1 }]);
  assert.equal(res.echoed.valueScale, 100);
});

test('send() rejects on host error', async () => {
  await assert.rejects(bridge.send('premiere', 'fail.always'), /deliberate failure/);
});

test('per-call timeoutMs overrides the 30s default', async () => {
  const t0 = Date.now();
  await assert.rejects(
    bridge.send('premiere', 'slow.never_replies', {}, { timeoutMs: 400 }),
    /timed out after 0.4s/
  );
  assert.ok(Date.now() - t0 < 2000, 'should fail fast, not wait 30s');
});

test('sendJob() polls _jobStatus to completion', async () => {
  const res = await bridge.sendJob('premiere', 'slow.job', {}, { pollMs: 100, maxWaitMs: 5000 });
  assert.deepEqual(res, { finished: true, took: 'a while' });
});

test('getStatus() reports adapter state through the facade', () => {
  const status = bridge.getStatus();
  assert.equal(status.premiere, 'connected');
  assert.equal(status.aftereffects, 'disconnected');
  assert.equal(typeof status.pendingRequests, 'number');
});

test('host-initiated GET_STYLE_PROFILE gets a reply through the hook', async () => {
  // Grab the live server-side socket and send a panel-style command; the
  // bridge must answer with { id, result } (profile or null).
  const serverSocket = [...wss.clients][0];
  const replyPromise = new Promise((resolve) => {
    serverSocket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
  serverSocket.send(JSON.stringify({ id: 999, command: 'GET_STYLE_PROFILE', params: {} }));
  const reply = await replyPromise;
  assert.equal(reply.id, 999);
  assert.ok('result' in reply);
});

test('uxp adapter is selectable and honestly unimplemented', async () => {
  const uxpBridge = new AdobeBridge({ adapters: { premiere: 'uxp' }, premierePort: PORT });
  await assert.rejects(uxpBridge.send('premiere', '_ping'), /not implemented|skeleton/);
});

test('unknown adapter kind fails loudly at construction', () => {
  assert.throws(() => new AdobeBridge({ adapters: { premiere: 'flash' } }), /Unknown bridge adapter 'flash'/);
});
