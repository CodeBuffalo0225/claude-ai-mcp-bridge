// ============================================================================
//  Face detection — wraps tools/vision/detect-faces.swift (Apple Vision).
//
//  Local, free, no new npm deps. The Swift helper is compiled once with
//  `swiftc -O` and cached under ~/.cache/claude-ai-editor/. Command Line
//  Tools sometimes ship a default SDK newer than the compiler (seen on this
//  Mac: Swift 6.1.2 vs MacOSX26.2.sdk), so we try the default SDK first and
//  then every installed MacOSX*.sdk, newest first, until one compiles.
//
//  Honest failure: on non-macOS, or if nothing compiles, detectFaces()
//  returns { available:false, reason } — callers must surface that and use
//  the manual-selection fallback. It never returns an empty face list as if
//  detection had run.
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SWIFT_SOURCE = path.resolve(HERE, '../../../tools/vision/detect-faces.swift');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-ai-editor');
const SDK_ROOT = '/Library/Developer/CommandLineTools/SDKs';

let compiled = null; // memoised { bin } | { error }

export async function ensureDetector({ swiftSource = SWIFT_SOURCE, cacheDir = CACHE_DIR } = {}) {
  if (compiled) return compiled;
  if (process.platform !== 'darwin') {
    compiled = { error: 'Face detection uses Apple Vision and only runs on macOS.' };
    return compiled;
  }
  const src = fs.readFileSync(swiftSource);
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 12);
  const bin = path.join(cacheDir, `detect-faces-${hash}`);
  if (fs.existsSync(bin)) return (compiled = { bin });
  fs.mkdirSync(cacheDir, { recursive: true });

  const sdks = [null, ...listSdks()];
  const errors = [];
  for (const sdk of sdks) {
    const args = ['-O', ...(sdk ? ['-sdk', sdk] : []), swiftSource, '-o', bin];
    try {
      await run('swiftc', args, { timeout: 300000 });
      return (compiled = { bin, sdk: sdk || 'default' });
    } catch (e) {
      errors.push(`${sdk || 'default SDK'}: ${String(e.stderr || e.message).split('\n').find((l) => l.includes('error')) || e.message}`);
    }
  }
  compiled = { error: `Could not compile the Vision face detector. Tried:\n${errors.join('\n')}` };
  return compiled;
}

function listSdks() {
  try {
    return fs.readdirSync(SDK_ROOT)
      .filter((n) => /^MacOSX\d+(\.\d+)?\.sdk$/.test(n))
      .sort((a, b) => sdkVersion(b) - sdkVersion(a))
      .map((n) => path.join(SDK_ROOT, n));
  } catch {
    return [];
  }
}

function sdkVersion(name) {
  const m = name.match(/MacOSX(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0;
}

/**
 * @param {string[]} imagePaths
 * @returns {Promise<{available:boolean, reason?:string, engine?:string, images?:Array}>}
 */
export async function detectFaces(imagePaths, opts = {}) {
  const det = await ensureDetector(opts);
  if (det.error) return { available: false, reason: det.error };
  try {
    const { stdout } = await run(det.bin, imagePaths, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    return { available: true, ...parseDetectorOutput(stdout) };
  } catch (e) {
    return { available: false, reason: `Vision detector failed: ${e.message}` };
  }
}

/** Parse + sanity-check the helper's JSON (exported for tests). */
export function parseDetectorOutput(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new Error('Face detector returned non-JSON output');
  }
  if (!Array.isArray(doc.images)) throw new Error('Face detector output missing images[]');
  for (const img of doc.images) {
    img.faces = (img.faces || []).filter((f) => f.bbox && f.bbox.w > 0 && f.bbox.h > 0);
    // Largest face first: index 0 is the most likely subject.
    img.faces.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  }
  return { engine: doc.engine, os: doc.os, images: doc.images };
}
