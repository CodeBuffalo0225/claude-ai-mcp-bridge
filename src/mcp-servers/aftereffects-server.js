#!/usr/bin/env node

// ============================================================================
//  After Effects MCP Server
//  Exposes tools for motion graphics, VFX, titles, and dynamic linking
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AdobeBridge } from '../bridge/adobe-bridge.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('AfterEffectsMCP');

class AfterEffectsMCPServer {
  constructor(bridge) {
    this.bridge = bridge || new AdobeBridge();
    this.server = new McpServer({
      name: 'adobe-after-effects',
      version: '1.0.0',
      description: 'AI Motion Graphics & VFX for Adobe After Effects — titles, intros, animations, compositing',
    });

    this._registerAllTools();
  }

  _registerAllTools() {
    this._registerProjectTools();
    this._registerCompositionTools();
    this._registerLayerTools();
    this._registerAnimationTools();
    this._registerTitleTools();
    this._registerVFXTools();
    this._registerDynamicLinkTools();
    this._registerRenderTools();
  }

  // ── PROJECT ────────────────────────────────────────────────────────────

  _registerProjectTools() {
    this.server.tool(
      'ae_project_open',
      'Open an After Effects project (.aep)',
      { path: z.string() },
      async ({ path }) => {
        const result = await this.bridge.send('aftereffects', 'project.open', { path });
        return { content: [{ type: 'text', text: `AE Project opened: ${result.name}` }] };
      }
    );

    this.server.tool(
      'ae_project_create',
      'Create a new After Effects project',
      {
        name: z.string(),
        path: z.string(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'project.create', params);
        return { content: [{ type: 'text', text: `AE Project created: ${params.name}` }] };
      }
    );

    this.server.tool(
      'ae_import_footage',
      'Import footage items into the AE project',
      {
        files: z.array(z.string()),
        folder: z.string().optional(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'project.importFootage', params);
        return { content: [{ type: 'text', text: `Imported ${result.imported.length} items` }] };
      }
    );
  }

  // ── COMPOSITIONS ───────────────────────────────────────────────────────

  _registerCompositionTools() {
    this.server.tool(
      'ae_comp_create',
      'Create a new composition',
      {
        name: z.string(),
        width: z.number().default(1920),
        height: z.number().default(1080),
        frameRate: z.number().default(30),
        duration: z.number().default(10).describe('Duration in seconds'),
        backgroundColor: z.string().default('#000000'),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'comp.create', params);
        return { content: [{ type: 'text', text: `Composition "${params.name}" created (${params.width}x${params.height}, ${params.duration}s)` }] };
      }
    );

    this.server.tool(
      'ae_comp_get_info',
      'Get info about a composition — layers, duration, render settings',
      { compName: z.string().optional().describe('Comp name or active comp') },
      async ({ compName }) => {
        const info = await this.bridge.send('aftereffects', 'comp.getInfo', { compName });
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      }
    );
  }

  // ── LAYERS ─────────────────────────────────────────────────────────────

  _registerLayerTools() {
    this.server.tool(
      'ae_add_layer',
      'Add a layer to the composition (footage, solid, shape, text, null, adjustment, camera, light)',
      {
        compName: z.string().optional(),
        layerType: z.enum(['footage', 'solid', 'shape', 'text', 'null', 'adjustment', 'camera', 'light']),
        name: z.string().optional(),
        footageItem: z.string().optional().describe('For footage layers — name of the project item'),
        color: z.string().optional().describe('For solid layers — hex color'),
        text: z.string().optional().describe('For text layers — the text content'),
        startTime: z.number().default(0),
        duration: z.number().optional(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'layer.add', params);
        return { content: [{ type: 'text', text: `Added ${params.layerType} layer "${params.name || params.text || 'unnamed'}"` }] };
      }
    );

    this.server.tool(
      'ae_layer_transform',
      'Set transform properties on a layer — position, scale, rotation, opacity, anchor point',
      {
        compName: z.string().optional(),
        layerIndex: z.number().describe('Layer index (1-based)'),
        position: z.tuple([z.number(), z.number()]).optional(),
        scale: z.tuple([z.number(), z.number()]).optional(),
        rotation: z.number().optional(),
        opacity: z.number().optional(),
        anchorPoint: z.tuple([z.number(), z.number()]).optional(),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'layer.transform', params);
        return { content: [{ type: 'text', text: `Transform updated on layer ${params.layerIndex}` }] };
      }
    );

    this.server.tool(
      'ae_apply_effect',
      'Apply an effect to a layer in After Effects',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        effectName: z.string().describe('Effect match name (e.g., "ADBE Gaussian Blur 2", "ADBE Glo2")'),
        parameters: z.record(z.any()).optional(),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'layer.applyEffect', params);
        return { content: [{ type: 'text', text: `Effect "${params.effectName}" applied to layer ${params.layerIndex}` }] };
      }
    );

    this.server.tool(
      'ae_set_layer_blending',
      'Set blending mode and track matte for a layer',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        blendMode: z.enum([
          'normal', 'add', 'multiply', 'screen', 'overlay', 'soft_light',
          'hard_light', 'color_dodge', 'color_burn', 'difference', 'exclusion',
          'luminosity', 'color', 'saturation', 'hue',
        ]).optional(),
        trackMatte: z.enum(['none', 'alpha', 'alpha_inverted', 'luma', 'luma_inverted']).optional(),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'layer.setBlending', params);
        return { content: [{ type: 'text', text: `Blending updated on layer ${params.layerIndex}` }] };
      }
    );
  }

  // ── ANIMATION & KEYFRAMES ─────────────────────────────────────────────

  _registerAnimationTools() {
    this.server.tool(
      'ae_add_keyframe',
      'Add a keyframe to a property on a layer',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        property: z.string().describe('Property path (e.g., "Position", "Opacity", "Scale", "Rotation")'),
        time: z.number().describe('Time in seconds'),
        value: z.any().describe('Property value (number, array, or string depending on property)'),
        easing: z.enum(['linear', 'ease_in', 'ease_out', 'ease_in_out', 'hold', 'bezier']).default('ease_in_out'),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'animation.addKeyframe', params);
        return { content: [{ type: 'text', text: `Keyframe at ${params.time}s on "${params.property}" for layer ${params.layerIndex}` }] };
      }
    );

    this.server.tool(
      'ae_add_expression',
      'Add a JavaScript expression to a property for procedural animation',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        property: z.string(),
        expression: z.string().describe('After Effects expression (JavaScript)'),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'animation.addExpression', params);
        return { content: [{ type: 'text', text: `Expression added to "${params.property}" on layer ${params.layerIndex}` }] };
      }
    );

    this.server.tool(
      'ae_animate_preset',
      'Apply a pre-built animation preset to a layer — pop-in, slide, typewriter, bounce, etc.',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        preset: z.enum([
          // Entrance
          'fade_in', 'fade_in_up', 'fade_in_down', 'fade_in_left', 'fade_in_right',
          'scale_pop', 'scale_bounce', 'scale_elastic',
          'slide_in_left', 'slide_in_right', 'slide_in_up', 'slide_in_down',
          'rotate_in', 'flip_in', 'blur_in', 'glitch_in',
          // Exit
          'fade_out', 'fade_out_up', 'scale_out', 'slide_out_left', 'slide_out_right',
          // Text specific
          'typewriter', 'word_by_word', 'letter_by_letter', 'scramble_text',
          // Continuous
          'float', 'pulse', 'wiggle', 'orbit', 'breathe',
        ]),
        startTime: z.number().default(0),
        duration: z.number().default(0.5).describe('Animation duration in seconds'),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'animation.applyPreset', params);
        return { content: [{ type: 'text', text: `Animation "${params.preset}" applied to layer ${params.layerIndex}` }] };
      }
    );
  }

  // ── TITLES & INTROS ────────────────────────────────────────────────────

  _registerTitleTools() {
    this.server.tool(
      'ae_create_intro',
      'Create a complete YouTube intro animation — logo reveal, channel name, subscribe prompt.',
      {
        channelName: z.string(),
        tagline: z.string().optional(),
        logoPath: z.string().optional().describe('Path to channel logo image'),
        style: z.enum([
          'modern_minimal', 'glitch_tech', 'neon_glow', 'cinematic_epic',
          'playful_bounce', 'elegant_fade', 'dynamic_shapes', 'particle_burst',
          'retro_vhs', 'liquid_morph', 'geometric_reveal', 'smoke_reveal',
          'fire_reveal', 'water_ripple', 'holographic', '3d_flip',
        ]).default('modern_minimal'),
        duration: z.number().default(5).describe('Intro duration in seconds'),
        colorScheme: z.object({
          primary: z.string().default('#FF0000'),
          secondary: z.string().default('#FFFFFF'),
          accent: z.string().default('#FFD700'),
          background: z.string().default('#000000'),
        }).optional(),
        includeSubscribePrompt: z.boolean().default(true),
        soundEffect: z.boolean().default(true),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'titles.createIntro', params);
        return {
          content: [{
            type: 'text',
            text: `Intro created: "${params.channelName}" (${params.style})\n` +
              `Duration: ${params.duration}s\n` +
              `Comp name: ${result.compName}\n` +
              `Layers: ${result.layerCount}`,
          }],
        };
      }
    );

    this.server.tool(
      'ae_create_lower_third',
      'Create a lower third title animation',
      {
        title: z.string(),
        subtitle: z.string().optional(),
        style: z.enum([
          'clean_bar', 'modern_line', 'gradient_slide', 'glitch_reveal',
          'minimal_underline', 'boxed', 'neon_outline', 'news_ticker',
        ]).default('clean_bar'),
        position: z.enum(['left', 'center', 'right']).default('left'),
        duration: z.number().default(4),
        colors: z.object({
          bar: z.string().default('#FF0000'),
          text: z.string().default('#FFFFFF'),
          background: z.string().default('rgba(0,0,0,0.7)'),
        }).optional(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'titles.createLowerThird', params);
        return { content: [{ type: 'text', text: `Lower third created: "${params.title}" (${params.style})` }] };
      }
    );

    this.server.tool(
      'ae_create_end_screen',
      'Create a YouTube end screen with subscribe button, video suggestions, and call-to-action',
      {
        channelName: z.string(),
        style: z.enum(['modern', 'minimal', 'animated', 'neon', 'gradient']).default('modern'),
        duration: z.number().default(20).describe('YouTube end screens are typically 20s'),
        subscribePlacement: z.enum(['center', 'left', 'right']).default('center'),
        videoSlots: z.number().default(2).describe('Number of video suggestion slots (1-4)'),
        colors: z.object({
          primary: z.string().default('#FF0000'),
          text: z.string().default('#FFFFFF'),
          background: z.string().default('#000000'),
        }).optional(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'titles.createEndScreen', params);
        return { content: [{ type: 'text', text: `End screen created (${params.style}, ${params.duration}s, ${params.videoSlots} video slots)` }] };
      }
    );

    this.server.tool(
      'ae_create_transition',
      'Create a custom transition composition — can be used as a Dynamic Link in Premiere',
      {
        style: z.enum([
          'whip_pan', 'zoom_through', 'glitch_cut', 'ink_blot', 'light_leak',
          'film_burn', 'pixel_sort', 'luma_wipe', 'shape_morph', 'liquid_transition',
          'paper_tear', 'shatter', 'spin_blur', 'rgb_split', 'cube_rotate',
        ]),
        duration: z.number().default(1),
        colors: z.object({
          primary: z.string().optional(),
          secondary: z.string().optional(),
        }).optional(),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'titles.createTransition', params);
        return { content: [{ type: 'text', text: `Transition "${params.style}" created (${params.duration}s)` }] };
      }
    );
  }

  // ── VFX ────────────────────────────────────────────────────────────────

  _registerVFXTools() {
    this.server.tool(
      'ae_green_screen',
      'Key out green/blue screen footage',
      {
        compName: z.string().optional(),
        layerIndex: z.number(),
        keyColor: z.enum(['green', 'blue', 'custom']).default('green'),
        customColor: z.string().optional(),
        edgeFeather: z.number().default(2),
        spillSuppression: z.number().default(50),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'vfx.greenScreen', params);
        return { content: [{ type: 'text', text: `Green screen keyed on layer ${params.layerIndex}` }] };
      }
    );

    this.server.tool(
      'ae_motion_track',
      'Track motion in footage and apply to another layer (position, rotation, scale)',
      {
        compName: z.string().optional(),
        sourceLayer: z.number(),
        targetLayer: z.number(),
        trackType: z.enum(['position', 'rotation', 'scale', 'perspective']).default('position'),
        trackPoint: z.tuple([z.number(), z.number()]).optional().describe('Initial track point [x, y]'),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'vfx.motionTrack', params);
        return { content: [{ type: 'text', text: `Motion tracked: ${result.keyframeCount} keyframes generated` }] };
      }
    );

    this.server.tool(
      'ae_particle_system',
      'Create a particle system effect (confetti, sparks, snow, fire, magic dust)',
      {
        compName: z.string().optional(),
        type: z.enum(['confetti', 'sparks', 'snow', 'fire', 'smoke', 'magic_dust', 'rain', 'stars', 'custom']),
        emitterPosition: z.tuple([z.number(), z.number()]).optional(),
        color: z.string().optional(),
        intensity: z.number().min(1).max(10).default(5),
        duration: z.number().default(3),
      },
      async (params) => {
        await this.bridge.send('aftereffects', 'vfx.particles', params);
        return { content: [{ type: 'text', text: `Particle system "${params.type}" created` }] };
      }
    );
  }

  // ── DYNAMIC LINK ───────────────────────────────────────────────────────

  _registerDynamicLinkTools() {
    this.server.tool(
      'ae_dynamic_link_to_premiere',
      'Send an After Effects composition to Premiere Pro via Dynamic Link',
      {
        compName: z.string().describe('Name of the AE composition to link'),
        premiereSequence: z.string().optional().describe('Target Premiere sequence'),
        trackIndex: z.number().default(1),
        startTime: z.number().default(0),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'dynamicLink.toPremiere', params);
        return {
          content: [{
            type: 'text',
            text: `Dynamic Link created: AE comp "${params.compName}" → Premiere V${params.trackIndex + 1} at ${params.startTime}s`,
          }],
        };
      }
    );

    this.server.tool(
      'ae_replace_with_ae_comp',
      'Replace a Premiere Pro clip with an After Effects composition via Dynamic Link',
      {
        premiereTrack: z.number(),
        premiereClipIndex: z.number(),
        createNew: z.boolean().default(true).describe('Create a new AE comp from the clip'),
        compName: z.string().optional().describe('Existing comp to use (if createNew is false)'),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'dynamicLink.replaceClip', params);
        return { content: [{ type: 'text', text: `Clip replaced with AE comp "${result.compName}"` }] };
      }
    );
  }

  // ── RENDER ─────────────────────────────────────────────────────────────

  _registerRenderTools() {
    this.server.tool(
      'ae_render',
      'Add composition to the render queue and start rendering',
      {
        compName: z.string().optional(),
        outputPath: z.string(),
        format: z.enum(['prores_422', 'prores_4444', 'h264', 'h265', 'png_sequence', 'exr_sequence', 'gif']).default('prores_4444'),
        quality: z.enum(['draft', 'standard', 'best']).default('best'),
      },
      async (params) => {
        const result = await this.bridge.send('aftereffects', 'render.start', params);
        return { content: [{ type: 'text', text: `Render started: ${params.format} → ${params.outputPath}` }] };
      }
    );
  }

  // ── SERVER START ───────────────────────────────────────────────────────

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.success('After Effects MCP Server running on stdio');
  }
}

// ── Standalone Launch ────────────────────────────────────────────────────
const isMainModule = process.argv[1] && process.argv[1].includes('aftereffects-server');

if (isMainModule) {
  const server = new AfterEffectsMCPServer();
  server.start().catch((err) => {
    console.error('Failed to start After Effects MCP Server:', err);
    process.exit(1);
  });
}

export { AfterEffectsMCPServer };
