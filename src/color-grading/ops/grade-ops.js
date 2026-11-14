// ============================================================================
//  Grade operations — the editor-neutral vocabulary between "recommend" and
//  "act". Every recommendation is a list of these; every editor action maps
//  from these. Schema-gated with zod (repo convention): an op that does not
//  validate never reaches the editor.
//
//  Two value domains, never mixed:
//   - `lumetri` ops carry Lumetri SLIDER units (Premiere's own controls).
//     Their pixel effect is Lumetri's internal maths, which is not
//     documented — so the engine never simulates them. Their result is
//     verified by re-exporting a frame from Premiere.
//   - every other op (curves, hue curves, wheels, masked secondaries) is
//     defined in normalised encoded R'G'B' and implemented exactly by
//     ops/transform.js — so it can be previewed and baked to a .cube LUT.
// ============================================================================

import { z } from 'zod';

const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);

export const LumetriOp = z.object({
  op: z.literal('lumetri'),
  // Logical control id from actions/lumetri-controls.js (e.g. "basic.exposure").
  control: z.string(),
  value: z.number().finite(),
  mode: z.enum(['absolute', 'delta']).default('absolute'),
});

export const CurveOp = z.object({
  op: z.literal('curve'),
  channel: z.enum(['master', 'red', 'green', 'blue']),
  points: z.array(point).min(2).max(16),
});

const hueBand = {
  center: z.number().min(0).max(360), // HSV hue, degrees
  width: z.number().min(10).max(180), // full width of the raised-cosine window
};

export const HueVsSatOp = z.object({ op: z.literal('hueVsSat'), ...hueBand, amount: z.number().min(-1).max(1) }); // ×(1+amount) at centre
export const HueVsHueOp = z.object({ op: z.literal('hueVsHue'), ...hueBand, shiftDeg: z.number().min(-30).max(30) });
export const HueVsLumaOp = z.object({ op: z.literal('hueVsLuma'), ...hueBand, amount: z.number().min(-0.3).max(0.3) }); // luma offset at centre, × pixel saturation

const wheel = z.object({ hueDeg: z.number().min(0).max(360), amount: z.number().min(0).max(0.2), luma: z.number().min(-0.2).max(0.2).default(0) });
export const WheelsOp = z.object({
  op: z.literal('wheels'),
  shadows: wheel.optional(),
  midtones: wheel.optional(),
  highlights: wheel.optional(),
});

// HSL Secondary — colour-qualified correction, the engine twin of Lumetri ▸
// HSL Secondary (whose key cannot be set by script on 26.5.2). Qualifier =
// raised-cosine hue window × soft saturation range × soft luma range.
// Correction: chroma scaled around luma (brightness held), hue shift, and a
// colour-balance push (Cb/Cr) like the HSL Secondary correction wheel.
const range01 = z.tuple([unit, unit]);
export const HslSecondaryOp = z.object({
  op: z.literal('hslSecondary'),
  qualifier: z.object({
    hueCenter: z.number().min(0).max(360),
    hueWidth: z.number().min(10).max(180),
    satRange: range01,
    lumaRange: range01.default([0, 1]),
    softness: z.number().min(0.005).max(0.3).default(0.06),
  }),
  correction: z.object({
    saturation: z.number().min(-0.8).max(0.8).default(0),
    hueShiftDeg: z.number().min(-30).max(30).default(0),
    cb: z.number().min(-0.05).max(0.05).default(0),
    cr: z.number().min(-0.05).max(0.05).default(0),
  }),
});

export const MaskSpec = z.object({
  kind: z.enum(['skin', 'faceTrack', 'manual']),
  faceIndex: z.number().int().min(0).default(0),
  featherPx: z.number().min(0).max(200).default(12),
  // Optional cleanup on the matte, mirroring Lumetri HSL Secondary ▸ Refine.
  denoise: z.number().min(0).max(1).default(0),
});

export const SecondaryOp = z.object({
  op: z.literal('secondary'),
  mask: MaskSpec,
  // A secondary carries its own inner ops; only pixel-domain ops are allowed.
  ops: z.array(z.lazy(() => PixelOp)).min(1),
});

export const PixelOp = z.discriminatedUnion('op', [CurveOp, HueVsSatOp, HueVsHueOp, HueVsLumaOp, WheelsOp, HslSecondaryOp]);
export const GradeOp = z.union([LumetriOp, PixelOp, SecondaryOp]);

export function validateOps(ops) {
  const ok = [], rejected = [];
  for (const raw of ops || []) {
    const r = GradeOp.safeParse(raw);
    if (r.success) ok.push(r.data);
    else rejected.push({ op: raw, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  return { ok, rejected };
}

export const isPixelOp = (o) => ['curve', 'hueVsSat', 'hueVsHue', 'hueVsLuma', 'wheels', 'hslSecondary'].includes(o.op);
