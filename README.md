# 🎬 Adobe MCP Editor — Claude Code AI Video Editor

> **AI-powered video editing via Claude Code** — MCP Bridge to Adobe Premiere Pro & After Effects with intelligent editing, color grading, sound engineering, and automated shorts creation.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Claude Code (CLI)                                             │
│     ↕  MCP Protocol (stdio)                                    │
│   ┌──────────────────────┐  ┌────────────────────────┐         │
│   │  Premiere Pro MCP    │  │  After Effects MCP     │         │
│   │  Server (40+ tools)  │  │  Server (30+ tools)    │         │
│   └──────────┬───────────┘  └──────────┬─────────────┘         │
│              ↕ WebSocket                ↕ WebSocket              │
│   ┌──────────────────────┐  ┌────────────────────────┐         │
│   │  CEP Bridge Panel    │  │  CEP Bridge Panel      │         │
│   │  (inside Premiere)   │  │  (inside After Effects) │         │
│   └──────────┬───────────┘  └──────────┬─────────────┘         │
│              ↕ ExtendScript             ↕ ExtendScript           │
│   ┌──────────────────────┐  ┌────────────────────────┐         │
│   │  Adobe Premiere Pro  │  │  Adobe After Effects   │         │
│   │  DOM / QE DOM        │  │  DOM / Scripting API   │         │
│   └──────────────────────┘  └────────────────────────┘         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install

```bash
git clone <repo-url> adobe-mcp-editor
cd adobe-mcp-editor
npm install
```

### 2. Install CEP Bridge Panels in Adobe Apps

```bash
# Copy CEP panels to Adobe extensions directory

# macOS:
cp -r src/bridge/cep-panel ~/Library/Application\ Support/Adobe/CEP/extensions/claude-ai-editor/

# Windows:
copy src\bridge\cep-panel "%APPDATA%\Adobe\CEP\extensions\claude-ai-editor\"
```

Enable unsigned extensions in debug mode:
- **macOS**: `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`
- **Windows**: Registry → `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.11` → set `PlayerDebugMode` to `1`

### 3. Configure Claude Code

Add the MCP servers to your Claude Code config:

```bash
# Open Claude Code settings
claude config
```

Add to your MCP servers configuration:

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "node",
      "args": ["src/mcp-servers/premiere-server.js"],
      "cwd": "/path/to/adobe-mcp-editor"
    },
    "after-effects": {
      "command": "node",
      "args": ["src/mcp-servers/aftereffects-server.js"],
      "cwd": "/path/to/adobe-mcp-editor"
    }
  }
}
```

### 4. Open Adobe Apps & Enable the Bridge

1. Open **Premiere Pro** → Window → Extensions → **Claude AI Editor Bridge**
2. Open **After Effects** → Window → Extensions → **Claude AI Editor Bridge**
3. Both should show "Waiting for MCP server connection..."

### 5. Start Editing with Claude Code

```bash
claude
```

Then ask Claude to edit your video:

```
> Open my project at /Videos/MyProject.prproj and give me a full
  YouTube-style edit with a 5-second hook, remove all dead air,
  add zoom-ins on highlights, and color grade with cinematic teal/orange.
```

---

## 🎛️ Available Tools (70+)

### Premiere Pro MCP Server

#### Project Management
| Tool | Description |
|------|-------------|
| `project_open` | Open a .prproj file |
| `project_create` | Create new project with presets (YouTube 1080p/4K, Shorts, etc.) |
| `project_get_info` | Get full project info — sequences, bins, media |
| `project_save` | Save / Save As |
| `project_import_media` | Import video, audio, images into bins |

#### Timeline
| Tool | Description |
|------|-------------|
| `timeline_create` | Create sequence with custom resolution/framerate |
| `timeline_get_state` | Get all clips, tracks, markers, settings |
| `timeline_add_clip` | Add media to timeline at specific position |
| `timeline_set_playhead` | Move playhead to timecode |
| `timeline_add_marker` | Add colored markers with comments |

#### Editing
| Tool | Description |
|------|-------------|
| `edit_cut` | Razor cut at specific time |
| `edit_trim` | Trim in/out points |
| `edit_delete_clip` | Delete with ripple or gap |
| `edit_move_clip` | Move clips between tracks/positions |
| `edit_speed_duration` | Speed ramp, slow-mo, reverse |
| `edit_add_transition` | Cross dissolve, morph cut, wipe, etc. |
| `edit_add_text` | Essential Graphics text with animation |
| `edit_set_opacity` | Opacity with keyframe animation |
| `edit_set_scale_position` | Motion: scale, position, rotation with keyframes |
| `edit_apply_effect` | Apply any video/audio effect |

#### AI-Powered Editing
| Tool | Description |
|------|-------------|
| `ai_auto_edit` | **Full automated edit** — hooks, pacing, cuts, zoom-ins, text overlays |
| `ai_detect_highlights` | Find best moments — energy, laughter, key phrases |
| `ai_generate_hook` | Create cold open, teaser montage, question hook |
| `ai_remove_silence` | Smart dead air removal with breath preservation |
| `ai_beat_sync` | Sync video cuts to music beats/BPM |
| `ai_face_tracking_zoom` | Auto-zoom and reframe on faces |

#### Color Grading
| Tool | Description |
|------|-------------|
| `color_apply_lut` | Apply .cube LUT files |
| `color_grade_preset` | 30+ presets (cinematic, YouTube, social, documentary) |
| `color_manual_grade` | Full Lumetri: temperature, curves, wheels, vignette |
| `color_match` | Match color between clips |
| `color_auto_correct` | Auto white balance & exposure correction |

#### Sound Engineering
| Tool | Description |
|------|-------------|
| `audio_normalize` | LUFS-targeted loudness normalization |
| `audio_denoise` | Remove hiss, hum, wind, room tone |
| `audio_eq` | Parametric EQ with presets (voice, podcast, music) |
| `audio_compress` | Dynamic range compression presets |
| `audio_add_music` | Background music with auto-ducking |
| `audio_add_sfx` | Sound effects library (whoosh, impact, etc.) |
| `audio_master` | **Full mastering chain** — EQ, compress, limit, normalize |

#### Shorts Cutter
| Tool | Description |
|------|-------------|
| `shorts_auto_detect` | AI-find best short moments from long-form video |
| `shorts_create` | Create vertical short with reframe, captions, hook |
| `shorts_add_captions` | Animated captions (Hormozi, TikTok, karaoke styles) |
| `shorts_batch_create` | Create multiple shorts at once |

#### Export
| Tool | Description |
|------|-------------|
| `export_media` | Export via Media Encoder (YouTube, ProRes, etc.) |
| `export_frame` | Export still frame for thumbnails |

---

### After Effects MCP Server

#### Compositions & Layers
| Tool | Description |
|------|-------------|
| `ae_comp_create` | Create compositions |
| `ae_add_layer` | Add footage, solid, shape, text, null, adjustment, camera, light |
| `ae_layer_transform` | Set position, scale, rotation, opacity |
| `ae_apply_effect` | Apply any AE effect |
| `ae_set_layer_blending` | Blend modes and track mattes |

#### Animation
| Tool | Description |
|------|-------------|
| `ae_add_keyframe` | Keyframe any property with easing |
| `ae_add_expression` | JavaScript expressions for procedural animation |
| `ae_animate_preset` | 30+ animation presets (fade, slide, bounce, glitch, etc.) |

#### Titles & Intros
| Tool | Description |
|------|-------------|
| `ae_create_intro` | **16 intro styles** — minimal, glitch, neon, cinematic, particle, etc. |
| `ae_create_lower_third` | 8 lower third styles |
| `ae_create_end_screen` | YouTube end screens with subscribe + video slots |
| `ae_create_transition` | 15 custom transition types |

#### VFX
| Tool | Description |
|------|-------------|
| `ae_green_screen` | Chroma key (green/blue screen) |
| `ae_motion_track` | Motion tracking with target linking |
| `ae_particle_system` | Particles (confetti, sparks, snow, fire, etc.) |

#### Dynamic Link
| Tool | Description |
|------|-------------|
| `ae_dynamic_link_to_premiere` | Send AE comp to Premiere timeline |
| `ae_replace_with_ae_comp` | Replace Premiere clip with AE composition |

---

## 💬 Example Claude Code Conversations

### Full YouTube Edit
```
> I have raw footage at /Videos/raw-interview.mp4. Create a YouTube video:
  1. Import it and create a 1080p 30fps sequence
  2. Remove all dead air and silence
  3. Create a 5-second cold open hook from the best moment
  4. Add zoom-ins on 8-10 highlight moments
  5. Color grade with "youtube_vibrant" preset
  6. Master the audio for YouTube (-14 LUFS)
  7. Add background music with auto-ducking
  8. Export as YouTube 1080p H.264
```

### Create Shorts from Long Video
```
> Analyze my 30-minute video on the timeline and find the 5 best
  moments for YouTube Shorts. Create each one with:
  - Auto face-tracking reframe to vertical
  - Hormozi-style animated captions
  - A hook text in the first 3 seconds
  - Export all as 1080x1920
```

### Cinematic Color Grade
```
> Color grade the entire timeline:
  - Apply cinematic teal & orange at 70% intensity
  - Add a subtle vignette
  - Boost shadows slightly for a faded film look
  - Match all clips to the first one
```

### Professional Audio
```
> Fix the audio on my podcast:
  - Remove background hiss and room tone
  - Apply broadcast voice EQ
  - Compress with podcast_standard preset
  - Normalize to -16 LUFS
  - Add the intro music at /Audio/intro.mp3 with auto-ducking
```

### Create Intro in After Effects
```
> Create a 5-second channel intro for "TechInsider":
  - Style: glitch_tech
  - Colors: primary #00FF88, background #0A0A0A
  - Include the logo at /Assets/logo.png
  - Tagline: "The Future, Explained"
  - Dynamic link it to the beginning of my Premiere timeline
```

---

## 🎨 Color Grading Presets

**Cinematic**: teal_orange, warm, cold, desaturated, blockbuster_action, indie_film, film_noir, vintage_film

**YouTube**: vibrant, clean, warm_cozy, dark_moody

**Social**: instagram_aesthetic, tiktok_punchy, pastel_dream, neon_glow

**Documentary**: natural, dramatic, black_and_white

**Mood**: golden_hour, blue_hour, summer_vibes, winter_cold

**Technical**: rec709_standard, slog3_to_rec709, vlog_to_rec709, hdr_to_sdr

---

## 🔊 Audio Presets

**EQ**: voice_clarity, voice_deep, voice_bright, voice_broadcast, podcast_standard, podcast_intimate, music_balanced, music_reduce_for_voiceover, de_ess, de_plosive

**Compression**: voice_gentle, voice_aggressive, voice_broadcast, music_light, music_heavy, music_limiter, podcast_standard, youtube_standard

**Mastering Targets**: YouTube (-14 LUFS), Podcast (-16 LUFS), Broadcast (-24 LUFS), Streaming (-14 LUFS), Cinema (-27 LUFS)

---

## 📁 Project Structure

```
adobe-mcp-editor/
├── src/
│   ├── index.js                       # Main entry point
│   ├── mcp-servers/
│   │   ├── premiere-server.js         # Premiere Pro MCP (40+ tools)
│   │   └── aftereffects-server.js     # After Effects MCP (30+ tools)
│   ├── bridge/
│   │   ├── adobe-bridge.js            # WebSocket communication layer
│   │   └── cep-panel.html             # CEP panel (runs inside Adobe apps)
│   ├── ai-editor/
│   │   └── editor-engine.js           # AI editing intelligence
│   ├── color-grading/
│   │   └── color-grader.js            # 30+ color presets + manual controls
│   ├── sound-engineering/
│   │   └── sound-engineer.js          # EQ, compression, mastering
│   ├── shorts-cutter/
│   │   └── shorts-cutter.js           # Vertical content creation
│   ├── extendscript/
│   │   ├── premiere/
│   │   │   └── premiere-bridge.jsx    # Premiere Pro ExtendScript API
│   │   └── aftereffects/
│   │       └── ae-bridge.jsx          # After Effects ExtendScript API
│   └── utils/
│       └── logger.js                  # Color-coded logging
├── config/
│   └── claude_code_config.json        # Claude Code MCP configuration
├── dashboard/                         # Status dashboard (optional)
├── package.json
└── README.md
```

---

## 🔧 How It Works

### Architecture

1. **Claude Code** communicates with MCP servers via **stdio** (Model Context Protocol)
2. MCP servers translate tool calls into commands sent over **WebSocket**
3. **CEP Bridge Panels** running inside Adobe apps receive WebSocket messages
4. CEP panels execute commands via **ExtendScript** in Premiere Pro/After Effects DOM
5. Results flow back through the same chain to Claude Code

### Communication Flow

```
Claude Code → (stdio) → MCP Server → (WebSocket) → CEP Panel → (ExtendScript) → Adobe App
                                                                                       ↓
Claude Code ← (stdio) ← MCP Server ← (WebSocket) ← CEP Panel ← (ExtendScript) ← Result
```

### Simulation Mode

When Adobe apps aren't connected, the bridge operates in **simulation mode** with realistic mock responses. This allows development and testing of the MCP tools without running Adobe applications.

---

## 📋 Requirements

- **Node.js** 18+
- **Adobe Premiere Pro** 2024+
- **Adobe After Effects** 2024+
- **Claude Code** (latest)
- CEP extensions enabled (debug mode)

---

## 📄 License

MIT
