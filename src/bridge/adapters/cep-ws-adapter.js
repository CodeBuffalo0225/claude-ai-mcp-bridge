// ============================================================================
//  CepWebSocketAdapter — HostAdapter over the CEP panel's WebSocket server.
//
//  The CEP panel (src/bridge/cep-panel.html) runs a WS server inside the
//  host app; this adapter is the Node-side client. All transport concerns
//  live here: connect/reconnect, request/response correlation, timeouts,
//  and surfacing panel-initiated commands (style-learning) via hooks.
// ============================================================================

import WebSocket from 'ws';
import { HostAdapter } from './host-adapter.js';
import { Logger } from '../../utils/logger.js';

const RECONNECT_INTERVAL = 3000;
const REQUEST_TIMEOUT = 30000;

export class CepWebSocketAdapter extends HostAdapter {
  /**
   * @param {object} opts - HostAdapter opts plus { host, port }
   */
  constructor(opts = {}) {
    super(opts);
    this.host = opts.host || 'localhost';
    this.port = opts.port;
    if (!this.port) throw new Error(`CepWebSocketAdapter(${this.appName}): port is required`);

    this.logger = new Logger(`CepAdapter:${this.appName}`);
    this.ws = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.reconnectAttempts = 0;
    this.closed = false;        // intentional disconnect stops the reconnect loop
    this.reconnectTimer = null;
  }

  async connect() {
    this.closed = false;
    const url = `ws://${this.host}:${this.port}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${this.appName} timed out`));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.logger.info(`WebSocket connected: ${this.appName} (${url})`);
        this._setupMessageHandler(ws);
        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('close', () => {
        this.ws = null;
        this._scheduleReconnect();
      });
    });
  }

  _setupMessageHandler(ws) {
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Host-initiated commands (e.g. the panel's style-learning buttons)
        // are the upper layer's business — hand them up with a reply channel.
        if (message.command && this.hooks.onServerCommand) {
          this.hooks.onServerCommand(message, (payload) => this._sendRaw(payload));
          return;
        }

        // Responses to our pending requests
        if (message.id && this.pendingRequests.has(message.id)) {
          const { resolve, reject, timeout } = this.pendingRequests.get(message.id);
          clearTimeout(timeout);
          this.pendingRequests.delete(message.id);

          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message.result);
          }
        }

        // Event broadcasts from the host app
        if (message.event && this.hooks.onEvent) {
          this.hooks.onEvent(message.event, message.data);
        }
      } catch (err) {
        this.logger.error(`Failed to parse message from ${this.appName}:`, err.message);
      }
    });
  }

  _scheduleReconnect() {
    // Never permanently give up — the CEP panel may open at any time (e.g.
    // the host app was launched after the bridge started). Capped backoff so
    // the adapter self-heals without a manual restart. Only an intentional
    // disconnect() stops the loop (and lets the process exit).
    if (this.closed) return;
    this.reconnectAttempts++;
    const delay = RECONNECT_INTERVAL * Math.min(this.reconnectAttempts, 5);

    this.reconnectTimer = setTimeout(async () => {
      if (this.closed) return;
      this.logger.info(`Reconnecting to ${this.appName} (attempt ${this.reconnectAttempts})...`);
      try {
        await this.connect();
      } catch {
        // Will reschedule via close handler
      }
    }, delay);
    // Don't hold the event loop open just to retry a dead panel
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async send(command, params = {}, opts = {}) {
    let ws = this.ws;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // On-demand reconnect: the panel may have opened after we started.
      // Attempt one fresh connection before failing. Never simulate — if it
      // still can't connect, hard-fail per the #1 hard rule.
      try {
        this.reconnectAttempts = 0;
        ws = await this.connect();
      } catch (err) {
        throw new Error(
          `Bridge not connected to ${this.appName} (on-demand reconnect failed: ${err.message}). ` +
          `Open the Claude AI Editor panel in ${this.appName} (Window → Extensions). ` +
          `Auto-reconnect retries every ${RECONNECT_INTERVAL / 1000}s.`
        );
      }
    }

    const id = ++this.requestId;
    const message = JSON.stringify({ id, command, params });
    const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request to ${this.appName} timed out after ${timeoutMs / 1000}s: ${command}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      ws.send(message);
    });
  }

  _sendRaw(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.logger.error(`Failed to send WS message: ${err.message}`);
      }
    }
  }

  async disconnect() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.logger.info(`Disconnected from ${this.appName}`);
    }
    for (const { reject, timeout } of this.pendingRequests.values()) {
      clearTimeout(timeout);
      reject(new Error(`Disconnected from ${this.appName} with request in flight`));
    }
    this.pendingRequests.clear();
  }

  getStatus() {
    return {
      state: this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      pendingRequests: this.pendingRequests.size,
    };
  }
}
