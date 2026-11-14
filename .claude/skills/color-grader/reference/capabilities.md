# Colour grading — capability table

Verified live on **Premiere Pro 26.5.2** (macOS 15.6), 2026-11-14, against the
a hunting-blind interview project (iPhone 17 Pro Max H.264, 8-bit 4:2:0, BT.709, limited
range) on the working copy `_WORKING_color_skill_test`. "Live" = exercised
against the running app with evidence; "unit" = covered by `npm test` only.

## Capabilities

| Capability | Status | How | Evidence |
|---|---|---|---|
| Source encoding / colour space / bit depth / range | ✅ implemented | `ProjectItem.getColorSpace()` (H.273 codes) + ffmpeg stream tags + Lumetri Input LUT state | Live: Rec.709 1/1/1, 8-bit 420 tv |
| Transform-pipeline / double-transform check | ✅ implemented (🟡 HDR paths unit-only) | `inspectSource`; recognises Premiere log colour management | Live: SDR iPhone + Sony FX3 S-Log3; HLG/PQ need sample footage |
| Camera-log technical transform (step 2) | ✅ implemented | `color_apply_source_transform` → `app.project.setLogColorManagement(true)`; Premiere applies the vendor transform from metadata (Sony S-Log3/S-Gamut3.Cine = codes 1001/1012); refuses non-log media | Live: both FX3 clips transformed; iPhone clip correctly refused |
| Editor-intent closed loop | ✅ implemented | `color_solve`: one control → stated metric target + mandatory reason; several `timeSec` → solved on the mean (clip-level) | Live: Exposure (hit_bound at +2.5), Blacks vs darkest real shot, Temperature on 3-frame mean warmth, Tint on 3-frame mean skin hue (120.8–121.0°) |
| Log-footage suspicion from histogram | 🟡 heuristic | lifted p1 + compressed range + low chroma → asks, never assumes | Unit |
| Frame export (graded render) | ✅ implemented | QE `exportFramePNG` at the CTI; restores playhead + active sequence | Live |
| Scopes: luma percentiles, clipping, WB cast, saturation, vectorscope | ✅ implemented (software) | `frame-stats.js` on exported frames — Lumetri's own scopes are not readable by script | Live |
| Face detection + landmarks | ✅ implemented | Apple Vision via `tools/vision/detect-faces.swift` (local, free) | Live: 1 face, landmark conf 0.87–0.93 |
| Face tracking across frames | 🟡 sampled | IoU association over analysed frames; reports coverage/gaps/jitter; no per-frame interpolation | Live: 5–6 samples, coverage 1.0 |
| Skin isolation (not the face box) | ✅ implemented | landmark polygon − lips/eyes/brows, per-face adaptive chroma/luma qualifier, confidence + reasons | Live: conf 0.875–0.897, 98% kept; unit: lips/eyes/blaze excluded |
| Multiple people / complexions | ✅ implemented (🟡 one person live) | every face measured against itself; skin matched only for declared same-person pairs | Unit (two-person tracking); live footage had one person |
| Key-leakage measurement (would a global key hit the background?) | ✅ implemented | qualifier + op footprint inside vs outside face masks | Live: 65–75% leakage on the blind shot → masked route |
| Manual selection fallback | ✅ implemented | `manualFallback` text + `secondaryKeyConfirmed` / `confirmMaskTracked` gates | Unit |
| Primary: Temperature / Tint / Exposure / Contrast / Highlights / Shadows / Whites / Blacks / Saturation | ✅ implemented | section-anchored ComponentParam write + read-back; closed-loop solve on re-rendered frames | Live: Tint 0→5, cast −0.0091→−0.0024 |
| RGB curves (master / R / G / B) incl. S-curve | 🟡 partial | not scriptable (opaque blob) → frame-derived curve baked to `.cube`; load manually | Unit + live bake/preview; LUT load not exercised live |
| Hue vs Luma / Hue vs Hue / Hue vs Sat | 🟡 partial | not scriptable → raised-cosine, luma-preserving ops baked to `.cube` or routed to a masked secondary | Unit + live preview |
| Warm/cool determination | ✅ implemented | `warmth.verdict`: per-tonal-range casts on luma-ranked low-chroma pixels + skin vs line + warm dominance; same-pixel before/after measurement | Live: cabin = slightly_warm, ceremony = neutral, autumn woods = warm_content |
| Primary colour wheels (shadows/midtones/highlights) | 🟡 partial | Lumetri wheels are opaque blobs (`getColorValue` throws) → engine tonal wheels solved per range against measured casts, skin-guarded, baked to `.cube` (`color_warmth_lut`) | Live design on 6 frames: mids cast −0.0175 → −0.0134 mean, skin ±3°, no clipping; LUT load not scriptable |
| HSL Secondary (colour-qualified correction) | 🟡 partial | engine `hslSecondary` op (hue × sat × luma soft key; chroma around luma, hue shift, Cb/Cr push) in the same `.cube`; key auto-placed above skin saturation | Live: key weight 4% inside face vs 41% outside |
| HSL Secondary qualifier (Lumetri key) | ❌ unavailable by script | `setColorValue` on Set/Add/Remove color stores the colour but builds no key (Show Mask render: nothing selected, 26.5.2) — eyedropper in the UI | Live render evidence |
| Lumetri WB selector / Look / Input LUT dropdowns | ❌ unavailable by script | WB picker colour stores but Temperature/Tint don't move; Look index stores but render is pixel-identical | Live render evidence |
| Effect masks + mask tracking | ❌ unavailable by script | drawn + Track Forward in the UI; bridge supplies the face track and verifies isolation per frame | — |
| Lumetri Color Match ("Apply Match", face detection toggle) | ❌ unavailable by script | measured matching (`color_match_shots`) on scriptable controls | Live recommendations; closed-loop apply exercised via primary |
| Add Lumetri instance to a clip | ✅ implemented | QE `addVideoEffect` via `getActiveSequence()` (QE `getSequenceAt` throws on 26.5.2) | Live |
| Remove a Lumetri instance | ❌ unavailable | no remove API; restore = write snapshot values back; disable via fx toggle | Live restore pixel-identical |
| Non-destructive + restore | ✅ implemented | `_WORKING_` guard, auto snapshot, `color_restore` | Live |
| Validation across the clip (flicker, banding, tracking, skin drift) | ✅ implemented (sampled) | `color_validate_frames` | Live: 6 frames, no issues |
| Before/after comparison | ✅ implemented | Premiere renders side-by-side + deltas; engine previews are labelled as engine previews | Live |

## Lumetri controls

Generated from `src/color-grading/actions/lumetri-controls.js`
(`color_capabilities` returns the same table from the code). Controls are
located by **section + display name + type**, never a fixed index, because
Lumetri repeats names ("Saturation" ×4) and indices drift between versions.

| Control id | Lumetri (26.5.2) | Status | Note / fallback |
|---|---|---|---|
| `basic.temperature` | Basic Correction ▸ Temperature | ✅ implemented |  |
| `basic.tint` | Basic Correction ▸ Tint | ✅ implemented |  |
| `basic.exposure` | Basic Correction ▸ Exposure | ✅ implemented |  |
| `basic.contrast` | Basic Correction ▸ Contrast | ✅ implemented |  |
| `basic.highlights` | Basic Correction ▸ Highlights | ✅ implemented |  |
| `basic.shadows` | Basic Correction ▸ Shadows | ✅ implemented |  |
| `basic.whites` | Basic Correction ▸ Whites | ✅ implemented |  |
| `basic.blacks` | Basic Correction ▸ Blacks | ✅ implemented |  |
| `basic.saturation` | Basic Correction ▸ Saturation | ✅ implemented | 100 = unchanged. Not a delta. |
| `creative.fadedFilm` | Creative ▸ Faded Film | ✅ implemented |  |
| `creative.sharpen` | Creative ▸ Sharpen | ✅ implemented |  |
| `creative.vibrance` | Creative ▸ Vibrance | ✅ implemented |  |
| `creative.saturation` | Creative ▸ Saturation | ✅ implemented | 100 = unchanged. Not a delta. |
| `creative.tintBalance` | Creative ▸ Tint Balance | ✅ implemented |  |
| `creative.lookIntensity` | Creative ▸ Intensity | ✅ implemented |  |
| `hsl.denoise` | HSL Secondary ▸ Denoise | 🟡 partial | needs a key set in the UI first |
| `hsl.blur` | HSL Secondary ▸ Blur | 🟡 partial | needs a key set in the UI first |
| `hsl.temperature` | HSL Secondary ▸ Temperature | 🟡 partial | needs a key set in the UI first |
| `hsl.tint` | HSL Secondary ▸ Tint | 🟡 partial | needs a key set in the UI first |
| `hsl.contrast` | HSL Secondary ▸ Contrast | 🟡 partial | needs a key set in the UI first |
| `hsl.sharpen` | HSL Secondary ▸ Sharpen | 🟡 partial | needs a key set in the UI first |
| `hsl.saturation` | HSL Secondary ▸ Saturation | 🟡 partial | needs a key set in the UI first |
| `vignette.amount` | Vignette ▸ Amount | ✅ implemented |  |
| `vignette.midpoint` | Vignette ▸ Midpoint | ✅ implemented |  |
| `vignette.roundness` | Vignette ▸ Roundness | ✅ implemented |  |
| `vignette.feather` | Vignette ▸ Feather | ✅ implemented |  |
| `curves.rgb` | RGB Curves (master/R/G/B) — opaque string blob | ❌ unavailable | fallback: bake a .cube LUT (color_build_curve_lut) and load it in Creative ▸ Look |
| `curves.hueVsSat` | Hue vs Sat curve — opaque string blob | ❌ unavailable | fallback: bake into a .cube LUT if leakage is low; else HSL Secondary key + Saturation, or a masked second Lumetri |
| `curves.hueVsHue` | Hue vs Hue curve — opaque string blob | ❌ unavailable | fallback: bake into a .cube LUT |
| `curves.hueVsLuma` | Hue vs Luma curve — opaque string blob | ❌ unavailable | fallback: bake into a .cube LUT |
| `curves.lumaVsSat` | Luma vs Sat curve — opaque string blob | ❌ unavailable | fallback: bake into a .cube LUT |
| `curves.satVsSat` | Sat vs Sat curve — opaque string blob | ❌ unavailable | fallback: bake into a .cube LUT |
| `wheels.shadows` | Color Wheels & Match wheels — opaque blob | ❌ unavailable | fallback: bake wheels into a .cube LUT; or Basic Temperature/Tint for global casts |
| `wheels.midtones` | Color Wheels & Match wheels — opaque blob | ❌ unavailable | fallback: bake wheels into a .cube LUT |
| `wheels.highlights` | Color Wheels & Match wheels — opaque blob | ❌ unavailable | fallback: bake wheels into a .cube LUT |
| `colorMatch.apply` | Color Match "Apply Match" button — UI only | ❌ unavailable | fallback: measure-and-solve shot matching (color_match_shots) on Temperature/Tint/Exposure/Contrast/Saturation |
| `hsl.key` | HSL Secondary key colours/ranges — packed values + blob | ❌ unavailable | fallback: set the key by eyedropper in the UI, then confirm (secondaryKeyConfirmed) |
| `mask.shape` | Effect masks (ellipse/pen) — no scripting API | ❌ unavailable | fallback: draw the mask in Effect Controls; this tool supplies the face track to follow |
| `mask.track` | Mask tracking — UI only | ❌ unavailable | fallback: Effect Controls ▸ mask ▸ Track Forward; validate with color_validate_frames |
| `look.path` | Creative ▸ Look / Input LUT file path — opaque asset blob | ❌ unavailable | fallback: Browse… in the UI |

Neutral values were read from a freshly added Lumetri instance on 26.5.2
(Saturation 100, Vignette Midpoint 50, Feather 50, Look Intensity 100, all
others 0). UI ranges are Premiere's slider ranges; the scripting range is not
documented, so every write is checked by read-back instead.

## Still needs footage-based validation

- HDR (HLG/PQ) sources: encoding detection and transform advice are
  unit-tested only. Camera log was validated live 2026-11-14 (Sony FX3
  S-Log3/S-Gamut3.Cine, "Test Color" / "Test Color 2" sequences).
- Darker complexions and mixed colour temperature on one face: the logic is
  per-face and adaptive, but live footage so far is light-to-medium skin in
  daylight, overcast and tungsten. Multiple people per frame were validated
  live (2 faces at once, ceremony footage).
- Loading a baked `.cube` in Lumetri ▸ Creative ▸ Look and confirming the
  Premiere render matches the engine preview (`color_compare`).
- The masked face-lift apply (`confirmMaskTracked:true`) and the HSL-key
  route: both need the manual mask/key step done in the UI first.
- `color-bridge.jsx` loaded through `premiere-bridge.jsx` on panel reload:
  handlers were validated live via scoped `_eval`, and the include line's
  `$.fileName` resolution was verified, but a full `bridge_reload_jsx` was
  not run (another session owned the live JSX at the time).
- The 13 MCP tools were exercised through an in-memory MCP client with a
  fake bridge; the workflow beneath them was exercised live.
