---
name: color-grader
description: Applies Lumetri color grade presets to Premiere clips or sequences. Triggers on "color grade", "apply [preset name]", "match grade", "grade this", "give it the fishing look", "color pass". By default auto-picks the preset by content type (fishing → fishing_coastal_outdoor_natural; hunting → blockbuster_action; brand → youtube_vibrant). If user names a preset, use that instead.
---

# color-grader — Lumetri Preset Applier

Applies Travis's signature grades via Premiere's Lumetri Color through the bridge.

## Default auto-pick

| Content signal | Default preset | Notes |
|---|---|---|
| Fishing (boat, bridge, kayak, beach, water) | `fishing_coastal_outdoor_natural` | Travis signature — clean water, natural skin, NOT teal-orange |
| Hunting/action (treestand, blind, harvest) | `blockbuster_action` | Cinematic punch |
| Hunting/atmosphere (pre-dawn, foggy) | `cinematic_warm` | Mood |
| Brand collab (sponsor mention) | `youtube_vibrant` | Punchy, ad-friendly |
| Outdoor lifestyle (general) | `youtube_warm_cozy` | Approachable |
| Low-light/moody | `youtube_dark_moody` | Shadow detail |

User override always wins.

## Content detection (priority order)

1. **Transcript hits** from audio-intelligence — species names map to content type
2. **Project/sequence name** — "florida fishing" / "muzzleloader" / "tenex"
3. **Filename hints** — GoPro chapter ranges per known trip
4. **CLAUDE.md Active Projects** section

## Application

Long-form (YT 8–15 min): adjustment layer OR per-clip. One consistent grade.

Shorts/reels: same preset, can push sat/contrast +10% (mobile/smaller screens).

Multi-platform from one source: same base, document per-platform micro-adjustments.

## Output

`~/Downloads/logs/{TS}_color_grader_applied.json`:
```json
{
  "sequenceName": "<name>",
  "presetPicked": "fishing_coastal_outdoor_natural",
  "presetSource": "auto|user_override",
  "contentSignal": "transcript_hit:snapper",
  "appliedTo": {"clipsAffected": 25, "method": "adjustment_layer|per_clip"},
  "rationale": "Transcript contains 'snapper' → fishing → coastal natural preset",
  "approved": null
}
```

## Bridge tools
- `mcp__premiere-pro__color_apply_lumetri`
- `mcp__premiere-pro__timeline_get_state`

## Hard rules
1. NEVER override a manually-graded sequence without asking
2. NEVER teal-orange on fishing content — Travis rejected that look
3. NEVER stack presets — clear existing Lumetri first
4. ALWAYS log preset + signal
5. Brand collab default: `youtube_vibrant` unless brand has spec
