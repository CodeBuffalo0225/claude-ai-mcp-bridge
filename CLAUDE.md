# Claude AI MCP Editor — Project Memory
# Updated: 2026-05-21 (Florida Fishing May 26 session)

## Who This Is For
Travis — Team Buffalo Outdoors. Hunting / fishing / outdoor lifestyle creator.
Primary YouTube/TikTok/Instagram/Facebook/X. Brand collabs (BetterBoat, MoultrieMobile, PSE, Tenex, etc.)

## Style DNA (generated 2026-05-05 from 51 projects, 13,746 clips)
- **Social avg cut duration:** 7.12s | **CPM:** 8.4
- **Short clip % (social):** 78-96% of cuts ≤5s
- **Hook pattern:** Fast micro-cut opening (10+ cuts ≤3s) → narrative rhythm → emotional close
- **Caption style:** minimal_white or hormozi_style (uppercase, scale_pop, white/gold)
- **Color grade (hunting/action):** blockbuster_action or cinematic_warm
- **Color grade (product/brand):** youtube_vibrant
- **Music:** Cinematic/country for hunting; upbeat/relaxed for fishing; stripped for shorts
- **Reel length:** 10–25 seconds
- **Closest style analogs:** BetterBoat shorts (7.08s avg), Hunt Under $1K (5.98s avg, 96% short)

---

## ✅ RELIABILITY LAYER — SHIPPED 2026-07-05 (needs ONE final app restart to activate)

Deployed in commit(s) on `feat/agent-team-and-audio-pipeline`. After ONE full quit+reopen of
Premiere/AE (to load the new panel + JSX), the restart tax is gone forever:

1. **JSX version handshake (kills bug #10).** Both .jsx files carry `BRIDGE_JSX_VERSION`
   ("2026-07-05.1") + an `_info` handler returning the live version + full handler list.
   Panel logs "JSX loaded: vX, N handlers" at startup. MCP tools: `bridge_preflight`
   (Premiere) / `ae_bridge_preflight` (AE). RUN THE PREFLIGHT FIRST every session.
2. **Hot-reload (kills the Cmd+Q tax).** `bridge_reload_jsx` / `ae_bridge_reload_jsx`
   re-evalFiles the .jsx in the running app and returns the fresh version. JSX edits no
   longer need a Premiere/AE restart — ONLY panel-HTML or MCP-server (.js) edits do
   (server edits: kill the node proc, Claude Code respawns it).
3. **Async jobs (kills bug #11-class timeouts).** Any command sent with `params._async=true`
   returns `{jobId}` instantly; panel stashes the result for `_jobStatus` polling.
   `bridge.sendJob()` wraps this. Already wired: `export_media`, `export_clip_audio`,
   `color_grade_preset` (full_timeline), `ae_render`. `bridge.send()` also takes
   `{timeoutMs}` per call now.
4. **AE render fixed — NO MORE PNG-loop + ffmpeg.** Preferred: `ae_render_headless`
   (saves project via new AE `project.save` handler, spawns `aerender` CLI in background,
   poll with `ae_render_status`; default output module "Lossless", transcode with ffmpeg
   only if h264 needed). `ae_render` (in-app RQ) now applies templates honestly — errors
   with the installed-template list instead of silently rendering defaults; check
   `ae_render_list_templates`. `_eval` also added to the AE bridge.
5. **Simulation code deleted** from adobe-bridge.js (hard rule #1 can't regress).
6. **Stale copy neutralized:** `Adobe files/premiere-bridge.jsx` is now a symlink to
   `src/extendscript/premiere/premiere-bridge.jsx` (old file kept as `.stale-2026-07-05.bak`).
7. **Duplicate MCP registration removed:** `premiere-pro` deleted from `~/.claude.json`
   (Downloads project) — `premiere-live` is THE Premiere server now (backup:
   `~/.claude.json.bak-2026-07-05`).

**Session pattern from now on:** `bridge_preflight` → verify jsxVersion ≥ 2026-07-05.2 →
edit. After any .jsx change: bump `BRIDGE_JSX_VERSION`, `bridge_reload_jsx`, confirm version.

## ✅ RECIPE TOOLS + UXP-READY SEAM — SHIPPED 2026-07-05 (session 2)

1. **`ramp_clip` (first recipe tool).** One call = probe → auto-calibrate valueScale →
   design keys → apply → read-back verify. Shapes: `punch_in`, `open_slow_rampout`
   (transition goes at the over-cranked tail), `ramp_into_slow`, `custom`. Clean slow-mo
   ratio auto-picked from sourceFps+timelineFps (60→24 = 40%). Refuses clips that already
   have speed keys. Run on a WORKING COPY. JSX handlers `edit.speedRampProbe` /
   `edit.speedRamp` now actually exist (jsx v2026-07-05.2) — the cutpilot-speed-ramp
   skill described them but they were never implemented. Math in `src/recipes/speed-ramp.js`,
   22 unit tests in `tests/` (`npm test`, fixed for node22).
   ❌ LIVE-VERIFIED BROKEN 2026-07-06 on Premiere 26.3.0 — DO NOT USE, do not re-attempt
   without a design change first. `edit.speedRampProbe` returns `timeRemapFound: false`
   on every clip tried (real GoPro footage, confirmed NOT VFR). Root cause confirmed at
   the raw DOM level: `clip.components` AND the QE `qeClip` component list both show
   exactly 3 entries (`AE.ADBE Opacity`, `AE.ADBE Motion`, `AE.ADBE Lumetri`) — no Time
   Remapping component, on any clip, even after manually enabling Time Remapping on the
   clip via the Premiere UI first (ruled out the "lazy instantiation" theory). QE's
   `qeClip.speed` also stays `1` throughout. Conclusion: Premiere 26.3.0's scripting API
   (standard DOM and QE DOM both) does not expose a scriptable Time Remapping / ramp
   handle at all — the whole `_findRampTarget()` component-walk approach this tool and
   the folded-in CutPilot-AI code relied on is a dead end on this Premiere build, not a
   calibration or naming bug. See [[speed-ramp-premiere-bridge]] for what to try next
   (UI-automation drag via computer-use, or check if UXP's DOM exposes this differently).
   Test artifact left in project: sequence "GX018683 - ramp test" (untouched, no ramp
   applied, safe to ignore or delete).
2. **CEP→UXP = one-file swap now.** Transport lives behind `src/bridge/adapters/`
   (HostAdapter contract → `cep-ws-adapter.js` active, `uxp-adapter.js` skeleton with
   build guide). AdobeBridge is a facade; MCP servers/recipes/graders are transport-
   agnostic. Protocol contract: `docs/host-adapter-protocol.md`. Switch per app via
   `BRIDGE_ADAPTER_PREMIERE=uxp` or `adapters:{premiere:'uxp'}`. Key UXP fact: connection
   direction inverts (Node hosts the WS server, UXP plugin dials out); frames + internal
   commands (`_info`, `_jobStatus`, async jobs…) stay identical.
3. **Bugfix found by the loopback tests:** adapter `disconnect()` now stops the
   infinite reconnect loop + rejects in-flight requests; reconnect timers are unref'd so
   they can't pin the process open.

---

## ⚠️ BRIDGE BUGS — READ BEFORE TOUCHING ANYTHING (state as of 2026-05-21)

### FIXED in this repo (verified working)
1. **Silent-simulation fallback** (`src/bridge/adobe-bridge.js` line ~172) — when WS dropped, bridge returned fake responses instead of throwing. **Now throws hard** with reconnect state. This was the #1 friction source.
2. **`timeline.addClip` ignored inPoint/outPoint/startTime** (`src/extendscript/premiere/premiere-bridge.jsx` line ~194) — was passing seconds where ticks were required, mediaType=1 (audio) instead of 4 (audio+video), and number instead of String for ticks. All three fixed. Verified: 5s slice inserted at t=15s placed correctly.
3. **`timeline.create` hangs on missing preset** (`src/extendscript/premiere/premiere-bridge.jsx` line ~109) — default preset path pointed at a 9×16 30fps file; when missing, Premiere popped a modal that blocked the WS reply forever. **Now validates preset file existence first**, searches installed Premiere versions (2026→2023) for a matching .sqpreset via `_findDefaultPreset()`, fails fast with actionable error if none found.

### KNOWN BUG — UNFIXED
4. **Parallel `timeline.addClip` leaves 1-frame strays** at ripple boundaries when prior clip's end doesn't perfectly align with next clip's start (frame-quantization to 60fps grid). Workaround: insert sequentially, OR run a post-pass that snaps adjacent clips together. Observed twice in the May 21 Florida Fishing run.
7. **`timeline.addClip` ignores `inPoint`/`outPoint` when the project item has lingering in/out from prior sessions.** Bridge inserts the project item's CURRENT in/out instead of the requested values. Observed 2026-05-22 with GX018675: requested in=7.37/out=17.38 (10s), got in=19.98/out=40.98 (21s — leftover from a prior session that placed this clip at 19.98–40.98). Fix needed: handler must force `projectItem.setInPoint(requestedIn)` + `setOutPoint(requestedOut)` BEFORE every `track.insertClip()`, not rely on whatever state the project item carries.
8. **`edit.addText` lies** — handler returns "Added text at Ns" but V2 stays empty. Observed 2026-05-22. Need to inspect the Essential Graphics insertion path; probably failing silently inside a try/catch that returns success regardless.
9. **`timeline.addClip` second-call-per-session silently fails** — first addClip lands, subsequent calls in the same session return success but don't actually add. Observed 2026-05-22. Likely related to lingering project item state across calls.
10. **Bridge handler set is non-deterministic across panel restarts.** Same session, different points in time: `edit.deleteClip` and `timeline.duplicate` swung from working → "Unknown command". The CEP extension appears to load DIFFERENT JSX content based on panel close/reopen cycles, even though the manifest points to one file. Suspicion: CEP caches parsed JSX and stale cache wins over re-eval. Need: a startup diagnostic the panel logs ("JSX vN loaded with handlers: [...]") so we know which JSX is live before depending on a handler. Add to bridge backlog as P0 — the entire workflow is fragile until handler availability is predictable.
11. **`color.applyLumetri` times out on full-timeline 4K grade.** Confirmed twice (2026-05-29) via `color_grade_preset` scope=full_timeline on the FL Story v3 + final-cut sequences (14–16 clips, 3840×2160). MCP request times out every time; bridge stays responsive afterward (project_get_info still answers), so it's the Lumetri apply loop blocking the WS reply, not a crash. WORKAROUND: apply grade manually (drop a Lumetri preset on an adjustment layer over V1), or try scope=selected_clips / per-clip. P1 bridge fix: chunk the apply + reply async like encodeSequence.
    - **FIX WRITTEN 2026-05-29 (needs Premiere restart to load JSX).** Root cause: `color-grader.js applyPreset` looped every clip with a SEPARATE `bridge.send('color.applyLumetri')` — one WS round-trip per clip — so 14-16 4K clips blew past the MCP tool-call timeout. Fix: new bridge handler **`color.applyTimelineGrade`** loops every clip on every video track INSIDE ExtendScript and replies once (single round-trip). `applyPreset` now calls it for scope=full_timeline; selected/range scopes still go per-clip. Also fixed a latent bug: handler read `params.basic`/`params.creative` but the server sends `{settings:{basic,creative}}` — now reads `params.settings || params` (so grades actually applied, not just an empty Lumetri). Shared logic extracted to `_applyLumetriToClip()`. MCP `color_grade_preset` now surfaces per-clip `failures[]`.
12. **`edit.deleteClip` with `clipIndex: -1` clears the WHOLE track in one call** (verified working 2026-05-29, premiere-live bridge). `trackIndex: 0` = V1, `trackIndex: 100` = A1 (≥100 → audioTracks[idx-100]); the server response mislabels A1 as "V101" but it DOES hit audio. Deleting a V1 clip does NOT remove linked A1 audio — clear both tracks separately. `timeline_clear_track` is NOT implemented on this bridge ("Unknown command: timeline.clearTrack").
14. **`edit.addText` is a silent no-op on premiere-live bridge (2026-05-29).** `edit_add_text` returns "Added text ... at 0s" but NO trackItem appears on the target track (V2 verified empty via timeline_get_state after two attempts). The handler claims success without creating an Essential Graphics/title clip. Also `premiere_eval` is dead on this bridge ("Unknown command: _eval" — MCP→bridge command-name mismatch), so can't introspect or add the title via raw ExtendScript either. Burned hook text must currently be added manually in Premiere (Essential Graphics → Text). P1 bridge fix.
    - **FIX WRITTEN 2026-05-29 (needs Premiere restart to load JSX).** Root cause: Premiere 2024+ removed the scripted plain-text title path — both `track.addTextClip` (native) and the QE `addTextClip` fallback fail/no-op in 2026. There is NO reliable API for raw scripted titles anymore. Fixes: (1) MCP `edit_add_text` wrapper NO LONGER lies — it returns the bridge's real `{added}` flag and, on failure, surfaces `method0/1/2Error`, `premiereVersion`, and a `hint` (with `isError:true`). (2) Bridge `edit.addText` gains **Method 0 = MOGRT import** via `seq.importMGT(mogrtPath, ticks, vidTrack, 0)` then writes the caption into the template's `Source Text` property — the only Adobe-supported scripted-title path in 2026. Pass `mogrtPath` (a .mogrt exported once from Essential Graphics) to `edit_add_text` for reliable burned-in captions; without it the tool now honestly reports failure instead of faking success. `premiere_eval`/`_eval` mismatch is the separate stale-JSX issue (#10) — the `_eval` handler exists in repo JSX and will work after restart.
13. **add_clip 1-frame-gap artifact + fix (2026-05-29).** `timeline_add_clip` trims the out-point ~1 frame short when `inPoint: 0` (e.g. out=19 → clip dur 18.9833); clips with `inPoint>0` keep the exact requested duration. If you place clips on a rounded start grid you get a 1-frame black gap at every cut. FIX: set each clip's `startTime` to the PREVIOUS clip's ACTUAL end (cumulative sum of real durations: in=0 clips lose 1 frame, in>0 clips are exact) → frame-accurate, zero gaps. This is the reliable deterministic-rebuild ("Path B") recipe.

### FIX WRITTEN, NOT YET DEPLOYED (2026-05-22)
6. **`edit.cut` razor hangs Premiere.** Old handler missed `app.enableQE()` (required in Premiere 2024+ before `qe.*` is reachable), passed ticks as a number instead of String, and only razored video (linked audio stays connected to the now-truncated video clip). Source jsx is fixed: handler now enables QE, uses String-coerced ticks, razors both V1 and A1 tracks via `qeSeq.getVideoTrackAt(idx).razor()` + `qeSeq.getAudioTrackAt(idx).razor()`. Returns `{videoCut, audioCut}` flags. Set `params.videoOnly: true` to suppress the audio razor.

**STATUS: fix is in source file but NOT loaded into running Premiere.** Panel-reload-via-Window-menu doesn't re-evaluate jsx (see "CEP PANEL RELOAD" note above). Needs full Premiere quit + reopen to take effect. Until then, every `edit.cut` call hangs Premiere and times out. Workaround for trim work in the meantime: deliver razor TCs as a manual shot list (see `~/Downloads/logs/2026-05-22_florida_cut_v4_razor_shotlist.md` for the Florida May 26 example).

### FIXED via duplicate-then-carve pattern (2026-05-21)
5. **Color grade bypass.** `timeline.addClip` resolves `mediaName` to the raw project item — bypassing any color grade / effects applied in the source sequence. **Workaround now shipped:** new tool `timeline_duplicate` clones a source sequence whole (Premiere's `sequence.clone()` preserves every effect/grade/transition/marker), then use `edit_delete_clip` to carve down to the desired range. **This is the mandatory pattern when the source is graded.** Per-clip copy-with-effects is not implemented; sequence-level clone is the reliable equivalent.

   **Agentic flow when source is graded:**
   ```
   1. timeline_duplicate(sourceName: "Florida Fishing May 2026", destName: "Rough Cut") → activates the clone with all grades intact
   2. edit_delete_clip(clipIndex: N, ripple: true) for each non-keeper clip in reverse order, OR clipIndex: -1 to clear a track
   3. (Future) edit_trim_clip to shrink individual clips to the desired slice range
   ```

### STALE FILE WARNING
- `/Users/teambuffalooutdoors/Documents/Adobe AI Editor/Adobe files/premiere-bridge.jsx` is an OLD copy missing `edit.deleteClip`, `edit.moveClip`, `timeline.setActive`, `timeline.clearTrack`. The panel loads from `src/extendscript/premiere/premiere-bridge.jsx`. If the panel ever switches paths, you'll silently regress. Either delete the `Adobe files/` copy or symlink it to `src/extendscript/...`.

### CEP PANEL RELOAD IS A FULL PREMIERE RESTART
**Window → Extensions → close + reopen does NOT re-evaluate jsx.** ExtendScript state persists across panel reopens in CEP. Verified 2026-05-22: after editing the `edit.cut` handler and asking Travis to "reload the panel", the new handler did not register — old behavior persisted. The diagnostic was calling `edit.cut` with an invalid `trackIndex: 99`: new code returns a fast error, old code hangs Premiere. Old code hung → reload didn't take.

**To actually pick up jsx changes:**
1. **Fully quit Premiere Pro** (Cmd+Q)
2. Reopen Premiere + the project
3. Reopen Claude AI Editor panel from Window → Extensions

This costs ~30 seconds and loses any unsaved timeline scrub state. Only do it when you have a real reason. For new MCP TOOL registrations (added to `premiere-server.js`), restart the Node MCP server too — kill the `node premiere-server.js` process and Claude Code will respawn.

---

## Active Projects
- **Florida Fishing May 26.prproj** (active 2026-05-21) — source sequence "Florida Fishing May 2026" (3840×2160, 41 clips, 1:30:03.95). Florida footage = camera 1 batch only (GX018651–GX018675, 25 clips, 35:42). Non-Florida: GX028xxx, GX038xxx, GX048xxx. "Rough Cut" sequence built 600.016s with 25 Florida slices + 2 single-frame strays at 407.99s and 599.99s. **Color grade was bypassed (bug #5)** — rebuild needed once `copyClipRange` exists. Decision log: `~/Downloads/logs/2026-05-21_141500_florida_fishing_may26_roughcut_decisions_v2.json`. The "nibble nibble nibble yeah" line (day 2 bridge fishing) needs manual timecode from Travis to be preserved precisely.
- **Tenex.prproj** — 4 source files, sequences: GX018648, GX018648_RoughCut_v1 (39 clips, ~9:33). Needs redo with style DNA + trends.
- **muzzleloader '26.prproj** — 5 reels built (REEL_01_TheShot through REEL_05_Reaction). YT Final is master long-form.
- **Wild Boar Hunt.prproj** — locked, no edits started.

## Bridge / Connection
- **MCP server**: `node src/mcp-servers/premiere-server.js` (registered as `premiere-pro` and `premiere-live` in `~/.claude.json`)
- **CEP panel**: must be open in Premiere → Window → Extensions → Claude AI Editor → confirms WS listening on port 8081
- **Auto-reconnect**: bridge retries every 3s (linear backoff to 15s), 20 attempts = ~5 min recovery window
- **Health check**: call `project_get_info` — returns instantly when bridge is alive

---

## CutPilot Weekly Trend Refresh — LIVE (routine confirmed 2026-05-21)

- **Routine ID:** `trig_01DzeFzowGt6GqgJu9udcAYJ` (claude.ai remote routine, NOT local scheduled-task)
- **Schedule:** Every Monday `0 13 * * 1` UTC = 9am ET. Next run: 2026-05-25.
- **Last fired:** 2026-05-18 13:12 UTC. ✅ Output present.
- **Source repo:** `https://github.com/CodeBuffalo0225/claude-ai-mcp-bridge`
- **Local cache:** `~/Documents/cutpilot-trends-cache/` — shallow clone, `git pull --ff-only` at start of each editing session for freshest data.
- **Read paths:**
  - Latest digest: `intelligence/notebooklm/YYYYMMDD_digest.txt` ← read this first, fastest synthesis
  - Per-platform JSON: `intelligence/trends/YYYYMMDD_HHMM_<platform>_trends.json` (youtube|tiktok|instagram|linkedin)
  - Skill audits: `intelligence/skill-audits/` (empty as of 2026-05-21)

### Trend Synthesis — Week of 2026-05-18 (apply to any edit until next Monday's refresh)

**Cross-platform shifts that change how I should edit:**

| Pattern | Platforms | Confidence | Application to Travis's fishing/hunting cuts |
|---|---|---|---|
| **Authentic > polished** | IG, TT, LI | HIGH | KEEP imperfect footage. Missed casts, gear failures, dead time on the beach are NOT cuts — they're the texture. "I caught no fish day 1" IS the hook for the day-2 payoff. Stop trimming to highlight-reel only. |
| **Reaction split-screen for unexpected catches** | TT | HIGH | The "nibble nibble nibble yeah" line on the Florida bridge is THE format — creator audio reaction + rod-bend visual on split. Bridge tool needed: `edit_reaction_split_screen`. |
| **Hook = burned text over opening selfie, then supercut, ≤20s** | IG | HIGH | Open shorts/reels with Travis on-camera + burned text hook ("Wait, did I just…"). Bridge tool needed: `edit_hook_burn_text_open`. |
| **Sub-60s educational format = fastest-growing on YouTube** | YT | HIGH | "How to fish a Florida bridge for snapper" sub-60s cut is its own asset, separate from the long-form. |
| **Repeatable series formats compound algorithmically** | TT | HIGH | "Catch State 5: Florida" framing. Each trip = numbered episode. Bridge tool: `edit_series_format_template`. |
| **Numbered list / Top 5 Reels outperform single-product** | IG | HIGH | "Top 3 fish I caught in Florida" = same footage, different cut. Bridge tool: `edit_numbered_list_countdown`. |
| **LinkedIn vertical 9:16 beating YouTube for B2B** | LI | HIGH | Brand-collab deliverables (BetterBoat, MoultrieMobile, PSE, Tenex) should ship a LinkedIn 9:16 cut, not just YouTube. Bridge tools: `edit_vertical_reframe_linkedin`, `edit_burned_captions_linkedin`. |
| **MeatEater-style conservation storytelling outperforms gear-only** | YT | HIGH | Add narration / on-cam moments about why the spot/species matters, not just "here's the fish." |
| **SHOT Show 2026 gear-reveal Shorts driving high CTR** | YT | HIGH | Bridge tool: `edit_product_spec_overlay`, `edit_rapid_product_cut` — useful for any sponsor gear reveal. |
| **Women-led hunting/fishing TT content fastest-growing sub-niche** | TT | HIGH | Editorial signal: if any female creators are in Travis's collab funnel, lean in. |

### Audio Pipeline — BUILT 2026-05-22 (deploy requires Premiere restart)
**End-to-end transcription works.** Three pieces:

1. **Bridge tool `export_clip_audio`** (registered in `src/mcp-servers/premiere-server.js`, handler in `src/extendscript/premiere/premiere-bridge.jsx`):
   - Takes `{sequenceName?, startSec, endSec, outputPath, preset?}` — exports a sequence range as audio-only WAV
   - Uses AME preset `Waveform Audio 48kHz 16-bit.epr` by default (whisper-optimal uncompressed PCM)
   - Saves/restores sequence in/out points, writes to sandbox-accessible path (e.g. `/tmp/clip.wav`)
   - Works on graded sequences — does NOT require Full Disk Access to /Volumes/Pro 3/

2. **Whisper helper `~/.local/bin/transcribe_wav.py`** (uses faster-whisper, already pip-installed):
   - `transcribe_wav.py <wav> --model base --search "nibble" --words` → JSON with matches[] + word-level timestamps
   - Models: tiny (75MB, fast, misheard "mutton snapper" as "modern sniper") → base (recommended) → small → medium → large-v3
   - Smoke test 2026-05-22: caught "nibble nibble nibble nibble yeah" with frame-accurate timestamps

3. **ffmpeg static binary** at `~/.local/bin/ffmpeg` (already installed) — used by whisper for audio decoding.

**Standard flow (next session, after Premiere restart):**
```
1. timeline_get_state → find candidate clip + timeline TC range
2. export_clip_audio(startSec=X, endSec=Y, outputPath="/tmp/find.wav")
3. bash: ~/.local/bin/transcribe_wav.py /tmp/find.wav --model base --search "<phrase>" --words
4. Parse matches[] → use timestamps to drive razor cuts / reel builds
```

**DEPLOYMENT (one-time, requires Premiere restart):**
1. Full quit Premiere (Cmd+Q)
2. Restart Claude Code (kills + respawns the MCP server with new `export_clip_audio` tool registration)
3. Reopen Premiere + project + Claude AI Editor panel
4. New tool + JSX handler are live.

### Audio Access — Older Backlog (Travis flagged 2026-05-22)
Bridge currently exposes timeline STRUCTURE only (names, TCs, durations, mediaPaths, markers). No audio data, no playback, no transcript. This forces Travis to manually find moments like "the nibble line" — bad UX, repeatedly hit this session.

Three ways to fix, in order of friction:

1. **Full Disk Access toggle** for Terminal/Claude Code (System Settings → Privacy → Full Disk Access). 15-second one-time enable. Then ffmpeg + faster-whisper (both installed 2026-05-22 at ~/.local/bin/ffmpeg) can read /Volumes/Pro 3/ source files and transcribe autonomously. Sandbox blocked this on 2026-05-22; until FDA is granted, source-clip audio analysis is impossible.

2. **New bridge tool `export_clip_audio`** — writes a clip range's audio to a sandbox-accessible WAV (~/Downloads/cache/). Then whisper transcribes locally. Doesn't require FDA. Build cost ~15 min + the same panel-reload-pain. Best for analyzing sequence content not just raw files.

3. **Premiere built-in Speech-to-Text trigger** — find Premiere's menu command ID for "Transcribe Sequence" via `app.menuCommands.id()`, fire via `app.executeCommand(id)`. Wait for completion (poll for caption track), read the captions. Most reliable but slowest to build and slowest to run (~1-2 min per sequence).

### Bridge Tool Gap Audit (from trends bridgeRelevant=TRUE flags)
Tools the trends say I should be able to perform that the bridge currently can't:

1. `edit_reaction_split_screen` — highest near-term value for fishing content
2. `edit_hook_burn_text_open` — opens any short/reel
3. `edit_vertical_reframe_linkedin` (9:16 with bias toward subject)
4. `edit_burned_captions_linkedin` (silent-autoplay requires every word on screen)
5. `edit_numbered_list_countdown`
6. `edit_series_format_template` (apply a saved template/lower-third to new episode)
7. `edit_cinematic_fast_cut` (treestand-style rapid intercut preset)
8. `edit_product_spec_overlay` / `edit_rapid_product_cut` (for sponsor gear segments)

When Travis says "build bridge features" — this list is the prioritized backlog, derived from real trend signals, not guesses.

### Pre-edit Checklist (run every session, in this order)
1. `cd ~/Documents/cutpilot-trends-cache && git pull --ff-only` — pull latest trends
2. Read the newest digest in `intelligence/notebooklm/`
3. Cross-reference current project's deliverable platform(s) against the trend matrix above
4. Bake at least 2–3 trend patterns into the cut plan BEFORE writing the decision log
5. Note `cutpilotFlag` on each clip selection — which trend signal motivated the pick (e.g., `cutpilotFlag: "reaction_split_format"`)

## Weekly Workflow (now actually working)
1. ✅ Monday 9am ET: CutPilot remote routine writes 4 platform JSONs + digest to GitHub
2. ✅ Cowork opens Adobe AI Editor + Premiere
3. ✅ Pre-edit: `git pull` the trends cache, read latest digest
4. ⚠️ CEP panel opened in Premiere → bridge connects on port 8081 (auto-reconnects, throws hard on drop now — no more silent simulation)
5. ✅ Phase 1 manifest → Phase 2 editorial **with trend signals** → Phase 3 cuts (use `timeline_duplicate` if source is graded) → review
6. ❌ Phase 4 export (untested via bridge in current session)

---

## Available Caption Styles (shorts-cutter.js)
minimal_white | bold_yellow | karaoke_highlight | word_by_word | boxed | gradient_bg | tiktok_style | hormozi_style | netflix_subtitle

## Available Color Presets (color-grader.js — 30+ presets)
- **Cinematic**: cinematic_teal_orange, cinematic_warm, cinematic_cold, blockbuster_action, indie_film, film_noir, vintage_film
- **YouTube**: youtube_vibrant, youtube_clean, youtube_warm_cozy, youtube_dark_moody
- **Social/Outdoor**: instagram_aesthetic (+ more)

---

## Hard Rules
1. **Never simulate bridge calls.** Throw on disconnect. (Bug #1 — fixed in code; never reintroduce.)
2. **Never edit the source sequence.** Always duplicate or write to a new target.
3. **Check whether source is graded** before placing raw project-bin clips. Warn the user before bypassing grade. (Bug #5 — design gap.)
4. **Reload the CEP panel** after any .jsx edit. New handlers don't auto-register.
5. **Write the decision log BEFORE Phase 4 execution.** Rationale is the product, not just the cut.
6. **Reels: muted-first**, ≤8 word captions, hormozi or minimal_white style, 10–25s.
7. **Use sequential `timeline.addClip` for >5 clips** to avoid the 1-frame stray bug (#4), OR plan a cleanup pass.

---

## Session Learnings Log

### 2026-05-21 — Florida Fishing May 26
- Bridge had THREE real bugs (#1, #2, #3 above) blocking the agentic flow. All fixed in code this session.
- Color grade was bypassed because addClip pulled from project bin, not the graded source sequence. Travis flagged this as the editorial regression. Bug #5 logged.
- Parallel inserts left 1-frame strays at clip boundaries (bug #4). Sequential inserts recommended for production cuts.
- "Florida footage" ambiguity: same disk folder contained camera batches from multiple trips. Filenames (GX01xxx vs GX02xxx vs GX03xxx vs GX04xxx) correspond to different camera sessions, not necessarily the same shoot. Always confirm with Travis which batch = current project before scoring.
- No CutPilot trends file exists. Decision log flagged the gap. Routine needs creation.

### 2026-05-29 — "final cut" long-form recipe (Team Buffalo Outdoors YouTube)
Built the engagement-optimized long-form for Florida May 26 ("final cut", 9:41, 4K60). Reusable LONG-FORM recipe, derived from CutPilot 2026-05-25 digest (all HIGH confidence):
- **Cold-open teaser FIRST (~10-15s):** 3-second pattern-interrupt beats up front — the money moments (here: all 3 fish hookups) cut fast, BEFORE any intro. Trend: dramatic-shot openers > talking-head → >70% completion. This is the "promise."
- **Burned text hook over the teaser** (`edit_add_text`, V2, scale_pop, ~130px @4K): 85% watch muted; text carries the hook. Used "3 FISH. 1 BRIDGE."
- **Then chronological story = the payoff:** keep the authentic skunk (Day 1 beach, no fish) as SETUP — do NOT trim it to a highlight reel; it earns the Day 2 payoff. Deliver the full catches the teaser promised.
- **Emotional close** on the last beat (here: nibble line + calm outro).
- **Grade:** `youtube_vibrant` is the trend pick for YT long-form (currently must be applied manually — see bug #11).
- Find real reaction beats by mapping the full-sequence Whisper transcript (/tmp/fl_clean.json) timestamps back to source clips via each clip's sequence-start offset. Cold opens that land on actual "fish on!" audio beat guessed slices every time.
- Map of source money moments (Florida May 26): Fish#1 "fish on" = GX018658 src ~117s; Fish#2 "Crevalle Jack" reveal = GX018667 src ~25s; Fish#3 "we got himself a meal" = GX018669 src ~45s; nibble line = GX018675 src 0-34s.
