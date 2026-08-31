// ============================================================================
//  Project Harvester
//  Parses Premiere Pro .prproj files (gzipped XML) and extracts edit metrics
//  for style analysis. Fails gracefully per file — logs errors, skips bad
//  files, continues batch.
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Harvester');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: true,
  trimValues: true,
});

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Recursively scan a directory for .prproj files and harvest all of them.
 */
async function harvestDirectory(dirPath) {
  const files = findPrprojFiles(dirPath);
  logger.info(`Found ${files.length} .prproj file(s) in ${dirPath}`);
  return harvestFiles(files);
}

/**
 * Harvest an array of .prproj file paths.
 */
async function harvestFiles(filePaths) {
  const results = [];
  for (const fp of filePaths) {
    try {
      const analyses = await harvestSingleProject(fp);
      results.push(...analyses);
    } catch (err) {
      logger.error(`Skipping ${fp}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Harvest a single .prproj file.
 * Returns an array of ProjectAnalysis objects — one per sequence found.
 */
async function harvestSingleProject(filePath) {
  logger.info(`Parsing ${filePath}`);
  const raw = readFileSync(filePath);

  let xmlStr;
  try {
    const decompressed = gunzipSync(raw);
    xmlStr = decompressed.toString('utf-8');
  } catch {
    // Some older .prproj files may not be gzipped
    xmlStr = raw.toString('utf-8');
  }

  const doc = xmlParser.parse(xmlStr);
  const sequences = extractSequences(doc);

  if (sequences.length === 0) {
    logger.warn(`No sequences found in ${filePath}`);
  }

  return sequences.map((seq) => ({
    sourceFile: filePath,
    ...seq,
  }));
}

// ── File Discovery ──────────────────────────────────────────────────────────

function findPrprojFiles(dirPath) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (extname(entry).toLowerCase() === '.prproj') {
          results.push(full);
        }
      } catch {
        // permission error, skip
      }
    }
  };
  walk(dirPath);
  return results;
}

// ── XML Extraction ──────────────────────────────────────────────────────────

function extractSequences(doc) {
  // Premiere stores sequences under PremiereData > Project > RootProjectItem
  // or directly under Sequence nodes. We search broadly.
  const seqNodes = findNodes(doc, 'Sequence');
  return seqNodes.map(parseSequence).filter(Boolean);
}

function parseSequence(seqNode) {
  try {
    const name = seqNode['@_Name'] || seqNode.Name || seqNode['@_name'] || 'Untitled';

    // Format
    const width = findFirstValue(seqNode, 'FrameRect', 'Width') ||
                  findFirstValue(seqNode, 'VideoDisplayFormat', 'Width') ||
                  findAttr(seqNode, 'width') || 1920;
    const height = findFirstValue(seqNode, 'FrameRect', 'Height') ||
                   findFirstValue(seqNode, 'VideoDisplayFormat', 'Height') ||
                   findAttr(seqNode, 'height') || 1080;
    const framerate = extractFramerate(seqNode);

    // Tracks
    const videoTracks = findNodes(seqNode, 'VideoTrack');
    const audioTracks = findNodes(seqNode, 'AudioTrack');

    // Clips per track
    const allVideoClips = [];
    const allAudioClips = [];
    const graphicClips = [];
    const transitions = [];
    const lumetriClips = [];

    videoTracks.forEach((track, trackIdx) => {
      const clips = extractClips(track, trackIdx, 'video', framerate);
      const trackTransitions = extractTransitions(track);

      for (const clip of clips) {
        if (isGraphicClip(clip, track)) {
          graphicClips.push({ ...clip, trackIndex: trackIdx });
        }
        if (hasLumetriEffect(clip._rawNode || track)) {
          lumetriClips.push(clip);
        }
        allVideoClips.push(clip);
      }
      transitions.push(...trackTransitions);
    });

    audioTracks.forEach((track, trackIdx) => {
      const clips = extractClips(track, trackIdx, 'audio', framerate);
      allAudioClips.push(...clips);
    });

    // Cut pattern (V1 clips in order)
    const v1Clips = allVideoClips.filter((c) => c.trackIndex === 0);
    v1Clips.sort((a, b) => a.inPoint - b.inPoint);
    const cutPattern = v1Clips.map((c) => [c.inPoint, c.outPoint, c.durationFrames]);

    // Gaps between V1 clips
    for (let i = 1; i < v1Clips.length; i++) {
      v1Clips[i].gapBefore = Math.max(0, v1Clips[i].inPoint - v1Clips[i - 1].outPoint);
    }

    // Music track detection (long continuous clips on A2/A3)
    const musicTracks = detectMusicTracks(allAudioClips, audioTracks.length);

    // Sequence duration
    const allClips = [...allVideoClips, ...allAudioClips];
    const maxOut = allClips.reduce((m, c) => Math.max(m, c.outPoint || 0), 0);
    const durationFrames = maxOut;
    const durationSeconds = framerate > 0 ? durationFrames / framerate : 0;

    // Lumetri params extraction
    const lumetriParams = lumetriClips.map(extractLumetriParams).filter(Boolean);

    return {
      sequenceName: name,
      format: { width: Number(width), height: Number(height), framerate },
      durationFrames,
      durationSeconds: Math.round(durationSeconds * 100) / 100,
      videoTrackCount: videoTracks.length,
      audioTrackCount: audioTracks.length,
      clips: {
        video: allVideoClips,
        audio: allAudioClips,
        graphics: graphicClips,
      },
      cutPattern,
      transitions,
      musicTracks,
      lumetriClips: lumetriParams,
      clipCounts: {
        totalVideo: allVideoClips.length,
        totalAudio: allAudioClips.length,
        graphics: graphicClips.length,
        withLumetri: lumetriClips.length,
        withTransitions: transitions.length,
      },
    };
  } catch (err) {
    logger.warn(`Failed to parse sequence: ${err.message}`);
    return null;
  }
}

// ── Clip Extraction ─────────────────────────────────────────────────────────

function extractClips(trackNode, trackIdx, mediaType, framerate) {
  const clipNodes = findNodes(trackNode, 'ClipItem')
    .concat(findNodes(trackNode, 'clipitem'));

  return clipNodes.map((node) => {
    const inPoint = getNumericValue(node, 'Start') ??
                    getNumericValue(node, 'start') ??
                    getNumericValue(node, 'In') ??
                    getNumericValue(node, 'in') ?? 0;
    const outPoint = getNumericValue(node, 'End') ??
                     getNumericValue(node, 'end') ??
                     getNumericValue(node, 'Out') ??
                     getNumericValue(node, 'out') ?? 0;
    const durationFrames = outPoint - inPoint;

    return {
      trackIndex: trackIdx,
      mediaType,
      inPoint,
      outPoint,
      durationFrames,
      durationSeconds: framerate > 0 ? Math.round((durationFrames / framerate) * 1000) / 1000 : 0,
      gapBefore: 0,
      _rawNode: node,
    };
  });
}

function extractTransitions(trackNode) {
  const transNodes = findNodes(trackNode, 'Transition')
    .concat(findNodes(trackNode, 'transition'));

  return transNodes.map((node) => {
    const name = node['@_Name'] || node.Name || node['@_name'] ||
                 findFirstTextValue(node, 'Effect', 'Name') ||
                 findFirstTextValue(node, 'effect', 'name') ||
                 'Unknown';
    return { name: String(name) };
  });
}

function isGraphicClip(clip, trackNode) {
  const raw = clip._rawNode || {};
  const clipType = raw['@_ClipType'] || raw.ClipType || raw['@_cliptype'] || '';
  const mediaType = raw['@_MediaType'] || raw.MediaType || raw['@_mediatype'] || '';
  return String(clipType).toLowerCase().includes('graphic') ||
         String(mediaType).toLowerCase().includes('graphic') ||
         String(clipType).toLowerCase().includes('title') ||
         String(mediaType).toLowerCase().includes('title');
}

function hasLumetriEffect(node) {
  const str = JSON.stringify(node).toLowerCase();
  return str.includes('lumetri') || str.includes('color correction');
}

function extractLumetriParams(clip) {
  try {
    const raw = clip._rawNode || {};
    const str = JSON.stringify(raw);
    // Try to pull basic Lumetri values from the serialized clip
    const exposure = extractParamValue(str, 'exposure');
    const contrast = extractParamValue(str, 'contrast');
    const saturation = extractParamValue(str, 'saturation');
    return {
      trackIndex: clip.trackIndex,
      inPoint: clip.inPoint,
      exposure,
      contrast,
      saturation,
      hasLumetri: true,
    };
  } catch {
    return null;
  }
}

function extractParamValue(jsonStr, paramName) {
  const regex = new RegExp(`"${paramName}"\\s*:\\s*(-?[\\d.]+)`, 'i');
  const match = jsonStr.match(regex);
  return match ? parseFloat(match[1]) : null;
}

// ── Audio / Music Detection ─────────────────────────────────────────────────

function detectMusicTracks(audioClips, trackCount) {
  // Music tracks typically have fewer, longer clips on A2 or A3
  const trackStats = {};
  for (const clip of audioClips) {
    const idx = clip.trackIndex;
    if (!trackStats[idx]) trackStats[idx] = { clipCount: 0, totalDuration: 0, maxClipDuration: 0 };
    trackStats[idx].clipCount++;
    trackStats[idx].totalDuration += clip.durationFrames;
    trackStats[idx].maxClipDuration = Math.max(trackStats[idx].maxClipDuration, clip.durationFrames);
  }

  const musicTracks = [];
  for (const [idx, stats] of Object.entries(trackStats)) {
    const trackIdx = Number(idx);
    // Heuristic: music tracks have few clips with long durations, usually not on A1
    if (trackIdx >= 1 && stats.clipCount <= 5 && stats.maxClipDuration > 300) {
      musicTracks.push({ trackIndex: trackIdx, ...stats, isMusic: true });
    }
  }
  return musicTracks;
}

// ── Framerate Extraction ────────────────────────────────────────────────────

function extractFramerate(seqNode) {
  // Try multiple known locations
  const rate = findFirstValue(seqNode, 'TimeBase') ||
               findFirstValue(seqNode, 'timebase') ||
               findFirstValue(seqNode, 'FrameRate') ||
               findAttr(seqNode, 'framerate');
  if (rate) return Number(rate);

  // Nested Rate node with Timebase + Ntsc fields
  const rateNode = findFirstNode(seqNode, 'Rate') || findFirstNode(seqNode, 'rate');
  if (rateNode) {
    const tb = rateNode.TimeBase || rateNode.timebase || 30;
    const ntsc = rateNode.Ntsc || rateNode.ntsc;
    if (ntsc === true || ntsc === 'TRUE') return Number(tb) * 1000 / 1001;
    return Number(tb);
  }

  return 29.97; // sensible default
}

// ── Generic XML Helpers ─────────────────────────────────────────────────────

function findNodes(obj, tagName) {
  const results = [];
  const search = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(search);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === tagName || key.toLowerCase() === tagName.toLowerCase()) {
        const val = node[key];
        if (Array.isArray(val)) results.push(...val);
        else results.push(val);
      }
      search(node[key]);
    }
  };
  search(obj);
  return results;
}

function findFirstNode(obj, tagName) {
  const nodes = findNodes(obj, tagName);
  return nodes.length > 0 ? nodes[0] : null;
}

function findFirstValue(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    const node = findFirstNode(current, key);
    if (node === null || node === undefined) return null;
    current = node;
  }
  if (typeof current === 'object') return null;
  return current;
}

function findFirstTextValue(obj, ...keys) {
  return findFirstValue(obj, ...keys);
}

function findAttr(node, name) {
  if (!node || typeof node !== 'object') return null;
  return node[`@_${name}`] || node[`@_${name.charAt(0).toUpperCase()}${name.slice(1)}`] || null;
}

function getNumericValue(node, key) {
  const val = node[key] ?? node[key.toLowerCase()] ?? node[`@_${key}`];
  if (val === undefined || val === null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

export {
  harvestDirectory,
  harvestFiles,
  harvestSingleProject,
  findPrprojFiles,
};
