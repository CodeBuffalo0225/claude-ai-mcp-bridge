import { useState } from "react";

const TOOLS = {
  "Premiere Pro": {
    "Project": ["project_open", "project_create", "project_get_info", "project_save", "project_import_media"],
    "Timeline": ["timeline_create", "timeline_get_state", "timeline_add_clip", "timeline_set_playhead", "timeline_add_marker"],
    "Editing": ["edit_cut", "edit_trim", "edit_delete_clip", "edit_move_clip", "edit_speed_duration", "edit_add_transition", "edit_add_text", "edit_set_opacity", "edit_set_scale_position", "edit_apply_effect"],
    "AI Editing": ["ai_auto_edit", "ai_detect_highlights", "ai_generate_hook", "ai_remove_silence", "ai_beat_sync", "ai_face_tracking_zoom"],
    "Color Grading": ["color_apply_lut", "color_grade_preset", "color_manual_grade", "color_match", "color_auto_correct"],
    "Sound Engineering": ["audio_normalize", "audio_denoise", "audio_eq", "audio_compress", "audio_add_music", "audio_add_sfx", "audio_master"],
    "Shorts Cutter": ["shorts_auto_detect", "shorts_create", "shorts_add_captions", "shorts_batch_create"],
    "Export": ["export_media", "export_frame"]
  },
  "After Effects": {
    "Project": ["ae_project_open", "ae_project_create", "ae_import_footage"],
    "Compositions": ["ae_comp_create", "ae_comp_get_info"],
    "Layers": ["ae_add_layer", "ae_layer_transform", "ae_apply_effect", "ae_set_layer_blending"],
    "Animation": ["ae_add_keyframe", "ae_add_expression", "ae_animate_preset"],
    "Titles & Intros": ["ae_create_intro", "ae_create_lower_third", "ae_create_end_screen", "ae_create_transition"],
    "VFX": ["ae_green_screen", "ae_motion_track", "ae_particle_system"],
    "Dynamic Link": ["ae_dynamic_link_to_premiere", "ae_replace_with_ae_comp"],
    "Render": ["ae_render"]
  }
};

const COLOR_PRESETS = [
  { name: "Cinematic Teal & Orange", cat: "Cinematic" },
  { name: "Blockbuster Action", cat: "Cinematic" },
  { name: "Film Noir", cat: "Cinematic" },
  { name: "Vintage Film", cat: "Cinematic" },
  { name: "YouTube Vibrant", cat: "YouTube" },
  { name: "YouTube Dark & Moody", cat: "YouTube" },
  { name: "TikTok Punchy", cat: "Social" },
  { name: "Instagram Aesthetic", cat: "Social" },
  { name: "Golden Hour", cat: "Mood" },
  { name: "Winter Cold", cat: "Mood" },
];

const AUDIO_CHAIN = ["High-Pass 80Hz", "EQ (Voice Clarity)", "Compressor", "De-Esser", "Limiter -1dB", "Loudness -14 LUFS"];

const CAPTION_STYLES = ["hormozi_style", "karaoke_highlight", "word_by_word", "tiktok_style", "bold_yellow", "minimal_white", "boxed", "netflix_subtitle"];

const INTRO_STYLES = ["modern_minimal", "glitch_tech", "neon_glow", "cinematic_epic", "particle_burst", "holographic", "3d_flip", "smoke_reveal"];

const catColors = {
  "Project": "#6366f1",
  "Timeline": "#8b5cf6",
  "Editing": "#a855f7",
  "AI Editing": "#f43f5e",
  "Color Grading": "#f59e0b",
  "Sound Engineering": "#10b981",
  "Shorts Cutter": "#06b6d4",
  "Export": "#64748b",
  "Compositions": "#8b5cf6",
  "Layers": "#a855f7",
  "Animation": "#ec4899",
  "Titles & Intros": "#f43f5e",
  "VFX": "#f59e0b",
  "Dynamic Link": "#06b6d4",
  "Render": "#64748b",
};

export default function Dashboard() {
  const [activeApp, setActiveApp] = useState("Premiere Pro");
  const [activeCategory, setActiveCategory] = useState(null);
  const [view, setView] = useState("tools");

  const apps = Object.keys(TOOLS);
  const categories = Object.keys(TOOLS[activeApp]);
  const totalTools = Object.values(TOOLS).flatMap(app => Object.values(app).flat()).length;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0f",
      color: "#e2e8f0",
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    }}>
      {/* Header */}
      <div style={{
        borderBottom: "1px solid #1e1e2e",
        padding: "20px 32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "linear-gradient(180deg, #0f0f1a 0%, #0a0a0f 100%)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: "linear-gradient(135deg, #f43f5e, #8b5cf6)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, fontWeight: "bold",
          }}>🎬</div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: "-0.5px" }}>
              Adobe MCP Editor
            </h1>
            <p style={{ fontSize: 11, color: "#64748b", margin: 0, marginTop: 2 }}>
              Claude Code AI Video Editor — Premiere Pro + After Effects
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["tools", "presets", "architecture"].map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid",
              borderColor: view === v ? "#8b5cf6" : "#1e1e2e",
              background: view === v ? "#8b5cf620" : "transparent",
              color: view === v ? "#c4b5fd" : "#64748b",
              cursor: "pointer", fontSize: 11, fontFamily: "inherit",
              textTransform: "uppercase", letterSpacing: "0.5px",
            }}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Bar */}
      <div style={{
        display: "flex", gap: 1, padding: "0 32px", marginTop: 20,
      }}>
        {[
          { label: "Total Tools", value: totalTools, color: "#8b5cf6" },
          { label: "Premiere Tools", value: Object.values(TOOLS["Premiere Pro"]).flat().length, color: "#f43f5e" },
          { label: "AE Tools", value: Object.values(TOOLS["After Effects"]).flat().length, color: "#06b6d4" },
          { label: "Color Presets", value: "30+", color: "#f59e0b" },
          { label: "Audio Presets", value: "20+", color: "#10b981" },
          { label: "Intro Styles", value: "16", color: "#ec4899" },
        ].map((stat, i) => (
          <div key={i} style={{
            flex: 1, padding: "14px 16px",
            background: "#111118",
            borderLeft: i === 0 ? "none" : "1px solid #1a1a2e",
            borderRadius: i === 0 ? "10px 0 0 10px" : i === 5 ? "0 10px 10px 0" : 0,
          }}>
            <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: stat.color, marginTop: 4 }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: "20px 32px" }}>
        {view === "tools" && (
          <>
            {/* App Tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              {apps.map(app => (
                <button key={app} onClick={() => { setActiveApp(app); setActiveCategory(null); }} style={{
                  padding: "10px 20px", borderRadius: 8, border: "1px solid",
                  borderColor: activeApp === app ? (app === "Premiere Pro" ? "#f43f5e" : "#06b6d4") : "#1e1e2e",
                  background: activeApp === app ? (app === "Premiere Pro" ? "#f43f5e15" : "#06b6d415") : "#111118",
                  color: activeApp === app ? "#fff" : "#94a3b8",
                  cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
                }}>
                  {app === "Premiere Pro" ? "🎞️" : "✨"} {app}
                </button>
              ))}
            </div>

            {/* Category Grid */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}>
              {categories.map(cat => {
                const tools = TOOLS[activeApp][cat];
                const isActive = activeCategory === cat;
                const color = catColors[cat] || "#8b5cf6";
                return (
                  <div key={cat} onClick={() => setActiveCategory(isActive ? null : cat)} style={{
                    background: "#111118",
                    border: `1px solid ${isActive ? color : "#1a1a2e"}`,
                    borderRadius: 10, padding: 16, cursor: "pointer",
                    transition: "all 0.15s",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color }}>
                        {cat}
                      </h3>
                      <span style={{
                        fontSize: 10, color: "#64748b", background: "#1a1a2e",
                        padding: "2px 8px", borderRadius: 10,
                      }}>
                        {tools.length} tools
                      </span>
                    </div>
                    <div style={{
                      marginTop: 12, display: "flex", flexWrap: "wrap", gap: 4,
                      maxHeight: isActive ? 400 : 80, overflow: "hidden",
                      transition: "max-height 0.3s",
                    }}>
                      {tools.map(tool => (
                        <span key={tool} style={{
                          fontSize: 10, padding: "3px 8px", borderRadius: 4,
                          background: `${color}15`, color: `${color}cc`,
                          border: `1px solid ${color}30`,
                          whiteSpace: "nowrap",
                        }}>
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view === "presets" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
            {/* Color Grading */}
            <div style={{ background: "#111118", borderRadius: 12, padding: 20, border: "1px solid #1a1a2e" }}>
              <h3 style={{ fontSize: 14, color: "#f59e0b", marginBottom: 16 }}>🎨 Color Grading</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {COLOR_PRESETS.map((p, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 12px", background: "#0a0a12", borderRadius: 6,
                  }}>
                    <span style={{ fontSize: 11 }}>{p.name}</span>
                    <span style={{
                      fontSize: 9, padding: "2px 6px", borderRadius: 4,
                      background: "#f59e0b20", color: "#f59e0b",
                    }}>{p.cat}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Audio Mastering */}
            <div style={{ background: "#111118", borderRadius: 12, padding: 20, border: "1px solid #1a1a2e" }}>
              <h3 style={{ fontSize: 14, color: "#10b981", marginBottom: 16 }}>🔊 Audio Mastering Chain</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {AUDIO_CHAIN.map((step, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: "50%",
                      background: "#10b98130", color: "#10b981",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 700, flexShrink: 0,
                    }}>{i + 1}</div>
                    <div style={{
                      flex: 1, padding: "10px 14px", background: "#0a0a12",
                      borderRadius: 6, fontSize: 11, borderLeft: "2px solid #10b981",
                    }}>{step}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>TARGETS</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {["YouTube -14", "Podcast -16", "Broadcast -24", "Cinema -27"].map(t => (
                    <span key={t} style={{
                      fontSize: 10, padding: "4px 10px", borderRadius: 4,
                      background: "#10b98115", color: "#10b981", border: "1px solid #10b98130",
                    }}>{t} LUFS</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Captions & Intros */}
            <div style={{ background: "#111118", borderRadius: 12, padding: 20, border: "1px solid #1a1a2e" }}>
              <h3 style={{ fontSize: 14, color: "#ec4899", marginBottom: 16 }}>✏️ Caption Styles</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
                {CAPTION_STYLES.map(s => (
                  <span key={s} style={{
                    fontSize: 10, padding: "5px 10px", borderRadius: 6,
                    background: "#ec489915", color: "#ec4899", border: "1px solid #ec489930",
                  }}>{s}</span>
                ))}
              </div>
              <h3 style={{ fontSize: 14, color: "#f43f5e", marginBottom: 12 }}>🎬 Intro Styles</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {INTRO_STYLES.map(s => (
                  <span key={s} style={{
                    fontSize: 10, padding: "5px 10px", borderRadius: 6,
                    background: "#f43f5e15", color: "#f43f5e", border: "1px solid #f43f5e30",
                  }}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {view === "architecture" && (
          <div style={{
            background: "#111118", borderRadius: 12, padding: 32,
            border: "1px solid #1a1a2e", fontFamily: "'JetBrains Mono', monospace",
          }}>
            <h3 style={{ fontSize: 14, marginBottom: 24, color: "#c4b5fd" }}>System Architecture</h3>
            <pre style={{
              fontSize: 12, lineHeight: 1.7, color: "#94a3b8",
              whiteSpace: "pre", overflow: "auto",
            }}>{`
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │   ┌────────────────────┐                                     │
  │   │   Claude Code CLI  │  ← You type editing commands here   │
  │   └────────┬───────────┘                                     │
  │            │ stdio (MCP Protocol)                             │
  │            ↓                                                  │
  │   ┌────────────────────────────────────────────┐             │
  │   │         MCP Server Layer (Node.js)         │             │
  │   │                                            │             │
  │   │  ┌──────────────┐  ┌───────────────────┐   │             │
  │   │  │ Premiere MCP │  │ After Effects MCP │   │             │
  │   │  │  (40+ tools) │  │    (30+ tools)    │   │             │
  │   │  └──────┬───────┘  └────────┬──────────┘   │             │
  │   │         │                   │               │             │
  │   │  ┌──────┴───────────────────┴──────────┐   │             │
  │   │  │         Shared Modules              │   │             │
  │   │  │  ┌───────────┐ ┌──────────────┐     │   │             │
  │   │  │  │ AI Editor │ │ Color Grader │     │   │             │
  │   │  │  └───────────┘ └──────────────┘     │   │             │
  │   │  │  ┌───────────────┐ ┌────────────┐   │   │             │
  │   │  │  │Sound Engineer │ │Shorts Cut  │   │   │             │
  │   │  │  └───────────────┘ └────────────┘   │   │             │
  │   │  └─────────────────────────────────────┘   │             │
  │   └────────────────────┬───────────────────────┘             │
  │                        │ WebSocket                            │
  │                        ↓                                      │
  │   ┌────────────────────────────────────────────┐             │
  │   │       CEP Bridge Panels (in Adobe apps)    │             │
  │   │                                            │             │
  │   │  ┌──────────────┐  ┌───────────────────┐   │             │
  │   │  │  Premiere     │  │  After Effects    │   │             │
  │   │  │  Bridge Panel │  │  Bridge Panel     │   │             │
  │   │  └──────┬───────┘  └────────┬──────────┘   │             │
  │   └─────────┼───────────────────┼──────────────┘             │
  │             │ ExtendScript      │ ExtendScript                │
  │             ↓                   ↓                             │
  │   ┌──────────────┐  ┌───────────────────┐                    │
  │   │ Premiere Pro │  │  After Effects    │                    │
  │   │   DOM API    │  │    DOM API        │                    │
  │   └──────────────┘  └───────────────────┘                    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
`}</pre>
            <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                { label: "MCP Protocol", desc: "stdio transport between Claude Code and servers", color: "#8b5cf6" },
                { label: "WebSocket", desc: "Real-time bridge to CEP panels in Adobe apps", color: "#06b6d4" },
                { label: "ExtendScript", desc: "Adobe's scripting engine (ES3-based JavaScript)", color: "#f59e0b" },
                { label: "CEP Panel", desc: "HTML/Node.js panel running inside Adobe apps", color: "#10b981" },
              ].map((item, i) => (
                <div key={i} style={{
                  flex: "1 1 200px", padding: "12px 16px",
                  background: `${item.color}08`, borderRadius: 8,
                  borderLeft: `3px solid ${item.color}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: item.color }}>{item.label}</div>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
