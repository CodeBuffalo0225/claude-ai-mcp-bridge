// ============================================================================
//  Motion MCP tools (Premiere): transitions, audio fades, whoosh SFX, titles,
//  lower thirds, and verification from renders. Registered by
//  premiere-server.js. Thin wrappers over motion/motion-workflow.js.
//
//  Every transition is built from keyframes on the clips (Opacity / Motion /
//  Gaussian Blur / Directional Blur / Offset / Crop / Volume) — Premiere's
//  scripted QE transitions hang or render white on 26.x. Writes refuse any
//  sequence not named "_WORKING_*" unless allowNonWorkingSequence is true.
//  Failures come back as isError with the exact message; nothing simulated.
// ============================================================================

import { z } from 'zod';
import { MotionWorkflow } from '../motion/motion-workflow.js';
import { TRANSITIONS, TEXT_ANIMATIONS, transitionRecipe } from '../motion/recipes.js';
import { TITLE_STYLES } from '../motion/titles.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `ERROR: ${e.message || e}` }], isError: true });
const wrap = (fn) => async (params) => { try { return await fn(params); } catch (e) { return fail(e); } };

const seqShape = {
  sequenceName: z.string().describe('Sequence to animate. Must be a "_WORKING_" duplicate (timeline_duplicate) unless allowNonWorkingSequence is true.'),
  allowNonWorkingSequence: z.boolean().default(false),
};

export const LOOKS = {
  crossDissolve: 'Invisible, classic. Smooth S-curve on the top layer, no luminance dip. Overlap (A/B roll).',
  blurDissolve: 'Dreamy / premium. Both shots defocus through the dissolve. Overlap.',
  dipToBlack: 'Story beat, time passing. Butt cut.',
  zoomPush: 'Energetic social cut: punch in on A, land out of a zoom on B, blur sells the motion. Butt cut + whoosh.',
  whipPan: 'Fast whip: image slides sideways with a directional streak. Butt cut + whoosh.',
  featheredWipe: 'Soft-edged reveal sweeping across the frame. Overlap.',
};

export function registerMotionTools(server, bridge) {
  const wf = new MotionWorkflow(bridge);

  server.tool('motion_recipes',
    'List the transition and text-animation recipes, what each looks like, how clips must be arranged (butt cut vs overlap), default durations, and title styles. Read before choosing.',
    {},
    wrap(async () => ok({
      transitions: TRANSITIONS.map((n) => { const r = transitionRecipe(n, { durationSec: 1 }); return { name: n, look: LOOKS[n], arrangement: r.arrangement, defaultDurationSec: r.defaultDuration, audio: r.audio, sfx: r.sfx || null }; }),
      textAnimations: TEXT_ANIMATIONS,
      titleStyles: Object.keys(TITLE_STYLES),
      notes: [
        'Overlap transitions need the next shot on another video track overlapping A (motion_build_ab_roll lays shots out that way, or pass lift:true to re-place B one track up using its head handle).',
        'Verify with motion_verify_transition (renders frames) and motion_verify_audio (exports the mix).',
      ],
    })));

  server.tool('motion_build_ab_roll',
    'Lay shots out on two video tracks ready for transitions: overlap transitions put the next shot on the other track overlapping by the transition length; butt transitions keep it on the same track. Clears the sequence first unless clear:false.',
    {
      ...seqShape,
      shots: z.array(z.object({ mediaPath: z.string().optional(), projectItemName: z.string().optional(), inSec: z.number(), outSec: z.number() })).min(1),
      transitions: z.array(z.object({ name: z.enum(TRANSITIONS), durationSec: z.number().positive().optional() })).default([]),
      tracks: z.array(z.number().int().min(0)).length(2).default([0, 1]),
      startSec: z.number().min(0).default(0),
      clear: z.boolean().default(true),
    },
    wrap(async (p) => ok(await wf.buildABRoll(p))));

  server.tool('motion_transition_apply',
    'Apply a video + audio transition between clip A (trackIndex/clipIndex) and the shot that follows it. Built from keyframes (baked easing curves), with an equal-power audio crossfade or fades and, for zoom push / whip pan, a synthesised whoosh whose peak lands on the cut. Every key is read back.',
    {
      ...seqShape,
      name: z.enum(TRANSITIONS),
      trackIndex: z.number().int().min(0).default(0),
      clipIndex: z.number().int().min(0),
      durationSec: z.number().positive().optional().describe('Defaults to the recipe length'),
      audio: z.boolean().default(true),
      sfx: z.boolean().optional().describe('Force the whoosh on/off (default: recipe decides)'),
      sfxGainDb: z.number().max(0).default(-14),
      lift: z.boolean().default(false).describe('Overlap recipes on a butt cut: re-place B one track up using its head handle (refused if B carries effects/grades)'),
    },
    wrap(async (p) => ok(await wf.applyTransition(p))));

  server.tool('motion_fade',
    'Fade a clip in from black (edge:"head") or out to black (edge:"tail"), with its linked audio faded on the same window.',
    {
      ...seqShape,
      trackIndex: z.number().int().min(0).default(0),
      clipIndex: z.number().int().min(0),
      edge: z.enum(['head', 'tail']),
      durationSec: z.number().positive().default(1),
      audio: z.boolean().default(true),
    },
    wrap(async (p) => ok(await wf.fadeEdge(p))));

  server.tool('motion_title_add',
    'Render a title (clean sans, soft feathered shadow) at sequence resolution, place it on a free track above the picture and animate it in and out (fadeUp, blurIn, scalePop, featherReveal).',
    {
      ...seqShape,
      text: z.string().min(1),
      style: z.enum(Object.keys(TITLE_STYLES)).default('hero'),
      animation: z.enum(TEXT_ANIMATIONS).default('blurIn'),
      startSec: z.number().min(0),
      durationSec: z.number().positive().default(3),
      inSec: z.number().positive().default(0.7),
      outSec: z.number().positive().default(0.5),
      trackIndex: z.number().int().min(1).optional(),
      y: z.number().min(0.05).max(0.95).optional().describe('Vertical centre as a fraction of the frame — keep titles off faces'),
      scrim: z.number().min(0).max(0.8).default(0.4).describe('Peak opacity of a soft feathered dark band behind the text (0 = none)'),
    },
    wrap(async (p) => ok(await wf.addTitle(p))));

  server.tool('motion_lower_third_add',
    'Lower third as three layers — feathered bar with accent stripe, name, role — staggered: the bar wipes in first, type follows and leaves first.',
    {
      ...seqShape,
      name: z.string().min(1),
      role: z.string().default(''),
      startSec: z.number().min(0),
      durationSec: z.number().positive().default(4),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    },
    wrap(async (p) => ok(await wf.addLowerThird(p))));

  server.tool('motion_sfx_whoosh',
    'Synthesise an original whoosh (swept band-pass noise, left→right pan, no licensing) whose peak lands at atSec, and lay it on a free audio track.',
    {
      sequenceName: z.string(),
      atSec: z.number().min(0),
      durationSec: z.number().min(0.2).max(3).default(0.8),
      gainDb: z.number().max(0).default(-14),
      seed: z.number().int().default(7),
    },
    wrap(async (p) => ok(await wf.addWhoosh(p))));

  server.tool('motion_verify_transition',
    'Render frames across a transition window and measure them: luma curve (unintended dip / flash), how the change is spread across frames (a hidden hard cut), sharpness (blur masking for push/whip), plus a labelled contact sheet. kind: "dissolve" | "masked" (zoom push, whip) | "dip" (dip to black between shots) | "fadeIn" / "fadeOut" (sequence edges).',
    {
      sequenceName: z.string(),
      windowSec: z.array(z.number()).length(2),
      kind: z.enum(['dissolve', 'masked', 'dip', 'fadeIn', 'fadeOut']).default('dissolve'),
      samples: z.number().int().min(4).max(16).default(9),
      outDir: z.string().optional(),
    },
    wrap(async (p) => ok(await wf.verifyTransition(p))));

  server.tool('motion_verify_audio',
    'Export the mixed audio of a range and measure it: short-term RMS envelope, level before/at/after each event time (e.g. each cut), and clicks (single-sample jumps far above the local level).',
    {
      sequenceName: z.string(),
      startSec: z.number().min(0),
      endSec: z.number().positive(),
      events: z.array(z.object({ label: z.string(), t: z.number() })).default([]),
    },
    wrap(async (p) => ok(await wf.verifyAudio(p))));
}
