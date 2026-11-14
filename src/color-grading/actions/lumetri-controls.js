// ============================================================================
//  Lumetri control registry — which grading controls the bridge can
//  ACTUALLY read and write, and how to find them.
//
//  Ground truth: a live read-only probe of Lumetri Color on Premiere Pro
//  26.5.2 (2026-11-14), stored as tests/fixtures/lumetri-26.5.2-probe.json.
//  Lumetri exposes ~130 flat ComponentParams; display names repeat
//  ("Saturation" ×4, "Temperature" ×2…) and some are blank. A control is
//  therefore located by SECTION HEADER + display name + value type — never by
//  a hard-coded index, which drifts between Premiere versions.
//
//  status:
//    implemented  — numeric ComponentParam, setValue + getValue read-back
//                   verified live.
//    partial      — writable, but only meaningful after a manual UI step
//                   (e.g. HSL Secondary sliders need a key set by eyedropper).
//    unavailable  — opaque blob / button / UI-only. Not writable by script.
//                   The fallback is named in `fallback`.
//
//  Neutral values are the Lumetri defaults read from a fresh instance.
//  uiRange is the slider range shown in Premiere's UI. It is NOT confirmed
//  as the scripting range; every write is verified by read-back instead.
// ============================================================================

export const SECTION_HEADERS = ['Basic Correction', 'Creative', 'Curves', 'Color Wheels & Match', 'HSL Secondary', 'Vignette'];

const C = (section, name, neutral, uiRange, extra = {}) => ({ section, name, type: 'number', neutral, uiRange, status: 'implemented', ...extra });

export const LUMETRI_CONTROLS = {
  // Basic Correction ▸ White Balance / Tone / Saturation
  'basic.temperature': C('Basic Correction', 'Temperature', 0, [-100, 100], { axis: 'blue↔yellow (+ = warmer)' }),
  'basic.tint': C('Basic Correction', 'Tint', 0, [-100, 100], { axis: 'green↔magenta (+ = magenta)' }),
  'basic.exposure': C('Basic Correction', 'Exposure', 0, [-5, 5]),
  'basic.contrast': C('Basic Correction', 'Contrast', 0, [-100, 100]),
  'basic.highlights': C('Basic Correction', 'Highlights', 0, [-100, 100]),
  'basic.shadows': C('Basic Correction', 'Shadows', 0, [-100, 100]),
  'basic.whites': C('Basic Correction', 'Whites', 0, [-100, 100]),
  'basic.blacks': C('Basic Correction', 'Blacks', 0, [-100, 100]),
  'basic.saturation': C('Basic Correction', 'Saturation', 100, [0, 200], { note: '100 = unchanged. Not a delta.' }),
  // Creative
  'creative.fadedFilm': C('Creative', 'Faded Film', 0, [0, 100]),
  'creative.sharpen': C('Creative', 'Sharpen', 0, [-100, 100]),
  'creative.vibrance': C('Creative', 'Vibrance', 0, [-100, 100]),
  'creative.saturation': C('Creative', 'Saturation', 100, [0, 200], { note: '100 = unchanged. Not a delta.' }),
  'creative.tintBalance': C('Creative', 'Tint Balance', 0, [-100, 100]),
  'creative.lookIntensity': C('Creative', 'Intensity', 100, [0, 200]),
  // HSL Secondary — sliders writable; the KEY (qualifier) is not.
  'hsl.denoise': C('HSL Secondary', 'Denoise', 0, [0, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.blur': C('HSL Secondary', 'Blur', 0, [0, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.temperature': C('HSL Secondary', 'Temperature', 0, [-100, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.tint': C('HSL Secondary', 'Tint', 0, [-100, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.contrast': C('HSL Secondary', 'Contrast', 0, [-100, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.sharpen': C('HSL Secondary', 'Sharpen', 0, [-100, 100], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  'hsl.saturation': C('HSL Secondary', 'Saturation', 100, [0, 200], { status: 'partial', requires: 'secondaryKeyConfirmed' }),
  // Vignette
  'vignette.amount': C('Vignette', 'Amount', 0, [-5, 5]),
  'vignette.midpoint': C('Vignette', 'Midpoint', 50, [0, 100]),
  'vignette.roundness': C('Vignette', 'Roundness', 0, [-100, 100]),
  'vignette.feather': C('Vignette', 'Feather', 50, [0, 100]),
};

const U = (what, fallback) => ({ status: 'unavailable', what, fallback });

export const UNAVAILABLE_CONTROLS = {
  'curves.rgb': U('RGB Curves (master/R/G/B) — opaque string blob', 'bake a .cube LUT (color_build_curve_lut) and load it in Creative ▸ Look'),
  'curves.hueVsSat': U('Hue vs Sat curve — opaque string blob', 'bake into a .cube LUT if leakage is low; else HSL Secondary key + Saturation, or a masked second Lumetri'),
  'curves.hueVsHue': U('Hue vs Hue curve — opaque string blob', 'bake into a .cube LUT'),
  'curves.hueVsLuma': U('Hue vs Luma curve — opaque string blob', 'bake into a .cube LUT'),
  'curves.lumaVsSat': U('Luma vs Sat curve — opaque string blob', 'bake into a .cube LUT'),
  'curves.satVsSat': U('Sat vs Sat curve — opaque string blob', 'bake into a .cube LUT'),
  'wheels.shadows': U('Color Wheels & Match wheels — opaque blob', 'bake wheels into a .cube LUT; or Basic Temperature/Tint for global casts'),
  'wheels.midtones': U('Color Wheels & Match wheels — opaque blob', 'bake wheels into a .cube LUT'),
  'wheels.highlights': U('Color Wheels & Match wheels — opaque blob', 'bake wheels into a .cube LUT'),
  'colorMatch.apply': U('Color Match "Apply Match" button — UI only', 'measure-and-solve shot matching (color_match_shots) on Temperature/Tint/Exposure/Contrast/Saturation'),
  'hsl.key': U('HSL Secondary key colours/ranges — packed values + blob', 'set the key by eyedropper in the UI, then confirm (secondaryKeyConfirmed)'),
  'mask.shape': U('Effect masks (ellipse/pen) — no scripting API', 'draw the mask in Effect Controls; this tool supplies the face track to follow'),
  'mask.track': U('Mask tracking — UI only', 'Effect Controls ▸ mask ▸ Track Forward; validate with color_validate_frames'),
  'look.path': U('Creative ▸ Look / Input LUT file path — opaque asset blob', 'Browse… in the UI'),
};

/**
 * Locate a control in a probed property list.
 * @param props [{ index, name, type }] from color.probeLumetri
 * @returns { index, name, section } or { error }
 */
export function resolveControl(props, controlId) {
  const def = LUMETRI_CONTROLS[controlId];
  if (!def) {
    const u = UNAVAILABLE_CONTROLS[controlId];
    return { error: u ? `${controlId} is not scriptable: ${u.what}. Fallback: ${u.fallback}` : `Unknown Lumetri control: ${controlId}` };
  }
  const range = sectionRange(props, def.section);
  if (!range) return { error: `Lumetri section "${def.section}" not found on this Premiere version` };
  for (let i = range.start; i < range.end; i++) {
    const p = props[i];
    if (p.name === def.name && p.type === def.type) return { index: p.index, name: p.name, section: def.section };
  }
  return { error: `"${def.name}" (${def.type}) not found in Lumetri ▸ ${def.section} on this Premiere version` };
}

export function sectionRange(props, sectionName) {
  let start = -1;
  for (let i = 0; i < props.length; i++) {
    if (start < 0) {
      if (props[i].name === sectionName && props[i].type === 'boolean') start = i + 1;
    } else if (SECTION_HEADERS.includes(props[i].name) && props[i].type === 'boolean') {
      return { start, end: i };
    }
  }
  return start < 0 ? null : { start, end: props.length };
}

/**
 * Turn lumetri ops into a write list against a probe. Delta ops are resolved
 * against the CURRENT value. Unsupported/partial controls are returned in
 * `skipped` with the reason — never dropped silently.
 */
export function planLumetriWrites(props, ops, { secondaryKeyConfirmed = false } = {}) {
  const writes = [], skipped = [];
  for (const op of ops) {
    const def = LUMETRI_CONTROLS[op.control];
    if (def?.requires === 'secondaryKeyConfirmed' && !secondaryKeyConfirmed) {
      skipped.push({ control: op.control, reason: 'HSL Secondary sliders act on whatever the key selects. Set the key with the eyedropper in Premiere first, then retry with secondaryKeyConfirmed:true.' });
      continue;
    }
    const loc = resolveControl(props, op.control);
    if (loc.error) { skipped.push({ control: op.control, reason: loc.error }); continue; }
    const current = props.find((p) => p.index === loc.index)?.value;
    const value = op.mode === 'delta' ? (typeof current === 'number' ? current + op.value : NaN) : op.value;
    if (!Number.isFinite(value)) { skipped.push({ control: op.control, reason: `cannot apply delta: current value unreadable (${current})` }); continue; }
    const [lo, hi] = def.uiRange;
    const warning = value < lo || value > hi ? `value ${value} is outside the UI range [${lo}, ${hi}] — Premiere may clamp; read-back will show what stuck` : null;
    writes.push({ control: op.control, index: loc.index, name: loc.name, section: loc.section, before: current, value: round(value), warning });
  }
  return { writes, skipped };
}

/**
 * Presets in color-grader.js store every value as an OFFSET from neutral
 * (saturation: 10 means "+10"). Lumetri saturation is absolute with 100 =
 * neutral, so sending the raw preset number would set Saturation = 10 —
 * near grayscale. This converts preset groups to absolute lumetri ops and
 * reports what the preset asked for that cannot be scripted.
 */
const PRESET_KEYS = {
  basic: { temperature: 'basic.temperature', tint: 'basic.tint', exposure: 'basic.exposure', contrast: 'basic.contrast', highlights: 'basic.highlights', shadows: 'basic.shadows', whites: 'basic.whites', blacks: 'basic.blacks', saturation: 'basic.saturation' },
  creative: { vibrance: 'creative.vibrance', saturation: 'creative.saturation', fadeAmount: 'creative.fadedFilm', sharpen: 'creative.sharpen' },
  vignette: { amount: 'vignette.amount', midpoint: 'vignette.midpoint', roundness: 'vignette.roundness', feather: 'vignette.feather' },
};
const ABSOLUTE_PRESET_KEYS = new Set(['vignette.midpoint', 'vignette.feather', 'vignette.roundness']);

export function presetToLumetriOps(preset) {
  const ops = [], unsupported = [];
  for (const [group, values] of Object.entries(preset)) {
    if (['name', 'notes'].includes(group)) continue;
    const map = PRESET_KEYS[group];
    if (!map) {
      unsupported.push({ group, reason: group === 'curves' ? UNAVAILABLE_CONTROLS['curves.rgb'].what
        : group === 'colorWheels' ? UNAVAILABLE_CONTROLS['wheels.midtones'].what
        : group === 'hsl' ? 'HSL per-colour saturation/luminance — no scriptable control (would need Hue vs Sat/Luma curves)'
        : 'unknown preset group' });
      continue;
    }
    for (const [key, v] of Object.entries(values)) {
      const control = map[key];
      if (!control || typeof v !== 'number') { unsupported.push({ group, key, reason: 'no matching Lumetri control' }); continue; }
      const def = LUMETRI_CONTROLS[control];
      const value = ABSOLUTE_PRESET_KEYS.has(control) ? v : def.neutral + v;
      ops.push({ op: 'lumetri', control, value: round(value), mode: 'absolute' });
    }
  }
  return { ops, unsupported };
}

/** Capability table rows for docs / the color_capabilities tool. */
export function capabilityTable() {
  return [
    ...Object.entries(LUMETRI_CONTROLS).map(([id, d]) => ({ control: id, lumetri: `${d.section} ▸ ${d.name}`, status: d.status, note: d.requires ? 'needs a key set in the UI first' : (d.note || '') })),
    ...Object.entries(UNAVAILABLE_CONTROLS).map(([id, d]) => ({ control: id, lumetri: d.what, status: d.status, note: `fallback: ${d.fallback}` })),
  ];
}

function round(x) { return Math.round(x * 1000) / 1000; }
