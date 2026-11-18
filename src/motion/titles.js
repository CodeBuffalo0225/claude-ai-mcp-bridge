// ============================================================================
//  Title / lower-third renderer — transparent PNGs at sequence resolution.
//
//  Premiere 26.x has no scriptable graphic text (Essential Graphics text is
//  only reachable through a .mogrt), so titles are rendered here as stills
//  and animated in Premiere with Opacity / Motion / Blur / Crop keyframes.
//  Look: clean sans, generous tracking, a soft FEATHERED drop shadow (SVG
//  Gaussian blur, not a hard offset), and a lower-third bar whose edges are
//  feathered with an alpha gradient. Rendered by librsvg via sharp, using
//  installed system fonts.
// ============================================================================

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export const TITLE_STYLES = {
  // Centered hero title.
  hero: { size: 0.085, weight: 800, tracking: 0.04, color: '#ffffff', y: 0.5, anchor: 'middle', upper: true },
  // Smaller centered chapter card.
  chapter: { size: 0.05, weight: 700, tracking: 0.12, color: '#ffffff', y: 0.5, anchor: 'middle', upper: true },
  // Social hook, upper third.
  hook: { size: 0.07, weight: 900, tracking: 0.02, color: '#ffffff', y: 0.22, anchor: 'middle', upper: true },
};

function shadowFilter(h, strength = 0.55) {
  const blur = Math.max(2, Math.round(h * 0.006));
  const dy = Math.max(1, Math.round(h * 0.003));
  return `<filter id="soft" x="-20%" y="-50%" width="140%" height="200%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="${blur}"/>
    <feOffset dy="${dy}" result="b"/>
    <feComponentTransfer><feFuncA type="linear" slope="${strength}"/></feComponentTransfer>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
}

const FONT = "'Helvetica Neue', 'Avenir Next', Helvetica, Arial, sans-serif";

/** Render one line of title text. Returns the PNG path. */
export async function renderTitle({ text, style = 'hero', width = 3840, height = 2160, outPath, color }) {
  const s = TITLE_STYLES[style];
  if (!s) throw new Error(`unknown title style ${style}`);
  const size = Math.round(height * s.size);
  const t = s.upper ? String(text).toUpperCase() : String(text);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs>${shadowFilter(height)}</defs>
    <text x="${width / 2}" y="${Math.round(height * s.y + size * 0.35)}" text-anchor="${s.anchor}" font-family="${FONT}" font-weight="${s.weight}" font-size="${size}" letter-spacing="${(s.tracking * size).toFixed(1)}" fill="${color || s.color}" filter="url(#soft)">${esc(t)}</text></svg>`;
  return writeSvg(svg, outPath);
}

/**
 * Lower third as THREE layers (bar, name, role) so they can be staggered.
 * The bar's left edge is solid and its right edge feathers to transparent.
 */
export async function renderLowerThird({ name, role = '', width = 3840, height = 2160, outDir, prefix = 'lower_third', accent = '#E8A23A' }) {
  const x = Math.round(width * 0.07), yBase = Math.round(height * 0.80);
  const nameSize = Math.round(height * 0.042), roleSize = Math.round(height * 0.024);
  const barH = Math.round(nameSize * 2.6), barW = Math.round(width * 0.36);
  const barY = yBase - Math.round(nameSize * 1.55);
  const bar = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#000" stop-opacity="0.62"/><stop offset="0.7" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <filter id="feather" x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation="${Math.round(height * 0.004)}"/></filter></defs>
    <rect x="${x - Math.round(height * 0.012)}" y="${barY}" width="${barW}" height="${barH}" fill="url(#fade)" filter="url(#feather)"/>
    <rect x="${x - Math.round(height * 0.012)}" y="${barY + Math.round(barH * 0.12)}" width="${Math.max(4, Math.round(height * 0.004))}" height="${Math.round(barH * 0.76)}" fill="${accent}"/></svg>`;
  const nameSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs>${shadowFilter(height, 0.45)}</defs>
    <text x="${x + Math.round(height * 0.012)}" y="${yBase - Math.round(nameSize * 0.2)}" font-family="${FONT}" font-weight="800" font-size="${nameSize}" letter-spacing="${(0.03 * nameSize).toFixed(1)}" fill="#ffffff" filter="url(#soft)">${esc(String(name).toUpperCase())}</text></svg>`;
  const roleSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs>${shadowFilter(height, 0.4)}</defs>
    <text x="${x + Math.round(height * 0.012)}" y="${yBase + Math.round(roleSize * 1.15)}" font-family="${FONT}" font-weight="500" font-size="${roleSize}" letter-spacing="${(0.18 * roleSize).toFixed(1)}" fill="#ffffff" fill-opacity="0.88" filter="url(#soft)">${esc(String(role).toUpperCase())}</text></svg>`;
  fs.mkdirSync(outDir, { recursive: true });
  return {
    bar: await writeSvg(bar, path.join(outDir, `${prefix}_bar.png`)),
    name: await writeSvg(nameSvg, path.join(outDir, `${prefix}_name.png`)),
    role: role ? await writeSvg(roleSvg, path.join(outDir, `${prefix}_role.png`)) : null,
  };
}

async function writeSvg(svg, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}
