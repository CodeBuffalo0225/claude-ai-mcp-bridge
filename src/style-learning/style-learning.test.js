// ============================================================================
//  Style Learning — Unit Tests
//  Run: node --test src/style-learning/style-learning.test.js
// ============================================================================

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';

// ── Mock the Anthropic SDK before importing style-analyzer ──────────────────
// We replace the default export so no real API call is made.

const MOCK_PROFILE = {
  profile_name: 'Test Style',
  style_summary: 'A test editing style for unit testing purposes.',
  pacing: { category: 'medium', avg_cut_seconds: 3.5, notes: 'moderate pacing' },
  caption_style: { preferred_zone: 'lower_third', typical_duration_seconds: 2, notes: 'standard' },
  b_roll_usage: { category: 'moderate', ratio: 0.35, notes: 'some b-roll' },
  transition_style: { category: 'cut-only', notes: 'hard cuts' },
  format_preference: { primary: '1920x1080', notes: 'landscape HD' },
  color_approach: { category: 'graded', notes: 'lumetri used' },
  music_integration: { category: 'mixed', notes: 'some music' },
  claude_context_block: 'You are editing for a creator who uses medium pacing with hard cuts.',
};

// ── Import modules under test ───────────────────────────────────────────────

import {
  computeAggregateStats,
  mean,
  median,
  percentile,
  trackIndexToZone,
} from './style-analyzer.js';

import {
  saveProfile,
  loadProfile,
  profileExists,
  clearProfile,
  getProfilePath,
} from './style-profile-store.js';

// ── Test Data: Mock ProjectAnalysis arrays ───────────────────────────────────

function makeMockAnalysis(overrides = {}) {
  return {
    sourceFile: '/test/project.prproj',
    sequenceName: 'Main Sequence',
    format: { width: 1920, height: 1080, framerate: 30 },
    durationFrames: 9000,
    durationSeconds: 300,
    videoTrackCount: 3,
    audioTrackCount: 3,
    clips: {
      video: [
        { trackIndex: 0, mediaType: 'video', inPoint: 0, outPoint: 90, durationFrames: 90 },
        { trackIndex: 0, mediaType: 'video', inPoint: 90, outPoint: 210, durationFrames: 120 },
        { trackIndex: 0, mediaType: 'video', inPoint: 210, outPoint: 300, durationFrames: 90 },
        { trackIndex: 1, mediaType: 'video', inPoint: 50, outPoint: 140, durationFrames: 90 },
        { trackIndex: 2, mediaType: 'video', inPoint: 100, outPoint: 160, durationFrames: 60 },
      ],
      audio: [
        { trackIndex: 0, mediaType: 'audio', inPoint: 0, outPoint: 300, durationFrames: 300 },
        { trackIndex: 2, mediaType: 'audio', inPoint: 0, outPoint: 9000, durationFrames: 9000 },
      ],
      graphics: [
        { trackIndex: 1, mediaType: 'graphic', inPoint: 10, outPoint: 70, durationFrames: 60 },
        { trackIndex: 3, mediaType: 'graphic', inPoint: 200, outPoint: 260, durationFrames: 60 },
      ],
    },
    cutPattern: [
      [0, 90, 90],
      [90, 210, 120],
      [210, 300, 90],
    ],
    transitions: [{ name: 'Cross Dissolve' }],
    musicTracks: [{ trackIndex: 2, clipCount: 1, totalDuration: 9000, maxClipDuration: 9000, isMusic: true }],
    lumetriClips: [{ trackIndex: 0, inPoint: 0, hasLumetri: true }],
    clipCounts: {
      totalVideo: 5,
      totalAudio: 2,
      graphics: 2,
      withLumetri: 2,
      withTransitions: 1,
    },
    ...overrides,
  };
}

// ── Tests: Stat Helpers ─────────────────────────────────────────────────────

describe('stat helpers', () => {
  it('mean() computes correctly', () => {
    assert.equal(mean([10, 20, 30]), 20);
    assert.equal(mean([]), 0);
    assert.equal(mean([5]), 5);
  });

  it('median() computes correctly', () => {
    assert.equal(median([10, 20, 30]), 20);
    assert.equal(median([10, 20, 30, 40]), 25);
    assert.equal(median([]), 0);
  });

  it('percentile() computes p10 and p90', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(arr, 10), 1);
    assert.equal(percentile(arr, 90), 9);
    assert.equal(percentile([], 50), 0);
  });

  it('trackIndexToZone() maps correctly', () => {
    assert.equal(trackIndexToZone(0), 'lower_third');
    assert.equal(trackIndexToZone(1), 'lower_third');
    assert.equal(trackIndexToZone(2), 'mid');
    assert.equal(trackIndexToZone(3), 'upper');
    assert.equal(trackIndexToZone(5), 'upper');
  });
});

// ── Tests: Aggregate Stats ──────────────────────────────────────────────────

describe('computeAggregateStats', () => {
  it('computes stats from a single mock analysis', () => {
    const analyses = [makeMockAnalysis()];
    const stats = computeAggregateStats(analyses);

    // Cut durations from cutPattern: [90, 120, 90]
    assert.equal(stats.avg_cut_duration_frames, 100);
    assert.equal(stats.median_cut_duration_frames, 90);
    assert.equal(stats.cut_duration_p10, 90);
    assert.equal(stats.cut_duration_p90, 120);

    // Clip count per sequence
    assert.equal(stats.avg_clip_count_per_sequence, 5);

    // Captions: trackIndex 1 → lower_third, trackIndex 3 → upper
    assert.equal(stats.caption_track_zone_distribution.lower_third, 0.5);
    assert.equal(stats.caption_track_zone_distribution.upper, 0.5);
    assert.equal(stats.caption_track_zone_distribution.mid, 0);

    // Caption avg duration
    assert.equal(stats.caption_avg_duration_frames, 60);

    // Transition usage rate: 1 transition / 3 cuts
    assert.ok(Math.abs(stats.transition_usage_rate - 0.33) < 0.01);

    // Transition types
    assert.equal(stats.transition_types_used.length, 1);
    assert.equal(stats.transition_types_used[0].name, 'Cross Dissolve');

    // Music
    assert.equal(stats.music_track_presence_rate, 1);

    // B-roll ratio: 2 non-V1 clips / 5 total = 0.4
    assert.equal(stats.b_roll_ratio, 0.4);

    // Format
    assert.equal(stats.format_distribution['1920x1080'], 1);

    // Color grade: 2 with lumetri / 5 total = 0.4
    assert.equal(stats.color_grade_usage_rate, 0.4);
  });

  it('computes stats across multiple analyses', () => {
    const a1 = makeMockAnalysis();
    const a2 = makeMockAnalysis({
      sourceFile: '/test/project2.prproj',
      format: { width: 1080, height: 1920, framerate: 30 },
      cutPattern: [[0, 30, 30], [30, 60, 30]],
      transitions: [],
      musicTracks: [],
      clipCounts: { totalVideo: 3, totalAudio: 1, graphics: 0, withLumetri: 0, withTransitions: 0 },
      clips: {
        video: [
          { trackIndex: 0, mediaType: 'video', inPoint: 0, outPoint: 30, durationFrames: 30 },
          { trackIndex: 0, mediaType: 'video', inPoint: 30, outPoint: 60, durationFrames: 30 },
          { trackIndex: 1, mediaType: 'video', inPoint: 10, outPoint: 40, durationFrames: 30 },
        ],
        audio: [],
        graphics: [],
      },
    });
    const stats = computeAggregateStats([a1, a2]);

    // Music: 1 out of 2 sequences
    assert.equal(stats.music_track_presence_rate, 0.5);

    // Format distribution
    assert.equal(stats.format_distribution['1920x1080'], 1);
    assert.equal(stats.format_distribution['1080x1920'], 1);

    // B-roll: (2 + 1) non-V1 / (5 + 3) total = 3/8 = 0.375 → 0.38
    assert.equal(stats.b_roll_ratio, 0.38);
  });

  it('handles empty analyses array', () => {
    const stats = computeAggregateStats([]);
    assert.equal(stats.avg_cut_duration_frames, 0);
    assert.equal(stats.b_roll_ratio, 0);
    assert.equal(stats.music_track_presence_rate, 0);
  });
});

// ── Tests: Profile Store Round-trip ─────────────────────────────────────────

describe('style-profile-store', () => {
  const testProfile = { ...MOCK_PROFILE, generated_at: new Date().toISOString() };

  afterEach(() => {
    // Clean up after tests
    try { clearProfile(); } catch { /* ignore */ }
  });

  it('saveProfile + loadProfile round-trip', () => {
    saveProfile(testProfile);
    assert.ok(profileExists());

    const loaded = loadProfile();
    assert.ok(loaded);
    assert.equal(loaded.profile_name, 'Test Style');
    assert.equal(loaded.style_summary, testProfile.style_summary);
    assert.equal(loaded.claude_context_block, testProfile.claude_context_block);
  });

  it('profileExists returns false when no profile', () => {
    clearProfile();
    assert.equal(profileExists(), false);
  });

  it('loadProfile returns null when no profile', () => {
    clearProfile();
    assert.equal(loadProfile(), null);
  });

  it('clearProfile removes the file', () => {
    saveProfile(testProfile);
    assert.ok(profileExists());
    clearProfile();
    assert.equal(profileExists(), false);
  });

  it('loadProfile flags stale profiles (>30 days old)', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const staleProfile = { ...testProfile, generated_at: oldDate };
    saveProfile(staleProfile);

    const loaded = loadProfile();
    assert.ok(loaded);
    assert.equal(loaded.stale, true);
  });

  it('loadProfile does not flag fresh profiles as stale', () => {
    saveProfile(testProfile);
    const loaded = loadProfile();
    assert.ok(loaded);
    assert.equal(loaded.stale, undefined);
  });
});

// ── Tests: Harvester graceful failure ───────────────────────────────────────

describe('project-harvester graceful failure', async () => {
  const { harvestFiles } = await import('./project-harvester.js');

  it('skips corrupt/unreadable files and returns empty', async () => {
    const tmpDir = join(tmpdir(), 'cutpilot-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    // Write a corrupt file
    const corruptPath = join(tmpDir, 'bad.prproj');
    writeFileSync(corruptPath, 'this is not valid gzip or xml');

    const results = await harvestFiles([corruptPath]);
    // Should not throw, should return empty or skip
    assert.ok(Array.isArray(results));

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips non-existent files without crashing', async () => {
    const results = await harvestFiles(['/nonexistent/path/fake.prproj']);
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });

  it('processes a valid gzipped minimal prproj', async () => {
    const tmpDir = join(tmpdir(), 'cutpilot-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    // Create a minimal valid prproj-like gzipped XML
    const minimalXml = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData>
  <Project>
    <Sequence Name="Test Seq">
      <Rate><TimeBase>30</TimeBase></Rate>
      <FrameRect><Width>1920</Width><Height>1080</Height></FrameRect>
      <VideoTrack>
        <ClipItem>
          <Start>0</Start><End>90</End>
        </ClipItem>
        <ClipItem>
          <Start>90</Start><End>180</End>
        </ClipItem>
      </VideoTrack>
      <AudioTrack>
        <ClipItem>
          <Start>0</Start><End>180</End>
        </ClipItem>
      </AudioTrack>
    </Sequence>
  </Project>
</PremiereData>`;
    const gzipped = gzipSync(Buffer.from(minimalXml, 'utf-8'));
    const filePath = join(tmpDir, 'test.prproj');
    writeFileSync(filePath, gzipped);

    const results = await harvestFiles([filePath]);
    assert.ok(results.length > 0, 'should find at least one sequence');
    assert.equal(results[0].sequenceName, 'Test Seq');
    assert.equal(results[0].format.width, 1920);
    assert.equal(results[0].format.height, 1080);
    assert.ok(results[0].cutPattern.length >= 2, 'should find clips in cut pattern');

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
