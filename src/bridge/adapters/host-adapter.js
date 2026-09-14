// ============================================================================
//  HostAdapter — the transport seam between AdobeBridge and a host app.
//
//  AdobeBridge (and everything above it: MCP servers, recipes, graders)
//  speaks ONLY this interface. Today the one real implementation is
//  CepWebSocketAdapter (CEP panel + ExtendScript). When Adobe retires CEP,
//  UXP support = implementing this same interface in uxp-adapter.js and
//  flipping config — nothing above the seam changes.
//
//  The wire contract an adapter must honor (see docs/host-adapter-protocol.md):
//    request:  { id, command, params }
//    response: { id, result } | { id, error }
//  Commands are dot-notation ("timeline.addClip") plus the internal set the
//  upper layers rely on: _ping, _status, _info, _reloadJsx, _jobStatus, _eval,
//  and the async-job convention (params._async=true → { jobId } immediately,
//  poll _jobStatus). How a command is EXECUTED (evalScript into ExtendScript,
//  UXP DOM calls, anything else) is the adapter's private business.
// ============================================================================

export class HostAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.appName - 'premiere' | 'aftereffects' (labeling/logs)
   * @param {object} [opts.hooks]
   * @param {function} [opts.hooks.onServerCommand] - (message, reply) for
   *   host-initiated commands (e.g. the CEP panel's style-learning requests).
   *   `reply(payload)` sends a JSON payload back to the host.
   * @param {function} [opts.hooks.onEvent] - (event, data) host broadcasts.
   */
  constructor(opts = {}) {
    this.appName = opts.appName || 'unknown';
    this.hooks = opts.hooks || {};
  }

  /** Establish the transport. Resolve when commands can be sent. */
  async connect() {
    throw new Error(`${this.constructor.name}.connect() not implemented`);
  }

  /**
   * Send one command and resolve with its result (or reject with its error).
   * Must implement on-demand reconnect: if the transport is down, try once
   * to re-establish before failing — never simulate a response.
   * @param {string} command
   * @param {object} params
   * @param {object} [opts] - { timeoutMs } per-call timeout override
   */
  async send(command, params = {}, opts = {}) {
    throw new Error(`${this.constructor.name}.send() not implemented`);
  }

  /** Tear down the transport. */
  async disconnect() {
    throw new Error(`${this.constructor.name}.disconnect() not implemented`);
  }

  /** @returns {{ state: 'connected'|'disconnected', pendingRequests: number }} */
  getStatus() {
    return { state: 'disconnected', pendingRequests: 0 };
  }
}
