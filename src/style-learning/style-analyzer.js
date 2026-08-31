// ============================================================================
//  Style Analyzer
//  Takes harvested ProjectAnalysis arrays, computes aggregate statistics,
//  then calls the Claude API once to generate a natural-language Style DNA
//  Profile.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '../utils/logger.js';

const logger = new Logger('StyleAnalyzer');

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyze an array of ProjectAnalysis objects and generate a Style DNA Profile.
 * @param {Array} projectAnalyses - Output from project-harvester
 * @returns {object} - Parsed Style DNA Profile JSON
 */
async function analyzeStyle(projectAnalyses) {
  if (!projectAnalyses || projectAnalyses.length === 0) {
    throw new Error('No project analyses provided');
  }

  // Deduplicate by sourceFile to count unique projects
  const uniqueProjects = new Set(projectAnalyses.map((a) => a.sourceFile));

  logger.info(`Computing stats across ${projectAnalyses.length} sequences from ${uniqueProjects.size} projects`);
  const stats = computeAggregateStats(projectAnalyses);
  stats._meta = {
    projectCount: uniqueProjects.size,
    sequenceCount: projectAnalyses.length,
  };

  logger.info('Calling Claude API for Style DNA Profile...');
  const profile = await callClaudeForProfile(stats);

  profile.analyzed_project_count = uniqueProjects.size;
  profile.analyzed_sequence_count = projectAnalyses.length;
  profile.generated_at = new Date().toISOString();

  return profile;
}

// ── Aggregate Statistics ────────────────────────────────────────────────────

function computeAggregateStats(analyses) {
  // Collect all V1 clip durations (the "cut" durations)
  const allCutDurations = [];
  let totalClipsPerSeq = [];
  const captionsByZone = { lower_third: 0, mid: 0, upper: 0 };
  const captionDurations = [];
  let totalCuts = 0;
  let cutsWithTransitions = 0;
  const transitionTypes = {};
  let sequencesWithMusic = 0;
  let totalVideoClips = 0;
  let nonV1VideoClips = 0;
  const seqDurations = [];
  const formats = {};
  let clipsWithLumetri = 0;
  let totalClipsForLumetri = 0;

  for (const seq of analyses) {
    const fr = seq.format?.framerate || 29.97;

    // Cut durations from cutPattern (V1 clips)
    if (seq.cutPattern) {
      for (const [, , dur] of seq.cutPattern) {
        allCutDurations.push(dur);
      }
    }

    // Clip count per sequence
    const videoCount = seq.clipCounts?.totalVideo || 0;
    totalClipsPerSeq.push(videoCount);

    // Captions / graphics by zone
    if (seq.clips?.graphics) {
      for (const g of seq.clips.graphics) {
        const zone = trackIndexToZone(g.trackIndex);
        captionsByZone[zone]++;
        captionDurations.push(g.durationFrames);
      }
    }

    // Transitions
    const seqTransitions = seq.transitions?.length || 0;
    const seqCuts = seq.cutPattern?.length || 0;
    totalCuts += seqCuts;
    cutsWithTransitions += seqTransitions;
    if (seq.transitions) {
      for (const t of seq.transitions) {
        const name = t.name || 'Unknown';
        transitionTypes[name] = (transitionTypes[name] || 0) + 1;
      }
    }

    // Music
    if (seq.musicTracks && seq.musicTracks.length > 0) {
      sequencesWithMusic++;
    }

    // B-roll ratio
    if (seq.clips?.video) {
      for (const clip of seq.clips.video) {
        totalVideoClips++;
        if (clip.trackIndex > 0) nonV1VideoClips++;
      }
    }

    // Sequence duration
    seqDurations.push(seq.durationSeconds || 0);

    // Format distribution
    const fmt = `${seq.format?.width || 0}x${seq.format?.height || 0}`;
    formats[fmt] = (formats[fmt] || 0) + 1;

    // Lumetri
    totalClipsForLumetri += videoCount;
    clipsWithLumetri += seq.clipCounts?.withLumetri || 0;
  }

  // Sort for percentiles
  allCutDurations.sort((a, b) => a - b);

  const avgFramerate = analyses.reduce((s, a) => s + (a.format?.framerate || 29.97), 0) / analyses.length;

  return {
    avg_cut_duration_frames: mean(allCutDurations),
    median_cut_duration_frames: median(allCutDurations),
    cut_duration_p10: percentile(allCutDurations, 10),
    cut_duration_p90: percentile(allCutDurations, 90),
    avg_cut_duration_seconds: round(mean(allCutDurations) / avgFramerate),
    avg_clip_count_per_sequence: round(mean(totalClipsPerSeq)),
    caption_track_zone_distribution: zoneDistribution(captionsByZone),
    caption_avg_duration_frames: round(mean(captionDurations)),
    transition_usage_rate: totalCuts > 0 ? round(cutsWithTransitions / totalCuts) : 0,
    transition_types_used: topN(transitionTypes, 3),
    music_track_presence_rate: analyses.length > 0 ? round(sequencesWithMusic / analyses.length) : 0,
    b_roll_ratio: totalVideoClips > 0 ? round(nonV1VideoClips / totalVideoClips) : 0,
    avg_sequence_duration_seconds: round(mean(seqDurations)),
    format_distribution: formats,
    color_grade_usage_rate: totalClipsForLumetri > 0 ? round(clipsWithLumetri / totalClipsForLumetri) : 0,
    avg_framerate: round(avgFramerate),
  };
}

// ── Claude API Call ─────────────────────────────────────────────────────────

async function callClaudeForProfile(stats) {
  const client = new Anthropic();

  const systemPrompt = `You are a professional video editor analyzing edit pattern statistics to generate a Style DNA Profile. Output ONLY a JSON object, no markdown.`;

  const userPrompt = `Analyze the following editing statistics computed from real Premiere Pro project files and generate a Style DNA Profile.

STATISTICS:
${JSON.stringify(stats, null, 2)}

Return a JSON object with exactly these keys:
- profile_name: string (invent a short creative name for the style, e.g. "Fast-Cut Vertical Storyteller")
- style_summary: string (2-3 sentence natural language description of the editing style)
- pacing: { category: "fast"|"medium"|"slow", avg_cut_seconds: number, notes: string }
- caption_style: { preferred_zone: string, typical_duration_seconds: number, notes: string }
- b_roll_usage: { category: "heavy"|"moderate"|"minimal", ratio: number, notes: string }
- transition_style: { category: "cut-only"|"mixed"|"transition-heavy", notes: string }
- format_preference: { primary: string, notes: string }
- color_approach: { category: "graded"|"natural"|"mixed", notes: string }
- music_integration: { category: "music-forward"|"nat-sound"|"mixed", notes: string }
- claude_context_block: string — a 150-200 word paragraph written in second person ("You are editing for a creator who...") describing this editing style for injection into future AI editing sessions. This is the MOST IMPORTANT field — it should capture pacing, caption preferences, b-roll habits, color grading tendencies, transition preferences, and music integration approach so that an AI editor can match this creator's established style.

Output ONLY the raw JSON object. No markdown fences, no explanation.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip any accidental markdown fences
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('Failed to parse Claude response as JSON:', cleaned.slice(0, 200));
    throw new Error(`Claude returned invalid JSON: ${err.message}`);
  }
}

// ── Stat Helpers ────────────────────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * arr.length) - 1;
  return arr[Math.max(0, idx)];
}

function round(val) {
  return Math.round(val * 100) / 100;
}

function trackIndexToZone(trackIndex) {
  if (trackIndex <= 1) return 'lower_third';
  if (trackIndex === 2) return 'mid';
  return 'upper';
}

function zoneDistribution(counts) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  if (total === 0) return { lower_third: 0, mid: 0, upper: 0 };
  return {
    lower_third: round(counts.lower_third / total),
    mid: round(counts.mid / total),
    upper: round(counts.upper / total),
  };
}

function topN(freqMap, n) {
  return Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

// Export internals for testing
export {
  analyzeStyle,
  computeAggregateStats,
  callClaudeForProfile,
  mean,
  median,
  percentile,
  trackIndexToZone,
};
