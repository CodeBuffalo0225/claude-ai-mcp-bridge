#!/usr/bin/env node

// ============================================================================
//  Adobe MCP Editor — Main Entry Point
//  Starts both Premiere Pro and After Effects MCP servers
// ============================================================================

import { Logger } from './utils/logger.js';

const logger = new Logger('Main');

logger.info('Adobe MCP Editor v1.0.0');
logger.info('Use individual server commands:');
logger.info('  npm run start:premiere     — Premiere Pro MCP server');
logger.info('  npm run start:aftereffects — After Effects MCP server');
logger.info('');
logger.info('Or register with Claude Code:');
logger.info('  claude mcp add premiere-pro node src/mcp-servers/premiere-server.js');
logger.info('  claude mcp add after-effects node src/mcp-servers/aftereffects-server.js');
