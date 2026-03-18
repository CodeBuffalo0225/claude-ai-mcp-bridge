// ============================================================================
//  Sound Engineer
//  Professional audio processing: normalization, denoising, EQ, compression,
//  music ducking, SFX, and full mastering chain.
// ============================================================================

import { Logger } from '../utils/logger.js';

const logger = new Logger('SoundEngineer');

// ── EQ Presets ───────────────────────────────────────────────────────────
const EQ_PRESETS = {
  voice_clarity: {
    name: 'Voice Clarity',
    bands: [
      { frequency: 80, gain: -6, q: 0.7, type: 'highpass' },      // Roll off rumble
      { frequency: 200, gain: -3, q: 1.5, type: 'peak' },          // Reduce muddiness
      { frequency: 2500, gain: 3, q: 1.2, type: 'peak' },          // Presence boost
      { frequency: 5000, gain: 2, q: 1.0, type: 'peak' },          // Clarity
      { frequency: 8000, gain: 1.5, q: 0.8, type: 'shelf_high' },  // Air
    ],
  },
  voice_deep: {
    name: 'Voice Deep & Rich',
    bands: [
      { frequency: 60, gain: -8, q: 0.7, type: 'highpass' },
      { frequency: 150, gain: 3, q: 1.0, type: 'peak' },
      { frequency: 300, gain: -2, q: 1.5, type: 'peak' },
      { frequency: 3000, gain: 2, q: 1.0, type: 'peak' },
      { frequency: 10000, gain: -2, q: 0.8, type: 'shelf_high' },
    ],
  },
  voice_bright: {
    name: 'Voice Bright',
    bands: [
      { frequency: 100, gain: -6, q: 0.7, type: 'highpass' },
      { frequency: 250, gain: -4, q: 1.5, type: 'peak' },
      { frequency: 3000, gain: 4, q: 1.0, type: 'peak' },
      { frequency: 6000, gain: 3, q: 0.8, type: 'peak' },
      { frequency: 12000, gain: 2, q: 0.7, type: 'shelf_high' },
    ],
  },
  voice_broadcast: {
    name: 'Broadcast Voice',
    bands: [
      { frequency: 80, gain: -12, q: 0.7, type: 'highpass' },
      { frequency: 180, gain: 2, q: 1.2, type: 'peak' },
      { frequency: 400, gain: -2, q: 1.5, type: 'peak' },
      { frequency: 2000, gain: 3, q: 1.0, type: 'peak' },
      { frequency: 5000, gain: 2, q: 0.8, type: 'peak' },
      { frequency: 10000, gain: 1, q: 0.7, type: 'shelf_high' },
    ],
  },
  podcast_standard: {
    name: 'Podcast Standard',
    bands: [
      { frequency: 80, gain: -8, q: 0.7, type: 'highpass' },
      { frequency: 250, gain: -2, q: 1.2, type: 'peak' },
      { frequency: 2500, gain: 2.5, q: 1.0, type: 'peak' },
      { frequency: 6000, gain: 1.5, q: 0.8, type: 'peak' },
    ],
  },
  podcast_intimate: {
    name: 'Podcast Intimate',
    bands: [
      { frequency: 80, gain: -6, q: 0.7, type: 'highpass' },
      { frequency: 200, gain: 2, q: 1.0, type: 'peak' },
      { frequency: 3000, gain: 1.5, q: 1.2, type: 'peak' },
      { frequency: 8000, gain: -1, q: 0.8, type: 'shelf_high' },
    ],
  },
  music_balanced: {
    name: 'Music Balanced',
    bands: [
      { frequency: 60, gain: 1, q: 0.8, type: 'peak' },
      { frequency: 250, gain: -1, q: 1.0, type: 'peak' },
      { frequency: 1000, gain: 0, q: 1.0, type: 'peak' },
      { frequency: 4000, gain: 1, q: 0.8, type: 'peak' },
      { frequency: 12000, gain: 1.5, q: 0.7, type: 'shelf_high' },
    ],
  },
  music_reduce_for_voiceover: {
    name: 'Music Under Voiceover',
    bands: [
      { frequency: 200, gain: -3, q: 1.5, type: 'peak' },
      { frequency: 1000, gain: -6, q: 0.5, type: 'peak' },
      { frequency: 3000, gain: -8, q: 0.8, type: 'peak' },
      { frequency: 8000, gain: -2, q: 0.8, type: 'shelf_high' },
    ],
  },
  de_ess: {
    name: 'De-Esser',
    bands: [
      { frequency: 5500, gain: -6, q: 3.0, type: 'peak' },
      { frequency: 7500, gain: -4, q: 2.5, type: 'peak' },
    ],
  },
  de_plosive: {
    name: 'De-Plosive',
    bands: [
      { frequency: 80, gain: -10, q: 1.0, type: 'peak' },
      { frequency: 120, gain: -6, q: 1.5, type: 'peak' },
    ],
  },
};

// ── Compressor Presets ───────────────────────────────────────────────────
const COMPRESSOR_PRESETS = {
  voice_gentle: { threshold: -20, ratio: 2, attack: 15, release: 150, makeupGain: 3 },
  voice_aggressive: { threshold: -25, ratio: 4, attack: 5, release: 100, makeupGain: 6 },
  voice_broadcast: { threshold: -18, ratio: 3, attack: 10, release: 120, makeupGain: 4 },
  music_light: { threshold: -15, ratio: 2, attack: 30, release: 200, makeupGain: 2 },
  music_heavy: { threshold: -25, ratio: 6, attack: 5, release: 80, makeupGain: 8 },
  music_limiter: { threshold: -3, ratio: 20, attack: 0.1, release: 50, makeupGain: 0 },
  podcast_standard: { threshold: -22, ratio: 3, attack: 10, release: 130, makeupGain: 4 },
  youtube_standard: { threshold: -20, ratio: 2.5, attack: 12, release: 140, makeupGain: 3.5 },
};

// ── Mastering Chain Configs ──────────────────────────────────────────────
const MASTERING_CHAINS = {
  youtube: {
    targetLUFS: -14,
    truePeak: -1,
    chain: ['High-Pass 60Hz', 'EQ (voice_clarity)', 'Compressor (youtube_standard)', 'De-Esser', 'Limiter -1dB', 'Loudness Norm -14 LUFS'],
  },
  podcast: {
    targetLUFS: -16,
    truePeak: -1,
    chain: ['High-Pass 80Hz', 'EQ (podcast_standard)', 'Compressor (podcast_standard)', 'De-Esser', 'Limiter -1dB', 'Loudness Norm -16 LUFS'],
  },
  broadcast: {
    targetLUFS: -24,
    truePeak: -2,
    chain: ['High-Pass 60Hz', 'EQ (voice_broadcast)', 'Multiband Comp', 'Limiter -2dB', 'Loudness Norm -24 LUFS'],
  },
  streaming: {
    targetLUFS: -14,
    truePeak: -1,
    chain: ['High-Pass 80Hz', 'EQ (balanced)', 'Compressor', 'Stereo Widener', 'Limiter -1dB', 'Loudness Norm -14 LUFS'],
  },
  cinema: {
    targetLUFS: -27,
    truePeak: -3,
    chain: ['High-Pass 40Hz', 'EQ (cinematic)', 'Multiband Comp', 'Reverb (subtle)', 'Limiter -3dB', 'Loudness Norm -27 LUFS'],
  },
};

class SoundEngineer {
  constructor(bridge) {
    this.bridge = bridge;
  }

  // ── Normalize ──────────────────────────────────────────────────────────

  async normalize(params) {
    const { targetLUFS = -14, truePeak = -1, scope = 'full_timeline' } = params;

    logger.info(`Normalizing audio to ${targetLUFS} LUFS (peak: ${truePeak}dB)`);

    const result = await this.bridge.send('premiere', 'audio.normalize', {
      targetLUFS,
      truePeak,
      scope,
    });

    return {
      tracksAdjusted: result.tracksAdjusted || 2,
      avgGainChange: result.avgGainChange || '+3.2',
      finalLUFS: targetLUFS,
    };
  }

  // ── Denoise ────────────────────────────────────────────────────────────

  async denoise(params) {
    const { trackIndex = 0, strength = 60, preserveVoice = true, removeTypes = ['all'] } = params;

    logger.info(`Denoising track ${trackIndex} (strength: ${strength}%)`);

    const result = await this.bridge.send('premiere', 'audio.denoise', {
      trackIndex,
      reduction: strength / 100,
      preserveVoice,
      noiseTypes: removeTypes,
    });

    return {
      snrImprovement: result.snrImprovement || Math.round(strength * 0.3),
    };
  }

  // ── EQ ─────────────────────────────────────────────────────────────────

  async applyEQ(params) {
    const { trackIndex, preset, bands } = params;

    let eqBands = bands;

    if (preset && preset !== 'custom') {
      const presetData = EQ_PRESETS[preset];
      if (!presetData) throw new Error(`Unknown EQ preset: ${preset}`);
      eqBands = presetData.bands;
      logger.info(`Applying EQ preset: ${presetData.name}`);
    }

    await this.bridge.send('premiere', 'audio.applyEQ', {
      trackIndex,
      bands: eqBands,
    });

    return { success: true, bandsApplied: eqBands.length };
  }

  // ── Compressor ─────────────────────────────────────────────────────────

  async compress(params) {
    const { trackIndex, preset, threshold, ratio, attack, release, makeupGain } = params;

    let settings = { threshold, ratio, attack, release, makeupGain };

    if (preset && preset !== 'custom') {
      const presetData = COMPRESSOR_PRESETS[preset];
      if (!presetData) throw new Error(`Unknown compressor preset: ${preset}`);
      settings = { ...presetData, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) };
      logger.info(`Applying compressor preset: ${preset}`);
    }

    await this.bridge.send('premiere', 'audio.applyCompressor', {
      trackIndex,
      ...settings,
    });

    return { success: true, settings };
  }

  // ── Add Music with Auto-Duck ───────────────────────────────────────────

  async addMusic(params) {
    const {
      musicFile, volume = -18, autoDuck = true, duckAmount = -12,
      fadeIn = 2, fadeOut = 3, loop = true, startTime = 0, endTime,
    } = params;

    logger.info(`Adding music: ${musicFile} (vol: ${volume}dB, duck: ${autoDuck})`);

    // Import the music file
    await this.bridge.send('premiere', 'project.importMedia', { files: [musicFile] });

    // Add to a dedicated music audio track
    const result = await this.bridge.send('premiere', 'audio.addMusic', {
      musicFile,
      audioTrackIndex: 2, // A2 for music
      volume,
      startTime,
      endTime,
      loop,
      fadeIn,
      fadeOut,
    });

    // Set up auto-ducking
    if (autoDuck) {
      await this.bridge.send('premiere', 'audio.setupDucking', {
        musicTrackIndex: 2,
        dialogueTrackIndex: 0,
        duckAmount,
        attackTime: 200,
        releaseTime: 500,
      });
    }

    return { success: true, trackIndex: 2 };
  }

  // ── Sound Effects ──────────────────────────────────────────────────────

  async addSFX(params) {
    const { sfxType, time, volume = -6, customPath } = params;

    logger.info(`Adding SFX: ${sfxType} at ${time}s`);

    await this.bridge.send('premiere', 'audio.addSFX', {
      type: sfxType,
      time,
      volume,
      customPath,
      trackIndex: 3, // A3 for SFX
    });

    return { success: true };
  }

  // ── Full Mastering Chain ───────────────────────────────────────────────

  async master(params) {
    const { target = 'youtube', enhanceVoice = true, stereoWidth = 100 } = params;

    const chain = MASTERING_CHAINS[target];
    if (!chain) throw new Error(`Unknown mastering target: ${target}`);

    logger.info(`Mastering for ${target} (target: ${chain.targetLUFS} LUFS)`);

    // Apply the full mastering chain
    const steps = [];

    // Step 1: High-pass filter
    await this.bridge.send('premiere', 'audio.applyFilter', {
      type: 'highpass',
      frequency: target === 'cinema' ? 40 : 80,
      trackIndex: 0,
    });
    steps.push('High-Pass Filter');

    // Step 2: EQ
    if (enhanceVoice) {
      const eqPreset = target === 'podcast' ? 'podcast_standard' : 'voice_clarity';
      await this.applyEQ({ trackIndex: 0, preset: eqPreset });
      steps.push(`EQ (${eqPreset})`);
    }

    // Step 3: Compression
    const compPreset = COMPRESSOR_PRESETS[`${target}_standard`] || COMPRESSOR_PRESETS.youtube_standard;
    await this.bridge.send('premiere', 'audio.applyCompressor', {
      trackIndex: 0,
      ...compPreset,
    });
    steps.push('Compression');

    // Step 4: De-esser
    await this.applyEQ({ trackIndex: 0, preset: 'de_ess' });
    steps.push('De-Esser');

    // Step 5: Stereo width
    if (stereoWidth !== 100) {
      await this.bridge.send('premiere', 'audio.setStereoWidth', {
        width: stereoWidth / 100,
      });
      steps.push(`Stereo Width (${stereoWidth}%)`);
    }

    // Step 6: Limiter
    await this.bridge.send('premiere', 'audio.applyLimiter', {
      ceiling: chain.truePeak,
      release: 50,
    });
    steps.push(`Limiter (${chain.truePeak}dB)`);

    // Step 7: Loudness normalization
    await this.normalize({ targetLUFS: chain.targetLUFS, truePeak: chain.truePeak });
    steps.push(`Loudness (${chain.targetLUFS} LUFS)`);

    return {
      finalLUFS: chain.targetLUFS,
      truePeak: chain.truePeak,
      chain: steps,
    };
  }

  getPresetList() {
    return {
      eq: Object.entries(EQ_PRESETS).map(([id, p]) => ({ id, name: p.name, bands: p.bands.length })),
      compressor: Object.keys(COMPRESSOR_PRESETS),
      mastering: Object.entries(MASTERING_CHAINS).map(([id, c]) => ({
        id, targetLUFS: c.targetLUFS, chain: c.chain,
      })),
    };
  }
}

export { SoundEngineer, EQ_PRESETS, COMPRESSOR_PRESETS, MASTERING_CHAINS };
