// ============================================================================
//  Image I/O — decode frames to raw 8-bit RGB and write previews. Uses
//  `sharp`, which is already a project dependency (no new deps).
//
//  Frames are expected to be display-referred 8-bit exports (Premiere QE
//  exportFramePNG, or ffmpeg with an explicit matrix — see frame-source.js).
//  This module does no colour conversion: it hands back the encoded values.
// ============================================================================

import sharp from 'sharp';

/**
 * Decode an image to { width, height, data: Uint8Array RGB, scale }.
 * `maxWidth` downsamples for analysis speed; `scale` maps decoded pixel
 * coordinates back to the original (origX = x / scale).
 */
export async function decodeRGB(path, { maxWidth } = {}) {
  const meta = await sharp(path).metadata();
  let pipeline = sharp(path).removeAlpha().toColourspace('srgb');
  let scale = 1;
  if (maxWidth && meta.width > maxWidth) {
    scale = maxWidth / meta.width;
    pipeline = pipeline.resize({ width: maxWidth, kernel: 'lanczos3' });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected 3 channels after decode, got ${info.channels}`);
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    scale,
    source: { path, width: meta.width, height: meta.height, bitsPerSample: meta.depth, hasAlpha: !!meta.hasAlpha },
  };
}

/** Build an image object from a raw RGB buffer (tests / synthetic frames). */
export function rgbImage(width, height, data) {
  return { width, height, data, scale: 1, source: { synthetic: true, width, height } };
}

export async function writePNG(img, path) {
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 3 },
  }).png().toFile(path);
  return path;
}

/**
 * Side-by-side before|after comparison with a thin divider, labels burned in
 * as SVG so the result is self-describing when shared.
 */
export async function writeComparison(before, after, path, { labels = ['BEFORE', 'AFTER'], note } = {}) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('before/after frames differ in size; export both from the same sequence');
  }
  const w = before.width, h = before.height, gap = 4;
  const toBuf = (img) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 3 },
  }).png().toBuffer();
  const fontSize = Math.max(14, Math.round(h / 28));
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const label = (text, x) => `<text x="${x + 12}" y="${fontSize + 10}" font-family="Helvetica" font-size="${fontSize}" font-weight="bold" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${esc(text)}</text>`;
  const noteSvg = note ? `<text x="12" y="${h - 12}" font-family="Helvetica" font-size="${Math.round(fontSize * 0.7)}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${esc(note)}</text>` : '';
  const svg = Buffer.from(`<svg width="${w * 2 + gap}" height="${h}" xmlns="http://www.w3.org/2000/svg">${label(labels[0], 0)}${label(labels[1], w + gap)}${noteSvg}</svg>`);
  await sharp({ create: { width: w * 2 + gap, height: h, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await toBuf(before), left: 0, top: 0 },
      { input: await toBuf(after), left: w + gap, top: 0 },
      { input: svg, left: 0, top: 0 },
    ])
    .png()
    .toFile(path);
  return path;
}
