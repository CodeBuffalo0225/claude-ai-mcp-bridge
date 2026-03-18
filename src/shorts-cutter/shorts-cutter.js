// ============================================================================
//  Shorts Cutter
//  Creates vertical shorts/reels from long-form horizontal video.
//  Handles reframing, captions, hooks, and batch export.
// ============================================================================

import { Logger } from '../utils/logger.js';

const logger = new Logger('ShortsCutter');

const PLATFORM_SPECS = {
  youtube_shorts: { width: 1080, height: 1920, maxDuration: 60, fps: 30 },
  tiktok:         { width: 1080, height: 1920, maxDuration: 180, fps: 30 },
  instagram_reels:{ width: 1080, height: 1920, maxDuration: 90, fps: 30 },
};

const CAPTION_STYLES = {
  minimal_white: {
    fontFamily: 'Helvetica Neue', fontSize: 48, color: '#FFFFFF',
    backgroundColor: 'none', shadow: true, maxWords: 5,
  },
  bold_yellow: {
    fontFamily: 'Impact', fontSize: 64, color: '#FFD700',
    backgroundColor: 'none', stroke: '#000000', strokeWidth: 3, maxWords: 4,
  },
  karaoke_highlight: {
    fontFamily: 'Montserrat Bold', fontSize: 56, color: '#FFFFFF',
    highlightColor: '#FFD700', highlightBg: 'none', maxWords: 3,
    animationType: 'word_highlight',
  },
  word_by_word: {
    fontFamily: 'Montserrat ExtraBold', fontSize: 72, color: '#FFFFFF',
    backgroundColor: 'none', maxWords: 1, animationType: 'pop_in',
  },
  boxed: {
    fontFamily: 'Arial Bold', fontSize: 48, color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.8)', padding: 10, maxWords: 5,
  },
  gradient_bg: {
    fontFamily: 'Poppins Bold', fontSize: 52, color: '#FFFFFF',
    backgroundGradient: ['#FF6B6B', '#4ECDC4'], padding: 12, maxWords: 4,
  },
  tiktok_style: {
    fontFamily: 'Proxima Nova Bold', fontSize: 56, color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, maxWords: 4,
  },
  hormozi_style: {
    fontFamily: 'Montserrat ExtraBold', fontSize: 80, color: '#FFFFFF',
    highlightColor: '#FFD700', backgroundColor: 'none',
    maxWords: 3, uppercase: true, animationType: 'scale_pop',
    shadow: true, shadowColor: '#000000', shadowBlur: 4,
  },
  netflix_subtitle: {
    fontFamily: 'Netflix Sans', fontSize: 44, color: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.75)', padding: 8, maxWords: 6,
    position: 'bottom',
  },
};

class ShortsCutter {
  constructor(bridge, aiEditor) {
    this.bridge = bridge;
    this.aiEditor = aiEditor;
  }

  // ── Auto-Detect Best Short Moments ─────────────────────────────────────

  async autoDetect(params) {
    const {
      maxShorts = 5,
      minDuration = 15,
      maxDuration = 60,
      platform = 'youtube_shorts',
      prioritize = 'engagement',
    } = params;

    const spec = PLATFORM_SPECS[platform] || PLATFORM_SPECS.youtube_shorts;
    const effectiveMaxDuration = Math.min(maxDuration, spec.maxDuration);

    logger.info(`Auto-detecting shorts (max: ${maxShorts}, ${minDuration}-${effectiveMaxDuration}s, ${platform})`);

    // Get highlights from the AI editor
    const highlights = await this.aiEditor.detectHighlights({
      sensitivity: 7,
      categories: this._getPriorityCategories(prioritize),
      maxHighlights: maxShorts * 3,
    });

    // Cluster nearby highlights into short candidates
    const candidates = this._clusterHighlights(highlights, minDuration, effectiveMaxDuration);

    // Score and rank candidates
    const scored = candidates.map((candidate) => ({
      ...candidate,
      viralityScore: this._scoreVirality(candidate, prioritize),
      suggestedHook: this._generateHookText(candidate),
    }));

    scored.sort((a, b) => b.viralityScore - a.viralityScore);

    return scored.slice(0, maxShorts);
  }

  // ── Create a Single Short ──────────────────────────────────────────────

  async createShort(params) {
    const {
      startTime, endTime, title, platform = 'youtube_shorts',
      reframeMode = 'auto_face_track', addCaptions = true,
      captionStyle = 'hormozi_style', addHookText, addCallToAction,
    } = params;

    const spec = PLATFORM_SPECS[platform] || PLATFORM_SPECS.youtube_shorts;
    const duration = endTime - startTime;
    const sequenceName = `Short_${title?.replace(/\s+/g, '_') || Date.now()}`;

    logger.info(`Creating short: "${title}" (${duration}s, ${platform})`);

    // 1. Create vertical sequence
    await this.bridge.send('premiere', 'timeline.create', {
      name: sequenceName,
      width: spec.width,
      height: spec.height,
      frameRate: spec.fps,
    });

    // 2. Copy the segment from the main timeline
    await this.bridge.send('premiere', 'edit.copySegment', {
      sourceSequence: 'active',
      startTime,
      endTime,
      targetSequence: sequenceName,
      targetTime: 0,
    });

    // 3. Apply reframing (horizontal → vertical)
    await this._applyReframe(sequenceName, reframeMode);

    // 4. Add hook text overlay
    if (addHookText) {
      await this.bridge.send('premiere', 'edit.addText', {
        text: addHookText.toUpperCase(),
        trackIndex: 2,
        startTime: 0,
        duration: 3,
        style: {
          fontFamily: 'Montserrat ExtraBold',
          fontSize: 72,
          color: '#FFFFFF',
          position: 'center',
          animation: 'scale_pop',
        },
      });
    }

    // 5. Add captions
    if (addCaptions) {
      await this.addCaptions({
        sequenceName,
        style: captionStyle,
        position: 'center',
      });
    }

    // 6. Add CTA
    if (addCallToAction) {
      await this.bridge.send('premiere', 'edit.addText', {
        text: addCallToAction,
        trackIndex: 3,
        startTime: duration - 5,
        duration: 5,
        style: {
          fontFamily: 'Montserrat Bold',
          fontSize: 48,
          color: '#FF0000',
          position: 'lower_third',
          animation: 'slide_up',
        },
      });
    }

    return { sequenceName, duration, platform };
  }

  // ── Add Captions ───────────────────────────────────────────────────────

  async addCaptions(params) {
    const {
      sequenceName, style = 'hormozi_style', position = 'center',
      maxWords = 3, fontSize, fontFamily, highlightColor, backgroundColor,
    } = params;

    const styleConfig = CAPTION_STYLES[style] || CAPTION_STYLES.hormozi_style;
    const finalConfig = {
      ...styleConfig,
      ...(fontSize && { fontSize }),
      ...(fontFamily && { fontFamily }),
      ...(highlightColor && { highlightColor }),
      ...(backgroundColor && { backgroundColor }),
      ...(maxWords && { maxWords }),
      position,
    };

    logger.info(`Adding captions (${style}, ${position})`);

    // Transcribe audio
    const transcription = await this.bridge.send('premiere', 'ai.transcribe', {
      sequenceName,
    });

    const words = transcription.words || this._generateSampleTranscription();

    // Group words into caption segments
    const segments = this._groupWordsIntoSegments(words, finalConfig.maxWords);

    // Create text layers for each segment
    for (const segment of segments) {
      const text = finalConfig.uppercase
        ? segment.text.toUpperCase()
        : segment.text;

      await this.bridge.send('premiere', 'edit.addAnimatedCaption', {
        sequenceName,
        text,
        startTime: segment.startTime,
        endTime: segment.endTime,
        style: finalConfig,
        highlightWords: segment.highlightWords,
        trackIndex: 4,
      });
    }

    return {
      wordCount: words.length,
      segments: segments.length,
    };
  }

  // ── Batch Create Shorts ────────────────────────────────────────────────

  async batchCreate(params) {
    const { shorts, platform, reframeMode, addCaptions, captionStyle } = params;

    logger.info(`Batch creating ${shorts.length} shorts...`);

    const created = [];

    for (const short of shorts) {
      const result = await this.createShort({
        startTime: short.startTime,
        endTime: short.endTime,
        title: short.title,
        platform,
        reframeMode,
        addCaptions,
        captionStyle,
        addHookText: short.hookText,
      });

      created.push({
        ...result,
        title: short.title,
      });
    }

    return { created };
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  async _applyReframe(sequenceName, mode) {
    switch (mode) {
      case 'auto_face_track':
        await this.bridge.send('premiere', 'edit.autoReframe', {
          sequenceName,
          method: 'face_tracking',
          motionSmoothing: 80,
        });
        break;
      case 'center_crop':
        await this.bridge.send('premiere', 'edit.setMotion', {
          trackIndex: 0,
          clipIndex: 0,
          scale: 177,  // 1920/1080 = 1.77x to fill vertical
          positionX: 540,
          positionY: 960,
        });
        break;
      case 'smart_crop':
        await this.bridge.send('premiere', 'edit.autoReframe', {
          sequenceName,
          method: 'smart_analysis',
          motionSmoothing: 60,
        });
        break;
      case 'split_screen':
        // Two stacked views
        await this.bridge.send('premiere', 'edit.splitScreen', {
          sequenceName,
          layout: 'top_bottom',
        });
        break;
    }
  }

  _getPriorityCategories(prioritize) {
    const mapping = {
      engagement: ['high_energy', 'key_phrase', 'emotion'],
      virality: ['high_energy', 'laughter', 'visual_impact'],
      education: ['key_phrase', 'plot_point'],
      humor: ['laughter', 'high_energy'],
      emotional: ['emotion', 'key_phrase'],
    };
    return mapping[prioritize] || mapping.engagement;
  }

  _clusterHighlights(highlights, minDuration, maxDuration) {
    const clusters = [];
    const used = new Set();

    for (const highlight of highlights) {
      if (used.has(highlight)) continue;

      let cluster = {
        startTime: highlight.startTime,
        endTime: highlight.endTime,
        highlights: [highlight],
        category: highlight.category,
        title: highlight.description,
      };

      // Expand cluster with nearby highlights
      for (const other of highlights) {
        if (used.has(other) || other === highlight) continue;
        if (other.startTime >= cluster.startTime - 2 && other.endTime <= cluster.startTime + maxDuration) {
          cluster.endTime = Math.max(cluster.endTime, other.endTime);
          cluster.highlights.push(other);
          used.add(other);
        }
      }

      // Ensure minimum duration
      const duration = cluster.endTime - cluster.startTime;
      if (duration < minDuration) {
        cluster.endTime = cluster.startTime + minDuration;
      }
      if (duration > maxDuration) {
        cluster.endTime = cluster.startTime + maxDuration;
      }

      cluster.duration = Math.round((cluster.endTime - cluster.startTime) * 10) / 10;
      clusters.push(cluster);
      used.add(highlight);
    }

    return clusters;
  }

  _scoreVirality(candidate, prioritize) {
    let score = 0;
    score += candidate.highlights.length * 1.5;
    score += candidate.highlights.reduce((sum, h) => sum + h.score, 0) / candidate.highlights.length;
    if (candidate.duration >= 15 && candidate.duration <= 30) score += 2;
    if (prioritize === 'virality' && candidate.category === 'laughter') score += 1.5;
    return Math.min(10, Math.round(score * 10) / 10);
  }

  _generateHookText(candidate) {
    const hooks = [
      'You need to see this...',
      'Wait for it...',
      'This changed everything.',
      'Nobody talks about this.',
      'POV: You just discovered...',
      'The truth about this...',
    ];
    return hooks[Math.floor(Math.random() * hooks.length)];
  }

  _generateSampleTranscription() {
    return [
      { word: 'This', startTime: 0.0, endTime: 0.2 },
      { word: 'is', startTime: 0.2, endTime: 0.3 },
      { word: 'the', startTime: 0.3, endTime: 0.4 },
      { word: 'most', startTime: 0.4, endTime: 0.6 },
      { word: 'important', startTime: 0.6, endTime: 1.0 },
      { word: 'thing', startTime: 1.0, endTime: 1.2 },
      { word: 'you', startTime: 1.3, endTime: 1.4 },
      { word: 'need', startTime: 1.4, endTime: 1.6 },
      { word: 'to', startTime: 1.6, endTime: 1.7 },
      { word: 'know', startTime: 1.7, endTime: 2.0 },
    ];
  }

  _groupWordsIntoSegments(words, maxWords) {
    const segments = [];

    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, i + maxWords);
      segments.push({
        text: chunk.map((w) => w.word).join(' '),
        startTime: chunk[0].startTime,
        endTime: chunk[chunk.length - 1].endTime,
        highlightWords: [chunk[chunk.length - 1].word], // Highlight last word
      });
    }

    return segments;
  }
}

export { ShortsCutter, PLATFORM_SPECS, CAPTION_STYLES };
