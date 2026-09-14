---
name: sifter
description: Scores and ranks clips in a Premiere sequence to identify the strongest moments. Triggers on "sift the footage", "find the good takes", "rank these clips", "which clips are best", or invoked by video-editor. ALWAYS runs audio-intelligence transcription FIRST by default (Travis spec — accuracy over speed). Combines transcript hits + duration + chronological position + GoPro chapter convention. Output: ranked clip list with rationale per pick.
---

# sifter — Clip Ranker

Evaluate every clip in a source sequence, return ranked list of strongest moments.

## Default: ALWAYS transcribe first

Invoke audio-intelligence before scoring. Skip only if:
- Video-editor explicitly says "skip transcription"
- Source has no audio
- Audio-intelligence ran for this sequence today (reuse latest log)

## Inputs

1. `mcp__premiere-pro__timeline_get_state`
2. Latest audio-intelligence log from `~/Downloads/logs/*audio_intelligence_*.json`
3. Latest CutPilot trend digest for target platform
4. `~/Documents/Adobe AI Editor/CLAUDE.md` style DNA
5. Upstream video-editor log

## Scoring (weighted)

1. **Hook potential** (3x) — reveal, action peak, reaction. Transcript hits: "biggest fish", "are you serious", "no way", "got him", "yeah!"
2. **Narrative payoff** (2x) — setup→punchline structure. Long clips with build patterns.
3. **Visual quality** (2x) — action, water clarity, light. Duration proxy if no visual analysis.
4. **Audio impact** (1x) — narration, reel drag, hookset grunt, species names ("snapper", "tarpon", "redfish", "striper", "fluke", "tarpon").
5. **Pacing fit** (2x) — clip length matches CutPilot pacing benchmark at this story point.

## Fallback heuristics (no transcript)

- Duration as action proxy: >2 min = sustained action
- Position as phase: first 20% = establish, middle 60% = build, last 20% = wrap
- GoPro 531/532s clips = auto-split cap = continuous moment
- Filename gaps (GX01xxx → GX02xxx) = camera/day boundary

## YouTube long-form structure

- 0:00–0:30 HOOK
- 0:30–1:30 ESTABLISH
- 1:30–4:00 BUILDING ACTION
- 4:00–6:30 RISING ACTION
- 6:30–8:30 CLIMAX
- 8:30–9:30 RESOLUTION
- 9:30–10:00 OUTRO/CTA

## Output

`~/Downloads/logs/{TS}_sifter_picks.json`:
```json
{
  "sourceSequence": "<name>",
  "deliverableType": "youtube_longform|...",
  "transcriptSource": "<log path or NONE>",
  "structureMap": [{"segment": "HOOK", "targetSec": 30, "pickedClipIndex": 0, "transcriptHit": "..."}],
  "rankedPicks": [
    {
      "clipName": "GX018675.MP4",
      "clipIndex": 24,
      "compositeScore": 9.2,
      "hookScore": 10, "narrativeScore": 8, "visualScore": 8, "audioScore": 10, "pacingScore": 9,
      "transcriptHits": [{"start": 7.37, "end": 17.38, "text": "nibble nibble nibble yeah"}],
      "suggestedSequencePosition": "HOOK",
      "suggestedTrimRange": {"inSec": 7.37, "outSec": 17.38},
      "rationale": "Contains 'nibble nibble nibble yeah' — TT reaction-format moment per 2026-05-18 trend",
      "cutpilotFlag": "tt_reaction_split",
      "approved": null
    }
  ]
}
```

## Bridge tools
- `mcp__premiere-pro__timeline_get_state`
- Indirect: invokes audio-intelligence

## Hard rules
1. NEVER skip transcription unless explicitly told
2. NEVER score from filename alone — read transcript
3. EVERY pick cites either transcript hit OR heuristic signal
4. EVERY pick cites cutpilotFlag from latest trend digest
5. DO NOT execute cuts — sifter is read-only
