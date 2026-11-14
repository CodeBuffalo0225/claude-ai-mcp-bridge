// ============================================================================
//  Face tracking across sampled frames — association by box overlap.
//
//  Vision detects faces per frame; this links detections into tracks with
//  greedy IoU matching (centre-distance fallback for fast motion). It is a
//  sampled tracker: it reports where a face was at each analysed frame and
//  how stable that was. It does not interpolate between samples and does not
//  claim frame-accurate tracking. Premiere's own mask tracker is UI-only (no
//  scripting API), so these tracks drive analysis, validation and manual
//  mask guidance — see SKILL.md capability table.
// ============================================================================

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

function centreDist(a, b) {
  return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2)) / Math.max(a.w, b.w);
}

/**
 * @param frames [{ time, faces:[{bbox, confidence, landmarksConfidence}] }] in time order
 * @param opts { minIou=0.3, maxCentreJump=0.6 (in face widths), maxGap=1 sample }
 */
export function trackFaces(frames, { minIou = 0.3, maxCentreJump = 0.6, maxGap = 1 } = {}) {
  const tracks = [];
  frames.forEach((frame, fi) => {
    const used = new Set();
    const live = tracks.filter((t) => fi - t.lastFrame <= maxGap + 1);
    // Score every live-track × face pair, take best pairs greedily.
    const pairs = [];
    for (const t of live) {
      const last = t.samples[t.samples.length - 1].bbox;
      frame.faces.forEach((f, k) => {
        const o = iou(last, f.bbox);
        const d = centreDist(last, f.bbox);
        if (o >= minIou || d <= maxCentreJump) pairs.push({ t, k, score: o - d * 0.1 });
      });
    }
    pairs.sort((a, b) => b.score - a.score);
    const takenTracks = new Set();
    for (const { t, k } of pairs) {
      if (used.has(k) || takenTracks.has(t)) continue;
      used.add(k); takenTracks.add(t);
      append(t, fi, frame, frame.faces[k], k);
    }
    frame.faces.forEach((f, k) => {
      if (used.has(k)) return;
      const t = { id: tracks.length, samples: [], lastFrame: fi };
      append(t, fi, frame, f, k);
      tracks.push(t);
    });
  });

  return tracks.map((t) => summarise(t, frames.length));
}

function append(t, fi, frame, face, k) {
  t.samples.push({ frameIndex: fi, time: frame.time, faceIndex: k, bbox: face.bbox, confidence: face.landmarksConfidence ?? face.confidence ?? null });
  t.lastFrame = fi;
}

function summarise(t, nFrames) {
  const s = t.samples;
  const coverage = s.length / nFrames;
  const gaps = [];
  for (let i = 1; i < s.length; i++) if (s[i].frameIndex - s[i - 1].frameIndex > 1) gaps.push([s[i - 1].frameIndex, s[i].frameIndex]);
  // Size jitter: relative change in face width between consecutive samples.
  // Large jitter on a steady shot = unstable detection, not motion.
  let sizeJitter = 0;
  for (let i = 1; i < s.length; i++) sizeJitter += Math.abs(s[i].bbox.w - s[i - 1].bbox.w) / s[i - 1].bbox.w;
  sizeJitter = s.length > 1 ? sizeJitter / (s.length - 1) : 0;
  const confs = s.map((x) => x.confidence).filter((c) => typeof c === 'number');
  const meanConfidence = confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : null;
  const reasons = [];
  if (coverage < 0.8) reasons.push(`face found in ${s.length}/${nFrames} sampled frames`);
  if (gaps.length) reasons.push(`${gaps.length} gap(s) in the track`);
  if (sizeJitter > 0.15) reasons.push(`face size jumps ${(100 * sizeJitter).toFixed(0)}% between samples — detection unstable or fast zoom`);
  return {
    id: t.id,
    samples: s,
    coverage: Math.round(coverage * 1000) / 1000,
    gaps,
    sizeJitter: Math.round(sizeJitter * 1000) / 1000,
    meanConfidence,
    stable: coverage >= 0.8 && gaps.length === 0 && sizeJitter <= 0.15,
    reasons,
  };
}
