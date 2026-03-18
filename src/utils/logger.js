// ============================================================================
//  Logger Utility — Color-coded console logging for Adobe MCP Editor
// ============================================================================

import chalk from 'chalk';

const LEVEL_COLORS = {
  info: 'blue',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

class Logger {
  constructor(prefix = 'MCP') {
    this.prefix = prefix;
  }

  _log(level, ...args) {
    const color = LEVEL_COLORS[level] || 'white';
    const tag = chalk[color](`[${this.prefix}]`);
    const timestamp = chalk.gray(new Date().toISOString().slice(11, 19));
    // Only output to stderr so we don't interfere with MCP stdio protocol
    console.error(`${timestamp} ${tag}`, ...args);
  }

  info(...args) { this._log('info', ...args); }
  success(...args) { this._log('success', chalk.green('✓'), ...args); }
  warn(...args) { this._log('warn', chalk.yellow('⚠'), ...args); }
  error(...args) { this._log('error', chalk.red('✗'), ...args); }
  debug(...args) { this._log('debug', ...args); }
}

export { Logger };
