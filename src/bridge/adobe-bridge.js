// ============================================================================
//  Adobe Bridge — WebSocket Communication Layer
//  Connects MCP servers to Adobe Premiere Pro and After Effects
//  via CEP panel WebSocket endpoints running inside each app.
// ============================================================================

import WebSocket from 'ws';
import { Logger } from '../utils/logger.js';

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
    if (this.reconnectAttempts[app] >= MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`Max reconnect attempts reached for ${app}`);
      return;
    }

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
   * @returns {Promise<any>} - Command result
   */
  async send(app, command, params = {}) {
    const ws = this.connections[app];

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // In development/simulation mode, return simulated responses
      logger.warn(`No connection to ${app} — running in simulation mode`);
      return this._simulateResponse(app, command, params);
    }

    const id = ++this.requestId;
    const message = JSON.stringify({ id, command, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request to ${app} timed out: ${command}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      ws.send(message);
    });
  }

  /**
   * Execute raw ExtendScript in an Adobe app.
   */
  async executeScript(app, script) {
    return this.send(app, '_eval', { script });
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

  // ── SIMULATION (when Adobe apps aren't connected) ──────────────────────

  _simulateResponse(app, command, params) {
    // Provides realistic mock responses for development and testing
    const simulations = {
      'project.open': { name: params.path?.split('/').pop() || 'Project', sequences: ['Main Sequence'] },
      'project.create': { path: `${params.path}/${params.name}.prproj`, name: params.name },
      'project.getInfo': {
        name: 'My Project',
        path: '/projects/my-project.prproj',
        sequences: [{ name: 'Main Sequence', duration: 300, trackCount: { video: 4, audio: 4 } }],
        mediaCount: 12,
        bins: ['Footage', 'Audio', 'Graphics'],
      },
      'project.save': { path: params.saveAs || '/projects/saved.prproj' },
      'project.importMedia': { imported: params.files || [] },
      'timeline.create': { name: params.name, id: `seq_${Date.now()}` },
      'timeline.getState': {
        name: 'Main Sequence',
        duration: 300,
        playheadPosition: 0,
        videoTracks: [
          { index: 0, clips: [{ name: 'Clip 1', start: 0, end: 45, source: 'footage_01.mp4' }] },
          { index: 1, clips: [] },
        ],
        audioTracks: [
          { index: 0, clips: [{ name: 'Audio 1', start: 0, end: 45 }] },
          { index: 1, clips: [] },
        ],
        markers: [],
      },
      'timeline.addClip': { clipId: `clip_${Date.now()}` },
      'export.media': { estimatedTime: '~5 minutes', jobId: `job_${Date.now()}` },
      'export.frame': { path: params.outputPath },
    };

    const key = command;
    return Promise.resolve(simulations[key] || { success: true, command, params, simulated: true });
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
