// ============================================================================
//  Transition, text and audio recipes — the LOOK, in editor terms. Pure data.
//
//  A recipe is a plan of property animations relative to the CUT (t = 0 is
//  the edit point in sequence time; negative = before). Layers:
//    A  outgoing clip     B  incoming clip     T  a title/graphic layer
//  arrangement:
//    same_track  A and B butt on one track; each animates its own end/head
//                (dip, zoom push, whip) — no media handles needed.
//    overlap     B sits on the track above, overlapping A by `durationSec`
//                (dissolve, blur dissolve, feathered wipe) — needs handles.
//  Sizes (blur radius, wipe feather, offsets) scale with frame height so a
//  recipe looks the same at 1080 and 2160. Values are in Premiere units:
//  Opacity %, Scale %, Blurriness px, Position as a FRACTION of the frame
//  (converted to Premiere's position units by the actions layer after a
//  probe), Feather px.
// ============================================================================

import { planKeys, joinKeys } from './easing.js';

const px = (h, at1080) => Math.round((at1080 * h) / 1080);

// Effect identities: display name (QE addVideoEffect) + the params we drive.
// Calibrated live on Premiere 26.5.2 (2026-11-17), 720p renders:
//  - Gaussian Blur / Directional Blur are the NEW-generation effects:
//    params Amount / Angle / Edge Behavior (not legacy Blurriness / Blur
//    Length). Amount behaves as a resolution-independent strength: 30 cut
//    image gradient energy ~17×. Edge Behavior 0 or 1: no dark borders.
//  - Directional Blur Angle 90 = HORIZONTAL streak (0 = vertical).
//  - Crop sides are %, Edge Feather is PIXELS (60 px ≈ 0.05 of the width
//    at 720p) → scaled with frame height.
//  - Offset ▸ Shift Center To is normalised [x, y] (0.5, 0.5 = centre).
//  - Linear Wipe does NOT attach via QE addVideoEffect on 26.5.2 → feathered
//    wipes use Crop + Edge Feather.
export const FX = {
  gaussianBlur: { name: 'Gaussian Blur', params: { amount: 'Amount', edge: 'Edge Behavior' } },
  directionalBlur: { name: 'Directional Blur', params: { angle: 'Angle', amount: 'Amount' } },
  crop: { name: 'Crop', params: { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom', feather: 'Edge Feather' } },
  offset: { name: 'Offset', params: { shift: 'Shift Center To', blend: 'Blend With Original' } },
};

const anim = (layer, component, param, from, to, startRel, durationSec, curve) => ({ layer, component, param, from, to, startRel, durationSec, curve });

/**
 * Video transitions.
 * @param name   recipe id
 * @param o      { durationSec, height (frame px), fps }
 */
export function transitionRecipe(name, { durationSec, height = 2160, fps = 30 } = {}) {
  const d = durationSec, h2 = d / 2;
  const R = {
    // Classic, invisible. Smooth S-curve on the incoming layer only — the
    // outgoing layer stays opaque underneath, so no luminance dip.
    crossDissolve: () => ({
      arrangement: 'overlap', defaultDuration: 0.8,
      effects: [],
      anims: [anim('B', 'Opacity', 'Opacity', 0, 100, -h2, d, 'smooth')],
      audio: 'equalPower',
    }),
    // Dreamy, premium: both layers defocus through the dissolve.
    blurDissolve: () => ({
      arrangement: 'overlap', defaultDuration: 1.0,
      effects: [{ layer: 'A', fx: 'gaussianBlur', set: { edge: 1, amount: 0 } }, { layer: 'B', fx: 'gaussianBlur', set: { edge: 1, amount: 0 } }],
      anims: [
        anim('B', 'Opacity', 'Opacity', 0, 100, -h2, d, 'smooth'),
        anim('A', 'Gaussian Blur', 'amount', 0, 32, -h2, d * 0.6, 'easeInSine'),
        anim('B', 'Gaussian Blur', 'amount', 32, 0, -h2 + d * 0.4, d * 0.6, 'easeOutSine'),
      ],
      audio: 'equalPower',
    }),
    // Story beat / time passing.
    dipToBlack: () => ({
      arrangement: 'same_track', defaultDuration: 1.0,
      effects: [],
      anims: [
        anim('A', 'Opacity', 'Opacity', 100, 0, -h2, h2, 'easeInSine'),
        anim('B', 'Opacity', 'Opacity', 0, 100, 0, h2, 'easeOutSine'),
      ],
      audio: 'fadeOutIn',
    }),
    // Energetic social cut: punch in on A, land out of a zoom on B, with
    // blur sold as motion blur. Repeat Edge Pixels avoids dark borders.
    zoomPush: () => ({
      arrangement: 'same_track', defaultDuration: 0.5,
      effects: [{ layer: 'A', fx: 'gaussianBlur', set: { edge: 1, amount: 0 } }, { layer: 'B', fx: 'gaussianBlur', set: { edge: 1, amount: 0 } }],
      anims: [
        anim('A', 'Motion', 'Scale', 100, 135, -h2, h2, 'easeInCubic'),
        anim('A', 'Gaussian Blur', 'amount', 0, 38, -h2, h2, 'easeInCubic'),
        anim('B', 'Motion', 'Scale', 135, 100, 0, h2, 'easeOutCubic'),
        anim('B', 'Gaussian Blur', 'amount', 38, 0, 0, h2, 'easeOutCubic'),
      ],
      audio: 'shortCrossfade', sfx: 'whoosh',
    }),
    // Whip pan: Offset wraps the image (no black edges), Directional Blur
    // streaks it along the move. A exits left, B enters from the right.
    whipPan: () => ({
      arrangement: 'same_track', defaultDuration: 0.4,
      effects: [
        { layer: 'A', fx: 'offset' }, { layer: 'A', fx: 'directionalBlur', set: { angle: 90, amount: 0 } },
        { layer: 'B', fx: 'offset' }, { layer: 'B', fx: 'directionalBlur', set: { angle: 90, amount: 0 } },
      ],
      anims: [
        anim('A', 'Offset', 'shift', [0.5, 0.5], [1.0, 0.5], -h2, h2, 'easeInQuint'),
        anim('A', 'Directional Blur', 'amount', 0, 85, -h2, h2, 'easeInQuint'),
        anim('B', 'Offset', 'shift', [0.0, 0.5], [0.5, 0.5], 0, h2, 'easeOutQuint'),
        anim('B', 'Directional Blur', 'amount', 85, 0, 0, h2, 'easeOutQuint'),
      ],
      audio: 'shortCrossfade', sfx: 'whoosh',
    }),
    // Soft-edged wipe: the incoming shot is revealed right→left behind a
    // wide feathered edge (Crop Left 100→0 + Edge Feather; Linear Wipe does
    // not attach by script on 26.5.2).
    featheredWipe: () => ({
      arrangement: 'overlap', defaultDuration: 0.9,
      effects: [{ layer: 'B', fx: 'crop', set: { feather: px(height, 160), left: 100 } }],
      anims: [anim('B', 'Crop', 'left', 100, 0, -h2, d, 'smooth')],
      audio: 'equalPower',
    }),
  };
  if (!R[name]) throw new Error(`unknown transition "${name}" — one of ${Object.keys(R).join(', ')}`);
  const r = R[name]();
  return { name, durationSec: d, fps, height, ...r };
}

export const TRANSITIONS = ['crossDissolve', 'blurDissolve', 'dipToBlack', 'zoomPush', 'whipPan', 'featheredWipe'];

/**
 * Text / graphic in-out animation. Times relative to the layer's start (in)
 * and end (out). Returns anims with startRel measured from the LAYER START;
 * the out-animation uses `endRel` = negative offset from the layer end.
 */
export function textRecipe(name, { height = 2160, inSec = 0.6, outSec = 0.45 } = {}) {
  const R = {
    fadeUp: () => ({
      effects: [],
      in: [anim('T', 'Opacity', 'Opacity', 0, 100, 0, inSec * 0.8, 'easeOutSine'), anim('T', 'Motion', 'PositionY', 0.035, 0, 0, inSec, 'settle')],
      out: [anim('T', 'Opacity', 'Opacity', 100, 0, -outSec, outSec, 'easeInSine'), anim('T', 'Motion', 'PositionY', 0, -0.02, -outSec, outSec, 'accelerate')],
    }),
    blurIn: () => ({
      effects: [{ layer: 'T', fx: 'gaussianBlur', set: { edge: 0, amount: 0 } }],
      in: [
        anim('T', 'Opacity', 'Opacity', 0, 100, 0, inSec * 0.7, 'easeOutSine'),
        anim('T', 'Gaussian Blur', 'amount', 24, 0, 0, inSec, 'settle'),
        anim('T', 'Motion', 'Scale', 106, 100, 0, inSec, 'settle'),
      ],
      out: [
        anim('T', 'Opacity', 'Opacity', 100, 0, -outSec, outSec, 'easeInSine'),
        anim('T', 'Gaussian Blur', 'amount', 0, 18, -outSec, outSec, 'accelerate'),
        anim('T', 'Motion', 'Scale', 100, 97, -outSec, outSec, 'accelerate'),
      ],
    }),
    scalePop: () => ({
      effects: [],
      in: [anim('T', 'Opacity', 'Opacity', 0, 100, 0, inSec * 0.35, 'easeOutSine'), anim('T', 'Motion', 'Scale', 72, 100, 0, inSec, 'easeOutBack')],
      out: [anim('T', 'Opacity', 'Opacity', 100, 0, -outSec, outSec, 'easeInSine'), anim('T', 'Motion', 'Scale', 100, 92, -outSec, outSec, 'accelerate')],
    }),
    // Feathered reveal left→right (Crop + Edge Feather), tiny drift.
    featherReveal: () => ({
      effects: [{ layer: 'T', fx: 'crop', set: { feather: px(height, 60), right: 100 } }],
      in: [anim('T', 'Crop', 'right', 100, 0, 0, inSec, 'settle'), anim('T', 'Motion', 'PositionX', -0.012, 0, 0, inSec * 1.2, 'settle')],
      out: [anim('T', 'Crop', 'left', 0, 100, -outSec, outSec, 'accelerate'), anim('T', 'Opacity', 'Opacity', 100, 0, -outSec * 0.5, outSec * 0.5, 'easeInSine')],
    }),
  };
  if (!R[name]) throw new Error(`unknown text animation "${name}" — one of ${Object.keys(R).join(', ')}`);
  return { name, ...R[name]() };
}

export const TEXT_ANIMATIONS = ['fadeUp', 'blurIn', 'scalePop', 'featherReveal'];

/**
 * Lower third = bar + name + role, staggered. Returns per-layer text recipes
 * with offsets so the bar leads and the type follows (and leaves first).
 */
export function lowerThirdRecipe({ height = 2160, stagger = 0.12 } = {}) {
  return {
    layers: [
      { layer: 'bar', recipe: 'featherReveal', inDelay: 0, outLead: 0 },
      { layer: 'name', recipe: 'fadeUp', inDelay: stagger * 1.5, outLead: stagger },
      { layer: 'role', recipe: 'fadeUp', inDelay: stagger * 2.5, outLead: stagger * 2 },
    ],
    height,
  };
}

/**
 * Turn anims into concrete key plans in CUT-relative (transition) or
 * LAYER-relative (text) seconds.
 */
export function planAnims(anims, { fps = 30, mode = 'baked', stepFrames = 1, durationOverride } = {}) {
  return anims.map((a) => ({
    layer: a.layer, component: a.component, param: a.param,
    ...planKeys({ from: a.from, to: a.to, startSec: a.startRel, durationSec: durationOverride ?? a.durationSec, curve: a.curve, fps, mode, stepFrames }),
  }));
}

export { joinKeys };
