// ============================================================================
//  UxpAdapter — HostAdapter skeleton for Adobe's UXP platform.
//
//  NOT IMPLEMENTED YET. This file exists so the CEP→UXP migration is a
//  fill-in-one-file job, not an architecture change. Everything above the
//  HostAdapter seam (AdobeBridge, MCP servers, recipes, graders, the JSON
//  command protocol) is already UXP-agnostic.
//
//  ── Build guide (what changes vs CEP, decided 2026-07-05) ────────────────
//
//  1. CONNECTION DIRECTION INVERTS. CEP panels can require('ws') and run a
//     WS *server* inside the app; UXP plugins cannot. So for UXP, Node hosts
//     the WebSocket server (see `listenPort` below) and the UXP plugin dials
//     OUT to ws://127.0.0.1:<port> as a client. Same JSON frames, opposite
//     direction. This adapter's connect() = start listening + wait for the
//     plugin to dial in.
//
//  2. COMMAND EXECUTION CHANGES, PROTOCOL DOES NOT. The UXP plugin replaces
//     cep-panel.html's evalScript→executeCommand(JSX) path with direct UXP
//     DOM calls, but it must keep the panel's exact wire behavior:
//       - { id, command, params } in → { id, result } | { id, error } out
//       - _ping    → { pong, app, port, scriptReady, jsxVersion→pluginVersion }
//       - _info    → { jsxVersion: <plugin version>, handlers: [...] }
//       - _reloadJsx → hot-reload plugin command modules (or a no-op that
//                      reports the running version)
//       - params._async=true → reply { jobId } immediately, then serve
//         _jobStatus polls (copy the jobs map logic from cep-panel.html)
//     Handler names stay identical ("timeline.addClip", "edit.speedRamp"…)
//     so every MCP tool works unchanged.
//
//  3. PORT PLAN: keep 8081 (Premiere) / 8082 (AE) as the listen ports so
//     preflight tooling and docs stay true.
//
//  4. ACTIVATION: config/env — set BRIDGE_ADAPTER_PREMIERE=uxp (or
//     adapters:{premiere:'uxp'} in AdobeBridge config). No other code moves.
// ============================================================================

import { HostAdapter } from './host-adapter.js';

export class UxpAdapter extends HostAdapter {
  constructor(opts = {}) {
    super(opts);
    this.listenPort = opts.port;
  }

  async connect() {
    throw new Error(
      `UxpAdapter(${this.appName}) is a skeleton — CEP is still the active transport. ` +
      'See the build guide in src/bridge/adapters/uxp-adapter.js and ' +
      'docs/host-adapter-protocol.md before wiring this up.'
    );
  }

  async send() {
    throw new Error(`UxpAdapter(${this.appName}).send(): not implemented — use the cep adapter`);
  }

  async disconnect() {}

  getStatus() {
    return { state: 'disconnected', pendingRequests: 0, note: 'uxp adapter not implemented' };
  }
}
