// ============================================================================
//  Adobe Bridge — facade over per-app HostAdapters.
//
//  Connects MCP servers to Adobe Premiere Pro and After Effects. The public
//  API (send/sendJob/executeScript/info/reloadJsx/connect/on/getStatus) is
//  what every upper layer uses; HOW commands reach the host app is a
//  HostAdapter's business. Today that's CepWebSocketAdapter (CEP panel);
//  when Adobe retires CEP, set adapter 'uxp' per app and implement
//  adapters/uxp-adapter.js — nothing else changes.
//  Contract: docs/host-adapter-protocol.md.
// ============================================================================

import { Logger } from '../utils/logger.js';
import { CepWebSocketAdapter } from './adapters/cep-ws-adapter.js';
import { UxpAdapter } from './adapters/uxp-adapter.js';
import { harvestDirectory } from '../style-learning/project-harvester.js';
import { analyzeStyle } from '../style-learning/style-analyzer.js';
import { saveProfile, loadProfile, clearProfile } from '../style-learning/style-profile-store.js';

const logger = new Logger('AdobeBridge');

// ── Default ports for the bridge transports ──────────────────────────────
const DEFAULT_PORTS = {
  premiere: 8081,
  aftereffects: 8082,
};

const ADAPTERS = {
  cep: CepWebSocketAdapter,
  uxp: UxpAdapter,
};

class AdobeBridge {
  constructor(config = {}) {
    this.config = {
      premierePort: config.premierePort || DEFAULT_PORTS.premiere,
      afterEffectsPort: config.afterEffectsPort || DEFAULT_PORTS.aftereffects,
      host: config.host || 'localhost',
      // Per-app transport: { premiere: 'cep'|'uxp', aftereffects: ... }.
      // Env vars BRIDGE_ADAPTER_PREMIERE / BRIDGE_ADAPTER_AFTEREFFECTS override.
      adapters: config.adapters || {},
      ...config,
    };

    this.eventListeners = new Map();
    this.adapters = {
      premiere: this._createAdapter('premiere'),
      aftereffects: this._createAdapter('aftereffects'),
    };
  }

  _createAdapter(app) {
    const envKey = app === 'premiere' ? 'BRIDGE_ADAPTER_PREMIERE' : 'BRIDGE_ADAPTER_AFTEREFFECTS';
    const kind = process.env[envKey] || this.config.adapters[app] || 'cep';
    const AdapterClass = ADAPTERS[kind];
    if (!AdapterClass) {
      throw new Error(`Unknown bridge adapter '${kind}' for ${app} (available: ${Object.keys(ADAPTERS).join(', ')})`);
    }
    if (kind !== 'cep') logger.info(`${app}: using '${kind}' adapter`);

    return new AdapterClass({
      appName: app,
      host: this.config.host,
      port: app === 'premiere' ? this.config.premierePort : this.config.afterEffectsPort,
      hooks: {
        onServerCommand: (message, reply) => this._handleServerCommand(message, reply),
        onEvent: (event, data) => this._emitEvent(app, event, data),
      },
    });
  }

  // ── CONNECTION MANAGEMENT ──────────────────────────────────────────────

  async connect(apps = ['premiere', 'aftereffects']) {
    const results = await Promise.allSettled(apps.map((app) => this.adapters[app].connect()));

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        logger.success(`Connected to ${apps[i]}`);
      } else {
        logger.warn(`Could not connect to ${apps[i]}: ${result.reason?.message}`);
        logger.info(`  Make sure the bridge panel/plugin is running in ${apps[i]}`);
      }
    });
  }

  async disconnect() {
    for (const [app, adapter] of Object.entries(this.adapters)) {
      await adapter.disconnect();
      logger.info(`Disconnected from ${app}`);
    }
  }

  // ── SEND COMMANDS ──────────────────────────────────────────────────────

  /**
   * Send a command to an Adobe app and wait for the response.
   * @param {string} app - 'premiere' or 'aftereffects'
   * @param {string} command - Dot-notation command (e.g., 'timeline.addClip')
   * @param {object} params - Command parameters
   * @param {object} opts - { timeoutMs } per-call timeout override
   * @returns {Promise<any>} - Command result
   */
  async send(app, command, params = {}, opts = {}) {
    const adapter = this.adapters[app];
    if (!adapter) throw new Error(`Unknown app: ${app}`);
    return adapter.send(command, params, opts);
  }

  /**
   * Run a long command as a host-side async job: the host replies with a
   * jobId immediately, then we poll _jobStatus until it finishes. Use for
   * anything that can outlive the request timeout (full-timeline grades,
   * exports, renders). maxWaitMs bounds the total polling time.
   */
  async sendJob(app, command, params = {}, { pollMs = 2000, maxWaitMs = 600000 } = {}) {
    const start = await this.send(app, command, { ...params, _async: true });
    if (!start || !start.jobId) {
      // Host predates async-job support — result came back synchronously.
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
   * Preflight handshake: which JSX/plugin build + handlers are live.
   */
  async info(app) {
    return this.send(app, '_info', {});
  }

  /**
   * Hot-reload the host-side script layer (no Premiere/AE restart).
   * Returns the freshly loaded version + handler list.
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

  // ── HOST-INITIATED COMMANDS (style learning) ──────────────────────────
  // The panel/plugin can send US commands (Analyze buttons in the panel UI).
  // These are app-agnostic — any adapter surfaces them through the same hook.

  _handleServerCommand(message, reply) {
    switch (message.command) {
      case 'ANALYZE_STYLE_DIR':
        this._handleAnalyzeStyleDir(message, reply);
        return;
      case 'GET_STYLE_PROFILE':
        reply({ id: message.id, result: loadProfile() });
        return;
      case 'CLEAR_STYLE_PROFILE':
        clearProfile();
        reply({ id: message.id, result: { success: true } });
        return;
      default:
        logger.warn(`Unhandled host-initiated command: ${message.command}`);
    }
  }

  _handleAnalyzeStyleDir(message, reply) {
    const { dirPath } = message.params || {};
    if (!dirPath) {
      reply({ id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: 'No dirPath provided' } });
      return;
    }

    // Run asynchronously so the bridge stays responsive
    (async () => {
      try {
        logger.info(`Style analysis started for: ${dirPath}`);
        const analyses = await harvestDirectory(dirPath);
        if (analyses.length === 0) {
          reply({ id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: 'No sequences found in directory' } });
          return;
        }
        const profile = await analyzeStyle(analyses);
        saveProfile(profile);
        reply({
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
        reply({ id: message.id, event: 'STYLE_ANALYSIS_ERROR', data: { message: err.message } });
      }
    })();
  }

  // ── STATUS ─────────────────────────────────────────────────────────────

  getStatus() {
    const premiere = this.adapters.premiere.getStatus();
    const aftereffects = this.adapters.aftereffects.getStatus();
    return {
      premiere: premiere.state,
      aftereffects: aftereffects.state,
      pendingRequests: premiere.pendingRequests + aftereffects.pendingRequests,
    };
  }
}

export { AdobeBridge };
