---
name: sequence-setter
description: Creates or duplicates Premiere sequences with the right settings for the target platform. Triggers on "create a sequence for [purpose]", "set up a sequence", "duplicate the source", "give me a working copy", or invoked by video-editor at start of cut build. ALWAYS duplicates by default (Travis spec — never risk the original). Only creates fresh when explicitly told "fresh" or "blank".
---

# sequence-setter — Sequence Initializer

Cardinal rule (Travis 2026-05-22): **always duplicate by default**.

## Default

`mcp__premiere-pro__timeline_duplicate(sourceName=<active>, destName=<smart name>)` — preserves color grade, transitions, markers, arrangement.

Create FRESH only when:
- User explicitly says "create fresh"/"blank"/"start over"
- No source exists
- Deliverable settings differ AND user wants clean start

## Naming convention

| Deliverable | Name |
|---|---|
| YouTube long-form | `<source> YT v{N}` |
| YouTube Short | `<source> Short v{N}` |
| TikTok reel | `<source> TT Reel v{N}` |
| Instagram reel | `<source> IG Reel v{N}` |
| LinkedIn | `<source> LI v{N}` |
| Working/scratch | `<source> Cut v{N}` |

N = next unused integer (check via `project_get_info`).

## Platform settings

| Platform | Resolution | FPS | Aspect |
|---|---|---|---|
| YT long-form (4K source) | 3840×2160 | match source (60 default) | 16:9 |
| YT long-form (1080 source) | 1920×1080 | match source | 16:9 |
| YT Short | 1080×1920 | 60 | 9:16 |
| TikTok | 1080×1920 | 60 | 9:16 |
| IG Reel | 1080×1920 | 60 | 9:16 |
| LinkedIn (per 2026-05-18 trend) | 1080×1920 | 60 | 9:16 |

Duplicate preserves source settings. If platform target differs (4K 16:9 source → 9:16 deliverable), log the mismatch — downstream handles reframe.

## Inputs
1. `mcp__premiere-pro__project_get_info`
2. Upstream video-editor log
3. CutPilot trends for current platform best-practice

## Output

`~/Downloads/logs/{TS}_sequence_setter_config.json`:
```json
{
  "action": "duplicated|created_fresh",
  "sourceSequence": "<original>",
  "workingSequence": "<new>",
  "platformTarget": "youtube_longform|...",
  "settings": {"width": 3840, "height": 2160, "frameRate": 60, "sampleRate": 48000},
  "preservedGrade": true,
  "approved": null
}
```

## Bridge tools
- `mcp__premiere-pro__project_get_info`
- `mcp__premiere-pro__timeline_duplicate` (PRIMARY)
- `mcp__premiere-pro__timeline_create` (only when user says "fresh")
- `mcp__premiere-pro__timeline_set_active`

## Hard rules
1. NEVER skip duplication for "speed"
2. NEVER reuse a sequence name — auto-increment version
3. ALWAYS activate the new sequence after creating
4. NEVER assume platform — read from video-editor log
5. If `timeline_duplicate` fails — STOP, report, don't workaround silently
