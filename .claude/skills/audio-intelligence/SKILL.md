---
name: audio-intelligence
description: Transcribes Premiere sequence audio via Whisper (locally, no cloud) and finds moments by spoken phrase. Triggers on "find the moment where I said X", "transcribe this", "where's the nibble", "what's said in this clip", "audio pass", or invoked by sifter at start of every cut. Uses export_clip_audio bridge tool to dump WAV, then runs ~/.local/bin/transcribe_wav.py with faster-whisper (base model default). Collapsed audio-engineer + audio-transcriber roles per Travis spec 2026-05-22.
---

# audio-intelligence — Whisper-Powered Audio Analysis

The only path from Premiere audio → searchable transcript with frame-accurate timestamps.

## Default workflow

1. Get target range — sequence + startSec + endSec (from upstream OR full sequence)
2. Export audio: `mcp__premiere-pro__export_clip_audio` → `/tmp/audio_intel_<TS>.wav` (WAV 48kHz 16-bit, whisper-optimal)
3. Transcribe via bash: `~/.local/bin/transcribe_wav.py /tmp/audio_intel_<TS>.wav --model base --words [--search "<phrase>"]`
4. Parse JSON output → segments[], words[], matches[]
5. Convert source-relative TCs → timeline-absolute for downstream
6. Write transcript log
7. Optional: clean /tmp WAV after

## Model defaults (Travis spec)

- **`base`** — default. Best accuracy/speed balance. Catches snapper/tarpon/striper/fluke/redfish.
- `tiny` — speed > accuracy. Smoke-tested as misheard "mutton snapper" → "modern sniper".
- `small` — when base misses gear brand names
- `medium`/`large-v3` — slow on CPU; only when needed

## Search vs full transcribe

- **Search**: user named a moment ("find where I said nibble") — pass `--search`
- **Full**: sifter invokes for whole-sequence scoring — no `--search`

## Inputs
1. `mcp__premiere-pro__timeline_get_state`
2. Upstream agent log (what range, what to search for)

## Output

`~/Downloads/logs/{TS}_audio_intelligence_<seq>_<start>-<end>.json`:
```json
{
  "sequenceName": "<name>",
  "rangeStartSec": 0, "rangeEndSec": 2141.78,
  "exportPath": "/tmp/audio_intel_<TS>.wav",
  "model": "base",
  "language": "en",
  "duration": 2141.78,
  "segments": [{"start": 7.37, "end": 17.38, "text": " nibble nibble nibble yeah, the mutton snapper is stealing my bait."}],
  "searchPhrase": "nibble",
  "matches": [{"type": "word", "start": 7.37, "end": 7.55, "word": " nibble"}],
  "timelineAbsoluteTimestamps": true,
  "notes": "TCs are sequence-absolute. For source-clip-relative, subtract clip.start.",
  "approved": null
}
```

## Coordination

- **sifter** invokes without search → full transcript for scoring
- **sifter** then invokes WITH search for specific named moments
- **multiclip-syncer** future: invoke for audio-overlap detection

## Bridge tools
- `mcp__premiere-pro__export_clip_audio` (PRIMARY — built 2026-05-22)
- `mcp__premiere-pro__timeline_get_state`

## Bash tools
- `~/.local/bin/transcribe_wav.py` (PRIMARY)
- `~/.local/bin/ffmpeg` (only if pre-processing — usually not needed)

## Hard rules

1. NEVER cloud-transcribe — local Whisper only
2. NEVER report a moment without start AND end TC
3. ALWAYS specify whether TCs are sequence-absolute or source-clip-relative
4. NEVER infer content — report Whisper's exact words (sifter does fuzzy matching)
5. CACHE — if same range was transcribed today, reuse log; check `~/Downloads/logs/` first
6. CLEAN /tmp WAVs older than 24 hours at run start

## Future v2 scope (placeholder)
- Music ducking on dialogue
- EQ presets (interview, outdoor wind, boat)
- Noise reduction (Premiere built-in)
- Sound effect insertion (reaction stings)
- Audio leveling/normalization

v1 = transcription + search only.
