// ============================================================================
//  Source inspection — workflow step 1 and 2: what is this footage encoded
//  as, and is the colour-management / transform pipeline already in place?
//
//  Evidence sources (each recorded in `evidence`):
//   - Premiere ProjectItem.getColorSpace() → { name, primaries,
//     transferCharacteristic, matrixEquation, isSceneReferred }. The numeric
//     codes are interpreted as ITU-T H.273 code points (Premiere reports 1/1/1
//     for Rec.709 media, which matches H.273). Verified live on Premiere
//     26.5.2 for 709 media only — HDR/log code points are from H.273, not yet
//     observed from Premiere (needs HDR/log sample footage).
//   - ffmpeg stream line: pix_fmt (bit depth, chroma subsampling), range,
//     matrix/primaries/transfer tags.
//   - Lumetri state: Input LUT selection, High Dynamic Range toggle.
//
//  Log footage is frequently tagged as plain bt709 in H.264/HEVC headers, so
//  "rec709 tags" never proves "display-referred". If the histogram looks
//  log-like we say so as a SUSPICION and ask; we never silently assume.
// ============================================================================

// ITU-T H.273 code points (subset).
const H273_TRANSFER = { 1: 'bt709', 6: 'bt709', 13: 'srgb', 14: 'bt709', 15: 'bt709', 16: 'pq', 18: 'hlg' };
const H273_PRIMARIES = { 1: 'bt709', 9: 'bt2020', 12: 'p3d65' };
const H273_MATRIX = { 1: 'bt709', 5: 'bt601', 6: 'bt601', 9: 'bt2020nc', 10: 'bt2020c' };

/** Parse the `Video:` line(s) of `ffmpeg -i` output. */
export function parseFfmpegVideoStream(text) {
  const line = String(text).split('\n').find((l) => /Stream .*Video:/.test(l));
  if (!line) return null;
  const codec = (line.match(/Video:\s*([a-z0-9_]+)/i) || [])[1] || null;
  const pf = line.match(/,\s*([a-z0-9_]+)\(([^)]*)\)/i) || line.match(/,\s*(yuv[a-z0-9_]+|rgb[a-z0-9_]+|gbr[a-z0-9_]+|nv12|p010le)\s*,/i);
  const pixFmt = pf ? pf[1] : null;
  const inner = pf && pf[2] ? pf[2].split(',').map((s) => s.trim()) : [];
  let range = null, matrix = null, primaries = null, transfer = null;
  for (const tok of inner) {
    if (tok === 'tv' || tok === 'pc') range = tok === 'tv' ? 'limited' : 'full';
    else if (tok.includes('/')) {
      const [m, p, t] = tok.split('/');
      matrix = m; primaries = p || m; transfer = t || p || m;
    } else if (/^(bt|smpte|arib|iec|ycgco|gbr|unknown)/.test(tok)) {
      matrix = primaries = transfer = tok;
    }
  }
  const size = line.match(/,\s*(\d{2,5})x(\d{2,5})/);
  const fps = line.match(/([\d.]+)\s*fps/);
  let bitDepth = 8;
  if (pixFmt) {
    const m = pixFmt.match(/p(\d{2})(le|be)?$/) || pixFmt.match(/(\d{2})(le|be)$/);
    if (m) bitDepth = Number(m[1]);
    else if (pixFmt === 'p010le') bitDepth = 10;
  }
  const chroma = pixFmt ? (pixFmt.match(/(4[24][024])/) || [])[1] || null : null;
  return {
    codec, pixFmt, bitDepth, chromaSubsampling: chroma, range,
    matrix, primaries, transfer: normaliseTransfer(transfer),
    width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    raw: line.trim(),
  };
}

function normaliseTransfer(t) {
  if (!t) return null;
  if (t === 'arib-std-b67') return 'hlg';
  if (t === 'smpte2084') return 'pq';
  if (t === 'iec61966-2-1') return 'srgb';
  return t;
}

/** Decode Premiere's getColorSpace() payload. */
export function parsePremiereColorSpace(cs) {
  if (!cs || cs.empty) return null;
  return {
    name: cs.name || null,
    transfer: H273_TRANSFER[cs.transferCharacteristic] || `h273:${cs.transferCharacteristic}`,
    primaries: H273_PRIMARIES[cs.primaries] || `h273:${cs.primaries}`,
    matrix: H273_MATRIX[cs.matrixEquation] || `h273:${cs.matrixEquation}`,
    sceneReferred: !!cs.isSceneReferred,
  };
}

/**
 * Histogram heuristic for "this might be log": compressed tonal range with
 * a lifted floor and low saturation. Returns a suspicion with numbers — not a
 * classification. Thresholds describe the typical look of an un-transformed
 * log image; a flat-lit or foggy Rec.709 shot can trip them too, which is
 * why the result is phrased as a question.
 */
export function logSuspicion(frameStats) {
  if (!frameStats) return null;
  const { p1, p99 } = frameStats.luma;
  const lifted = p1 > 0.06;
  const compressed = p99 - p1 < 0.62;
  const flat = frameStats.saturation.chromaP95 < 0.12;
  const suspicious = lifted && compressed && flat;
  return {
    suspicious,
    evidence: { lumaP1: round(p1), lumaP99: round(p99), chromaP95: round(frameStats.saturation.chromaP95) },
    note: suspicious
      ? 'Lifted blacks + compressed range + low chroma: this may be un-transformed log or a flat picture profile. Confirm the camera profile before grading (declaredEncoding).'
      : null,
  };
}

/**
 * Combine evidence into an encoding verdict and pipeline decision.
 * @param {object} p { premiere, ffmpeg, lumetri:{inputLutSelected, hdrMode}, sequence, declaredEncoding, frameStats }
 */
export function inspectSource({ premiere, ffmpeg, lumetri = {}, sequence = {}, declaredEncoding, frameStats } = {}) {
  const evidence = [];
  const warnings = [];
  const pr = parsePremiereColorSpace(premiere);
  if (pr) evidence.push(`Premiere interprets the media as "${pr.name}" (transfer ${pr.transfer}, primaries ${pr.primaries}, matrix ${pr.matrix}${pr.sceneReferred ? ', scene-referred' : ''}).`);
  if (ffmpeg) evidence.push(`Container: ${ffmpeg.codec} ${ffmpeg.pixFmt} — ${ffmpeg.bitDepth}-bit ${ffmpeg.chromaSubsampling || ''}, ${ffmpeg.range || 'range untagged'}, tags ${ffmpeg.matrix || '?'}/${ffmpeg.primaries || '?'}/${ffmpeg.transfer || '?'}.`);

  let encoding = 'unknown';
  const tagTransfer = pr?.transfer || ffmpeg?.transfer;
  if (declaredEncoding) {
    encoding = declaredEncoding;
    evidence.push(`Encoding declared by the editor: ${declaredEncoding}.`);
  } else if (tagTransfer === 'hlg') encoding = 'hlg';
  else if (tagTransfer === 'pq') encoding = 'pq';
  else if (tagTransfer === 'bt709' || tagTransfer === 'srgb') encoding = 'sdr_rec709';

  if (pr && ffmpeg?.transfer && pr.transfer !== ffmpeg.transfer && !(pr.transfer === 'bt709' && ffmpeg.transfer === 'bt709')) {
    warnings.push(`Premiere's interpretation (${pr.transfer}) differs from the file tag (${ffmpeg.transfer}) — check Modify ▸ Interpret Footage ▸ Color Management.`);
  }

  const suspicion = !declaredEncoding && encoding === 'sdr_rec709' ? logSuspicion(frameStats) : null;
  if (suspicion?.suspicious) warnings.push(suspicion.note);

  // Transform pipeline.
  const hdrSource = encoding === 'hlg' || encoding === 'pq';
  const logSource = typeof encoding === 'string' && encoding.startsWith('log');
  const transformNeeded = hdrSource || logSource;
  const colorManaged = !!(pr && (hdrSource ? pr.transfer === encoding : false));
  const steps = [];
  if (!transformNeeded) {
    steps.push('Display-referred SDR source: no technical input transform. Grade directly.');
    if (lumetri.inputLutSelected) warnings.push('A Lumetri Input LUT is selected on a Rec.709 source — if it is a log→709 LUT this is a wrong (or double) transform. Verify before grading.');
  } else if (hdrSource) {
    if (colorManaged && lumetri.inputLutSelected) {
      warnings.push(`DOUBLE TRANSFORM RISK: Premiere already colour-manages this ${encoding.toUpperCase()} media into the sequence space AND a Lumetri Input LUT is selected. Remove one.`);
    }
    steps.push(colorManaged
      ? `Premiere colour-manages ${encoding.toUpperCase()} → sequence working space. Do NOT add a conversion LUT on top.`
      : `Set the clip interpretation to ${encoding.toUpperCase()} (Interpret Footage ▸ Color Management) so Premiere performs the transform once.`);
    steps.push(`Delivery decides the target: SDR Rec.709 output needs tone-mapping (sequence/export colour settings); HDR output needs an HDR sequence working space.`);
  } else if (logSource) {
    steps.push(lumetri.inputLutSelected
      ? 'A Lumetri Input LUT is selected — confirm it is the camera vendor\'s log→Rec.709 LUT for this exact profile. Do not add a second technical LUT.'
      : `Apply exactly one technical transform for ${encoding} (camera-vendor LUT in Lumetri ▸ Basic ▸ Input LUT, or Premiere's log colour management) BEFORE any creative grade.`);
  }
  if (encoding === 'unknown') warnings.push('Source encoding could not be established from metadata. State the camera profile (declaredEncoding) before grading.');
  if (ffmpeg && ffmpeg.bitDepth <= 8) evidence.push('8-bit source: keep curve slopes gentle — steep curves and large hue shifts band.');

  return {
    encoding,
    bitDepth: ffmpeg?.bitDepth ?? null,
    chromaSubsampling: ffmpeg?.chromaSubsampling ?? null,
    range: ffmpeg?.range ?? null,
    premiereInterpretation: pr,
    sequence,
    transform: { needed: transformNeeded, premiereColorManaged: colorManaged, inputLutSelected: !!lumetri.inputLutSelected, steps },
    logSuspicion: suspicion,
    evidence,
    warnings,
    readyForCreativeGrade: encoding !== 'unknown' && !warnings.some((w) => w.startsWith('DOUBLE TRANSFORM')) && !suspicion?.suspicious,
  };
}

function round(x) { return Math.round(x * 1000) / 1000; }
