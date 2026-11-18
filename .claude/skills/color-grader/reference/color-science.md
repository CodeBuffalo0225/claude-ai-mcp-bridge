# Colour-science notes and sources

What the code assumes, why, and where it came from. Anything not listed here
was measured live (see capabilities.md) rather than taken from a document.

## Measurement domain
Frames are analysed as **display-encoded R'G'B'** (8-bit PNG exports), the same
domain Lumetri's waveform and vectorscope show. Luma uses **BT.709** weights
(0.2126 / 0.7152 / 0.0722) and Cb/Cr scale factors 1.8556 / 1.5748.
- ITU-R BT.709-6, *Parameter values for the HDTV standards*, §3 — luma and
  colour-difference equations. https://www.itu.int/rec/R-REC-BT.709

Source-frame extraction passes the YUV matrix and range to ffmpeg explicitly,
because swscale's default YUV→RGB conversion is BT.601 and would skew hue and
saturation on BT.709 footage.

## Skin-tone line (diagnostic only)
The vectorscope "skin" or I line sits about **123°** from +Cb. It comes from
the NTSC YIQ I axis. Well-balanced skin of every complexion clusters near it;
what mainly differs between people is distance from centre (chroma) and
brightness, and real skin sits a few degrees off the line. The tools report
`skinLineDeviationDeg` and never rotate skin onto the line.
- Kdenlive docs, "Vectorscope I and Q lines".
  https://docs.kdenlive.org/en/tips_and_tricks/scopes/vectorscope_i_and_q_lines.html
- Boris FX / VEGAS scope documentation (skin falls slightly clockwise of the line).
  https://cdn.borisfx.com/borisfx/Documentation/vegas/2026/en/content/topics/8-design/video_scope_settings.htm
- "Why is the red primary oriented at 104° on a vectorscope?" (axis derivation).
  https://chriskiehl.com/article/what-is-red-doing-over-there

## Curves
Monotone cubic Hermite interpolation keeps a curve through increasing points
from overshooting, folding or inverting, so a contrast curve can't solarise.
- F. N. Fritsch & R. E. Carlson, "Monotone Piecewise Cubic Interpolation",
  SIAM J. Numer. Anal. 17(2), 1980.

The S-curve pivots at the skin (or scene) median, so midtone and skin
brightness stay put. Its strength is then reduced by bisection until the
frame's own p1 stays above the 8-bit information-loss floor (2/255), p99
stays below the clip threshold (254/255), toe slope stays ≥ 0.6 and maximum
slope ≤ 1.6. The thresholds mark *information loss* and *banding risk*; they
are not aesthetic targets.

## Hue curves and wheels
- Hue windows are raised-cosine (C¹-continuous), so there are no hard hue
  boundaries; `safetyReport` flags windows that are too narrow for their strength.
- Saturation changes scale chroma around BT.709 luma, so brightness doesn't
  move when skin is desaturated. (HSV-S scaling brightened skin +0.019 on the
  live frame, and was replaced.)
- Wheels use overlapping smoothstep weights for shadows/midtones/highlights
  that sum to 1 everywhere. As in an editor, a midtone wheel also reaches into
  the lower shadows and upper highlights. Lumetri's own wheels are
  "shadows/midtones/highlights" in Color Wheels & Match, not lift/gamma/gain.
  The engine's wheels are its own maths, used for LUT baking and previews, and
  are not claimed to equal Lumetri's.

## White balance
The cast is measured as the mean Cb/Cr of **near-neutral** pixels (HSV S <
0.12, 0.2 < Y < 0.95, unclipped). It is decomposed onto the blue↔yellow and
green↔magenta axes, the axes of Lumetri's Temperature and Tint. With fewer
than 1% neutral pixels it falls back to grey-world, marked low-confidence,
and nothing is corrected automatically. Limitation: "near-neutral" is
statistical, not semantic. Desaturated foliage or a coloured-but-dull
surface can count as neutral; read `whiteBalance.method/confidence`.

## Lumetri slider maths
Undocumented. The bridge never predicts pixels from slider values. It solves
closed-loop instead: write, re-render through QE `exportFramePNG`,
re-measure, then take secant steps (`recommend/solver.js`). Every measurement
is returned.

## Premiere scripting surface
- ExtendScript ComponentParam (`getValue`, `setValue(value, updateUI)`,
  `areKeyframesSupported`): https://ppro-scripting.docsforadobe.dev/sequence/componentparam/
- Premiere UXP reference (ExtendScript is frozen; UXP is the successor):
  https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/componentparam
- Masks and tracking are documented only as UI features (Effect Controls):
  https://helpx.adobe.com/premiere-pro/how-to/create-clip-masks.html
- Live facts on 26.5.2 (probe, 2026-11-14): DOM `Sequence.exportFramePNG` is
  undefined; QE `exportFramePNG(timecode, pathWithoutExt)` works;
  `qe.project.getSequenceAt(i)` throws; curves, Hue-vs curves, wheels and HSL
  key are opaque strings or packed numbers.

## Face detection
Apple Vision `VNDetectFaceLandmarksRequest` (face box + faceContour, lips,
eyes, brows, pupils, nose). It returns no skin mask; skin is isolated
downstream.
- https://developer.apple.com/documentation/vision/vndetectfacelandmarksrequest
- https://developer.apple.com/documentation/vision/vnfacelandmarks2d
