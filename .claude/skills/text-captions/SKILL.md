---
name: text-captions
description: Adds Essential Graphics text overlays — hooks, captions, lower-thirds, titles — to Premiere timelines. Triggers on "add captions", "burn text", "hook overlay", "add a title", "text on top", or invoked by video-editor for any short/reel/social cut. Auto-generates copy from CutPilot trend templates (e.g., "Bro this snapper stole my bait" style) based on cut content + platform. If user provides specific copy, uses that instead.
---

# text-captions — Hook & Caption Writer

Short-form cuts LIVE OR DIE on the first 3 seconds of burned-in text.

## Default behavior

Auto-generate copy from trend templates + content context unless user provides specific text.

### Trend template library (from CutPilot Weekly Trend Refresh)

| Template (trend source) | When | Example |
|---|---|---|
| **Reaction reveal** (TT HIGH 2026-05-18) | Unexpected catch, gear failure | "Bro this snapper stole my bait" |
| **Wait this looks so cool** (IG HIGH 2026-05-18) | Stunning visual reveal | "Wait... watch the water turn" |
| **POV: [scenario]** (TT HIGH) | Subjective moment | "POV: a snapper is winning all day" |
| **Numbered list / Top N** (IG HIGH) | Multi-fish recap | "3 fish in 2 hours. Florida." |
| **I have [escape]** (IG HIGH) | Comedic restoration | "I have a tree stand" |
| **Confessional gear obsession** (IG HIGH) | Brand collab love | (lip-sync "Bleeding Love") |
| **Sub-60s educational** (YT HIGH) | How-to | "How to fish a Florida bridge" |
| **Story arc** (YT HIGH) | Long-form opener | "Day 1: no fish. Day 2..." |

## Copy generation rules

- **Max 8 words** per caption (Travis DNA — minimal_white pattern)
- **Declarative, present tense** ("Snapper. Stolen." not "I caught a...")
- **Written for muted-first viewing** — text carries narrative
- **Don't explain what's on screen** — complement it
- **One concept per caption**
- **Travis voice**: casual, slight self-deprecation, fishing-bro tone (cross-reference travis-voice + dale-carnegie-htwf skills)

## Default style (Travis DNA)

| Property | Value |
|---|---|
| Position | center (hooks) / lower_third (captions) |
| Font | Arial Bold (minimal_white pattern) |
| Size | 140pt for hooks (4K), 90pt for captions |
| Color | white (#FFFFFF) |
| Animation | scale_pop (hooks), fade_in (captions) |
| Track | V2 |
| Duration | full clip for hooks; 2-3s for captions |

For hormozi-style (when asked): uppercase, gold, scale_pop, drop shadow.

## Inputs
1. Upstream sifter log — picked clips + rationale (content context)
2. Upstream audio-intelligence log — transcript hits to mirror
3. Latest trend digest — current templates
4. CLAUDE.md style DNA

## Output

`~/Downloads/logs/{TS}_text_captions_added.json`:
```json
{
  "sequenceName": "<name>",
  "textsAdded": [
    {
      "text": "Bro this snapper stole my bait",
      "trendTemplate": "tt_reaction_reveal",
      "startTime": 0, "duration": 10, "trackIndex": 1,
      "style": {"fontSize": 140, "color": "#FFFFFF", "position": "center", "animation": "scale_pop"},
      "sourceOfCopy": "auto_generated|user_provided",
      "rationale": "Cold-open hook for nibble reel; mirrors content per 2026-05-18 TT reaction trend"
    }
  ],
  "approved": null
}
```

## Bridge tools
- `mcp__premiere-pro__edit_add_text` (PRIMARY — fixed 2026-05-22 to verify clip landed)

## Hard rules

1. NEVER use stock phrases ("Subscribe!", "Like and comment") — Travis voice is specific
2. NEVER over-narrate — text complements, doesn't explain
3. NEVER stack 2+ overlays at same TC
4. ALWAYS verify text landed by reading timeline state after add_text; if `added: false` → report and STOP (no silent lies)
5. Brand collab: don't put brand name in hooks unless user asks (ad-fatigue)
6. Track: always V2 default; check V2 is empty at target TC first
