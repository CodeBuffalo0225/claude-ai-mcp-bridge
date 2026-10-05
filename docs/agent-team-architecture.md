# Premiere Pro Agent Team — Architecture Review
**Status:** DRAFT for Travis review. Mark up freely, change scope, kill agents you don't want.
**Date:** 2026-05-22
**Build after:** sign-off + open questions answered

---

## Top-level user experience

> Travis: "Edit my Florida fishing trip into a 10-min YouTube cut + a 15s TikTok reel of the nibble moment"

→ `video-editor` orchestrator fires → reads CLAUDE.md style DNA + CutPilot trends → delegates to sub-agents → final cuts delivered in Premiere, ready to export.

User never has to think about which sub-agent does what. The orchestrator chooses based on the request.

---

## Agent catalog

### 1. video-editor (ORCHESTRATOR)
**Triggers on:** "edit my [trip/project]", "make a [YouTube/TikTok/Reel] cut from X", "build a cut", "the editor"
**Role:** Plans the cut, delegates to sub-agents, writes the master decision log.
**Reads:**
- `~/Documents/Adobe AI Editor/CLAUDE.md` (style DNA, bug status, bridge backlog)
- `~/Documents/cutpilot-trends-cache/intelligence/notebooklm/<latest>_digest.txt`
- Active Premiere project state via `mcp__premiere-pro__project_get_info` + `timeline_get_state`
**Writes:**
- `./logs/{date}_videoeditor_decisions.json` — master plan with sub-agent assignments
**Bridge tools used directly:**
- `project_get_info`, `timeline_get_state`, `timeline_set_active`, `timeline_duplicate`
**Delegates to:** all sub-agents below
**Q for Travis:** Does the orchestrator AUTO-PICK the right format (long YT vs Short vs Reel vs LinkedIn) from your request, or always ask first?

### 1a. sifter
**Triggers on:** "sift the footage", "find the good takes", invoked by video-editor
**Role:** Read the source manifest, score each clip by duration + position + (eventually) transcript hits. Output ranked clip list.
**Reads:** Source sequence state, optional transcript from audio-transcriber
**Writes:** `./logs/{date}_sifter_picks.json` with `[{clipName, score, rationale, transcriptHit?}]`
**Bridge tools:** `timeline_get_state`
**Q for Travis:** Should sifter ALWAYS call audio-transcriber first to get transcripts before scoring, or only when video-editor explicitly asks? (Cost vs accuracy tradeoff.)

### 1b. color-grader
**Triggers on:** "color grade", "apply [preset name]", "match grade"
**Role:** Apply Lumetri preset to clips/sequence based on style DNA + content type
**Reads:** Style DNA color section from CLAUDE.md, sequence state
**Writes:** `./logs/{date}_grader_applied.json`
**Bridge tools:** `color_apply_lumetri`
**Q for Travis:** Does grader DECIDE the preset (from CLAUDE.md style rules: hunting→blockbuster_action, fishing→?, brand→youtube_vibrant) or always take it as input?
**Q for Travis:** What's your fishing-specific grade preset? Style DNA in CLAUDE.md only covers hunting/action.

### 1c. sequence-setter
**Triggers on:** "create a sequence for [purpose]", invoked by video-editor at the start of a new cut
**Role:** Decide sequence settings (resolution/fps/aspect) based on target platform from trends
**Reads:** Trends (LinkedIn vertical / TikTok 9:16 / YT 16:9 4K guidance), source manifest
**Writes:** `./logs/{date}_seq_config.json`
**Bridge tools:** `timeline_create`
**Q for Travis:** Should sequence-setter ALWAYS duplicate-from-master (preserves grade) or sometimes create fresh? Current pattern is duplicate→trim.

### 1d. multiclip-syncer
**Triggers on:** "sync multicam", "align cameras", invoked when source has multiple angle clips
**Role:** Sync clips from multiple cameras using audio waveform / timecode
**Bridge tools used:** **NONE EXIST YET** — needs new `multicam_sync` bridge tool. Premiere has built-in "Synchronize" in Project panel; bridge needs to trigger it via `app.executeCommand` with the right menu command ID.
**Q for Travis:** Is multicam syncing important for the Florida-fishing genre, or mostly relevant for hunting trips with multiple GoPros? (Affects priority.) If yes, this is a NEW bridge tool I need to build first.

### 2. audio-engineer
**Triggers on:** "audio pass", "audio cleanup", invoked by video-editor
**Role:** Coordinates audio work. Lightweight — mostly delegates to 2a. Future: ducking music, EQ, noise reduction.
**Bridge tools used directly:** none today
**Delegates to:** audio-transcriber (2a)
**Q for Travis:** Collapse audio-engineer INTO audio-transcriber for v1 (one agent, simpler)? Re-split later when you want music/EQ work?

### 2a. audio-transcriber (THE WHISPER AGENT)
**Triggers on:** "find the moment where I said X", "transcribe this clip", "where's the nibble", invoked by sifter or audio-engineer
**Role:** Export sequence range as WAV via `export_clip_audio`, run `transcribe_wav.py`, return segments with timestamps. Searchable.
**Reads:** Sequence state, target search phrase
**Writes:** `./logs/{date}_transcript_{seq}_{range}.json`
**Bridge tools:** `export_clip_audio` (NEW, built today, deploys next restart)
**Bash tools:** `~/.local/bin/transcribe_wav.py`
**Q for Travis:** Default model size — `base` is recommended (accurate enough for "snapper" word, ~2x slower than tiny). OK?

### 3. text-captions
**Triggers on:** "add captions", "burn text", "hook overlay", invoked by video-editor or directly
**Role:** Add Essential Graphics text overlays for hooks/captions per CutPilot trend patterns
**Reads:** Trends (hook patterns, caption styles), sequence state
**Writes:** `./logs/{date}_text_added.json`
**Bridge tools:** `edit_add_text` (currently buggy — silently fails; needs fix as part of P0 bridge cleanup)
**Q for Travis:** When this agent writes captions, should it WRITE its own copy (from trend templates) or always take copy from user?

### 4. exporter
**Triggers on:** "export final", "render for [platform]", "ship it"
**Role:** Pick the right preset for the target platform, queue export
**Reads:** Sequence settings, target platform
**Writes:** `./logs/{date}_export_log.json`, output media files
**Bridge tools:** `export_media`
**Q for Travis:** Should exporter queue MULTIPLE outputs from one source (YT + TT + IG + LI) in parallel, or one at a time?

---

## Coordination protocol

**State sharing via decision logs:**
- Every agent writes a timestamped JSON to `./logs/`
- Each log has `approved: null` initially; user marks `true`/`false` post-hoc → learning signal
- Downstream agents read the LATEST log from their upstream agents at start

**Triggering chain (example: "make me a 10-min YT cut + TikTok reel of the nibble line"):**
```
1. video-editor fires (user phrase match)
2. video-editor → sequence-setter (create FL Cut V5 at 4K/60)
3. video-editor → audio-transcriber (find "nibble" in source) ← USES WHISPER
4. video-editor → sifter (rank clips, incorporating nibble timestamp)
5. video-editor → color-grader (apply fishing preset to sequence)
6. video-editor → text-captions (add hook text per trend patterns)
7. video-editor → exporter (queue YT export + spawn second cut for TT reel)
```

---

## LOCKED ANSWERS (2026-05-22) — used for build

1. ✅ Auto-pick format (default YT/story); ask only when ambiguous
2. ✅ Sifter transcribes first by default (accuracy > speed)
3. ✅ Color grader auto-picks preset from style + content; allow user override
4. ✅ Fishing preset = **`fishing_coastal_outdoor_natural`** — clean water, natural skin, blues/greens richer, deck detail preserved, NOT teal-orange. Built into color-grader.js this session.
5. ✅ Sequence-setter always duplicates by default — never modify original
6. ✅ Multicam syncing IS needed → `multicam_sync` bridge tool BUILT this session
7. ✅ Collapse audio-engineer + audio-transcriber → **one agent: `audio-intelligence`**
8. ✅ Whisper default = `base` model
9. ✅ Captions auto-generate from trend templates; allow user override
10. ✅ Exporter sequential by default

## Final agent count: 8 (was 9 — audio collapsed)

1. video-editor (orchestrator)
1a. sifter
1b. color-grader (default = fishing_coastal_outdoor_natural for fishing content)
1c. sequence-setter (always duplicates source)
1d. multiclip-syncer (uses new multicam_sync bridge tool)
2. audio-intelligence (Whisper, base model default, runs by default during sift)
3. text-captions (auto-generates from trend templates, user override allowed)
4. exporter (sequential by default)

## Original open questions (resolved above)

1. **Auto-pick format or always ask?** (1)
2. **Sifter always transcribes first, or on-demand?** (1a)
3. **Grader decides preset or takes input?** (1b)
4. **Fishing-specific color grade preset name?** (1b)
5. **Sequence-setter: always duplicate or sometimes create?** (1c)
6. **Multicam syncing priority?** (1d) — affects whether I build new bridge tool first
7. **Collapse audio-engineer into transcriber for v1?** (2)
8. **Whisper default model: base OK?** (2a)
9. **Captions write own copy from templates or take input?** (3)
10. **Exporter: parallel multi-platform or sequential?** (4)

---

## Gaps in current bridge (needed for full team)

- **`multicam_sync`** — new tool, fires Premiere's built-in Synchronize via `app.executeCommand` menu command
- **`edit_add_text` reliability** — currently lies (returns success, doesn't add). Needs JSX handler audit.
- **`edit_cut` deployment** — fix in source not yet loaded (panel reload bug)
- **`timeline_duplicate` deployment** — same

These get cleaned up in the same Premiere restart that deploys `export_clip_audio`.

---

## After your sign-off

I will:
1. Answer/incorporate any architecture changes you mark up
2. Build 9 SKILL.md files (one per agent) in `~/Documents/Adobe AI Editor/.claude/skills/` (project-local, version-controlled with the bridge)
3. Audit/fix the buggy bridge handlers (edit_add_text, etc.)
4. Build any new bridge tools you greenlight (multicam_sync if Q6=yes)
5. Bundle deployment: ONE Premiere restart + ONE Claude Code restart → everything live
6. Next session opens with the agent team ready to dispatch

Estimated build time: ~45 min for skills + ~30 min for bridge fixes.
