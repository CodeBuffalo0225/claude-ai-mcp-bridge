// ============================================================================
//  Adobe Bridge — WebSocket Communication Layer
//  Connects MCP servers to Adobe Premiere Pro and After Effects
//  via CEP panel WebSocket endpoints running inside each app.
// ============================================================================

import WebSocket from 'ws';
import { Logger } from '../utils/logger.js';
import { harvestDirectory } from '../style-learning/project-harvester.js';
import { analyzeStyle } from '../style-learning/style-analyzer.js';
import { saveProfile, loadProfile, clearProfile } from '../style-learning/style-profile-store.js';

const logger = new Logger('AdobeBridge');

// ── Default ports for the CEP bridge panels ──────────────────────────────
const DEFAULT_PORTS = {
  premiere: 8081,
  aftereffects: 8082,
};

// ── Reconnection settings ────────────────────────────────────────────────
const RECONNECT_INTERVAL = 3000;
const MAX_RECONNECT_ATTEMPTS = 20;
const REQUEST_TIMEOUT = 30000;

class AdobeBridge {
  constructor(config = {}) {
    this.config = {
      premierePort: config.premierePort || DEFAULT_PORTS.premiere,
      afterEffectsPort: config.afterEffectsPort || DEFAULT_PORTS.aftereffects,
      host: config.host || 'localhost',
      ...config,
    };

    this.connections = {
      premiere: null,
      aftereffects: null,
    };

    this.pendingRequests = new Map();
    this.requestId = 0;
    this.reconnectAttempts = { premiere: 0, aftereffects: 0 };
    this.eventListeners = new Map();
  }

  // ── CONNECTION MANAGEMENT ──────────────────────────────────────────────

  async connect(apps = ['premiere', 'aftereffects']) {
    const promises = apps.map((app) => this._connectToApp(app));
    const results = await Promise.allSettled(promises);

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        logger.success(`Connected to ${apps[i]}`);
      } else {
        logger.warn(`Could not connect to ${apps[i]}: ${result.reason?.message}`);
        logger.info(`  Make sure the CEP bridge panel is running in ${apps[i]}`);
        logger.info(`  Expected WebSocket at ws://${this.config.host}:${this._getPort(apps[i])}`);
      }
    });
  }

  async _connectToApp(app) {
    const port = this._getPort(app);
    const url = `ws://${this.config.host}:${port}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${app} timed out`));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.connections[app] = ws;
        this.reconnectAttempts[app] = 0;
        logger.info(`WebSocket connected: ${app} (${url})`);
        this._setupMessageHandler(app, ws);
        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('close', () => {
        this.connections[app] = null;
        this._scheduleReconnect(app);
      });
    });
  }

  _getPort(app) {
    return app === 'premiere' ? this.config.premierePort : this.config.afterEffectsPort;
  }

  _setupMessageHandler(app, ws) {
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle style-learning commands from CEP panel
        if (message.command === 'ANALYZE_STYLE_DIR') {
          this._handleAnalyzeStyleDir(ws, message);
          return;
        }
        if (message.command === 'GET_STYLE_PROFILE') {
          this._handleGetStyleProfile(ws, message);
          return;
        }
        if (message.command === 'CLEAR_STYLE_PROFILE') {
          this._handleClearStyleProfile(ws, message);
          return;
        }

        // Handle responses to pending requests
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

        // Handle event broadcasts from Adobe apps
        if (message.event) {
          this._emitEvent(app, message.event, message.data);
        }
      } catch (err) {
        logger.error(`Failed to parse message from ${app}:`, err.message);
      }
    });
  }

  _scheduleReconnect(app) {
    // Never permanently give up — the CEP panel may open at any time (e.g. the
    // host app was launched after the bridge started). Keep retrying with a
    // capped backoff so the bridge self-heals without a manual restart.
    this.reconnectAttempts[app]++;
    const delay = RECONNECT_INTERVAL * Math.min(this.reconnectAttempts[app], 5);

    setTimeout(async () => {
      logger.info(`Reconnecting to ${app} (attempt ${this.reconnectAttempts[app]})...`);
      try {
        await this._connectToApp(app);
      } catch {
        // Will reschedule via close handler
      }
    }, delay);
  }

  // ── SEND COMMANDS ──────────────────────────────────────────────────────

  /**
   * Send a command to an Adobe app and wait for the response.
   * @param {string} app - 'premiere' or 'aftereffects'
   * @param {string} command - Dot-notation command (e.g., 'timeline.addClip')
   * @param {object} params - Command parameters
   * @param {object} opts - { timeoutMs } per-call override of REQUEST_TIMEOUT
   * @returns {Promise<any>} - Command result
   */
  async send(app, command, params = {}, opts = {}) {
    let ws = this.connections[app];

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // On-demand reconnect: the panel may have opened after the bridge
      // started (e.g. the host app was launched late). Attempt one fresh
      // connection before failing. Never simulate — if it still can't
      // connect, hard-fail per the skill's #1 rule.
      try {
        this.reconnectAttempts[app] = 0;
        ws = await this._connectToApp(app);
      } catch (err) {
        throw new Error(
          `Bridge not connected to ${app} (on-demand reconnect failed: ${err.message}). ` +
          `Open the Claude AI Editor panel in ${app} (Window → Extensions). ` +
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
        reject(new Error(`Request to ${app} timed out after ${timeoutMs / 1000}s: ${command}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      ws.send(message);
    });
  }

  /**
   * Run a long command as a panel-side async job: the panel replies with a
   * jobId immediately, then we poll _jobStatus until it finishes. Use for
   * anything that can outlive REQUEST_TIMEOUT (full-timeline grades,
   * exports, renders). maxWaitMs bounds the total polling time.
   */
  async sendJob(app, command, params = {}, { pollMs = 2000, maxWaitMs = 600000 } = {}) {
    const start = await this.send(app, command, { ...params, _async: true });
    if (!start || !start.jobId) {
      // Panel predates async-job support — result came back synchronously.
      return start;
    }
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const status = await this.send(app, '_jobStatus', { jobId: start.jobId });
      if (status.done) return status.result;
    }
    throw new Error(`Job ${start.jobId} (${command}) still running after ${maxWaitMs / 1000}s — check the ${app} panel log`);
  }

  /**
   * Execute raw ExtendScript in an Adobe app.
   */
  async executeScript(app, script) {
    return this.send(app, '_eval', { script });
  }

  /**
   * Preflight handshake: which JSX build + handlers are live in the engine.
   */
  async info(app) {
    return this.send(app, '_info', {});
  }

  /**
   * Hot-reload the JSX bridge in the running host app (no Premiere/AE
   * restart). Returns the freshly loaded version + handler list.
   */
  async reloadJsx(app) {
    return this.send(app, '_reloadJsx', {}, { timeoutMs: 15000 });
  }

  // ── EVENT SYSTEM ───────────────────────────────────────────────────────

  on(app, event, callback) {
    const key = `${app}:${event}`;
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key).push(callback);
  }

  _emitEvent(app, event, data) {
    const key = `${app}:${event}`;
    const listeners = this.eventListeners.get(key) || [];
    listeners.forEach((cb) => cb(data));
  }

  // ── DISCONNECT ─────────────────────────────────────────────────────────

  async disconnect() {
    for (const [app, ws] of Object.entries(this.connections)) {
      if (ws) {
        ws.close();
        this.connections[app] = null;
        logger.info(`Disconnected from ${app}`);
      }
    }
    this.pendingRequests.clear();
  }

  // ── STYLE LEARNING HANDLERS ──────────────────────────────────────────

  _handleAnalyzeStyleDir(ws, message) {
    const { dirPath } = message.params || {};
    if (!dirPath) {
      this._sendToWs(ws, { id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: 'No dirPath provided' } });
      return;
    }

    // Run asynchronously so the bridge stays responsive
    (async () => {
      try {
        logger.info(`Style analysis started for: ${dirPath}`);
        const analyses = await harvestDirectory(dirPath);
        if (analyses.length === 0) {
          this._sendToWs(ws, { id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: 'No sequences found in directory' } });
          return;
        }
        const profile = await analyzeStyle(analyses);
        saveProfile(profile);
        this._sendToWs(ws, {
          id: message.id,
          event: 'STYLE_ANALYSIS_COMPLETE',
          data: {
            profile_name: profile.profile_name,
            style_summary: profile.style_summary,
            analyzed_project_count: profile.analyzed_project_count,
            analyzed_sequence_count: profile.analyzed_sequence_count,
            generated_at: profile.generated_at,
          },
        });
      } catch (err) {
        logger.error(`Style analysis failed: ${err.message}`);
        this._sendToWs(ws, { id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: err.message } });
      }
    })();
  }

  _handleGetStyleProfile(ws, message) {
    const profile = loadProfile();
    this._sendToWs(ws, { id: message.id, result: profile });
  }

  _handleClearStyleProfile(ws, message) {
    clearProfile();
    this._sendToWs(ws, { id: message.id, result: { success: true } });
  }

  _sendToWs(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        logger.error(`Failed to send WS message: ${err.message}`);
      }
    }
  }

  // ── STATUS ─────────────────────────────────────────────────────────────

  getStatus() {
    return {
      premiere: this.connections.premiere?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      aftereffects: this.connections.aftereffects?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      pendingRequests: this.pendingRequests.size,
    };
  }
}

export { AdobeBridge };
