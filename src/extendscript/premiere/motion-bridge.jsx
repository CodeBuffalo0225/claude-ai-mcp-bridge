// ============================================================================
//  Motion bridge handlers — transitions, text animation, audio fades.
//  Loaded by premiere-bridge.jsx via $.evalFile. ExtendScript (ES3).
//
//  Verified live on Premiere 26.5.2 (2026-11-17):
//   - ComponentParam keys: addKey / setValueAtKey / getKeys take SECONDS in
//     MEDIA time: keyT = seqT - clip.start + clip.inPoint. Default
//     interpolation renders linear; setInterpolationTypeAtKey modes per
//     Adobe PProPanel: Linear 0, Hold 4, Bezier 5, Time 6.
//   - Opacity ▸ Opacity is %, Motion ▸ Position is normalised [x, y],
//     Motion ▸ Scale is %, audio Volume ▸ Level is LINEAR amplitude with
//     1.0 = +15 dB (0 dB = 0.17782794).
//   - QE getVideoEffectByName + addVideoEffect: Gaussian Blur, Directional
//     Blur (new-generation: Amount / Angle / Edge Behavior), Crop, Offset,
//     Transform attach. Linear Wipe is found by name but does NOT attach.
//     QE item lookup must go through getActiveSequence() (getSequenceAt
//     throws).
//   - QE exportFramePNG writes RGBA: faded areas are transparent.
//  Writes are read back; debug goes in the returned JSON (never $.writeln).
// ============================================================================

/* global app, qe, PremiereBridge, _findSequence, _secondsToTicks */

var MOTION_BRIDGE_JSX_VERSION = "2026-11-17.m2";

function _mbSeq(p) { return p && p.sequenceName ? _findSequence(p.sequenceName) : app.project.activeSequence; }

function _mbTrack(seq, kind, idx) {
  var tracks = kind === "audio" ? seq.audioTracks : seq.videoTracks;
  return (idx >= 0 && idx < tracks.numTracks) ? tracks[idx] : null;
}

function _mbItem(seq, p) {
  var tr = _mbTrack(seq, p.kind || "video", p.trackIndex || 0);
  if (!tr) return { error: "No " + (p.kind || "video") + " track " + p.trackIndex };
  var ci = p.clipIndex || 0;
  if (ci < 0 || ci >= tr.clips.numItems) return { error: "No clip " + ci + " on " + (p.kind || "video") + " track " + p.trackIndex + " (has " + tr.clips.numItems + ")" };
  return { item: tr.clips[ci], track: tr };
}

function _mbComp(item, name, occurrence) {
  var hits = [];
  for (var k = 0; k < item.components.numItems; k++) {
    var c = item.components[k];
    if (c.displayName === name || c.matchName === name) hits.push(c);
  }
  if (!hits.length) return null;
  if (occurrence === undefined || occurrence === null || occurrence < 0) return hits[hits.length - 1];
  return hits[occurrence] || null;
}

function _mbParam(comp, name) {
  for (var j = 0; j < comp.properties.numItems; j++) if (comp.properties[j].displayName === name) return comp.properties[j];
  return null;
}

// Linked partners (A/V) as {kind, trackIndex, clipIndex}.
function _mbLinked(seq, item) {
  var out = [], li = null;
  try { li = item.getLinkedItems(); } catch (e) { return out; }
  if (!li) return out;
  for (var i = 0; i < li.numItems; i++) {
    var x = li[i];
    if (x.nodeId === item.nodeId) continue;
    var kinds = ["video", "audio"];
    for (var kk = 0; kk < 2; kk++) {
      var tracks = kinds[kk] === "video" ? seq.videoTracks : seq.audioTracks;
      for (var t = 0; t < tracks.numTracks; t++) for (var c = 0; c < tracks[t].clips.numItems; c++) {
        if (tracks[t].clips[c].nodeId === x.nodeId) out.push({ kind: kinds[kk], trackIndex: t, clipIndex: c });
      }
    }
  }
  return out;
}

function _mbVal(v) { return (v instanceof Array) ? v.slice(0) : v; }

PremiereBridge["motion.listClips"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var out = { sequence: seq.name, width: seq.frameSizeHorizontal, height: seq.frameSizeVertical, frameDurationSec: seq.getSettings().videoFrameRate.seconds, video: [], audio: [] };
  var kinds = ["video", "audio"];
  for (var kk = 0; kk < 2; kk++) {
    var tracks = kinds[kk] === "video" ? seq.videoTracks : seq.audioTracks;
    for (var t = 0; t < tracks.numTracks; t++) {
      var clips = [];
      for (var c = 0; c < tracks[t].clips.numItems; c++) {
        var it = tracks[t].clips[c], comps = [];
        for (var q = 0; q < it.components.numItems; q++) comps.push(it.components[q].displayName);
        var media = null, mediaDur = null;
        try { media = it.projectItem.getMediaPath(); } catch (e) {}
        try { mediaDur = it.projectItem.getOutPoint(4).seconds; } catch (e2) {}
        clips.push({ clipIndex: c, name: it.name, nodeId: it.nodeId, startSec: it.start.seconds, endSec: it.end.seconds, inSec: it.inPoint.seconds, outSec: it.outPoint.seconds, mediaPath: media, mediaDurationSec: mediaDur, components: comps, linked: _mbLinked(seq, it) });
      }
      out[kinds[kk]].push({ trackIndex: t, clips: clips });
    }
  }
  return out;
};

PremiereBridge["motion.probe"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var comps = [];
  for (var k = 0; k < r.item.components.numItems; k++) {
    var c = r.item.components[k], ps = [];
    if (c.matchName === "AE.ADBE Lumetri") { comps.push({ index: k, name: c.displayName, matchName: c.matchName, params: "(Lumetri — use color.probeLumetri)" }); continue; }
    for (var j = 0; j < c.properties.numItems; j++) {
      var pr = c.properties[j], v = null, tv = false, nk = 0;
      try { v = pr.getValue(); } catch (e) {}
      try { tv = pr.isTimeVarying(); } catch (e2) {}
      try { var ks = pr.getKeys(); nk = ks ? ks.length : 0; } catch (e3) {}
      ps.push({ index: j, name: pr.displayName, value: _mbVal(v), timeVarying: tv, keys: nk });
    }
    comps.push({ index: k, name: c.displayName, matchName: c.matchName, params: ps });
  }
  return { sequence: seq.name, clip: r.item.name, startSec: r.item.start.seconds, inSec: r.item.inPoint.seconds, components: comps };
};

// Add a video effect by display name through QE (activate + restore).
PremiereBridge["motion.addEffect"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var before = 0;
  for (var k = 0; k < r.item.components.numItems; k++) if (r.item.components[k].displayName === p.effectName) before++;
  var prev = app.project.activeSequence, switched = !prev || prev.sequenceID !== seq.sequenceID, err = null;
  if (switched) app.project.activeSequence = seq;
  try {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    var eff = qe.project.getVideoEffectByName(p.effectName);
    if (!eff) err = "No video effect named '" + p.effectName + "'";
    else {
      var qt = qs.getVideoTrackAt(p.trackIndex || 0), it = null, n = -1;
      for (var i = 0; i < qt.numItems; i++) { var cand = qt.getItemAt(i); if (cand.type === "Empty") continue; n++; if (n === (p.clipIndex || 0)) { it = cand; break; } }
      if (!it) err = "QE item not found"; else it.addVideoEffect(eff);
    }
  } catch (e) { err = "addVideoEffect failed: " + e.message; }
  if (switched && prev) app.project.activeSequence = prev;
  if (err) return { error: err };
  var after = 0;
  for (k = 0; k < r.item.components.numItems; k++) if (r.item.components[k].displayName === p.effectName) after++;
  if (after <= before) return { error: "Effect '" + p.effectName + "' did not appear on the clip" };
  return { added: true, effectName: p.effectName, occurrence: after - 1, componentCount: r.item.components.numItems };
};

// Static values: [{ component, occurrence?, param, value }]
PremiereBridge["motion.setValues"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var res = [];
  for (var i = 0; i < (p.values || []).length; i++) {
    var v = p.values[i], c = _mbComp(r.item, v.component, v.occurrence), out = { component: v.component, param: v.param, requested: v.value };
    if (!c) { out.error = "component not on clip"; res.push(out); continue; }
    var pr = _mbParam(c, v.param);
    if (!pr) { out.error = "param not found"; res.push(out); continue; }
    try {
      if (pr.isTimeVarying()) pr.setTimeVarying(false, true);
      pr.setValue(v.value, true);
      out.after = _mbVal(pr.getValue());
      out.ok = true;
    } catch (e) { out.error = e.message; }
    res.push(out);
  }
  return { results: res };
};

// Keys: { component, occurrence?, param, keys:[{t, v}], interp, clearFrom?, clearTo? }
// t in CLIP time (seconds); interp 0 linear / 5 bezier / 4 hold.
PremiereBridge["motion.setKeys"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var c = _mbComp(r.item, p.component, p.occurrence);
  if (!c) return { error: "component '" + p.component + "' not on clip " + r.item.name };
  var pr = _mbParam(c, p.param);
  if (!pr) return { error: "param '" + p.param + "' not in " + p.component };
  if (!pr.areKeyframesSupported()) return { error: p.component + " ▸ " + p.param + " does not support keyframes" };
  var keys = p.keys || [];
  if (!keys.length) return { error: "no keys" };
  try {
    if (!pr.isTimeVarying()) pr.setTimeVarying(true, true);
    var lo = (p.clearFrom !== undefined) ? p.clearFrom : keys[0].t - 1e-4;
    var hi = (p.clearTo !== undefined) ? p.clearTo : keys[keys.length - 1].t + 1e-4;
    try { pr.removeKeyRange(lo, hi, true); } catch (eR) {}
    for (var i = 0; i < keys.length; i++) {
      pr.addKey(keys[i].t);
      pr.setValueAtKey(keys[i].t, keys[i].v, true);
    }
    var interp = (p.interp === undefined) ? 0 : p.interp;
    for (i = 0; i < keys.length; i++) { try { pr.setInterpolationTypeAtKey(keys[i].t, interp, true); } catch (eI) {} }
  } catch (e) { return { error: "keyframing failed: " + e.message }; }
  // Read back first / middle / last.
  var chk = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]], rb = [], ok = true;
  for (var q = 0; q < chk.length; q++) {
    var got = pr.getValueAtTime(chk[q].t), want = chk[q].v;
    var g = (got instanceof Array) ? got : [got], w = (want instanceof Array) ? want : [want];
    for (var z = 0; z < w.length; z++) if (Math.abs(g[z] - w[z]) > 0.01 * Math.max(1, Math.abs(w[z]))) ok = false;
    rb.push({ t: chk[q].t, want: want, got: _mbVal(got) });
  }
  var total = 0;
  try { total = pr.getKeys().length; } catch (eK) {}
  return { clip: r.item.name, component: c.displayName, param: pr.displayName, keysWritten: keys.length, keysOnParam: total, interp: interp, readBack: rb, ok: ok };
};

// Remove every key on a param (restore to a static value).
PremiereBridge["motion.clearKeys"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var c = _mbComp(r.item, p.component, p.occurrence);
  if (!c) return { error: "component not on clip" };
  var pr = _mbParam(c, p.param);
  if (!pr) return { error: "param not found" };
  try { pr.removeKeyRange(-1e6, 1e6, true); pr.setTimeVarying(false, true); if (p.value !== undefined) pr.setValue(p.value, true); } catch (e) { return { error: e.message }; }
  return { cleared: true, value: _mbVal(pr.getValue()) };
};

function _mbFindProjectItem(p) {
  var want = p.mediaPath || null, name = p.projectItemName || null;
  function walk(bin) {
    for (var i = 0; i < bin.children.numItems; i++) {
      var c = bin.children[i];
      if (c.type === 2) { var f = walk(c); if (f) return f; continue; }
      try { if (want && c.getMediaPath && c.getMediaPath() === want) return c; } catch (e) {}
      if (name && c.name === name) return c;
    }
    return null;
  }
  return walk(app.project.rootItem);
}

// Place a source range at an exact sequence time (overwrite, no ripple).
// Uses projectItem in/out (4 = all media types) then track.overwriteClip,
// then restores the project item's previous in/out.
PremiereBridge["motion.placeClip"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var pi = _mbFindProjectItem(p);
  if (!pi) return { error: "Project item not found: " + (p.mediaPath || p.projectItemName) };
  var tr = _mbTrack(seq, p.kind || "video", p.trackIndex || 0);
  if (!tr) return { error: "track not found" };
  var oldIn = null, oldOut = null;
  try { oldIn = pi.getInPoint(4).seconds; oldOut = pi.getOutPoint(4).seconds; } catch (e) {}
  try {
    if (p.inSec !== undefined) pi.setInPoint(p.inSec, 4);
    if (p.outSec !== undefined) pi.setOutPoint(p.outSec, 4);
    tr.overwriteClip(pi, p.startSec);
  } catch (e2) { return { error: "overwriteClip failed: " + e2.message }; }
  try { if (oldIn !== null) pi.setInPoint(oldIn, 4); if (oldOut !== null) pi.setOutPoint(oldOut, 4); } catch (e3) {}
  // Find what landed.
  for (var c = 0; c < tr.clips.numItems; c++) {
    var it = tr.clips[c];
    if (Math.abs(it.start.seconds - p.startSec) < 0.02) return { placed: true, clipIndex: c, name: it.name, startSec: it.start.seconds, endSec: it.end.seconds, inSec: it.inPoint.seconds, outSec: it.outPoint.seconds };
  }
  return { error: "clip did not land at " + p.startSec + "s" };
};

// Remove every clip on the listed tracks (rebuilding a WORKING sequence).
PremiereBridge["motion.clearTracks"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var removed = 0, i, t;
  var vt = p.video || [], at = p.audio || [];
  for (t = 0; t < vt.length; t++) { var tr = _mbTrack(seq, "video", vt[t]); if (!tr) continue; for (i = tr.clips.numItems - 1; i >= 0; i--) { tr.clips[i].remove(false, false); removed++; } }
  for (t = 0; t < at.length; t++) { var ta = _mbTrack(seq, "audio", at[t]); if (!ta) continue; for (i = ta.clips.numItems - 1; i >= 0; i--) { ta.clips[i].remove(false, false); removed++; } }
  return { removed: removed };
};

PremiereBridge["motion.importFiles"] = function (p) {
  var before = app.project.rootItem.children.numItems;
  var ok = app.project.importFiles(p.paths, true, app.project.rootItem, false);
  var found = [];
  for (var i = 0; i < p.paths.length; i++) {
    var pi = _mbFindProjectItem({ mediaPath: p.paths[i] });
    found.push({ path: p.paths[i], name: pi ? pi.name : null, ok: !!pi });
  }
  return { imported: ok, rootItemsBefore: before, rootItemsAfter: app.project.rootItem.children.numItems, items: found };
};

// Add tracks through QE (activate + restore).
PremiereBridge["motion.ensureTracks"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var needV = Math.max(0, (p.video || 0) - seq.videoTracks.numTracks), needA = Math.max(0, (p.audio || 0) - seq.audioTracks.numTracks);
  if (!needV && !needA) return { video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks, added: false };
  var prev = app.project.activeSequence, switched = !prev || prev.sequenceID !== seq.sequenceID, err = null;
  if (switched) app.project.activeSequence = seq;
  try {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    // addTracks(numVideo, videoAfterIndex, numAudio, audioType 1=stereo, audioAfterIndex, numSubmix, submixType, submixAfter)
    qs.addTracks(needV, seq.videoTracks.numTracks, needA, 1, seq.audioTracks.numTracks, 0, 1, 0);
  } catch (e) { err = "addTracks failed: " + e.message; }
  if (switched && prev) app.project.activeSequence = prev;
  if (err) return { error: err };
  return { video: seq.videoTracks.numTracks, audio: seq.audioTracks.numTracks, added: true };
};

// Remove one clip (optionally with its linked partners). No ripple.
PremiereBridge["motion.removeClip"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var gone = [{ kind: p.kind || "video", trackIndex: p.trackIndex || 0, name: r.item.name, startSec: r.item.start.seconds }];
  var partners = [];
  if (p.withLinked !== false) {
    var li = null;
    try { li = r.item.getLinkedItems(); } catch (e) {}
    if (li) for (var i = 0; i < li.numItems; i++) if (li[i].nodeId !== r.item.nodeId) partners.push(li[i]);
  }
  try { r.item.remove(false, false); } catch (e1) { return { error: "remove failed: " + e1.message }; }
  for (var j = 0; j < partners.length; j++) { try { gone.push({ linked: true, name: partners[j].name, startSec: partners[j].start.seconds }); partners[j].remove(false, false); } catch (e2) {} }
  return { removed: gone };
};

// Set a clip's sequence end (stills / graphics length). Reads back.
PremiereBridge["motion.setClipEnd"] = function (p) {
  var seq = _mbSeq(p);
  if (!seq) return { error: "Sequence not found" };
  var r = _mbItem(seq, p);
  if (r.error) return r;
  var t = new Time();
  t.seconds = p.endSec;
  try { r.item.end = t; } catch (e) { return { error: "set end failed: " + e.message }; }
  return { name: r.item.name, startSec: r.item.start.seconds, endSec: r.item.end.seconds, ok: Math.abs(r.item.end.seconds - p.endSec) < 0.05 };
};

PremiereBridge["motion._info"] = function () { return { motionBridgeVersion: MOTION_BRIDGE_JSX_VERSION }; };
