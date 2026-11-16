// ============================================================================
//  Style Profile Store
//  Persists and retrieves the generated Style DNA Profile to disk.
//  macOS: ~/Library/Application Support/CutPilot-AI/style-profile.json
//  Windows: %APPDATA%\CutPilot-AI\style-profile.json
// ============================================================================

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { Logger } from '../utils/logger.js';

const logger = new Logger('ProfileStore');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getStorePath() {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'CutPilot-AI');
  }
  if (plat === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'CutPilot-AI');
  }
  // Linux / fallback
  return join(homedir(), '.config', 'cutpilot-ai');
}

function getProfilePath() {
  return join(getStorePath(), 'style-profile.json');
}

function ensureDir() {
  const dir = getStorePath();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a Style DNA Profile object to disk.
 */
function saveProfile(profileObject) {
  ensureDir();
  const filePath = getProfilePath();
  const data = { ...profileObject, _savedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.success(`Profile saved to ${filePath}`);
}

/**
 * Load the saved profile. Returns the profile object or null if none exists.
 * Adds `stale: true` if the profile is older than 30 days.
 */
function loadProfile() {
  const filePath = getProfilePath();
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const profile = JSON.parse(raw);

    // Check staleness
    const savedAt = profile.generated_at || profile._savedAt;
    if (savedAt) {
      const age = Date.now() - new Date(savedAt).getTime();
      if (age > THIRTY_DAYS_MS) {
        profile.stale = true;
      }
    }

    return profile;
  } catch (err) {
    logger.error(`Failed to read profile: ${err.message}`);
    return null;
  }
}

/**
 * Check whether a profile exists on disk.
 */
function profileExists() {
  return existsSync(getProfilePath());
}

/**
 * Delete the stored profile.
 */
function clearProfile() {
  const filePath = getProfilePath();
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    logger.success('Profile cleared');
  }
}

export {
  saveProfile,
  loadProfile,
  profileExists,
  clearProfile,
  getStorePath,
  getProfilePath,
};
