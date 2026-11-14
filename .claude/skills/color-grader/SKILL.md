---
name: color-grader
description: Analyse, recommend and apply Lumetri colour grades in Premiere through the Claude AI Editor bridge, with particular care for people and natural skin. Triggers on "color grade", "grade this", "fix the white balance", "correct exposure", "S-curve", "skin looks orange/too red/too saturated", "lift his face", "track this face", "match these shots", "match skin tones", "apply [preset name]", "give it the fishing look", "color pass". Measures before it acts, uses only controls the bridge can actually set, verifies every change on a re-rendered frame, and says plainly when something needs a manual step.
---

# color-grader — skin-aware Lumetri grading

Three separate layers (never mix them):

| Layer | Code | Does |
|---|---|---|
| **Analysis** | `src/color-grading/analysis/` | Scopes from real frames, Apple Vision faces + landmarks, skin isolation, key leakage, face tracks, source encoding |
| **Recommendation** | `src/color-grading/recommend/` | Pure: measurements → grade ops + route + evidence. No editor calls |
| **Editor actions** | `src/color-grading/actions/` + `src/extendscript/premiere/color-bridge.jsx` | Snapshot → write → read back. The only layer that touches Premiere |

Before promising anything, call **`color_capabilities`** — or read [reference/capabilities.md](reference/capabilities.md). Short version for Premiere 26.5.2: Basic/Creative/Vignette sliders and HSL-Secondary sliders are scriptable; **RGB curves, Hue-vs curves, colour wheels, the HSL key, masks and mask tracking are not.** Those go through a `.cube` LUT (global ops) or a manual mask/key step (local ops).

## Preconditions (every session)

1. `bridge_preflight` → JSX ≥ 2026-07-05.1 and `_info.colorBridgeVersion` present. If `_eval` answers `{ok,result}` or `_info` is missing, the **old CutPilot-AI panel** has clobbered the bridge (it is symlinked into CEP/extensions) — close it and `bridge_reload_jsx`.
2. **Never grade the source sequence.** `timeline_duplicate` → `_WORKING_<name>`. Write tools refuse anything else unless `allowNonWorkingSequence:true` (only when Travis says so).
3. Every write leaves a snapshot path in its result. `color_restore` puts it back (verified pixel-identical on 26.5.2).

## The workflow (in order — do not skip 1–3)

1. **Inspect the source** — `color_inspect_source`. Encoding (Rec.709 / HLG / PQ / log), bit depth, range, Premiere's interpretation, Input LUT state. Log footage is often tagged bt709; if the tool raises `logSuspicion`, ask for the camera profile and pass `declaredEncoding`.
2. **Fix the pipeline first** — exactly one technical transform. If `transform.needed` and not in place, do that (interpretation or vendor LUT) before any creative move. Never add a second technical LUT; heed `DOUBLE TRANSFORM` warnings.
   - **Camera log (Sony/Canon/etc.)**: confirm the profile from the camera's own metadata first (Sony: `<clip>M01.XML` → `CaptureGammaEquation`, e.g. `s-log3-cine`). Then `color_apply_source_transform` — it turns on Premiere log colour management so Premiere applies the vendor transform from metadata, and refuses if Premiere detects no log. Re-run `color_inspect_source`: it must read `log_premiere_managed:…` and `readyForCreativeGrade:true`. Check the sequence has auto tone-mapping on for SDR delivery.
   - Do **not** try `setOverrideColorSpace` with a hand-built or renamed ColorSpace: Premiere resolves by internal codes and silently stores Rec.709 (verified 26.5.2). Only Premiere's own detected object works.
3. **Analyse** — `color_analyze_frames` on 3–6 representative frames (start/mid/end, each lighting change). Read: luma p1/p50/p99, clipping, white-balance cast (+ its method/confidence), saturation, and per face: `skinConfidence`, `reliable`, skin luma/chroma, vectorscope angle, `leakage`.
4. **Primary** — `color_correct_primary` (`apply:false` first, show the plan; then `apply:true`). WB is solved closed-loop on near-neutral pixels; Whites/Blacks only undo clipping/crushing *the grade* introduced (compared with the ungraded source frame). Exposure is **not** pushed to any universal target.
5. **Faces & skin** — check `skinCheck` (`natural:true`) after step 4. Skin hue near the 123° line is a *diagnostic*, not a target; complexions differ mainly in brightness and chroma, and every face is measured against itself. If `reliable:false`, use the `manualFallback` it gives (eyedropper key / drawn mask) — don't guess.
6. **Curves & secondaries** (only when justified by step 3/5 or asked):
   - S-curve → `color_build_curve_lut` (pivot = skin/scene median; strength auto-reduced to protect p1/p99; master only). Load the `.cube` in a **second** Lumetri ▸ Creative ▸ Look.
   - Skin saturation → `color_skin_saturation`. Low leakage → global hue curve (LUT). High leakage → masked/keyed route.
   - Face lift → `color_face_lift` (two calls: plan + manual mask/track, then `confirmMaskTracked:true`).
   - **Editor intent** (no neutral/clipping evidence to act on — e.g. an underexposed interview) → `color_solve` with an explicit metric target and a written `reason` (e.g. `basic.exposure`, `luma.p99 → 0.82`, "use the highlight headroom"). Expect `hit_bound` when tone-mapping rolls highlights off; stop there rather than chasing the number. The skin check flags brightness change on a step meant to brighten — read the hue shift, not the flag.
   - **Too warm / too cool?** Read `warmth.verdict` from `color_analyze_frames` — never the neutral-pixel cast alone (it under-reads warm shots: neutrals render warm and drop out of the sample). Verdict cues: per-tonal-range casts agreeing, skin vs the line, warm share of chroma. `warm_content` (warm scene, skin on the line) is left alone.
     Correct in this order, all solved on **several frames** (`timeSec:[…]` → mean metric), because one Lumetri value covers the clip:
     1. `color_solve` **Temperature** on `warmth.mids.blueYellow` toward a moderate target (about a third of the cast). Watch skin chroma: a Temperature that drains the face (live: −48 cost −33% skin chroma) is too far.
     2. `color_solve` **Tint** on `skin.0.vectorscopeAngle`, holding the subject's own measured hue. Cooling an orange cast rotates skin toward red, because the cast axis is not the skin axis; Tint puts it back. Don't target the 123° line.
     3. `color_warmth_lut` with `times:[…]` → **tonal colour wheels + HSL Secondary** solved on the engine. The wheels are scaled down by the **skin guard** (±3° hue, ±12% chroma). The HSL key's saturation floor sits above skin p90, and the result reports its measured weight inside vs outside the face. Load the `.cube` in a second Lumetri ▸ Creative ▸ Look; the instance can be added by script with `color_apply {instance:1}`. Then **`color_verify_lut`** on a frame never exported before — it proves from renders (positive control + Look-intensity toggle per instance) whether the LUT is active and matches the `.cube`. Lumetri fields cannot show a Browse-loaded LUT; never report a LUT as applied without this.
     Lumetri's own wheels, HSL key, Look and WB picker are **not** scriptable (live renders: key set by script → Show Mask selects nothing; Look index set → pixel-identical render).
7. **Match shots** — `color_match_shots`. Order: neutral balance → skin brightness → skin saturation → contrast. Skin is matched **only** for face pairs you declare as the same person.
8. **Validate** — `color_validate_frames` across the clip: flicker, banding, track failures, skin drift. Review every listed issue. **One Lumetri value covers the whole clip**: a value solved on one frame can crush another (live: Blacks −25 solved at 30:00 crushed a rain section at 20:00 by 1.1%). Re-solve against the darkest *real* shot with `clip.shadows` as the metric; ignore occluded/transitional frames but report them. On long continuous takes, median jumps and short face tracks are usually content changes (different people, light), not flicker.
9. **Before/after + summary** — every apply returns a Premiere-rendered `before|after` PNG; `color_compare` for any pair. Summarise: what changed (control, from → to, read-back), evidence, what was manual, what is unverified.

## Usage examples

**"Correct exposure and white balance while preserving natural skin."**
```
color_inspect_source {sequenceName:"_WORKING_X", clipIndex:0, timeSec:20}
color_correct_primary {sequenceName:"_WORKING_X", clipIndex:0, timeSec:20, apply:false}   → show plan
color_correct_primary {..., apply:true}   → solved[], skinCheck[].natural, comparison.image, snapshot
```
Live run (hunting-blind interview, 2026-11-14): green cast −0.0091 measured on neutrals → Tint 0→5 → −0.0024 (converged, 2 renders); skin hue −2.5°, chroma +3%, luma −0.4% → natural.

**"Apply a gentle S-curve without crushing shadows or clipping highlights."**
```
color_build_curve_lut {sequenceName:"_WORKING_X", timeSec:20, strength:0.35}
```
→ points, `evidence` (p1 0.115→0.097, p99 0.922→0.933, max slope 1.14), `safety.ok`, `.cube`, engine preview. Load the LUT, then `color_compare` the Premiere render against `previewPath`.

**"Reduce orange skin saturation without affecting the background."**
```
color_skin_saturation {sequenceName:"_WORKING_X", timeSec:20, faceIndex:0, amount:-0.15}
```
Read `route`. On the hunting-blind interview shot it returned `manual_mask`: 75% of what a skin-hue curve would touch is outside the face (leaves, wood, hands). Then: second Lumetri → HSL Secondary eyedropper on the cheek → refine → `color_apply {instance:1, ops:[{control:"hsl.saturation", value:85}], secondaryKeyConfirmed:true}` → `color_compare` and check `regions.meanAbsLumaChangeOutside`.

**"Track this face and subtly lift its midtones."**
```
color_face_lift {sequenceName:"_WORKING_X", clipIndex:0, timeSec:20, validateTimes:[5,12,30,45], lift:0.06}
```
→ face track (per-sample boxes, stability), engine preview, manual steps. Draw the ellipse mask on Lumetri instance 1, Track Forward, then repeat with `confirmMaskTracked:true` → Exposure solved on that instance against measured skin luma, `isolationByFrame` shows the change stayed on the face at every validation time.

**"Match skin tones and contrast across these shots."**
```
color_match_shots {reference:{sequenceName:"_WORKING_X", timeSec:20},
  targets:[{sequenceName:"_WORKING_X", clipIndex:1, timeSec:70, pairs:[{refFace:0, targetFace:0}]}], apply:false}
```
Review, then `apply:true`. Without `pairs`, only balance and contrast are matched — different people are never pushed toward one complexion.

## Presets (Travis's looks — unchanged defaults)

| Content signal | Default preset | Notes |
|---|---|---|
| Fishing (boat, bridge, kayak, beach, water) | `fishing_coastal_outdoor_natural` | Travis signature — clean water, natural skin, NOT teal-orange |
| Hunting/action (treestand, blind, harvest) | `blockbuster_action` | Cinematic punch |
| Hunting/atmosphere (pre-dawn, foggy) | `cinematic_warm` | Mood |
| Brand collab (sponsor mention) | `youtube_vibrant` | Punchy, ad-friendly |
| Outdoor lifestyle (general) | `youtube_warm_cozy` | Approachable |
| Low-light/moody | `youtube_dark_moody` | Shadow detail |

User override always wins. Apply with `color_grade_preset`. Presets carry only what Lumetri can script: preset `curves`, `colorWheels` and `hsl` are reported as **skipped** (use a LUT for those). Preset saturation values are offsets and are sent as `100 + x`. Run a preset as a *starting look* after steps 1–4, then verify skin with `color_analyze_frames`.

## Decision log

`logs/color/actions.jsonl` (every write: target, snapshot, requested/before/after, skipped) and `~/Downloads/logs/{TS}_color_grader_applied.json` for the editorial record:
```json
{ "sequenceName": "_WORKING_X", "steps": ["inspect","primary","skin_saturation"],
  "presetPicked": null, "contentSignal": "transcript_hit:buck",
  "changes": [{"control":"basic.tint","from":0,"to":5,"verified":true}],
  "manual": ["HSL key on cheek, instance 1"], "unverified": [], "approved": null }
```

## Hard rules
1. **Measure before acting; verify after.** A change counts only when read back *and* visible in a re-rendered frame. Never report a grade, face detection, track or scope result without the tool output that shows it.
2. **No universal targets.** No fixed exposure, curve points or wheel values. Targets come from neutral evidence, information loss (clipping), the editor's stated amount, or a reference shot.
3. **Face box ≠ skin mask.** Skin is the landmark region minus lips/eyes/brows, qualified per face. Low confidence → manual fallback, not a guess.
4. **Never force complexions together.** Match skin only within the same person; the 123° line is a diagnostic.
5. **Never grade the source sequence.** `_WORKING_` copies only; snapshot is automatic; `color_restore` undoes.
6. **Unscriptable means manual.** Curves/wheels/hue curves → `.cube`; masks/keys/tracking → UI step, then scripted sliders + verification. Say which in the summary.
7. **NEVER teal-orange on fishing content** — Travis rejected that look.
8. **NEVER override a manually-graded sequence without asking.** Grade on a second Lumetri instance or a `_WORKING_` copy.
9. One technical transform only; transform before creative.

Sources and colour-science notes: [reference/color-science.md](reference/color-science.md).
