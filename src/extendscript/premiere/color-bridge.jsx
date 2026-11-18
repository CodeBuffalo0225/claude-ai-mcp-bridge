// ============================================================================
//  Color bridge handlers — loaded by premiere-bridge.jsx via $.evalFile so
//  they live in their own file. ExtendScript (ES3): no let/const/arrows.
//
//  Every handler here is evidence-first:
//   - probe returns what Lumetri actually exposes (names, types, values);
//   - writes are guarded (the index must still carry the expected display
//     name) and READ BACK — `ok` means getValue() returned what we set;
//   - frame export uses QE exportFramePNG (verified on Premiere 26.5.2;
//     the DOM Sequence has no exportFramePNG).
//  Debug output goes in the returned JSON, never $.writeln (corrupts the
//  WebSocket relay — hard rule).
// ============================================================================

/* global app, qe, PremiereBridge, _findSequence, _secondsToTicks */

var COLOR_BRIDGE_JSX_VERSION = "2026-11-14.c3";

function _cbSeq(params) {
  if (params && params.sequenceName) return _findSequence(params.sequenceName);
  return app.project.activeSequence;
}

function _cbClip(seq, params) {
  var t = (params.trackIndex !== undefined) ? params.trackIndex : 0;
  var c = (params.clipIndex !== undefined) ? params.clipIndex : 0;
  var track = seq.videoTracks[t];
  if (!track) return { error: "No video track V" + t };
  if (c < 0 || c >= track.clips.numItems) return { error: "No clip at V" + t + ":" + c + " (track has " + track.clips.numItems + ")" };
  return { clip: track.clips[c], trackIndex: t, clipIndex: c };
}

function _cbLumetris(clip) {
  var out = [];
  for (var i = 0; i < clip.components.numItems; i++) {
    if (clip.components[i].matchName === "AE.ADBE Lumetri") out.push(clip.components[i]);
  }
  return out;
}

function _cbType(v) {
  if (v === null || v === undefined) return "null";
  if (v instanceof Array) return "array";
  return typeof v;
}

function _cbProps(lum) {
  var props = [];
  for (var i = 0; i < lum.properties.numItems; i++) {
    var p = lum.properties[i];
    var v = null, ty = "error", err = null;
    try { v = p.getValue(); ty = _cbType(v); } catch (e) { err = e.message; }
    var entry = { index: i, name: p.displayName, type: ty };
    if (ty === "number" || ty === "boolean") entry.value = v;
    else if (ty === "string") entry.blobLength = v.length; // opaque: never ship raw bytes
    if (err) entry.error = err;
    props.push(entry);
  }
  return props;
}

// Add a Lumetri Color instance to a clip through the QE DOM.
// Verified on 26.5.2: qe.project.getSequenceAt(i) throws an uncatchable
// "Unknown error exception", so the target sequence is activated briefly and
// reached through qe.project.getActiveSequence(), then the previous active
// sequence is restored. QE track items include "Empty" gap items, so the DOM
// clip index is mapped by skipping them.
function _cbAddLumetri(seq, trackIndex, clipIndex) {
  var prev = app.project.activeSequence;
  var switched = !prev || prev.sequenceID !== seq.sequenceID;
  if (switched) app.project.activeSequence = seq;
  var err = null;
  try {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs || qs.name !== seq.name) {
      err = "QE active sequence is '" + (qs ? qs.name : "none") + "', expected '" + seq.name + "'";
    } else {
      var qt = qs.getVideoTrackAt(trackIndex), it = null, n = -1;
      for (var i = 0; i < qt.numItems; i++) {
        var cand = qt.getItemAt(i);
        if (cand.type === "Empty") continue;
        n++;
        if (n === clipIndex) { it = cand; break; }
      }
      if (!it) err = "Could not locate V" + trackIndex + ":" + clipIndex + " in the QE DOM";
      else it.addVideoEffect(qe.project.getVideoEffectByName("Lumetri Color"));
    }
  } catch (e) {
    err = "QE addVideoEffect(Lumetri Color) failed: " + e.message;
  }
  if (switched && prev) app.project.activeSequence = prev;
  return err;
}

PremiereBridge["color.probeLumetri"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  var r = _cbClip(seq, params);
  if (r.error) return r;
  var lums = _cbLumetris(r.clip);
  var inst = params.instance || 0;
  var res = {
    colorBridgeVersion: COLOR_BRIDGE_JSX_VERSION,
    sequence: seq.name,
    clip: { name: r.clip.name, trackIndex: r.trackIndex, clipIndex: r.clipIndex, startSec: r.clip.start.seconds, endSec: r.clip.end.seconds, inSec: r.clip.inPoint.seconds },
    lumetriCount: lums.length,
    instance: inst,
    props: null
  };
  if (inst < lums.length) res.props = _cbProps(lums[inst]);
  return res;
};

PremiereBridge["color.setLumetriParams"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  var r = _cbClip(seq, params);
  if (r.error) return r;
  var inst = params.instance || 0;
  var lums = _cbLumetris(r.clip);
  var added = false;
  if (inst >= lums.length) {
    if (!params.ensure || inst !== lums.length) {
      return { error: "Clip has " + lums.length + " Lumetri instance(s); instance " + inst + " does not exist" + (params.ensure ? " (can only add the next one)" : " — pass ensure:true to add one") };
    }
    if (params.dryRun) return { error: "dryRun: instance " + inst + " would be added (not added)" };
    var addErr = _cbAddLumetri(seq, r.trackIndex, r.clipIndex);
    if (addErr) return { error: addErr };
    lums = _cbLumetris(r.clip);
    if (inst >= lums.length) return { error: "Lumetri was not added (QE call returned but no component appeared)" };
    added = true;
  }
  var lum = lums[inst];
  var results = [];
  var writes = params.writes || [];
  for (var w = 0; w < writes.length; w++) {
    var wr = writes[w];
    var out = { index: wr.index, name: wr.name, requested: wr.value };
    if (wr.index < 0 || wr.index >= lum.properties.numItems) { out.error = "index out of range"; results.push(out); continue; }
    var p = lum.properties[wr.index];
    if (p.displayName !== wr.name) { out.error = "index " + wr.index + " is '" + p.displayName + "', expected '" + wr.name + "' — Lumetri layout changed; re-probe"; results.push(out); continue; }
    try {
      out.before = p.getValue();
      if (typeof out.before !== "number") { out.error = "not a numeric control (" + _cbType(out.before) + ")"; results.push(out); continue; }
      if (!params.dryRun) p.setValue(wr.value, true);
      out.after = p.getValue();
      var tol = 0.001 * Math.max(1, Math.abs(wr.value));
      out.ok = params.dryRun ? null : (Math.abs(out.after - wr.value) <= tol);
    } catch (e2) {
      out.error = "setValue/getValue failed: " + e2.message;
    }
    results.push(out);
  }
  return { colorBridgeVersion: COLOR_BRIDGE_JSX_VERSION, sequence: seq.name, clipName: r.clip.name, lumetriCount: lums.length, instance: inst, added: added, dryRun: !!params.dryRun, results: results };
};

PremiereBridge["color.exportFrame"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  if (!params.outPath) return { error: "outPath required (without .png)" };
  var prevActive = app.project.activeSequence;
  var prevPos = null;
  try { prevPos = seq.getPlayerPosition().ticks; } catch (e0) {}
  if (!prevActive || prevActive.sequenceID !== seq.sequenceID) app.project.activeSequence = seq;
  seq.setPlayerPosition(String(_secondsToTicks(params.timeSec || 0)));
  app.enableQE();
  var qs = qe.project.getActiveSequence();
  if (!qs || qs.name !== seq.name) return { error: "QE active sequence is '" + (qs ? qs.name : "none") + "', expected '" + seq.name + "'" };
  var tc = qs.CTI.timecode;
  var ok = qs.exportFramePNG(tc, params.outPath);
  var res = { ok: ok === true, timecode: tc, path: params.outPath + ".png", sequence: seq.name, restoredActive: false };
  if (params.restore !== false) {
    if (prevPos !== null) { try { seq.setPlayerPosition(prevPos); } catch (e1) {} }
    if (prevActive && prevActive.sequenceID !== seq.sequenceID) { app.project.activeSequence = prevActive; res.restoredActive = true; }
  }
  return res;
};

PremiereBridge["color.sourceInfo"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  var r = _cbClip(seq, params);
  if (r.error) return r;
  var pi = r.clip.projectItem;
  var out = { sequence: seq.name, clip: r.clip.name, trackIndex: r.trackIndex, clipIndex: r.clipIndex };
  try { out.mediaPath = pi.getMediaPath(); } catch (e) { out.mediaPathError = e.message; }
  try { out.colorSpace = pi.getColorSpace(); } catch (e2) { out.colorSpaceError = e2.message; }
  out.clipInSec = r.clip.inPoint.seconds;
  out.clipStartSec = r.clip.start.seconds;
  out.clipDurationSec = r.clip.duration.seconds;
  try {
    var st = seq.getSettings();
    var wcs = null;
    try { wcs = st.workingColorSpace ? (st.workingColorSpace.name || String(st.workingColorSpace)) : null; } catch (e3) {}
    out.sequenceSettings = { width: seq.frameSizeHorizontal, height: seq.frameSizeVertical, maximumBitDepth: st.maximumBitDepth, compositeLinearColor: st.compositeLinearColor, workingColorSpace: wcs, frameDurationSec: st.videoFrameRate ? st.videoFrameRate.seconds : null };
  } catch (e4) { out.sequenceSettingsError = e4.message; }
  var lums = _cbLumetris(r.clip);
  out.lumetriCount = lums.length;
  if (lums.length) {
    var lum = lums[0], inputLut = [], hdr = null;
    for (var i = 0; i < lum.properties.numItems; i++) {
      var p = lum.properties[i];
      try {
        if (p.displayName === "Input LUT") inputLut.push(p.getValue());
        else if (p.displayName === "High Dynamic Range" && hdr === null) hdr = p.getValue();
      } catch (e5) {}
    }
    out.lumetri = { inputLutValues: inputLut, highDynamicRange: hdr };
  }
  return out;
};

// Step 2 — the ONE technical transform for camera-log media, done by
// Premiere's own colour management (verified live on 26.5.2 with Sony FX3
// S-Log3/S-Gamut3.Cine): app.project.setLogColorManagement(true) makes
// Premiere read the camera's log metadata (getOriginalColorSpace becomes
// e.g. "Sony S-Log3/S-Gamut3.Cine", transfer 1001 / primaries 1012). If the
// item carries an explicit override that hides it, the override is set to
// that detected native ColorSpace. Name-built ColorSpace objects do NOT
// work (Premiere resolves by internal codes) — only the detected object.
// Project-wide switch: affects log media only. Revert: setLogColorManagement(false).
PremiereBridge["color.applyLogColorManagement"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  var r = _cbClip(seq, params);
  if (r.error) return r;
  var pi = r.clip.projectItem;
  if (typeof app.project.setLogColorManagement !== "function") return { error: "app.project.setLogColorManagement is not available on this Premiere version" };
  var before = pi.getColorSpace();
  var ok = app.project.setLogColorManagement(true);
  var original = pi.getOriginalColorSpace();
  var isLog = /log/i.test(original.name || "") && original.transferCharacteristic >= 900;
  if (!isLog) {
    return { applied: false, reason: "Premiere does not detect log in this media's metadata (original = '" + original.name + "'). Not transforming; declare the camera profile or set Interpret Footage manually.", before: before, original: original, effective: pi.getColorSpace(), projectLogColorManagement: ok };
  }
  var overrode = false;
  var eff = pi.getColorSpace();
  if (eff.name !== original.name) { pi.setOverrideColorSpace(original); overrode = true; }
  var after = pi.getColorSpace();
  return { applied: after.name === original.name, before: before, original: original, effective: after, overrodeExplicitOverride: overrode, projectLogColorManagement: ok, media: pi.name };
};

PremiereBridge["color.listClips"] = function (params) {
  var seq = _cbSeq(params);
  if (!seq) return { error: "Sequence not found: " + (params.sequenceName || "(active)") };
  var tracks = [];
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var tr = seq.videoTracks[t], clips = [];
    for (var c = 0; c < tr.clips.numItems; c++) {
      var cl = tr.clips[c], mp = null;
      try { mp = cl.projectItem.getMediaPath(); } catch (e) {}
      clips.push({ clipIndex: c, name: cl.name, startSec: cl.start.seconds, endSec: cl.end.seconds, inSec: cl.inPoint.seconds, lumetriCount: _cbLumetris(cl).length, mediaPath: mp });
    }
    tracks.push({ trackIndex: t, clips: clips });
  }
  return { sequence: seq.name, tracks: tracks };
};
