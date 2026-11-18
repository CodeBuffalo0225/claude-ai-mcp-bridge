---
name: motion-designer
description: Add professional video + audio transitions, animated titles, lower thirds and whoosh SFX in Premiere through the Claude AI Editor bridge — built from keyframes and verified on Premiere's own renders. Triggers on "add transitions", "cross dissolve", "blur dissolve", "zoom transition", "whip pan", "feathered wipe", "dip to black", "fade in/out", "crossfade the audio", "animate the title", "title in/out", "lower third", "name super", "whoosh", "motion graphics", "make it look professional".
---

# motion-designer — keyframed transitions, text and SFX

Premiere 26.x scripted transitions (QE `addTransition`) hang or render solid white, and the
old `edit_add_transition` tool reported success without applying anything (it now errors and
names the replacement). Everything here is built from **keyframes on the clips** — Opacity,
Motion, Gaussian Blur, Directional Blur, Offset, Crop, Volume — so every move is editable in
Effect Controls afterwards, like hand-made work.

| Layer | Code |
|---|---|
| Curves & looks (pure) | `src/motion/easing.js`, `recipes.js`, `audio-curves.js` |
| Generated media | `src/motion/titles.js` (title / lower-third PNGs), `sfx.js` (whoosh WAV) |
| Editor actions | `src/motion/motion-actions.js` + `src/extendscript/premiere/motion-bridge.jsx` |
| Workflow | `src/motion/motion-workflow.js` |
| Verification | `src/motion/motion-verify.js` (renders + exported mix) |
| MCP tools | `src/mcp-servers/motion-tools.js` (`motion_*`) |

## Preconditions
1. `bridge_preflight` → `_info.motionBridgeVersion` present (≥ `2026-11-17.m2`).
2. Work on a `_WORKING_` duplicate (`timeline_duplicate`). Writes refuse anything else.
3. Generated titles / SFX go to `~/Downloads/cache/claude-ai-editor-motion/` — Premiere
   references them in place, so don't clean that folder while the project uses them.

## Workflow
1. **Recipes** — `motion_recipes`. Pick per beat, not per habit:

| Recipe | Look | Arrangement | Audio |
|---|---|---|---|
| `crossDissolve` (0.8 s) | invisible, classic | overlap | equal-power crossfade |
| `blurDissolve` (1.0 s) | dreamy / premium | overlap | equal-power crossfade |
| `featheredWipe` (0.9 s) | soft-edged sweep (Crop + Edge Feather) | overlap | equal-power crossfade |
| `dipToBlack` (1.0 s) | story beat, time passing | butt cut | fade out / in |
| `zoomPush` (0.5 s) | energetic punch-in, blur sells it | butt cut | de-click + **whoosh** |
| `whipPan` (0.4 s) | fast sideways whip, directional streak | butt cut | de-click + **whoosh** |

2. **Layout** — overlap recipes need the next shot on another video track overlapping A.
   `motion_build_ab_roll` lays shots out that way (A/B roll on V1/V2). On an existing
   butt cut, `lift:true` re-places B one track up using its head handle — refused when B
   carries effects/grades (a re-place would drop them). When A is on top the reveal is
   inverted onto A (identical composite).
3. **Apply** — `motion_transition_apply {name, trackIndex, clipIndex}` (A = outgoing clip).
   `motion_fade {edge:"head"|"tail"}` for the first/last shot. Every key is read back.
4. **Text** — `motion_title_add` (hero / chapter / hook; `blurIn`, `fadeUp`, `scalePop`,
   `featherReveal`). Keep titles **off faces** (`y`, e.g. 0.24 for upper third) and keep the
   soft scrim (`scrim` 0.3–0.5) over busy footage. `motion_lower_third_add {name, role}`:
   feathered bar with accent stripe wipes in, name then role fade up; role leaves first.
5. **Verify** — `motion_verify_transition {windowSec, kind}` for every transition
   (`dissolve`, `masked` for zoom/whip, `dip`, `fadeIn`, `fadeOut`): luma dip / flash, a hard
   cut hiding in the transition, blur masking at the cut, plus a contact sheet. Then
   `motion_verify_audio` over the edit with one event per cut: no clicks, no level holes.
   Report the numbers and send the contact sheets — don't call a transition smooth unless
   the render says so.

## Calibration (Premiere 26.5.2, measured on renders)
- Key time = **media time** = `seqT − clip.start + clip.inPoint` (stills start at 3600 s).
- Gaussian / Directional Blur are the new effects: `Amount`, `Angle`, `Edge Behavior`.
  Amount 30 ≈ heavy defocus. **Directional Blur Angle 90 = horizontal streak.**
- Crop sides are %, `Edge Feather` is pixels (scaled with frame height in recipes).
- Offset ▸ Shift Center To is normalised; Motion ▸ Position is normalised.
- Volume ▸ Level is linear amplitude, 1.0 = +15 dB (0 dB = 0.17782794).
- Linear Wipe is found by name but does **not** attach by script → Crop wipes.
- QE `exportFramePNG` writes RGBA; analysis composites over black.
- Heavy-blur frames can take a while to render — frame exports get a 180 s budget.

## Live result (test edit, 2026-11-17, 720p, 6 shots)
All seven checks pass on renders: cross dissolve (no dip, largest single step 22 % of the change),
zoom push (cut frame keeps 5 % of the shots' detail — fully masked), blur dissolve, whip pan
(21 %), feathered wipe, fade in (black end 0.000), fade out (0.019). Mix: no clicks; dissolves
move between levels with no hole; whoosh peaks land on the cuts. Hero title blurs in sharp by
+0.5 s; lower third staggers bar → name → role.

## Hard rules
1. Never claim a transition looks right without `motion_verify_transition` output.
2. Never animate the source sequence — `_WORKING_` copies only.
3. Never use QE transitions or Linear Wipe from script on 26.x.
4. Don't lift a graded/effected clip — rebuild as an A/B roll instead.
5. SFX level is relative to the mix: on un-normalised field audio (≈ −45 dB RMS) a −14 dBFS
   whoosh reads ~20 dB hot — lower `sfxGainDb` or normalise dialogue first.
