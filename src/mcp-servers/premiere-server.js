#!/usr/bin/env node

// ============================================================================
//  Premiere Pro MCP Server
//  Exposes 40+ tools for AI video editing via Model Context Protocol
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AdobeBridge } from '../bridge/adobe-bridge.js';
import { AIEditor } from '../ai-editor/editor-engine.js';
import { ColorGrader } from '../color-grading/color-grader.js';
import { SoundEngineer } from '../sound-engineering/sound-engineer.js';
import { ShortsCutter } from '../shorts-cutter/shorts-cutter.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('PremiereMCP');

class PremiereProMCPServer {
  constructor(bridge, aiEditor) {
    this.bridge = bridge || new AdobeBridge();
    this.aiEditor = aiEditor || new AIEditor(this.bridge);
    this.colorGrader = new ColorGrader(this.bridge);
    this.soundEngineer = new SoundEngineer(this.bridge);
    this.shortsCutter = new ShortsCutter(this.bridge, this.aiEditor);
    this.server = new McpServer({
      name: 'adobe-premiere-pro',
      version: '1.0.0',
      description: 'AI Video Editor for Adobe Premiere Pro — edit, color grade, sound engineer, and create shorts',
    });

    this._registerAllTools();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL REGISTRATION
  // ════════════════════════════════════════════════════════════════════════

  _registerAllTools() {
    this._registerProjectTools();
    this._registerTimelineTools();
    this._registerEditingTools();
    this._registerAIEditingTools();
    this._registerColorGradingTools();
    this._registerSoundEngineeringTools();
    this._registerShortsTools();
    this._registerExportTools();
    this._registerResourceProviders();
  }

  // ── PROJECT MANAGEMENT ─────────────────────────────────────────────────

  _registerProjectTools() {
    this.server.tool(
      'project_open',
      'Open an existing Premiere Pro project file (.prproj)',
      { path: z.string().describe('Absolute path to the .prproj file') },
      async ({ path }) => {
        const result = await this.bridge.send('premiere', 'project.open', { path });
        return { content: [{ type: 'text', text: `Project opened: ${result.name} (${result.sequences.length} sequences)` }] };
      }
    );

    this.server.tool(
      'project_create',
      'Create a new Premiere Pro project',
      {
        name: z.string().describe('Project name'),
        path: z.string().describe('Directory to save the project'),
        preset: z.enum(['youtube_1080p', 'youtube_4k', 'shorts_1080x1920', 'tiktok', 'instagram_reel', 'cinematic_24fps', 'custom']).default('youtube_1080p'),
      },
      async ({ name, path, preset }) => {
        const result = await this.bridge.send('premiere', 'project.create', { name, path, preset });
        return { content: [{ type: 'text', text: `Created project "${name}" with ${preset} preset at ${result.path}` }] };
      }
    );

    this.server.tool(
      'project_get_info',
      'Get information about the currently open project — sequences, bins, media, settings',
      {},
      async () => {
        const info = await this.bridge.send('premiere', 'project.getInfo');
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      }
    );

    this.server.tool(
      'project_save',
      'Save the current project',
      { saveAs: z.string().optional().describe('Optional new path to save-as') },
      async ({ saveAs }) => {
        const result = await this.bridge.send('premiere', 'project.save', { saveAs });
        return { content: [{ type: 'text', text: `Project saved: ${result.path}` }] };
      }
    );

    this.server.tool(
      'project_import_media',
      'Import media files (video, audio, images) into the project',
      {
        files: z.array(z.string()).describe('Array of file paths to import'),
        bin: z.string().optional().describe('Target bin/folder name (created if needed)'),
      },
      async ({ files, bin }) => {
        const result = await this.bridge.send('premiere', 'project.importMedia', { files, bin });
        return { content: [{ type: 'text', text: `Imported ${result.imported.length} files into ${bin || 'root'}` }] };
      }
    );
  }

  // ── TIMELINE MANAGEMENT ────────────────────────────────────────────────

  _registerTimelineTools() {
    this.server.tool(
      'timeline_create',
      'Create a new sequence/timeline with specified settings',
      {
        name: z.string().describe('Sequence name'),
        width: z.number().default(1920),
        height: z.number().default(1080),
        frameRate: z.number().default(30),
        sampleRate: z.number().default(48000),
      },
      async (params) => {
        const result = await this.bridge.send('premiere', 'timeline.create', params);
        return { content: [{ type: 'text', text: `Created timeline "${params.name}" (${params.width}x${params.height} @ ${params.frameRate}fps)` }] };
      }
    );

    this.server.tool(
      'timeline_get_state',
      'Get full state of the active timeline — all clips, tracks, markers, in/out points',
      { sequenceName: z.string().optional().describe('Specific sequence name, or leave empty for active') },
      async ({ sequenceName }) => {
        const state = await this.bridge.send('premiere', 'timeline.getState', { sequenceName });
        return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
      }
    );

    this.server.tool(
      'timeline_clear_track',
      'Remove ALL clips from a video track and its corresponding audio track',
      {
        trackIndex: z.number().default(0).describe('Video track index to clear (0 = V1)'),
        audioTrackIndex: z.number().default(0).describe('Audio track index to clear (0 = A1)'),
      },
      async (params) => {
        const result = await this.bridge.send('premiere', 'timeline.clearTrack', params);
        return { content: [{ type: 'text', text: `Cleared V${params.trackIndex + 1} and A${params.audioTrackIndex + 1}: removed ${result.removed} video clips` }] };
      }
    );

    this.server.tool(
      'timeline_set_active',
      'Set a specific sequence as the active sequence by name',
      { sequenceName: z.string().describe('Name of the sequence to activate') },
      async ({ sequenceName }) => {
        const result = await this.bridge.send('premiere', 'timeline.setActive', { sequenceName });
        return { content: [{ type: 'text', text: `Activated sequence: ${result.active}` }] };
      }
    );

    this.server.tool(
      'timeline_add_clip',
      'Add a clip from project media to the timeline at a specific position. Set audioOnly=true to add only audio.',
      {
        mediaName: z.string().describe('Name of the media item in the project panel'),
        trackIndex: z.number().default(0).describe('Video track index (0 = V1)'),
        startTime: z.number().describe('Start time in seconds on the timeline'),
        inPoint: z.number().optional().describe('Source in-point in seconds'),
        outPoint: z.number().optional().describe('Source out-point in seconds'),
        audioTrackIndex: z.number().optional().describe('Audio track index'),
        audioOnly: z.boolean().optional().describe('If true, add only to audio track, skip video'),
      },
      async (params) => {
        const result = await this.bridge.send('premiere', 'timeline.addClip', params);
        const target = params.audioOnly ? `A${(params.audioTrackIndex || 0) + 1}` : `V${params.trackIndex + 1}`;
        return { content: [{ type: 'text', text: `Added "${params.mediaName}" to ${target} at ${params.startTime}s` }] };
      }
    );

    this.server.tool(
      'timeline_set_playhead',
      'Move the playhead to a specific timecode position',
      { time: z.number().describe('Time in seconds') },
      async ({ time }) => {
        await this.bridge.send('premiere', 'timeline.setPlayhead', { time });
        return { content: [{ type: 'text', text: `Playhead moved to ${time}s` }] };
      }
    );

    this.server.tool(
      'timeline_add_marker',
      'Add a marker to the timeline at specified position',
      {
        time: z.number().describe('Time in seconds'),
        name: z.string().describe('Marker name'),
        color: z.enum(['green', 'red', 'yellow', 'blue', 'cyan', 'magenta', 'orange', 'white']).default('green'),
        comment: z.string().optional(),
        duration: z.number().optional().describe('Marker duration in seconds'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'timeline.addMarker', params);
        return { content: [{ type: 'text', text: `Marker "${params.name}" added at ${params.time}s` }] };
      }
    );

    this.server.tool(
      'premiere_eval',
      'Execute raw ExtendScript directly in Premiere Pro — for advanced operations not covered by other tools',
      { script: z.string().describe('ExtendScript code to evaluate in Premiere') },
      async ({ script }) => {
        const result = await this.bridge.send('premiere', '_eval', { script });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    );
  }

  // ── CLIP EDITING ───────────────────────────────────────────────────────

  _registerEditingTools() {
    this.server.tool(
      'edit_cut',
      'Cut/razor a clip at a specific time on a specific track',
      {
        trackIndex: z.number().describe('Track index (0 = V1)'),
        time: z.number().describe('Cut point in seconds'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.cut', params);
        return { content: [{ type: 'text', text: `Cut at ${params.time}s on V${params.trackIndex + 1}` }] };
      }
    );

    this.server.tool(
      'edit_trim',
      'Trim a clip by adjusting its in or out point on the timeline',
      {
        trackIndex: z.number(),
        clipIndex: z.number().describe('Index of the clip on the track'),
        trimType: z.enum(['in', 'out']).describe('Trim the in-point or out-point'),
        amount: z.number().describe('Amount in seconds (positive = extend, negative = shorten)'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.trim', params);
        return { content: [{ type: 'text', text: `Trimmed ${params.trimType}-point by ${params.amount}s` }] };
      }
    );

    this.server.tool(
      'edit_delete_clip',
      'Delete a clip from the timeline (ripple or leave gap)',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        ripple: z.boolean().default(true).describe('Ripple delete (close gap) or leave gap'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.deleteClip', params);
        return { content: [{ type: 'text', text: `Deleted clip ${params.clipIndex} on V${params.trackIndex + 1} (ripple: ${params.ripple})` }] };
      }
    );

    this.server.tool(
      'edit_move_clip',
      'Move a clip to a new position or track',
      {
        sourceTrack: z.number(),
        clipIndex: z.number(),
        destTrack: z.number(),
        destTime: z.number().describe('Destination time in seconds'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.moveClip', params);
        return { content: [{ type: 'text', text: `Moved clip to V${params.destTrack + 1} at ${params.destTime}s` }] };
      }
    );

    this.server.tool(
      'edit_speed_duration',
      'Change speed/duration of a clip (time remapping)',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        speed: z.number().describe('Speed multiplier (1.0 = normal, 0.5 = half speed, 2.0 = double)'),
        reverse: z.boolean().default(false),
        maintainPitch: z.boolean().default(true),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.speedDuration', params);
        return { content: [{ type: 'text', text: `Speed set to ${params.speed}x${params.reverse ? ' (reversed)' : ''}` }] };
      }
    );

    this.server.tool(
      'edit_add_transition',
      'Add a video transition between clips',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        position: z.enum(['start', 'end', 'between']),
        transitionType: z.enum([
          'cross_dissolve', 'dip_to_black', 'dip_to_white', 'film_dissolve',
          'additive_dissolve', 'push', 'slide', 'wipe',
          'morph_cut', 'iris_round', 'zoom'
        ]).default('cross_dissolve'),
        duration: z.number().default(0.5).describe('Transition duration in seconds'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.addTransition', params);
        return { content: [{ type: 'text', text: `Added ${params.transitionType} (${params.duration}s) at ${params.position} of clip` }] };
      }
    );

    this.server.tool(
      'edit_add_text',
      'Add a text/title layer to the timeline using Essential Graphics',
      {
        text: z.string().describe('The text content'),
        trackIndex: z.number().default(1),
        startTime: z.number(),
        duration: z.number().default(3),
        style: z.object({
          fontFamily: z.string().default('Arial Bold'),
          fontSize: z.number().default(72),
          color: z.string().default('#FFFFFF'),
          backgroundColor: z.string().optional(),
          position: z.enum(['center', 'lower_third', 'upper_left', 'upper_right', 'custom']).default('center'),
          x: z.number().optional(),
          y: z.number().optional(),
          animation: z.enum(['none', 'fade_in', 'slide_up', 'typewriter', 'scale_pop', 'glitch']).default('fade_in'),
        }).optional(),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.addText', params);
        return { content: [{ type: 'text', text: `Added text "${params.text}" at ${params.startTime}s (${params.duration}s)` }] };
      }
    );

    this.server.tool(
      'edit_set_opacity',
      'Set the opacity of a clip on the timeline',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        opacity: z.number().min(0).max(100).describe('Opacity 0-100'),
        keyframes: z.array(z.object({
          time: z.number().describe('Time relative to clip start in seconds'),
          value: z.number().min(0).max(100),
        })).optional().describe('Optional keyframe animation'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.setOpacity', params);
        return { content: [{ type: 'text', text: `Opacity set to ${params.opacity}%` }] };
      }
    );

    this.server.tool(
      'edit_set_scale_position',
      'Set scale, position, rotation of a clip (motion controls)',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        scale: z.number().optional().describe('Scale percentage (100 = original)'),
        positionX: z.number().optional().describe('X position in pixels'),
        positionY: z.number().optional().describe('Y position in pixels'),
        rotation: z.number().optional().describe('Rotation in degrees'),
        anchorX: z.number().optional(),
        anchorY: z.number().optional(),
        keyframes: z.array(z.object({
          time: z.number(),
          scale: z.number().optional(),
          positionX: z.number().optional(),
          positionY: z.number().optional(),
          rotation: z.number().optional(),
          easing: z.enum(['linear', 'ease_in', 'ease_out', 'ease_in_out', 'bezier']).default('ease_in_out'),
        })).optional(),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.setMotion', params);
        return { content: [{ type: 'text', text: `Motion properties updated on V${params.trackIndex + 1} clip ${params.clipIndex}` }] };
      }
    );

    this.server.tool(
      'edit_apply_effect',
      'Apply a video or audio effect to a clip',
      {
        trackIndex: z.number(),
        clipIndex: z.number(),
        effectName: z.string().describe('Effect name (e.g., "Gaussian Blur", "Warp Stabilizer", "Lumetri Color")'),
        parameters: z.record(z.any()).optional().describe('Effect parameter key-value pairs'),
      },
      async (params) => {
        await this.bridge.send('premiere', 'edit.applyEffect', params);
        return { content: [{ type: 'text', text: `Applied "${params.effectName}" to clip` }] };
      }
    );
  }

  // ── AI-POWERED EDITING ─────────────────────────────────────────────────

  _registerAIEditingTools() {
    this.server.tool(
      'ai_auto_edit',
      'AI auto-edit: analyze footage and create an engaging edit with pacing, cuts, and transitions. Designed for YouTube-style content with hooks and retention.',
      {
        style: z.enum([
          'youtube_engaging',     // Fast cuts, zoom-ins, text overlays
          'documentary',          // Slower, cinematic, B-roll heavy
          'vlog',                 // Jump cuts, face tracking, natural
          'tutorial',             // Clean, focused, step-by-step
          'cinematic',            // Film-grade, slow transitions
          'podcast',              // Multi-cam, speaker switching
          'music_video',          // Beat-synced cuts
          'commercial',           // Punchy, 30-60 second focused
          'gaming',               // Fast, meme-driven, overlay-heavy
        ]).describe('Editing style/genre'),
        hookDuration: z.number().default(5).describe('Duration of the hook/intro in seconds'),
        targetDuration: z.number().optional().describe('Target final video duration in seconds'),
        pacingIntensity: z.number().min(1).max(10).default(6).describe('Pacing speed 1=slow, 10=extremely fast cuts'),
        removeDeadAir: z.boolean().default(true).describe('Remove silence/dead air automatically'),
        deadAirThreshold: z.number().default(0.8).describe('Seconds of silence before cutting'),
        addZoomIns: z.boolean().default(true).describe('Add subtle zoom-ins on key moments'),
        addTextOverlays: z.boolean().default(true).describe('Add text call-outs for key points'),
      },
      async (params) => {
        const result = await this.aiEditor.autoEdit(params);
        return {
          content: [{
            type: 'text',
            text: `AI Auto-Edit Complete!\n` +
              `Style: ${params.style}\n` +
              `Original: ${result.originalDuration}s → Final: ${result.finalDuration}s\n` +
              `Cuts made: ${result.cutsCount}\n` +
              `Dead air removed: ${result.deadAirRemoved}s\n` +
              `Zoom-ins added: ${result.zoomIns}\n` +
              `Text overlays: ${result.textOverlays}\n` +
              `Hook section: 0-${params.hookDuration}s\n` +
              `Engagement score: ${result.engagementScore}/10`,
          }],
        };
      }
    );

    this.server.tool(
      'ai_detect_highlights',
      'Analyze footage for highlight moments — high energy, laughter, key phrases, action, emotion. Uses audio analysis, motion detection, and face recognition.',
      {
        sensitivity: z.number().min(1).max(10).default(5),
        categories: z.array(z.enum([
          'high_energy', 'laughter', 'key_phrase', 'action', 'emotion',
          'music_peak', 'crowd_reaction', 'visual_impact', 'plot_point',
        ])).default(['high_energy', 'laughter', 'key_phrase']),
        minHighlightDuration: z.number().default(2),
        maxHighlights: z.number().default(20),
      },
      async (params) => {
        const highlights = await this.aiEditor.detectHighlights(params);
        return {
          content: [{
            type: 'text',
            text: `Found ${highlights.length} highlights:\n` +
              highlights.map((h, i) =>
                `  ${i + 1}. [${h.startTime}s-${h.endTime}s] ${h.category} (score: ${h.score}/10) — "${h.description}"`
              ).join('\n'),
          }],
        };
      }
    );

    this.server.tool(
      'ai_generate_hook',
      'Generate an attention-grabbing hook/intro for the video. Analyzes the best moment from the footage and creates a cold open.',
      {
        hookStyle: z.enum([
          'cold_open',         // Jump to the most exciting moment
          'question',          // Pose an intriguing question with text
          'teaser_montage',    // Quick montage of upcoming highlights
          'countdown',         // "3 things you didn't know..."
          'controversy',       // Controversial statement opener
          'transformation',    // Before/after reveal
          'challenge',         // "Can I...?" opener
        ]),
        duration: z.number().default(5).describe('Hook duration in seconds'),
        addText: z.boolean().default(true),
        addSoundEffect: z.boolean().default(true),
      },
      async (params) => {
        const result = await this.aiEditor.generateHook(params);
        return {
          content: [{
            type: 'text',
            text: `Hook generated (${params.hookStyle}):\n` +
              `Duration: ${params.duration}s\n` +
              `Source moment: ${result.sourceTime}s\n` +
              `Text overlay: "${result.textOverlay}"\n` +
              `Sound effect: ${result.soundEffect}`,
          }],
        };
      }
    );

    this.server.tool(
      'ai_remove_silence',
      'Detect and remove silence/dead air from the timeline. Smart detection preserves intentional pauses.',
      {
        threshold: z.number().default(-35).describe('Audio threshold in dB (below = silence)'),
        minSilenceDuration: z.number().default(0.6).describe('Minimum silence to remove (seconds)'),
        padding: z.number().default(0.05).describe('Padding to keep around cuts (seconds)'),
        preserveBreaths: z.boolean().default(true).describe('Keep natural breath pauses'),
        transitionStyle: z.enum(['hard_cut', 'jump_cut', 'morph_cut', 'j_cut']).default('jump_cut'),
      },
      async (params) => {
        const result = await this.aiEditor.removeSilence(params);
        return {
          content: [{
            type: 'text',
            text: `Silence removal complete:\n` +
              `Segments removed: ${result.segmentsRemoved}\n` +
              `Time saved: ${result.timeSaved.toFixed(1)}s\n` +
              `Breaths preserved: ${result.breathsPreserved}\n` +
              `New duration: ${result.newDuration}s`,
          }],
        };
      }
    );

    this.server.tool(
      'ai_beat_sync',
      'Sync video cuts to the beat of background music. Analyzes BPM and creates cuts on beats.',
      {
        audioTrackIndex: z.number().default(0).describe('Audio track with the music'),
        cutOnEvery: z.enum(['beat', 'bar', 'half_beat', 'every_other_beat']).default('beat'),
        intensity: z.number().min(1).max(10).default(5),
        startTime: z.number().optional(),
        endTime: z.number().optional(),
        allowEffects: z.boolean().default(true).describe('Add zoom/flash on strong beats'),
      },
      async (params) => {
        const result = await this.aiEditor.beatSync(params);
        return {
          content: [{
            type: 'text',
            text: `Beat sync complete!\n` +
              `BPM detected: ${result.bpm}\n` +
              `Cuts synced: ${result.cutsCount}\n` +
              `Effects added: ${result.effectsCount}\n` +
              `Section: ${result.startTime}s - ${result.endTime}s`,
          }],
        };
      }
    );

    this.server.tool(
      'ai_face_tracking_zoom',
      'Auto-detect faces and add subtle zoom/reframe to keep the subject centered and dynamic.',
      {
        trackIndex: z.number().default(0),
        zoomAmount: z.number().default(1.2).describe('Max zoom multiplier (1.2 = 20% zoom)'),
        smoothness: z.number().min(1).max(10).default(7).describe('Camera movement smoothness'),
        reframeTo: z.enum(['center', 'rule_of_thirds', 'dynamic']).default('rule_of_thirds'),
      },
      async (params) => {
        const result = await this.aiEditor.faceTrackingZoom(params);
        return {
          content: [{
            type: 'text',
            text: `Face tracking zoom applied.\n` +
              `Faces detected: ${result.facesDetected}\n` +
              `Keyframes added: ${result.keyframesAdded}\n` +
              `Reframe style: ${params.reframeTo}`,
          }],
        };
      }
    );
  }

  // ── COLOR GRADING ──────────────────────────────────────────────────────

  _registerColorGradingTools() {
    this.server.tool(
      'color_apply_lut',
      'Apply a LUT (Look Up Table) to a clip or entire timeline for color grading',
      {
        lutName: z.string().describe('LUT name or path to .cube file'),
        intensity: z.number().min(0).max(100).default(80).describe('LUT intensity percentage'),
        trackIndex: z.number().optional().describe('Specific track (omit for entire timeline)'),
        clipIndex: z.number().optional(),
      },
      async (params) => {
        const result = await this.colorGrader.applyLUT(params);
        return { content: [{ type: 'text', text: `LUT "${params.lutName}" applied at ${params.intensity}% intensity` }] };
      }
    );

    this.server.tool(
      'color_grade_preset',
      'Apply a professional color grading preset to the timeline',
      {
        preset: z.enum([
          // Cinematic Looks
          'cinematic_teal_orange', 'cinematic_warm', 'cinematic_cold', 'cinematic_desaturated',
          'blockbuster_action', 'indie_film', 'film_noir', 'vintage_film',
          // YouTube Optimized
          'youtube_vibrant', 'youtube_clean', 'youtube_warm_cozy', 'youtube_dark_moody',
          // Social / Trendy
          'instagram_aesthetic', 'tiktok_punchy', 'pastel_dream', 'neon_glow',
          // Documentary
          'doc_natural', 'doc_dramatic', 'doc_black_and_white',
          // Season / Time
          'golden_hour', 'blue_hour', 'summer_vibes', 'winter_cold',
          // Technical
          'rec709_standard', 'slog3_to_rec709', 'vlog_to_rec709', 'hdr_to_sdr',
        ]).describe('Color grading preset name'),
        intensity: z.number().min(0).max(100).default(80),
        scope: z.enum(['full_timeline', 'selected_clips', 'in_out_range']).default('full_timeline'),
      },
      async (params) => {
        const result = await this.colorGrader.applyPreset(params);
        return {
          content: [{
            type: 'text',
            text: `Color grade "${params.preset}" applied at ${params.intensity}%\n` +
              `Scope: ${params.scope}\n` +
              `Clips affected: ${result.clipsAffected}`,
          }],
        };
      }
    );

    this.server.tool(
      'color_manual_grade',
      'Manually adjust Lumetri Color controls — temperature, tint, exposure, contrast, highlights, shadows, vibrance, saturation, etc.',
      {
        trackIndex: z.number().optional(),
        clipIndex: z.number().optional(),
        basic: z.object({
          temperature: z.number().min(-100).max(100).optional(),
          tint: z.number().min(-100).max(100).optional(),
          exposure: z.number().min(-5).max(5).optional(),
          contrast: z.number().min(-100).max(100).optional(),
          highlights: z.number().min(-100).max(100).optional(),
          shadows: z.number().min(-100).max(100).optional(),
          whites: z.number().min(-100).max(100).optional(),
          blacks: z.number().min(-100).max(100).optional(),
        }).optional(),
        creative: z.object({
          vibrance: z.number().min(-100).max(100).optional(),
          saturation: z.number().min(-100).max(100).optional(),
          fadeAmount: z.number().min(0).max(100).optional(),
          sharpen: z.number().min(0).max(100).optional(),
        }).optional(),
        curves: z.object({
          rgb: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
          red: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
          green: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
          blue: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
        }).optional(),
        colorWheels: z.object({
          shadowsTint: z.string().optional(),
          midtonesTint: z.string().optional(),
          highlightsTint: z.string().optional(),
        }).optional(),
        vignette: z.object({
          amount: z.number().min(-5).max(5).optional(),
          midpoint: z.number().min(0).max(100).optional(),
          roundness: z.number().min(0).max(100).optional(),
          feather: z.number().min(0).max(100).optional(),
        }).optional(),
      },
      async (params) => {
        const result = await this.colorGrader.manualGrade(params);
        return { content: [{ type: 'text', text: `Color adjustments applied. Modified: ${Object.keys(params).filter(k => k !== 'trackIndex' && k !== 'clipIndex').join(', ')}` }] };
      }
    );

    this.server.tool(
      'color_match',
      'Match the color/look of one clip to another reference clip',
      {
        sourceTrack: z.number(),
        sourceClip: z.number(),
        referenceTrack: z.number(),
        referenceClip: z.number(),
        matchFaces: z.boolean().default(true).describe('Use face detection for better skin tone matching'),
      },
      async (params) => {
        const result = await this.colorGrader.colorMatch(params);
        return { content: [{ type: 'text', text: `Color matched source to reference clip (confidence: ${result.confidence}%)` }] };
      }
    );

    this.server.tool(
      'color_auto_correct',
      'Auto white-balance and exposure correction for the entire timeline',
      {
        correctExposure: z.boolean().default(true),
        correctWhiteBalance: z.boolean().default(true),
        correctSaturation: z.boolean().default(false),
        strength: z.number().min(0).max(100).default(75),
      },
      async (params) => {
        const result = await this.colorGrader.autoCorrect(params);
        return { content: [{ type: 'text', text: `Auto correction applied to ${result.clipsFixed} clips (strength: ${params.strength}%)` }] };
      }
    );
  }

  // ── SOUND ENGINEERING ──────────────────────────────────────────────────

  _registerSoundEngineeringTools() {
    this.server.tool(
      'audio_normalize',
      'Normalize audio levels across the entire timeline for consistent volume (LUFS targeting)',
      {
        targetLUFS: z.number().default(-14).describe('Target LUFS level (-14 for YouTube, -16 for podcasts)'),
        truePeak: z.number().default(-1).describe('True peak ceiling in dB'),
        scope: z.enum(['full_timeline', 'dialogue_only', 'music_only', 'selected']).default('full_timeline'),
      },
      async (params) => {
        const result = await this.soundEngineer.normalize(params);
        return {
          content: [{
            type: 'text',
            text: `Audio normalized to ${params.targetLUFS} LUFS\n` +
              `True peak: ${params.truePeak}dB\n` +
              `Tracks adjusted: ${result.tracksAdjusted}\n` +
              `Average gain change: ${result.avgGainChange}dB`,
          }],
        };
      }
    );

    this.server.tool(
      'audio_denoise',
      'Remove background noise from audio tracks using spectral noise reduction',
      {
        trackIndex: z.number().default(0),
        strength: z.number().min(0).max(100).default(60).describe('Noise reduction strength'),
        preserveVoice: z.boolean().default(true),
        removeTypes: z.array(z.enum([
          'hiss', 'hum', 'buzz', 'wind', 'room_tone', 'keyboard', 'traffic', 'echo', 'all',
        ])).default(['all']),
      },
      async (params) => {
        const result = await this.soundEngineer.denoise(params);
        return {
          content: [{
            type: 'text',
            text: `Denoising applied (${params.strength}% strength)\n` +
              `Noise types removed: ${params.removeTypes.join(', ')}\n` +
              `SNR improvement: +${result.snrImprovement}dB`,
          }],
        };
      }
    );

    this.server.tool(
      'audio_eq',
      'Apply EQ (equalization) to audio tracks — voice optimization, music balancing, etc.',
      {
        trackIndex: z.number(),
        preset: z.enum([
          'voice_clarity', 'voice_deep', 'voice_bright', 'voice_broadcast',
          'podcast_standard', 'podcast_intimate',
          'music_balanced', 'music_bass_boost', 'music_reduce_for_voiceover',
          'ambience_subtle', 'ambience_dramatic',
          'de_ess', 'de_plosive',
          'custom',
        ]).optional(),
        bands: z.array(z.object({
          frequency: z.number().describe('Center frequency in Hz'),
          gain: z.number().describe('Gain in dB'),
          q: z.number().default(1).describe('Q factor / bandwidth'),
          type: z.enum(['lowpass', 'highpass', 'bandpass', 'shelf_low', 'shelf_high', 'peak', 'notch']).default('peak'),
        })).optional(),
      },
      async (params) => {
        const result = await this.soundEngineer.applyEQ(params);
        return { content: [{ type: 'text', text: `EQ applied: ${params.preset || 'custom'} on track ${params.trackIndex}` }] };
      }
    );

    this.server.tool(
      'audio_compress',
      'Apply dynamic range compression — tighten audio levels for more professional sound',
      {
        trackIndex: z.number(),
        preset: z.enum([
          'voice_gentle', 'voice_aggressive', 'voice_broadcast',
          'music_light', 'music_heavy', 'music_limiter',
          'podcast_standard', 'youtube_standard',
          'custom',
        ]).optional(),
        threshold: z.number().optional().describe('Threshold in dB'),
        ratio: z.number().optional().describe('Compression ratio (e.g., 3 for 3:1)'),
        attack: z.number().optional().describe('Attack time in ms'),
        release: z.number().optional().describe('Release time in ms'),
        makeupGain: z.number().optional().describe('Makeup gain in dB'),
      },
      async (params) => {
        const result = await this.soundEngineer.compress(params);
        return { content: [{ type: 'text', text: `Compression applied: ${params.preset || 'custom'} on track ${params.trackIndex}` }] };
      }
    );

    this.server.tool(
      'audio_add_music',
      'Add background music to the timeline with auto-ducking when voice is detected',
      {
        musicFile: z.string().describe('Path to the music file'),
        volume: z.number().default(-18).describe('Music volume in dB (relative to dialogue)'),
        autoDuck: z.boolean().default(true).describe('Auto-reduce music when dialogue is present'),
        duckAmount: z.number().default(-12).describe('How much to reduce music during dialogue (dB)'),
        fadeIn: z.number().default(2).describe('Fade in duration in seconds'),
        fadeOut: z.number().default(3).describe('Fade out duration in seconds'),
        loop: z.boolean().default(true).describe('Loop if music is shorter than video'),
        startTime: z.number().default(0),
        endTime: z.number().optional(),
      },
      async (params) => {
        const result = await this.soundEngineer.addMusic(params);
        return {
          content: [{
            type: 'text',
            text: `Music added: ${params.musicFile}\n` +
              `Volume: ${params.volume}dB | Auto-duck: ${params.autoDuck}\n` +
              `Fade in: ${params.fadeIn}s | Fade out: ${params.fadeOut}s`,
          }],
        };
      }
    );

    this.server.tool(
      'audio_add_sfx',
      'Add a sound effect at a specific point on the timeline',
      {
        sfxType: z.enum([
          'whoosh', 'impact', 'transition_swoosh', 'click', 'pop', 'ding',
          'notification', 'typing', 'camera_shutter', 'vinyl_scratch',
          'bass_drop', 'riser', 'glitch', 'error', 'success',
          'crowd_cheer', 'laugh_track', 'applause', 'gasp',
          'custom',
        ]),
        time: z.number().describe('Time to place the SFX in seconds'),
        volume: z.number().default(-6),
        customPath: z.string().optional().describe('Path to custom SFX file'),
      },
      async (params) => {
        const result = await this.soundEngineer.addSFX(params);
        return { content: [{ type: 'text', text: `SFX "${params.sfxType}" added at ${params.time}s` }] };
      }
    );

    this.server.tool(
      'audio_master',
      'Apply full audio mastering chain — EQ, compression, limiting, loudness normalization. One-click professional audio.',
      {
        target: z.enum(['youtube', 'podcast', 'broadcast', 'streaming', 'cinema']).default('youtube'),
        enhanceVoice: z.boolean().default(true),
        stereoWidth: z.number().min(0).max(200).default(100),
      },
      async (params) => {
        const result = await this.soundEngineer.master(params);
        return {
          content: [{
            type: 'text',
            text: `Audio mastered for ${params.target}:\n` +
              `Final LUFS: ${result.finalLUFS}\n` +
              `True Peak: ${result.truePeak}dB\n` +
              `Chain: ${result.chain.join(' → ')}`,
          }],
        };
      }
    );
  }

  // ── SHORTS / CLIPS CUTTER ─────────────────────────────────────────────

  _registerShortsTools() {
    this.server.tool(
      'shorts_auto_detect',
      'AI-analyze a long video and detect the best moments to cut into YouTube Shorts, TikToks, or Reels. Returns suggested clips with hooks.',
      {
        maxShorts: z.number().default(5).describe('Maximum number of shorts to suggest'),
        minDuration: z.number().default(15).describe('Minimum short duration in seconds'),
        maxDuration: z.number().default(60).describe('Maximum short duration in seconds'),
        platform: z.enum(['youtube_shorts', 'tiktok', 'instagram_reels', 'all']).default('youtube_shorts'),
        prioritize: z.enum(['engagement', 'virality', 'education', 'humor', 'emotional']).default('engagement'),
      },
      async (params) => {
        const shorts = await this.shortsCutter.autoDetect(params);
        return {
          content: [{
            type: 'text',
            text: `Found ${shorts.length} potential shorts:\n\n` +
              shorts.map((s, i) =>
                `Short ${i + 1}: "${s.title}"\n` +
                `  Time: ${s.startTime}s → ${s.endTime}s (${s.duration}s)\n` +
                `  Hook: "${s.suggestedHook}"\n` +
                `  Score: ${s.viralityScore}/10\n` +
                `  Category: ${s.category}`
              ).join('\n\n'),
          }],
        };
      }
    );

    this.server.tool(
      'shorts_create',
      'Create a vertical short from a section of the main timeline. Handles reframing, cropping, captions, and formatting.',
      {
        startTime: z.number().describe('Start time in the main timeline (seconds)'),
        endTime: z.number().describe('End time (seconds)'),
        title: z.string().optional().describe('Title for the short'),
        platform: z.enum(['youtube_shorts', 'tiktok', 'instagram_reels']).default('youtube_shorts'),
        reframeMode: z.enum(['auto_face_track', 'center_crop', 'smart_crop', 'split_screen', 'manual']).default('auto_face_track'),
        addCaptions: z.boolean().default(true),
        captionStyle: z.enum([
          'minimal_white', 'bold_yellow', 'karaoke_highlight', 'word_by_word',
          'boxed', 'gradient_bg', 'tiktok_style', 'hormozi_style',
        ]).default('hormozi_style'),
        addHookText: z.string().optional().describe('Text overlay for the hook in the first 3 seconds'),
        addCallToAction: z.string().optional().describe('CTA text for the end'),
      },
      async (params) => {
        const result = await this.shortsCutter.createShort(params);
        return {
          content: [{
            type: 'text',
            text: `Short created: "${params.title || 'Untitled Short'}"\n` +
              `Platform: ${params.platform}\n` +
              `Duration: ${result.duration}s\n` +
              `Resolution: 1080x1920\n` +
              `Reframe: ${params.reframeMode}\n` +
              `Captions: ${params.addCaptions ? params.captionStyle : 'none'}\n` +
              `Sequence name: ${result.sequenceName}`,
          }],
        };
      }
    );

    this.server.tool(
      'shorts_add_captions',
      'Generate and add animated captions/subtitles to a short or video. Supports multiple trending styles.',
      {
        sequenceName: z.string().optional().describe('Target sequence (active if empty)'),
        style: z.enum([
          'minimal_white', 'bold_yellow', 'karaoke_highlight', 'word_by_word',
          'boxed', 'gradient_bg', 'tiktok_style', 'hormozi_style',
          'netflix_subtitle', 'custom',
        ]).default('hormozi_style'),
        position: z.enum(['bottom', 'center', 'top', 'dynamic']).default('center'),
        maxWords: z.number().default(3).describe('Max words visible at once'),
        fontSize: z.number().default(72),
        fontFamily: z.string().default('Montserrat ExtraBold'),
        highlightColor: z.string().default('#FFD700'),
        backgroundColor: z.string().optional(),
      },
      async (params) => {
        const result = await this.shortsCutter.addCaptions(params);
        return {
          content: [{
            type: 'text',
            text: `Captions added (${params.style})\n` +
              `Words transcribed: ${result.wordCount}\n` +
              `Caption segments: ${result.segments}\n` +
              `Position: ${params.position}`,
          }],
        };
      }
    );

    this.server.tool(
      'shorts_batch_create',
      'Create multiple shorts from a single long-form video in one operation',
      {
        shorts: z.array(z.object({
          startTime: z.number(),
          endTime: z.number(),
          title: z.string(),
          hookText: z.string().optional(),
        })),
        platform: z.enum(['youtube_shorts', 'tiktok', 'instagram_reels']).default('youtube_shorts'),
        reframeMode: z.enum(['auto_face_track', 'center_crop', 'smart_crop']).default('auto_face_track'),
        addCaptions: z.boolean().default(true),
        captionStyle: z.string().default('hormozi_style'),
      },
      async (params) => {
        const result = await this.shortsCutter.batchCreate(params);
        return {
          content: [{
            type: 'text',
            text: `Batch created ${result.created.length} shorts:\n` +
              result.created.map((s, i) => `  ${i + 1}. "${s.title}" (${s.duration}s) → ${s.sequenceName}`).join('\n'),
          }],
        };
      }
    );
  }

  // ── EXPORT ─────────────────────────────────────────────────────────────

  _registerExportTools() {
    this.server.tool(
      'export_media',
      'Export the timeline using Adobe Media Encoder with specified settings',
      {
        preset: z.enum([
          'youtube_1080p_h264', 'youtube_4k_h264', 'youtube_4k_h265',
          'youtube_shorts_1080x1920', 'tiktok_1080x1920',
          'instagram_reel_1080x1920', 'instagram_post_1080x1080',
          'prores_422', 'prores_4444', 'dnxhd',
          'h264_high_quality', 'h265_high_quality',
          'gif_preview', 'thumbnail_jpg',
          'audio_only_wav', 'audio_only_mp3',
          'custom',
        ]).describe('Export preset'),
        outputPath: z.string().describe('Output file path'),
        sequenceName: z.string().optional(),
        inPoint: z.number().optional().describe('Export range start (seconds)'),
        outPoint: z.number().optional().describe('Export range end (seconds)'),
        useMediaEncoder: z.boolean().default(true),
      },
      async (params) => {
        const result = await this.bridge.send('premiere', 'export.media', params);
        return {
          content: [{
            type: 'text',
            text: `Export started: ${params.preset}\n` +
              `Output: ${params.outputPath}\n` +
              `Estimated time: ${result.estimatedTime}`,
          }],
        };
      }
    );

    this.server.tool(
      'export_frame',
      'Export a single frame as a still image (useful for thumbnails)',
      {
        time: z.number().describe('Time in seconds to capture'),
        outputPath: z.string(),
        format: z.enum(['png', 'jpg', 'tiff']).default('png'),
        quality: z.number().min(1).max(100).default(95),
      },
      async (params) => {
        const result = await this.bridge.send('premiere', 'export.frame', params);
        return { content: [{ type: 'text', text: `Frame exported: ${params.outputPath}` }] };
      }
    );
  }

  // ── RESOURCE PROVIDERS ─────────────────────────────────────────────────

  _registerResourceProviders() {
    this.server.resource(
      'premiere://project/info',
      'Current Premiere Pro project information',
      async (uri) => {
        const info = await this.bridge.send('premiere', 'project.getInfo');
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(info, null, 2) }] };
      }
    );

    this.server.resource(
      'premiere://timeline/state',
      'Current active timeline state with all clips and tracks',
      async (uri) => {
        const state = await this.bridge.send('premiere', 'timeline.getState', {});
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(state, null, 2) }] };
      }
    );

    this.server.resource(
      'premiere://presets/color',
      'Available color grading presets',
      async (uri) => {
        const presets = this.colorGrader.getPresetList();
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(presets, null, 2) }] };
      }
    );

    this.server.resource(
      'premiere://presets/audio',
      'Available audio engineering presets',
      async (uri) => {
        const presets = this.soundEngineer.getPresetList();
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(presets, null, 2) }] };
      }
    );
  }

  // ── SERVER START ───────────────────────────────────────────────────────

  async start() {
    // Connect the bridge to Premiere's CEP WebSocket before accepting commands
    await this.bridge.connect(['premiere']);
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.success('Premiere Pro MCP Server running on stdio');
  }
}

// ── Standalone Launch ────────────────────────────────────────────────────
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('premiere-server.js') ||
  process.argv[1].includes('premiere-server')
);

if (isMainModule) {
  const server = new PremiereProMCPServer();
  server.start().catch((err) => {
    console.error('Failed to start Premiere MCP Server:', err);
    process.exit(1);
  });
}

export { PremiereProMCPServer };
