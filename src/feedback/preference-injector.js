// ============================================================================
//  Preference Injector
//  Builds context blocks from user feedback preferences and the learned
//  Style DNA Profile for injection into Claude sessions.
// ============================================================================

import { loadProfile } from '../style-learning/style-profile-store.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('PrefInjector');

/**
 * Build the full preference context string to inject into Claude sessions.
 * Includes feedback preferences (if any) and the Style DNA Profile.
 *
 * @param {object} [options]
 * @param {string} [options.feedbackContext] - Pre-built feedback context string
 * @returns {string} - Full context block for system prompt injection
 */
function buildPreferenceContext(options = {}) {
  const blocks = [];

  // ── Feedback block (passed in from external feedback system) ────────────
  if (options.feedbackContext) {
    blocks.push(options.feedbackContext);
  }

  // ── Style Profile block ─────────────────────────────────────────────────
  const profile = loadProfile();

  if (profile) {
    const projectCount = profile.analyzed_project_count || '?';
    const sequenceCount = profile.analyzed_sequence_count || '?';

    let styleBlock = `--- LEARNED EDITING STYLE (analyzed from ${projectCount} projects, ${sequenceCount} sequences) ---\n`;
    styleBlock += profile.claude_context_block || '';

    if (profile.stale) {
      styleBlock += '\nNote: style profile is 30+ days old. Consider re-running analysis.';
    }

    styleBlock += '\n---';
    blocks.push(styleBlock);

    logger.debug(`Injected style profile: ${profile.profile_name}`);
  } else {
    blocks.push('--- No style profile loaded. Run: npm run learn-style to analyze existing projects. ---');
  }

  return blocks.join('\n\n');
}

export { buildPreferenceContext };
