---
name: multiclip-syncer
description: Synchronizes 2+ clips from different cameras (GoPro, phone, drone, action cam) using audio waveform alignment. Triggers on "sync multicam", "align cameras", "sync these clips", "multicam pass", or invoked by video-editor when source has multiple angles of the same moment. Uses the multicam_sync bridge tool which fires Premiere's QE-DOM synchronize. Default method = audio waveform (best for boat/outdoor footage with ambient sound).
---

# multiclip-syncer — Multi-camera Alignment

## When to invoke

- Boat fishing days — GoPro on rod + phone overhead + drone
- Hunting — GoPro on body + treestand cam + phone
- Interview/dialogue — multiple cameras on subject
- Any case with 2+ clips overlapping in time

## Default behavior

1. Identify clips to sync (from upstream agent OR user input)
2. Verify they're on the same video track (move via edit_move_clip if needed)
3. Call `mcp__premiere-pro__multicam_sync` with method=`audio`
4. Re-read timeline state — clip start positions should have adjusted (verification)
5. Fallback chain if audio fails: `timecode` → `markers`

## Method selection

| Source mix | Best method |
|---|---|
| All GoPro chapters (one camera, sequential) | `in_points` (already in sync) |
| GoPro + phone | `audio` if both have ambient; else `timecode` if app-synced |
| GoPro + drone | `audio` (propeller = reliable waveform marker) |
| GoPro + action cam (mixed brands) | `audio` |
| Pre-marked clips (user M-marks) | `markers` |
| Embedded TC clips (clapper/app) | `timecode` |

## Inputs
1. `mcp__premiere-pro__timeline_get_state`
2. Upstream video-editor log
3. Sifter log if it flagged duplicate-moment clips

## Output

`~/Downloads/logs/{TS}_multicam_sync_log.json`:
```json
{
  "sequenceName": "<name>",
  "clipsSynced": ["GX018670.MP4", "IMG_4421.MOV"],
  "method": "audio",
  "syncTrackChannel": 1,
  "bridgeResult": {"synced": true, "method": "qe.synchronize"},
  "verifiedByStateRead": true,
  "approved": null
}
```

## Bridge tools
- `mcp__premiere-pro__multicam_sync` (PRIMARY — built 2026-05-22)
- `mcp__premiere-pro__timeline_get_state`
- `mcp__premiere-pro__edit_move_clip`

## Hard rules
1. NEVER sync without verifying afterward (re-read state)
2. NEVER assume audio sync works — log fallback chain
3. If `multicam_sync` returns `synced: 'dialog_opened'` — Premiere needs user to click OK; report and pause
4. NEVER sync clips >5 min apart in timeline without confirmation
5. PRESERVE original arrangement — sync only adjusts start positions
