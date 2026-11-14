// ============================================================================
//  Skin-aware colour grading MCP tools (Premiere). Registered by
//  premiere-server.js. Thin wrappers over color-grading/color-workflow.js —
//  analysis, recommendation and editor actions stay in their own layers.
//
//  Every tool returns JSON with the evidence (measurements, read-backs,
//  file paths of exported frames / previews / LUTs). Failures come back as
//  isError with the exact message; nothing is simulated.
// ============================================================================

import { z } from 'zod';
import { ColorWorkflow } from '../color-grading/color-workflow.js';
import { capabilityTable } from '../color-grading/actions/lumetri-controls.js';
import { defaultWorkDir } from '../color-grading/actions/premiere-color-actions.js';

const targetShape = {
  sequenceName: z.string().describe('Sequence to work on. Writes require a "_WORKING_" duplicate (timeline_duplicate) unless allowNonWorkingSequence is true.'),
  trackIndex: z.number().int().min(0).default(0),
  clipIndex: z.number().int().min(0).default(0),
};
const frameSource = {
  sequenceName: z.string().optional().describe('Export the frame from this sequence (graded render)'),
  timeSec: z.number().min(0).optional().describe('Sequence time of the frame'),
  framePath: z.string().optional().describe('Or analyse an existing PNG/JPG frame instead'),
};

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `ERROR: ${e.message || e}` }], isError: true });
const wrap = (fn) => async (params) => { try { return await fn(params); } catch (e) { return fail(e); } };

export function registerColorTools(server, bridge) {
  const wf = new ColorWorkflow(bridge);

  const frameFrom = async ({ sequenceName, timeSec, framePath }) => {
    if (framePath) return framePath;
    if (!sequenceName || timeSec === undefined) throw new Error('Give framePath, or sequenceName + timeSec');
    const wd = defaultWorkDir();
    return (await wf.actions.exportFrame({ sequenceName, timeSec, outPath: `${wd}/frame` })).path;
  };

  server.tool('color_capabilities',
    'What the colour tools can actually do on this Premiere build: each grading control marked implemented / partial / unavailable, with the fallback for unavailable ones. Read this before promising a grade.',
    {},
    wrap(async () => ok({ verifiedOn: 'Premiere Pro 26.5.2 (live probe 2026-11-14)', controls: capabilityTable() })));

  server.tool('color_inspect_source',
    'Workflow steps 1-2: source colour space, gamma/log/HDR encoding, bit depth, range, Premiere interpretation, Lumetri Input LUT state — and whether a technical transform is needed or already applied (double-transform check). Run before any creative grade.',
    { ...targetShape, timeSec: z.number().optional(), declaredEncoding: z.string().optional().describe('Camera profile if known, e.g. "log_slog3", "log_applelog", "hlg", "sdr_rec709"') },
    wrap(async (p) => ok(await wf.inspect(p))));

  server.tool('color_apply_source_transform',
    'Workflow step 2 for camera-log media: turn on Premiere log colour management (app.project.setLogColorManagement) so Premiere applies the camera vendor transform from the clip metadata (e.g. Sony S-Log3/S-Gamut3.Cine → working space). Refuses when Premiere does not detect log in the media. Project-wide switch that only affects log media; revert with setLogColorManagement(false). Then re-run color_inspect_source.',
    { ...targetShape, allowNonWorkingSequence: z.boolean().default(false) },
    wrap(async ({ allowNonWorkingSequence, ...t }) => {
      const r = await wf.actions.applyLogColorManagement(t, { allowNonWorkingSequence });
      return { ...ok(r), isError: !r.applied };
    }));

  server.tool('color_export_frame',
    'Export one rendered frame (current grade + all tracks) from a sequence via QE exportFramePNG. Returns the PNG path.',
    { sequenceName: z.string(), timeSec: z.number().min(0), outPath: z.string().optional() },
    wrap(async (p) => ok(await wf.actions.exportFrame({ ...p, outPath: p.outPath || `${defaultWorkDir()}/frame` }))));

  server.tool('color_analyze_frames',
    'Workflow steps 3+5: software scopes (luma percentiles, clipping, neutral-pixel white balance, saturation), face detection (Apple Vision) with skin isolation that excludes lips/eyes/brows, per-face confidence, skin vectorscope angle (diagnostic vs the 123° skin line, never a target), key leakage into the background, and face tracks across frames.',
    { frames: z.array(z.object({ sequenceName: z.string().optional(), timeSec: z.number().optional(), path: z.string().optional(), label: z.string().optional() })).min(1).max(24) },
    wrap(async ({ frames }) => { const r = await wf.analyze(frames); return ok({ ...r.summary, reportPath: r.reportPath, workDir: r.workDir }); }));

  server.tool('color_correct_primary',
    'Workflow step 4: measure white balance (on near-neutral pixels) and grade-induced clipping/crushing, then (apply:true) solve Temperature/Tint/Whites/Blacks closed-loop — write, re-render, re-measure — and report skin change, a before|after Premiere render, and a snapshot to restore. Exposure is never pushed to a fixed target; subject brightness is reported for judgement.',
    { ...targetShape, instance: z.number().int().min(0).optional().describe("Required when the clip has more than one Lumetri"), timeSec: z.number().min(0), apply: z.boolean().default(false), preserveMood: z.boolean().default(false).describe('Keep the shot\'s colour cast (golden hour, etc.)'), allowNonWorkingSequence: z.boolean().default(false) },
    wrap(async ({ sequenceName, trackIndex, clipIndex, ...o }) => ok(await wf.correctPrimary({ sequenceName, trackIndex, clipIndex, instance: o.instance }, o))));

  server.tool('color_solve',
    'Editor-intent closed loop: set ONE scriptable Lumetri control (e.g. basic.exposure, basic.temperature, basic.contrast, basic.blacks, creative.vibrance) until a MEASURED metric reaches a target YOU state with a reason — e.g. "use the highlight headroom: luma.p99 → 0.85". Writes, re-renders, re-measures; returns every measurement, a skin check and a before|after render. Use when the primary step has no neutral/clipping evidence to act on.',
    {
      ...targetShape,
      instance: z.number().int().min(0).optional().describe("Required when the clip has more than one Lumetri"),
      timeSec: z.union([z.number().min(0), z.array(z.number().min(0)).min(1).max(8)]).describe('One time, or several: the metric is then the MEAN across them (a Lumetri value covers the whole clip)'),
      control: z.string(),
      metric: z.enum(['luma.p50', 'luma.p99', 'luma.p1', 'luma.spread', 'wb.blueYellow', 'wb.magentaGreen', 'clip.highlights', 'clip.shadows', 'chroma.p50', 'skin.0.lumaP50', 'skin.0.chromaP50', 'skin.0.vectorscopeAngle', 'skin.1.lumaP50', 'skin.1.chromaP50',
        'warmth.shadows.blueYellow', 'warmth.shadows.magentaGreen', 'warmth.mids.blueYellow', 'warmth.mids.magentaGreen', 'warmth.highlights.blueYellow', 'warmth.highlights.magentaGreen']),
      targetValue: z.number(),
      tolerance: z.number().positive(),
      probeStep: z.number().refine((v) => v !== 0, 'probeStep must be non-zero'),
      bounds: z.tuple([z.number(), z.number()]).optional(),
      reason: z.string().min(10).describe('Why this target — recorded in the result and the decision log'),
      allowNonWorkingSequence: z.boolean().default(false),
    },
    wrap(async ({ sequenceName, trackIndex, clipIndex, instance, ...o }) => {
      const r = await wf.solveToTarget({ sequenceName, trackIndex, clipIndex, instance }, { ...o, targetValue: o.targetValue });
      return { ...ok(r), isError: !r.applied };
    }));

  server.tool('color_warmth_lut',
    'Determine whether a shot is too warm/cool (multi-cue: tonal-range casts, skin vs skin line, warm dominance) and, if so, design tonal COLOUR WHEELS + an HSL SECONDARY (keyed on the dominant saturated warm hue, saturation floor above skin so faces are protected) from the frame, solve them on the engine, preview, and bake one .cube. Lumetri wheels/HSL key are not scriptable on 26.5.2 — load the .cube in a second Lumetri ▸ Creative ▸ Look, then color_compare against previewPath.',
    { ...frameSource, times: z.array(z.number().min(0)).min(2).max(8).optional().describe('Design on several frames of sequenceName (recommended — the LUT covers the whole clip)'), strength: z.number().min(0.05).max(1).default(0.4), hslSaturation: z.number().min(-0.6).max(0.3).default(-0.15) },
    wrap(async (p) => {
      let framePaths;
      if (p.times?.length) {
        if (!p.sequenceName) throw new Error('times needs sequenceName');
        const wd = defaultWorkDir();
        framePaths = [];
        for (const t of p.times) framePaths.push((await wf.actions.exportFrame({ sequenceName: p.sequenceName, timeSec: t, outPath: `${wd}/warmth_${t}` })).path);
      } else {
        framePaths = [await frameFrom(p)];
      }
      return ok(await wf.designWarmthLut({ framePaths, strength: p.strength, hslSaturation: p.hslSaturation }));
    }));

  server.tool('color_verify_lut',
    'After a .cube is loaded by hand (Lumetri ▸ Creative ▸ Look ▸ Browse): prove from renders whether it is active, in which Lumetri, and whether the render matches the .cube. Runs a positive control (exports not cached), toggles Look intensity per instance (snapshotted + restored), and compares with the .cube applied by the engine.',
    { ...targetShape, timeSec: z.number().min(0).describe('Use a frame not exported before'), lutPath: z.string().optional(), allowNonWorkingSequence: z.boolean().default(false) },
    wrap(async ({ sequenceName, trackIndex, clipIndex, timeSec, lutPath, allowNonWorkingSequence }) => {
      const r = await wf.verifyLut({ sequenceName, trackIndex, clipIndex }, { timeSec, lutPath, allowNonWorkingSequence });
      return { ...ok(r), isError: r.lutActive !== true || (r.match && !r.match.matches) };
    }));

  server.tool('color_build_curve_lut',
    'Workflow step 6 (curves): design a gentle master S-curve FROM THE FRAME (pivot at skin or scene median, strength reduced until shadows are not crushed and highlights not clipped), render an engine preview and bake a .cube LUT. Premiere curves are not scriptable — load the LUT in Lumetri ▸ Creative ▸ Look.',
    { ...frameSource, strength: z.number().min(0.05).max(1).default(0.35) },
    wrap(async (p) => ok(await wf.buildCurveLut({ framePath: await frameFrom(p), strength: p.strength }))));

  server.tool('color_skin_saturation',
    'Hue vs Saturation on one face\'s measured skin hue band (e.g. reduce orange skin). Measures how much of the frame the band would also hit outside faces; low leakage → global hue curve baked to .cube, high leakage → masked/keyed route with manual steps. Returns an engine preview and inside/outside-skin change.',
    { ...frameSource, faceIndex: z.number().int().min(0).default(0), amount: z.number().min(-0.6).max(0.6).default(-0.15).describe('-0.15 = 15% less saturation at the band centre') },
    wrap(async (p) => ok(await wf.skinSaturation({ framePath: await frameFrom(p), faceIndex: p.faceIndex, amount: p.amount }))));

  server.tool('color_face_lift',
    'Track a face across frames and subtly lift its midtones. Premiere masks/tracking are UI-only: first call returns the face track, an engine preview and manual mask steps; after you draw + Track Forward the mask on a second Lumetri, call again with confirmMaskTracked:true to solve Exposure on that instance against measured skin luma and verify the background did not change in every validation frame.',
    { ...targetShape, timeSec: z.number().min(0), validateTimes: z.array(z.number().min(0)).max(12).default([]), faceIndex: z.number().int().min(0).default(0), lift: z.number().min(0.01).max(0.3).default(0.06), instance: z.number().int().min(1).default(1), confirmMaskTracked: z.boolean().default(false), allowNonWorkingSequence: z.boolean().default(false) },
    wrap(async ({ sequenceName, trackIndex, clipIndex, ...o }) => ok(await wf.faceLift({ sequenceName, trackIndex, clipIndex }, o))));

  server.tool('color_match_shots',
    'Workflow step 7: match targets to a reference shot — neutral balance, contrast spread, and (only for face pairs you declare as the same person) skin brightness and saturation. apply:true solves each closed-loop on the target clip and returns before|after renders.',
    {
      reference: z.object({ sequenceName: z.string(), timeSec: z.number() }),
      targets: z.array(z.object({ sequenceName: z.string(), trackIndex: z.number().int().default(0), clipIndex: z.number().int(), timeSec: z.number(), pairs: z.array(z.object({ refFace: z.number().int(), targetFace: z.number().int() })).default([]) })).min(1).max(8),
      apply: z.boolean().default(false),
      allowNonWorkingSequence: z.boolean().default(false),
    },
    wrap(async (p) => ok(await wf.matchShots(p))));

  server.tool('color_validate_frames',
    'Workflow step 8: sample frames across a clip/sequence and report flicker (scene median jumps), banding (empty luma levels), face-track failures and skin consistency per tracked face.',
    { sequenceName: z.string(), times: z.array(z.number().min(0)).min(2).max(24) },
    wrap(async (p) => ok(await wf.validate(p))));

  server.tool('color_apply',
    'Write scriptable Lumetri controls (see color_capabilities) on a clip\'s Lumetri instance. Snapshots first, reads back every value, reports anything skipped. Unscriptable controls (curves, wheels, HSL key, masks) are refused with their fallback.',
    {
      ...targetShape,
      instance: z.number().int().min(0).optional().describe("Required when the clip has more than one Lumetri"),
      ops: z.array(z.object({ control: z.string(), value: z.number(), mode: z.enum(['absolute', 'delta']).default('absolute') })).min(1),
      secondaryKeyConfirmed: z.boolean().default(false).describe('Set only after you set the HSL Secondary key in the UI'),
      dryRun: z.boolean().default(false),
      allowNonWorkingSequence: z.boolean().default(false),
    },
    wrap(async ({ sequenceName, trackIndex, clipIndex, instance, ops, ...o }) => {
      const r = await wf.actions.applyLumetri({ sequenceName, trackIndex, clipIndex, instance }, ops.map((x) => ({ op: 'lumetri', ...x })), o);
      return { ...ok(r), isError: !o.dryRun && !r.verified };
    }));

  server.tool('color_restore',
    'Restore a clip\'s Lumetri values from a snapshot file written by any colour write.',
    { snapshotPath: z.string(), allowNonWorkingSequence: z.boolean().default(false) },
    wrap(async ({ snapshotPath, allowNonWorkingSequence }) => ok(await wf.actions.restore(snapshotPath, { allowNonWorkingSequence }))));

  server.tool('color_compare',
    'Workflow step 9: side-by-side before|after image plus measured deltas (luma, clipping, cast, change inside vs outside detected skin).',
    { beforePath: z.string(), afterPath: z.string(), outPath: z.string().optional(), note: z.string().optional() },
    wrap(async (p) => ok(await wf.compare(p.beforePath, p.afterPath, p.outPath || `${defaultWorkDir()}/compare.png`, { note: p.note }))));
}
