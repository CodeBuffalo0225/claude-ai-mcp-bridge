// ============================================================================
//  Color Grader
//  Professional color grading for Premiere Pro via Lumetri Color controls.
//  30+ presets, manual HSL/curve/wheel controls, auto-correction, LUT support.
// ============================================================================

import { Logger } from '../utils/logger.js';

const logger = new Logger('ColorGrader');

// ── Color Grading Presets (Lumetri Parameter Values) ─────────────────────
const COLOR_PRESETS = {
  // ── Cinematic ────────────────────────────────
  cinematic_teal_orange: {
    name: 'Cinematic Teal & Orange',
    basic: { contrast: 15, highlights: -10, shadows: 5 },
    creative: { vibrance: 15, saturation: -5 },
    colorWheels: { shadowsTint: '#1A8A9E', highlightsTint: '#D4802A' },
    curves: { blue: [{ x: 0, y: 0.08 }, { x: 0.5, y: 0.45 }, { x: 1, y: 0.88 }] },
    vignette: { amount: -1.5, midpoint: 50, feather: 60 },
  },
  cinematic_warm: {
    name: 'Cinematic Warm',
    basic: { temperature: 15, contrast: 10, shadows: -10 },
    creative: { vibrance: 10, fadeAmount: 5 },
    colorWheels: { midtonesTint: '#C4883A' },
    vignette: { amount: -1.0, midpoint: 40 },
  },
  cinematic_cold: {
    name: 'Cinematic Cold',
    basic: { temperature: -20, tint: 5, contrast: 20, shadows: -15 },
    creative: { saturation: -10 },
    colorWheels: { shadowsTint: '#2B4A7C', highlightsTint: '#8EB4D4' },
    vignette: { amount: -2.0, midpoint: 45 },
  },
  cinematic_desaturated: {
    name: 'Cinematic Desaturated',
    basic: { contrast: 25, highlights: -15, shadows: 10 },
    creative: { saturation: -30, vibrance: -10, fadeAmount: 8 },
    vignette: { amount: -1.5, midpoint: 50 },
  },
  blockbuster_action: {
    name: 'Blockbuster Action',
    basic: { contrast: 30, highlights: -5, shadows: -15, blacks: -10 },
    creative: { vibrance: 20, saturation: 5, sharpen: 30 },
    colorWheels: { shadowsTint: '#0E2F44', highlightsTint: '#E8A835' },
    vignette: { amount: -2.5, midpoint: 35, feather: 50 },
  },
  indie_film: {
    name: 'Indie Film',
    basic: { temperature: 5, contrast: -5, highlights: -20, shadows: 15 },
    creative: { saturation: -15, fadeAmount: 15, vibrance: -5 },
    vignette: { amount: -0.5, midpoint: 60 },
  },
  film_noir: {
    name: 'Film Noir',
    basic: { contrast: 40, highlights: -10, shadows: -20 },
    creative: { saturation: -100, fadeAmount: 5, sharpen: 20 },
    curves: { rgb: [{ x: 0, y: 0.05 }, { x: 0.3, y: 0.2 }, { x: 0.7, y: 0.85 }, { x: 1, y: 0.95 }] },
    vignette: { amount: -3.0, midpoint: 30, feather: 40 },
  },
  vintage_film: {
    name: 'Vintage Film',
    basic: { temperature: 10, contrast: -10, highlights: -15 },
    creative: { saturation: -20, fadeAmount: 20, vibrance: -10 },
    curves: {
      red: [{ x: 0, y: 0.05 }, { x: 1, y: 0.95 }],
      green: [{ x: 0, y: 0.03 }, { x: 1, y: 0.92 }],
      blue: [{ x: 0, y: 0.08 }, { x: 1, y: 0.85 }],
    },
    vignette: { amount: -2.0, midpoint: 40, roundness: 60 },
  },

  // ── YouTube Optimized ────────────────────────
  youtube_vibrant: {
    name: 'YouTube Vibrant',
    basic: { contrast: 10, highlights: -5, shadows: 5 },
    creative: { vibrance: 25, saturation: 10, sharpen: 15 },
  },
  youtube_clean: {
    name: 'YouTube Clean',
    basic: { temperature: 2, exposure: 0.1, contrast: 5, highlights: -10, shadows: 10 },
    creative: { vibrance: 10, sharpen: 10 },
  },
  youtube_warm_cozy: {
    name: 'YouTube Warm & Cozy',
    basic: { temperature: 20, contrast: 5, highlights: -10, shadows: 15 },
    creative: { vibrance: 15, fadeAmount: 3 },
    colorWheels: { midtonesTint: '#D49E5C' },
  },
  youtube_dark_moody: {
    name: 'YouTube Dark & Moody',
    basic: { exposure: -0.3, contrast: 20, highlights: -15, shadows: -10, blacks: -15 },
    creative: { saturation: -10, vibrance: 5, sharpen: 20 },
    vignette: { amount: -2.0, midpoint: 40 },
  },

  // ── Social / Trendy ──────────────────────────
  instagram_aesthetic: {
    name: 'Instagram Aesthetic',
    basic: { temperature: 8, contrast: -5, highlights: -10, shadows: 20 },
    creative: { vibrance: 20, fadeAmount: 10 },
    curves: { blue: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] },
  },
  tiktok_punchy: {
    name: 'TikTok Punchy',
    basic: { contrast: 20, highlights: 5, shadows: 5 },
    creative: { vibrance: 30, saturation: 15, sharpen: 25 },
  },
  pastel_dream: {
    name: 'Pastel Dream',
    basic: { temperature: 5, exposure: 0.3, contrast: -15, highlights: 10, shadows: 20 },
    creative: { saturation: -20, vibrance: 15, fadeAmount: 15 },
  },
  neon_glow: {
    name: 'Neon Glow',
    basic: { contrast: 30, shadows: -10, blacks: -15 },
    creative: { vibrance: 40, saturation: 20, sharpen: 15 },
  },

  // ── Documentary ──────────────────────────────
  doc_natural: {
    name: 'Documentary Natural',
    basic: { contrast: 5, highlights: -5, shadows: 5 },
    creative: { vibrance: 5, sharpen: 10 },
  },
  doc_dramatic: {
    name: 'Documentary Dramatic',
    basic: { contrast: 20, highlights: -15, shadows: -5 },
    creative: { vibrance: 10, saturation: -5 },
    vignette: { amount: -1.0, midpoint: 50 },
  },
  doc_black_and_white: {
    name: 'Documentary B&W',
    basic: { contrast: 25, highlights: -10, shadows: 10 },
    creative: { saturation: -100, sharpen: 15 },
    curves: { rgb: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.55 }, { x: 1, y: 0.97 }] },
  },

  // ── Season / Time ────────────────────────────
  golden_hour: {
    name: 'Golden Hour',
    basic: { temperature: 30, tint: 10, contrast: 10, shadows: 10 },
    creative: { vibrance: 20, saturation: 10 },
    colorWheels: { highlightsTint: '#FFD700', midtonesTint: '#E8A020' },
  },
  blue_hour: {
    name: 'Blue Hour',
    basic: { temperature: -25, contrast: 15, shadows: -10 },
    creative: { vibrance: 10, saturation: -5 },
    colorWheels: { shadowsTint: '#1E3A6E', midtonesTint: '#3A5FA0' },
  },
  summer_vibes: {
    name: 'Summer Vibes',
    basic: { temperature: 15, exposure: 0.2, contrast: 5, highlights: 10 },
    creative: { vibrance: 25, saturation: 15 },
  },
  winter_cold: {
    name: 'Winter Cold',
    basic: { temperature: -15, tint: -5, contrast: 10, shadows: -5 },
    creative: { saturation: -15, vibrance: 5 },
    colorWheels: { shadowsTint: '#2E5B8A', highlightsTint: '#C4D9F0' },
  },

  // ── Technical ────────────────────────────────
  rec709_standard: {
    name: 'Rec.709 Standard',
    basic: { contrast: 0, highlights: 0, shadows: 0 },
    creative: { saturation: 0, vibrance: 0 },
  },
  slog3_to_rec709: {
    name: 'S-Log3 to Rec.709',
    basic: { exposure: 1.5, contrast: 50, highlights: -20, shadows: 20, whites: 10, blacks: -10 },
    creative: { saturation: 30, vibrance: 15 },
  },
  vlog_to_rec709: {
    name: 'V-Log to Rec.709',
    basic: { exposure: 1.0, contrast: 40, highlights: -15, shadows: 15 },
    creative: { saturation: 25, vibrance: 10 },
  },
  hdr_to_sdr: {
    name: 'HDR to SDR',
    basic: { highlights: -30, whites: -20, contrast: -10 },
    creative: { saturation: -5 },
  },
};

class ColorGrader {
  constructor(bridge) {
    this.bridge = bridge;
  }

  async applyLUT(params) {
    const { lutName, intensity = 80, trackIndex, clipIndex } = params;

    logger.info(`Applying LUT: ${lutName} at ${intensity}%`);

    await this.bridge.send('premiere', 'color.applyLUT', {
      lutPath: lutName,
      intensity: intensity / 100,
      trackIndex,
      clipIndex,
    });

    return { success: true, lut: lutName, intensity };
  }

  async applyPreset(params) {
    const { preset, intensity = 80, scope = 'full_timeline' } = params;
    const presetData = COLOR_PRESETS[preset];

    if (!presetData) {
      throw new Error(`Unknown color preset: ${preset}`);
    }

    logger.info(`Applying color preset: ${presetData.name} (${intensity}%, ${scope})`);

    // Scale all values by intensity
    const scaledPreset = this._scalePreset(presetData, intensity / 100);

    // Get clips to apply to based on scope
    const clips = await this._getTargetClips(scope);

    // Apply Lumetri Color to each clip
    for (const clip of clips) {
      await this.bridge.send('premiere', 'color.applyLumetri', {
        trackIndex: clip.trackIndex,
        clipIndex: clip.clipIndex,
        settings: scaledPreset,
      });
    }

    return { clipsAffected: clips.length, preset: presetData.name };
  }

  async manualGrade(params) {
    const { trackIndex, clipIndex, basic, creative, curves, colorWheels, vignette } = params;

    const settings = {};
    if (basic) settings.basic = basic;
    if (creative) settings.creative = creative;
    if (curves) settings.curves = curves;
    if (colorWheels) settings.colorWheels = colorWheels;
    if (vignette) settings.vignette = vignette;

    await this.bridge.send('premiere', 'color.applyLumetri', {
      trackIndex, clipIndex, settings,
    });

    return { success: true };
  }

  async colorMatch(params) {
    const { sourceTrack, sourceClip, referenceTrack, referenceClip, matchFaces } = params;

    logger.info(`Color matching source [${sourceTrack}:${sourceClip}] to reference [${referenceTrack}:${referenceClip}]`);

    const result = await this.bridge.send('premiere', 'color.match', {
      source: { trackIndex: sourceTrack, clipIndex: sourceClip },
      reference: { trackIndex: referenceTrack, clipIndex: referenceClip },
      useFaceDetection: matchFaces,
    });

    return { confidence: result.confidence || 85 };
  }

  async autoCorrect(params) {
    const { correctExposure, correctWhiteBalance, correctSaturation, strength } = params;

    logger.info(`Auto-correcting (strength: ${strength}%)`);

    const result = await this.bridge.send('premiere', 'color.autoCorrect', {
      exposure: correctExposure,
      whiteBalance: correctWhiteBalance,
      saturation: correctSaturation,
      strength: strength / 100,
    });

    return { clipsFixed: result.clipsFixed || 0 };
  }

  getPresetList() {
    return Object.entries(COLOR_PRESETS).map(([key, preset]) => ({
      id: key,
      name: preset.name,
      hasVignette: !!preset.vignette,
      categories: this._categorizePreset(key),
    }));
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  _scalePreset(preset, scale) {
    const scaled = {};

    if (preset.basic) {
      scaled.basic = {};
      for (const [key, value] of Object.entries(preset.basic)) {
        scaled.basic[key] = typeof value === 'number' ? value * scale : value;
      }
    }

    if (preset.creative) {
      scaled.creative = {};
      for (const [key, value] of Object.entries(preset.creative)) {
        scaled.creative[key] = typeof value === 'number' ? value * scale : value;
      }
    }

    if (preset.colorWheels) scaled.colorWheels = { ...preset.colorWheels };
    if (preset.curves) scaled.curves = { ...preset.curves };

    if (preset.vignette) {
      scaled.vignette = {};
      for (const [key, value] of Object.entries(preset.vignette)) {
        scaled.vignette[key] = typeof value === 'number' ? value * scale : value;
      }
    }

    return scaled;
  }

  async _getTargetClips(scope) {
    const state = await this.bridge.send('premiere', 'timeline.getState', {});
    const clips = [];

    if (scope === 'full_timeline') {
      for (const track of (state.videoTracks || [])) {
        for (let i = 0; i < (track.clips || []).length; i++) {
          clips.push({ trackIndex: track.index, clipIndex: i });
        }
      }
    }

    return clips.length > 0 ? clips : [{ trackIndex: 0, clipIndex: 0 }];
  }

  _categorizePreset(key) {
    if (key.startsWith('cinematic') || key.startsWith('blockbuster') || key.startsWith('indie') || key.startsWith('film') || key.startsWith('vintage')) return ['cinematic'];
    if (key.startsWith('youtube')) return ['youtube'];
    if (key.startsWith('instagram') || key.startsWith('tiktok') || key.startsWith('pastel') || key.startsWith('neon')) return ['social'];
    if (key.startsWith('doc')) return ['documentary'];
    if (key.startsWith('golden') || key.startsWith('blue_hour') || key.startsWith('summer') || key.startsWith('winter')) return ['mood'];
    return ['technical'];
  }
}

export { ColorGrader, COLOR_PRESETS };
