// ============================================================================
//  Frame sources — where analysed frames come from.
//
//   premiere: the bridge renders the sequence frame (QE exportFramePNG) —
//             includes the CURRENT grade and every track above (titles,
//             graphics). Use for before/after evidence.
//   source:   ffmpeg decodes the original media — ungraded. Use to inspect
//             the camera original. The YUV→RGB matrix and range are passed
//             explicitly: ffmpeg's swscale defaults to BT.601, which skews
//             hue/saturation measurements on BT.709 footage.
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const local = path.join(os.homedir(), '.local', 'bin', 'ffmpeg');
  return fs.existsSync(local) ? local : 'ffmpeg';
}

const MATRIX_ARG = { bt709: 'bt709', bt601: 'bt601', smpte170m: 'bt601', bt470bg: 'bt601', bt2020nc: 'bt2020', bt2020c: 'bt2020', bt2020: 'bt2020' };

/** Build the ffmpeg args for one display-encoded RGB frame (exported for tests). */
export function ffmpegFrameArgs(mediaPath, timeSec, outPath, { matrix = 'bt709', range = 'limited' } = {}) {
  const m = MATRIX_ARG[matrix];
  if (!m) throw new Error(`Unsupported YUV matrix for frame extraction: ${matrix}`);
  const inRange = range === 'full' ? 'pc' : 'tv';
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0, timeSec)),
    '-i', mediaPath,
    '-frames:v', '1',
    '-vf', `scale=in_color_matrix=${m}:in_range=${inRange}:out_range=pc,format=rgb24`,
    outPath,
  ];
}

export async function extractSourceFrame(mediaPath, timeSec, outPath, opts = {}) {
  if (!fs.existsSync(mediaPath)) throw new Error(`Media not found: ${mediaPath}`);
  await run(ffmpegPath(), ffmpegFrameArgs(mediaPath, timeSec, outPath, opts), { timeout: 60000 });
  if (!fs.existsSync(outPath)) throw new Error(`ffmpeg produced no frame at ${timeSec}s from ${mediaPath}`);
  return outPath;
}

export async function probeMedia(mediaPath) {
  try {
    await run(ffmpegPath(), ['-hide_banner', '-i', mediaPath], { timeout: 30000 });
    return '';
  } catch (e) {
    // `ffmpeg -i` with no output always exits 1; the stream info is on stderr.
    return String(e.stderr || '');
  }
}

/** Wait until a file exists and its size is stable (QE export is async). */
export async function waitForFile(p, { timeoutMs = 20000, intervalMs = 150 } = {}) {
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) {
      const { size } = fs.statSync(p);
      if (size > 0 && size === lastSize) return p;
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Frame export did not appear at ${p} within ${timeoutMs} ms`);
}
