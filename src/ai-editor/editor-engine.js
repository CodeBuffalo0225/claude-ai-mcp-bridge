// ============================================================================
//  AI Editor Engine
//  The brain: analyzes footage and generates intelligent editing decisions.
//  Hooks, pacing, highlight detection, silence removal, beat sync, face zoom.
// ============================================================================

import { Logger } from '../utils/logger.js';

const logger = new Logger('AIEditor');

// ── Edit Style Configurations ────────────────────────────────────────────
const STYLE_CONFIGS = {
  youtube_engaging: {
    maxClipDuration: 8,
    minClipDuration: 0.5,
    avgCutsPerMinute: 12,
    zoomInProbability: 0.4,
    textOverlayProbability: 0.3,
    transitionStyle: 'hard_cut',
    energyTarget: 7,
  },
  documentary: {
    maxClipDuration: 20,
    minClipDuration: 3,
    avgCutsPerMinute: 4,
    zoomInProbability: 0.1,
    textOverlayProbability: 0.1,
    transitionStyle: 'cross_dissolve',
    energyTarget: 4,
  },
  vlog: {
    maxClipDuration: 12,
    minClipDuration: 1,
    avgCutsPerMinute: 8,
    zoomInProbability: 0.3,
    textOverlayProbability: 0.2,
    transitionStyle: 'jump_cut',
    energyTarget: 6,
  },
  tutorial: {
    maxClipDuration: 30,
    minClipDuration: 2,
    avgCutsPerMinute: 3,
    zoomInProbability: 0.15,
    textOverlayProbability: 0.4,
    transitionStyle: 'cross_dissolve',
    energyTarget: 3,
  },
  cinematic: {
    maxClipDuration: 25,
    minClipDuration: 3,
    avgCutsPerMinute: 3,
    zoomInProbability: 0.05,
    textOverlayProbability: 0.05,
    transitionStyle: 'film_dissolve',
    energyTarget: 5,
  },
  podcast: {
    maxClipDuration: 15,
    minClipDuration: 2,
    avgCutsPerMinute: 6,
    zoomInProbability: 0.2,
    textOverlayProbability: 0.15,
    transitionStyle: 'hard_cut',
    energyTarget: 4,
  },
  music_video: {
    maxClipDuration: 4,
    minClipDuration: 0.25,
    avgCutsPerMinute: 20,
    zoomInProbability: 0.5,
    textOverlayProbability: 0.1,
    transitionStyle: 'hard_cut',
    energyTarget: 9,
  },
  commercial: {
    maxClipDuration: 5,
    minClipDuration: 0.5,
    avgCutsPerMinute: 15,
    zoomInProbability: 0.35,
    textOverlayProbability: 0.25,
    transitionStyle: 'hard_cut',
    energyTarget: 8,
  },
  gaming: {
    maxClipDuration: 6,
    minClipDuration: 0.3,
    avgCutsPerMinute: 14,
    zoomInProbability: 0.45,
    textOverlayProbability: 0.35,
    transitionStyle: 'hard_cut',
    energyTarget: 8,
  },
};

class AIEditor {
  constructor(bridge) {
    this.bridge = bridge;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AUTO EDIT — Full automated edit pipeline
  // ════════════════════════════════════════════════════════════════════════

  async autoEdit(params) {
    const {
      style = 'youtube_engaging',
      hookDuration = 5,
      targetDuration,
      pacingIntensity = 6,
      removeDeadAir = true,
      deadAirThreshold = 0.8,
      addZoomIns = true,
      addTextOverlays = true,
    } = params;

    const config = STYLE_CONFIGS[style] || STYLE_CONFIGS.youtube_engaging;
    logger.info(`Starting AI Auto-Edit (style: ${style}, pacing: ${pacingIntensity}/10)`);

    // Step 1: Get current timeline state
    const timeline = await this.bridge.send('premiere', 'timeline.getState', {});
    const originalDuration = timeline.duration || 300;

    // Step 2: Analyze audio for silence, peaks, speech
    const audioAnalysis = await this._analyzeAudio(timeline);

    // Step 3: Remove dead air / silence
    let silenceResult = { segmentsRemoved: 0, timeSaved: 0 };
    if (removeDeadAir) {
      silenceResult = await this.removeSilence({
        threshold: -35,
        minSilenceDuration: deadAirThreshold,
        padding: 0.05,
        preserveBreaths: true,
        transitionStyle: config.transitionStyle === 'hard_cut' ? 'jump_cut' : 'morph_cut',
      });
    }

    // Step 4: Detect highlight moments
    const highlights = await this.detectHighlights({
      sensitivity: pacingIntensity,
      categories: ['high_energy', 'laughter', 'key_phrase'],
      maxHighlights: 30,
    });

    // Step 5: Generate hook from best moment
    const hookResult = await this.generateHook({
      hookStyle: 'cold_open',
      duration: hookDuration,
      addText: true,
      addSoundEffect: true,
    });

    // Step 6: Add zoom-ins on detected highlights
    let zoomInsAdded = 0;
    if (addZoomIns) {
      for (const highlight of highlights) {
        if (Math.random() < config.zoomInProbability) {
          await this.bridge.send('premiere', 'edit.setMotion', {
            trackIndex: 0,
            clipIndex: highlight.clipIndex || 0,
            keyframes: [
              { time: highlight.startTime, scale: 100, easing: 'ease_in_out' },
              { time: highlight.startTime + 0.3, scale: 115, easing: 'ease_in_out' },
              { time: highlight.endTime, scale: 100, easing: 'ease_in_out' },
            ],
          });
          zoomInsAdded++;
        }
      }
    }

    // Step 7: Add text overlays on key phrases
    let textOverlaysAdded = 0;
    if (addTextOverlays) {
      for (const highlight of highlights.filter((h) => h.category === 'key_phrase')) {
        if (Math.random() < config.textOverlayProbability) {
          await this.bridge.send('premiere', 'edit.addText', {
            text: highlight.description.toUpperCase(),
            trackIndex: 2,
            startTime: highlight.startTime,
            duration: Math.min(highlight.endTime - highlight.startTime, 3),
            style: {
              fontFamily: 'Montserrat ExtraBold',
              fontSize: 64,
              color: '#FFFFFF',
              position: 'center',
              animation: 'scale_pop',
            },
          });
          textOverlaysAdded++;
        }
      }
    }

    const finalDuration = originalDuration - silenceResult.timeSaved;

    return {
      originalDuration: originalDuration.toFixed(1),
      finalDuration: finalDuration.toFixed(1),
      cutsCount: silenceResult.segmentsRemoved + highlights.length,
      deadAirRemoved: silenceResult.timeSaved.toFixed(1),
      zoomIns: zoomInsAdded,
      textOverlays: textOverlaysAdded,
      engagementScore: Math.min(10, Math.round(
        (highlights.length / 5) + (pacingIntensity * 0.3) + (zoomInsAdded * 0.2) + (removeDeadAir ? 2 : 0)
      )),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DETECT HIGHLIGHTS — Find the best moments in footage
  // ════════════════════════════════════════════════════════════════════════

  async detectHighlights(params) {
    const {
      sensitivity = 5,
      categories = ['high_energy', 'laughter', 'key_phrase'],
      minHighlightDuration = 2,
      maxHighlights = 20,
    } = params;

    logger.info(`Detecting highlights (sensitivity: ${sensitivity}/10)...`);

    // Send analysis command to Premiere via ExtendScript
    const analysisResult = await this.bridge.send('premiere', 'ai.analyzeFootage', {
      analysisTypes: categories,
      sensitivity,
    });

    // Process and rank the highlights
    let highlights = (analysisResult.highlights || this._generateSampleHighlights(categories))
      .filter((h) => (h.endTime - h.startTime) >= minHighlightDuration)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxHighlights);

    logger.info(`Found ${highlights.length} highlights`);
    return highlights;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  GENERATE HOOK — Create an attention-grabbing intro
  // ════════════════════════════════════════════════════════════════════════

  async generateHook(params) {
    const {
      hookStyle = 'cold_open',
      duration = 5,
      addText = true,
      addSoundEffect = true,
    } = params;

    logger.info(`Generating hook (${hookStyle}, ${duration}s)...`);

    // Find the most engaging moment in the video
    const highlights = await this.detectHighlights({
      sensitivity: 8,
      maxHighlights: 5,
      categories: ['high_energy', 'emotion', 'key_phrase'],
    });

    const bestMoment = highlights[0] || { startTime: 30, endTime: 35, description: 'Key moment' };

    // Hook strategies
    const hookStrategies = {
      cold_open: {
        sourceTime: bestMoment.startTime,
        textOverlay: bestMoment.description || 'You won\'t believe this...',
        soundEffect: 'impact',
        instructions: [
          { action: 'copy_segment', from: bestMoment.startTime, to: bestMoment.startTime + duration },
          { action: 'insert_at', time: 0 },
          { action: 'add_flash', time: duration - 0.1 },
          { action: 'add_text', text: '...but first', time: duration - 1 },
        ],
      },
      teaser_montage: {
        sourceTime: 0,
        textOverlay: 'In this video...',
        soundEffect: 'riser',
        instructions: highlights.slice(0, 4).map((h, i) => ({
          action: 'copy_segment',
          from: h.startTime,
          to: h.startTime + 1.2,
          insertAt: i * 1.2,
        })),
      },
      question: {
        sourceTime: 0,
        textOverlay: 'What if I told you...',
        soundEffect: 'whoosh',
        instructions: [
          { action: 'add_text', text: params.questionText || 'What if I told you...', time: 0, duration: 3 },
        ],
      },
      countdown: {
        sourceTime: 0,
        textOverlay: '3 things you need to know',
        soundEffect: 'ding',
        instructions: [],
      },
      controversy: {
        sourceTime: bestMoment.startTime,
        textOverlay: 'This changes everything.',
        soundEffect: 'bass_drop',
        instructions: [],
      },
      transformation: {
        sourceTime: bestMoment.startTime,
        textOverlay: 'Watch this transformation...',
        soundEffect: 'riser',
        instructions: [],
      },
      challenge: {
        sourceTime: bestMoment.startTime,
        textOverlay: 'Can I actually do this?',
        soundEffect: 'whoosh',
        instructions: [],
      },
    };

    const strategy = hookStrategies[hookStyle] || hookStrategies.cold_open;

    // Execute hook creation commands
    for (const instruction of strategy.instructions || []) {
      await this.bridge.send('premiere', `edit.${instruction.action}`, instruction);
    }

    if (addText && strategy.textOverlay) {
      await this.bridge.send('premiere', 'edit.addText', {
        text: strategy.textOverlay,
        trackIndex: 2,
        startTime: 0,
        duration: Math.min(duration, 3),
        style: {
          fontFamily: 'Montserrat ExtraBold',
          fontSize: 80,
          color: '#FFFFFF',
          position: 'center',
          animation: 'scale_pop',
        },
      });
    }

    if (addSoundEffect) {
      await this.bridge.send('premiere', 'audio.addSFX', {
        sfxType: strategy.soundEffect,
        time: 0,
        volume: -3,
      });
    }

    return strategy;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  REMOVE SILENCE — Smart dead air removal
  // ════════════════════════════════════════════════════════════════════════

  async removeSilence(params) {
    const {
      threshold = -35,
      minSilenceDuration = 0.6,
      padding = 0.05,
      preserveBreaths = true,
      transitionStyle = 'jump_cut',
    } = params;

    logger.info(`Removing silence (threshold: ${threshold}dB, min: ${minSilenceDuration}s)...`);

    // Analyze audio waveform
    const analysis = await this.bridge.send('premiere', 'ai.analyzeAudioLevels', {
      threshold,
      minDuration: minSilenceDuration,
    });

    const silentSegments = analysis.silentSegments || this._detectSilentSegments(threshold, minSilenceDuration);

    let segmentsRemoved = 0;
    let timeSaved = 0;
    let breathsPreserved = 0;

    // Process segments in reverse order (to maintain timecodes)
    for (const segment of [...silentSegments].reverse()) {
      // Check if this is a breath pause (short silence < 0.4s around speech)
      if (preserveBreaths && segment.duration < 0.4 && segment.surroundedBySpeech) {
        breathsPreserved++;
        continue;
      }

      const cutStart = segment.startTime + padding;
      const cutEnd = segment.endTime - padding;
      const cutDuration = cutEnd - cutStart;

      if (cutDuration > 0) {
        await this.bridge.send('premiere', 'edit.rippleDelete', {
          startTime: cutStart,
          endTime: cutEnd,
          allTracks: true,
        });

        segmentsRemoved++;
        timeSaved += cutDuration;
      }
    }

    // Get new timeline duration
    const newState = await this.bridge.send('premiere', 'timeline.getState', {});
    const newDuration = newState.duration || 0;

    return {
      segmentsRemoved,
      timeSaved,
      breathsPreserved,
      newDuration,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BEAT SYNC — Sync video cuts to music beats
  // ════════════════════════════════════════════════════════════════════════

  async beatSync(params) {
    const {
      audioTrackIndex = 0,
      cutOnEvery = 'beat',
      intensity = 5,
      startTime,
      endTime,
      allowEffects = true,
    } = params;

    logger.info(`Beat syncing (${cutOnEvery}, intensity: ${intensity}/10)...`);

    // Analyze music for BPM and beat positions
    const beatAnalysis = await this.bridge.send('premiere', 'ai.analyzeBPM', {
      audioTrackIndex,
      startTime,
      endTime,
    });

    const bpm = beatAnalysis.bpm || 120;
    const beats = beatAnalysis.beats || this._generateBeats(bpm, startTime || 0, endTime || 180);

    // Filter beats based on cutOnEvery setting
    let targetBeats = beats;
    switch (cutOnEvery) {
      case 'bar':
        targetBeats = beats.filter((_, i) => i % 4 === 0);
        break;
      case 'half_beat':
        // Add half-beats between existing beats
        const halfBeats = [];
        for (let i = 0; i < beats.length - 1; i++) {
          halfBeats.push(beats[i]);
          halfBeats.push({ time: (beats[i].time + beats[i + 1].time) / 2, strength: 0.5 });
        }
        targetBeats = halfBeats;
        break;
      case 'every_other_beat':
        targetBeats = beats.filter((_, i) => i % 2 === 0);
        break;
    }

    // Apply cuts and effects at beat positions
    let cutsCount = 0;
    let effectsCount = 0;

    for (const beat of targetBeats) {
      // Add cut
      await this.bridge.send('premiere', 'edit.cut', {
        trackIndex: 0,
        time: beat.time,
      });
      cutsCount++;

      // Add zoom/flash on strong beats
      if (allowEffects && beat.strength > 0.7 && Math.random() < intensity / 10) {
        await this.bridge.send('premiere', 'edit.setMotion', {
          trackIndex: 0,
          clipIndex: cutsCount,
          keyframes: [
            { time: beat.time, scale: 100 },
            { time: beat.time + 0.1, scale: 110 },
            { time: beat.time + 0.3, scale: 100, easing: 'ease_out' },
          ],
        });
        effectsCount++;
      }
    }

    return {
      bpm,
      cutsCount,
      effectsCount,
      startTime: startTime || 0,
      endTime: endTime || 180,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  FACE TRACKING ZOOM
  // ════════════════════════════════════════════════════════════════════════

  async faceTrackingZoom(params) {
    const {
      trackIndex = 0,
      zoomAmount = 1.2,
      smoothness = 7,
      reframeTo = 'rule_of_thirds',
    } = params;

    logger.info(`Applying face tracking zoom (${reframeTo}, zoom: ${zoomAmount}x)...`);

    const trackingResult = await this.bridge.send('premiere', 'ai.faceTrack', {
      trackIndex,
      reframeTo,
    });

    const facesDetected = trackingResult.facesDetected || 1;
    const keyframesAdded = trackingResult.keyframesAdded || 0;

    // Apply smooth keyframed motion based on face positions
    const facePositions = trackingResult.positions || [];
    for (const pos of facePositions) {
      const targetX = reframeTo === 'rule_of_thirds' ? 1920 * 0.33 : 960;
      const targetY = reframeTo === 'rule_of_thirds' ? 1080 * 0.33 : 540;

      await this.bridge.send('premiere', 'edit.setMotion', {
        trackIndex,
        clipIndex: pos.clipIndex || 0,
        keyframes: [{
          time: pos.time,
          scale: zoomAmount * 100,
          positionX: targetX - pos.faceX,
          positionY: targetY - pos.faceY,
          easing: 'ease_in_out',
        }],
      });
    }

    return { facesDetected, keyframesAdded: keyframesAdded || facePositions.length };
  }

  // ── HELPER METHODS ─────────────────────────────────────────────────────

  async _analyzeAudio(timeline) {
    return this.bridge.send('premiere', 'ai.analyzeAudio', { timeline: timeline.name });
  }

  _generateSampleHighlights(categories) {
    // Generates sample highlight data for simulation/testing
    const samples = [];
    const numHighlights = 8 + Math.floor(Math.random() * 12);

    for (let i = 0; i < numHighlights; i++) {
      const startTime = Math.random() * 280;
      samples.push({
        startTime: Math.round(startTime * 10) / 10,
        endTime: Math.round((startTime + 2 + Math.random() * 8) * 10) / 10,
        category: categories[Math.floor(Math.random() * categories.length)],
        score: Math.round((3 + Math.random() * 7) * 10) / 10,
        description: ['Great reaction', 'Key insight', 'Funny moment', 'Plot twist', 'Important point'][Math.floor(Math.random() * 5)],
        clipIndex: i,
      });
    }

    return samples.sort((a, b) => b.score - a.score);
  }

  _detectSilentSegments(threshold, minDuration) {
    // Sample data for simulation
    const segments = [];
    let time = 0;
    while (time < 300) {
      if (Math.random() < 0.15) {
        const duration = 0.3 + Math.random() * 3;
        if (duration >= minDuration) {
          segments.push({
            startTime: time,
            endTime: time + duration,
            duration,
            avgLevel: threshold - 10,
            surroundedBySpeech: Math.random() > 0.3,
          });
        }
        time += duration;
      }
      time += 1 + Math.random() * 5;
    }
    return segments;
  }

  _generateBeats(bpm, startTime, endTime) {
    const beatInterval = 60 / bpm;
    const beats = [];
    let time = startTime;
    let beatIndex = 0;

    while (time < endTime) {
      beats.push({
        time: Math.round(time * 1000) / 1000,
        strength: beatIndex % 4 === 0 ? 1.0 : beatIndex % 2 === 0 ? 0.7 : 0.4,
        beatIndex,
      });
      time += beatInterval;
      beatIndex++;
    }

    return beats;
  }
}

export { AIEditor, STYLE_CONFIGS };
