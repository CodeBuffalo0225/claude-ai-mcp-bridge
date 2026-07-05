// ============================================================================
//  Premiere Pro ExtendScript Bridge
//  This script runs inside Adobe Premiere Pro's ExtendScript engine
//  via a CEP (Common Extensibility Platform) panel.
//
//  It receives commands from the Node.js MCP server via WebSocket
//  and executes them in Premiere Pro's scripting DOM.
// ============================================================================

/* global app, $, ProjectItemType, QEApplication */

// Bump on every edit to this file. `_info` reports it so the preflight can
// verify which JSX build is actually live in the engine (stale-cache bug #10).
var BRIDGE_JSX_VERSION = "2026-07-05.1";

// ── Premiere Pro DOM API Wrappers ────────────────────────────────────────

var PremiereBridge = {

  // ── PROJECT ────────────────────────────────────────────────────

  "project.open": function(params) {
    app.openDocument(params.path);
    var proj = app.project;
    return {
      name: proj.name,
      path: proj.path,
      sequences: (function() {
        var seqs = [];
        for (var i = 0; i < proj.sequences.numSequences; i++) {
          seqs.push(proj.sequences[i].name);
        }
        return seqs;
      })()
    };
  },

  "project.create": function(params) {
    // In Premiere, you typically open/create via File menu or templates
    // This creates via scripting when supported
    return { path: params.path + "/" + params.name + ".prproj", name: params.name };
  },

  "project.getInfo": function() {
    var proj = app.project;
    var sequences = [];
    for (var i = 0; i < proj.sequences.numSequences; i++) {
      var seq = proj.sequences[i];
      sequences.push({
        name: seq.name,
        id: seq.id,
        duration: seq.end - seq.zeroPoint,
        videoTrackCount: seq.videoTracks.numTracks,
        audioTrackCount: seq.audioTracks.numTracks
      });
    }

    return {
      name: proj.name,
      path: proj.path,
      sequences: sequences,
      mediaCount: proj.rootItem.children.numItems,
      activeSequence: proj.activeSequence ? proj.activeSequence.name : null
    };
  },

  "project.save": function(params) {
    if (params.saveAs) {
      app.project.saveAs(params.saveAs);
    } else {
      app.project.save();
    }
    return { path: app.project.path };
  },

  "project.importMedia": function(params) {
    var imported = [];
    var targetBin = app.project.rootItem;

    // Find or create target bin
    if (params.bin) {
      var found = false;
      for (var i = 0; i < targetBin.children.numItems; i++) {
        if (targetBin.children[i].name === params.bin && targetBin.children[i].type === ProjectItemType.BIN) {
          targetBin = targetBin.children[i];
          found = true;
          break;
        }
      }
      if (!found) {
        targetBin = app.project.rootItem.createBin(params.bin);
      }
    }

    // Import each file
    if (app.project.importFiles) {
      var success = app.project.importFiles(
        params.files,
        true, // suppress UI
        targetBin,
        false  // import as numbered stills
      );
      if (success) {
        imported = params.files;
      }
    }

    return { imported: imported, bin: params.bin || "root" };
  },

  // ── TIMELINE ───────────────────────────────────────────────────

  "timeline.create": function(params) {
    // Validate preset path BEFORE calling createNewSequence — if the file is
    // missing, Premiere pops a sequence-settings modal and the WebSocket reply
    // never comes back. Fail fast with a useful error instead.
    var presetPath = params.presetPath;
    if (presetPath) {
      var presetFile = new File(presetPath);
      if (!presetFile.exists) presetPath = null;
    }

    // No preset supplied — search installed Premiere versions for one matching
    // the requested dimensions + frame rate.
    if (!presetPath) {
      presetPath = _findDefaultPreset(params.width, params.height, params.frameRate);
    }

    if (!presetPath) {
      return {
        error: "No valid sequence preset found. Pass params.presetPath pointing to a .sqpreset file, or create the sequence manually in Premiere.",
        requested: { width: params.width, height: params.height, frameRate: params.frameRate }
      };
    }

    var seq;
    try {
      seq = app.project.createNewSequence(params.name, presetPath);
    } catch(e) {
      return { error: "createNewSequence failed: " + e.message, presetPath: presetPath };
    }
    if (!seq) return { error: "createNewSequence returned null", presetPath: presetPath };

    // Override dimensions if the requested size differs from the preset
    if (params.width && params.height) {
      try {
        var s = seq.getSettings();
        s.videoFrameWidth  = params.width;
        s.videoFrameHeight = params.height;
        seq.setSettings(s);
      } catch(e) {}
    }

    return { name: params.name, id: seq.id, created: true, presetUsed: presetPath };
  },

  "timeline.getState": function(params) {
    var seq = params.sequenceName
      ? _findSequence(params.sequenceName)
      : app.project.activeSequence;

    if (!seq) return { error: "No active sequence" };

    var videoTracks = [];
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vTrack = seq.videoTracks[v];
      var clips = [];
      for (var c = 0; c < vTrack.clips.numItems; c++) {
        var clip = vTrack.clips[c];
        clips.push({
          name: clip.name,
          start: clip.start.seconds,
          end: clip.end.seconds,
          duration: clip.duration.seconds,
          inPoint: clip.inPoint ? clip.inPoint.seconds : 0,
          outPoint: clip.outPoint ? clip.outPoint.seconds : 0,
          mediaPath: clip.projectItem ? clip.projectItem.getMediaPath() : ""
        });
      }
      videoTracks.push({ index: v, name: vTrack.name, clips: clips });
    }

    var audioTracks = [];
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var aTrack = seq.audioTracks[a];
      var aClips = [];
      for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
        var aClip = aTrack.clips[ac];
        aClips.push({
          name: aClip.name,
          start: aClip.start.seconds,
          end: aClip.end.seconds,
          duration: aClip.duration.seconds
        });
      }
      audioTracks.push({ index: a, name: aTrack.name, clips: aClips });
    }

    // Markers
    var markers = [];
    for (var m = 0; m < seq.markers.numMarkers; m++) {
      var marker = seq.markers[m];
      markers.push({
        name: marker.name,
        start: marker.start.seconds,
        end: marker.end.seconds,
        comment: marker.comments,
        type: marker.type
      });
    }

    return {
      name: seq.name,
      duration: seq.end ? (seq.end - seq.zeroPoint) : 0,
      playheadPosition: seq.getPlayerPosition ? seq.getPlayerPosition().seconds : 0,
      videoTracks: videoTracks,
      audioTracks: audioTracks,
      markers: markers,
      settings: {
        width: seq.frameSizeHorizontal,
        height: seq.frameSizeVertical
      }
    };
  },

  "timeline.addClip": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };
    var item = _findProjectItem(params.mediaName);
    if (!item) return { error: "Media not found: " + params.mediaName };

    // Set source in/out points on the project item.
    // Premiere's setInPoint/setOutPoint expect (timeAsTicksString, mediaType)
    // where mediaType: 1=audio, 2=video, 4=audio+video. Old code passed seconds
    // and mediaType=1 (audio-only), so video placement used full source length.
    if (params.inPoint !== undefined) {
      try { item.setInPoint(String(_secondsToTicks(params.inPoint)), 4); }
      catch(e) { try { item.setInPoint(params.inPoint, 4); } catch(e2) {} }
    }
    if (params.outPoint !== undefined) {
      try { item.setOutPoint(String(_secondsToTicks(params.outPoint)), 4); }
      catch(e) { try { item.setOutPoint(params.outPoint, 4); } catch(e2) {} }
    }

    // Place on video track — Premiere automatically links audio to A1
    var trackIdx = params.trackIndex || 0;
    var track = seq.videoTracks[trackIdx];
    if (!track) return { error: "Video track not found: " + trackIdx };

    // overwriteClip/insertClip require the start time as a STRING of ticks.
    // Passing a JS number silently fails and Premiere falls back to appending
    // at the track's end — that's the "everything got appended" bug.
    var startTicks = (params.startTime !== undefined)
      ? String(_secondsToTicks(params.startTime))
      : "0";

    // insertClip honors the project item's in/out trim; overwriteClip is the
    // fallback. Track which path actually placed the clip.
    var placed = false;
    var method = null;
    if (track.insertClip) {
      try { track.insertClip(item, startTicks); placed = true; method = "insertClip"; }
      catch(e) {}
    }
    if (!placed && track.overwriteClip) {
      try { track.overwriteClip(item, startTicks); placed = true; method = "overwriteClip"; }
      catch(e) {}
    }

    return {
      placed: placed,
      method: method,
      mediaName: params.mediaName,
      startTime: params.startTime,
      inPoint: params.inPoint,
      outPoint: params.outPoint
    };
  },

  "multicam.sync": function(params) {
    // Synchronize multiple clips on the timeline using audio waveform, timecode,
    // markers, or in/out points. Built 2026-05-22 per Travis spec — fishing boat
    // footage typically has GoPro + phone + drone that need waveform-based sync.
    //
    // params:
    //   clipNames: string[]  — clips on timeline to synchronize (by name match)
    //   trackIndex: number   — video track to look on (default 0 = V1)
    //   method: 'audio' | 'timecode' | 'markers' | 'in_points' | 'out_points'  (default 'audio')
    //   syncTrackChannel: number (default 1) — audio track channel for waveform sync
    //
    // Returns: { synced: bool, method: string, clipsAffected: number, ... }

    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    var method = params.method || 'audio';
    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var clipNames = params.clipNames || [];

    if (clipNames.length < 2) {
      return { error: "Need at least 2 clipNames to synchronize" };
    }

    var track = seq.videoTracks[trackIdx];
    if (!track) return { error: "Video track not found: V" + (trackIdx + 1) };

    // 1. Locate target clips on the track + select them (programmatic selection)
    var found = [];
    for (var i = 0; i < track.clips.numItems; i++) {
      var clip = track.clips[i];
      for (var j = 0; j < clipNames.length; j++) {
        if (clip.name === clipNames[j]) {
          found.push({ clip: clip, idx: i, name: clip.name });
          break;
        }
      }
    }
    if (found.length < 2) {
      return {
        error: "Found only " + found.length + " of " + clipNames.length + " clips on V" + (trackIdx + 1),
        foundNames: found.map(function(f) { return f.name; })
      };
    }

    // Select the clips so Premiere's synchronize command operates on them
    try {
      for (var f = 0; f < found.length; f++) {
        var addToSelection = (f > 0);
        found[f].clip.setSelected(true, !addToSelection);
      }
    } catch(e) {
      return { error: "Failed to select clips: " + e.message };
    }

    // 2. Try multiple sync paths, in order of reliability

    // Path A: native ProjectItem.synchronize on bin items (binItem.synchronize)
    // Skipping — only works on bin items, not timeline clips.

    // Path B: QE DOM synchronize on the active sequence
    var qeErr = null;
    try { app.enableQE(); } catch(e) {}
    if (typeof qe !== "undefined" && qe.project) {
      try {
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq && typeof qeSeq.synchronize === 'function') {
          // qe.synchronize signature: (syncType, audioChannel)
          // syncType: 0=in points, 1=out points, 2=timecode, 3=markers, 4=audio
          var syncTypeMap = { 'in_points': 0, 'out_points': 1, 'timecode': 2, 'markers': 3, 'audio': 4 };
          var syncTypeId = (syncTypeMap[method] !== undefined) ? syncTypeMap[method] : 4;
          var audioCh = params.syncTrackChannel || 1;
          qeSeq.synchronize(syncTypeId, audioCh);
          return {
            synced: true,
            method: 'qe.synchronize',
            syncBy: method,
            clipsAffected: found.length,
            clipNames: found.map(function(f) { return f.name; })
          };
        }
        qeErr = "qeSeq.synchronize not available";
      } catch(e) {
        qeErr = "qeSeq.synchronize threw: " + e.message;
      }
    } else {
      qeErr = "QE not initialized";
    }

    // Path C: fire Premiere menu command "Synchronize..." via executeCommand.
    // Premiere will open the Synchronize dialog with default sync method preselected.
    // Travis can click OK to accept.
    var menuErr = null;
    try {
      if (app.menuCommands && app.menuCommands.id) {
        var cmdId = app.menuCommands.id("Synchronize...");
        if (cmdId) {
          app.executeCommand(cmdId);
          return {
            synced: 'dialog_opened',
            method: 'menuCommand',
            note: "Synchronize dialog opened in Premiere. Click OK to confirm sync.",
            clipsAffected: found.length
          };
        }
        menuErr = "Menu command 'Synchronize...' not found";
      } else {
        menuErr = "app.menuCommands.id not available in this Premiere version";
      }
    } catch(e) {
      menuErr = "executeCommand threw: " + e.message;
    }

    return {
      synced: false,
      error: "All sync paths failed. Manual: select clips on timeline, Edit > Synchronize...",
      qeError: qeErr,
      menuError: menuErr,
      premiereVersion: app.version,
      clipsFound: found.length
    };
  },

  "timeline.setPlayhead": function(params) {
    var seq = app.project.activeSequence;
    if (seq && seq.setPlayerPosition) {
      seq.setPlayerPosition(_secondsToTicks(params.time));
    }
    return { time: params.time };
  },

  "timeline.addMarker": function(params) {
    var seq = app.project.activeSequence;
    if (seq) {
      var marker = seq.markers.createMarker(params.time);
      if (marker) {
        marker.name = params.name;
        marker.comments = params.comment || "";
        if (params.duration) marker.end = params.time + params.duration;
      }
    }
    return { added: true };
  },

  // ── EDITING ────────────────────────────────────────────────────

  "timeline.duplicate": function(params) {
    // Clone an existing sequence — preserves ALL effects, grades, transitions,
    // markers, and clip arrangement. Use this when the source sequence has
    // color grading or effects that timeline.addClip would bypass (since
    // addClip pulls raw project items, not graded timeline instances).
    //
    // Workflow: duplicate the graded source → edit.deleteClip to carve down
    // → result preserves Travis's grade work.
    var src = _findSequence(params.sourceName);
    if (!src) return { error: "Source sequence not found: " + params.sourceName };

    // IMPORTANT: Sequence.clone() in Premiere's ExtendScript API returns a
    // BOOLEAN success flag (not a Sequence object). The newly created
    // sequence appears in app.project.sequences with " Copy" auto-suffixed
    // on the source name. We must locate it by diffing the sequence list
    // before/after the clone() call. (Codex PR #2 review caught the prior
    // bug where we treated the return value as a sequence.)

    // Snapshot existing sequence IDs so we can identify the new one
    var beforeIds = {};
    for (var bi = 0; bi < app.project.sequences.numSequences; bi++) {
      beforeIds[app.project.sequences[bi].id] = true;
    }

    var cloneResult;
    try { cloneResult = src.clone(); }
    catch(e) { return { error: "Sequence.clone() threw: " + e.message }; }

    // Find the newly created sequence (id not in beforeIds)
    var dupe = null;
    for (var ai = 0; ai < app.project.sequences.numSequences; ai++) {
      var candidate = app.project.sequences[ai];
      if (!beforeIds[candidate.id]) { dupe = candidate; break; }
    }

    if (!dupe) {
      return {
        error: "clone() returned " + String(cloneResult) + " but no new sequence appeared in app.project.sequences. " +
               "Possible causes: clone silently failed, or this Premiere version requires a different duplication API.",
        cloneReturnValue: String(cloneResult)
      };
    }

    if (params.destName) {
      try { dupe.name = params.destName; } catch(e) {
        return {
          duplicated: true,
          activated: false,
          warning: "Created duplicate but failed to rename to '" + params.destName + "': " + e.message,
          sourceName: src.name,
          destName: dupe.name,
          id: dupe.id
        };
      }
    }

    if (params.activate !== false) {
      try { app.project.activeSequence = dupe; } catch(e) {
        return {
          duplicated: true,
          activated: false,
          warning: "Renamed but failed to activate: " + e.message,
          sourceName: src.name,
          destName: dupe.name,
          id: dupe.id
        };
      }
    }

    return {
      sourceName: src.name,
      destName: dupe.name,
      id: dupe.id,
      duplicated: true,
      activated: params.activate !== false,
      cloneReturnValue: String(cloneResult)
    };
  },

  "timeline.setActive": function(params) {
    var seq = _findSequence(params.sequenceName);
    if (!seq) return { error: "Sequence not found: " + params.sequenceName };
    app.project.activeSequence = seq;
    return { active: seq.name };
  },

  "timeline.clearTrack": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };
    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var track = seq.videoTracks[trackIdx];
    var removed = 0;
    if (track) {
      for (var i = track.clips.numItems - 1; i >= 0; i--) {
        try { track.clips[i].remove(false, true); removed++; } catch(e) {}
      }
    }
    var aTrackIdx = (params.audioTrackIndex !== undefined) ? params.audioTrackIndex : 0;
    var aTrack = seq.audioTracks[aTrackIdx];
    if (aTrack) {
      for (var ai = aTrack.clips.numItems - 1; ai >= 0; ai--) {
        try { aTrack.clips[ai].remove(false, true); } catch(e) {}
      }
    }
    return { removed: removed };
  },

  "edit.deleteClip": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };
    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var clipIdx  = (params.clipIndex  !== undefined) ? params.clipIndex  : 0;
    var ripple   = (params.ripple !== undefined) ? params.ripple : true;

    // trackIndex >= 100 means audio track (100=A1, 101=A2, etc.)
    var track;
    if (trackIdx >= 100) {
      track = seq.audioTracks[trackIdx - 100];
    } else {
      track = seq.videoTracks[trackIdx];
    }
    if (!track) return { error: "Track not found: " + trackIdx };

    // clipIndex = -1 means clear ALL clips on this track
    if (clipIdx === -1) {
      var removed = 0;
      for (var i = track.clips.numItems - 1; i >= 0; i--) {
        try { track.clips[i].remove(false, true); removed++; } catch(e) {}
      }
      return { removed: removed, trackIndex: trackIdx, clearedAll: true };
    }

    if (clipIdx >= track.clips.numItems) {
      return { error: "Clip not found at [" + trackIdx + ":" + clipIdx + "]" };
    }
    var clip = track.clips[clipIdx];
    try { clip.remove(ripple, true); } catch(e) {
      return { error: "Could not remove clip: " + e.message };
    }
    return { removed: true, trackIndex: trackIdx, clipIndex: clipIdx };
  },

  "edit.moveClip": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };
    var srcTrack = seq.videoTracks[params.sourceTrack || 0];
    var clip = srcTrack.clips[params.clipIndex || 0];
    if (!clip) return { error: "Source clip not found" };
    var newStart = _secondsToTicks(params.destTime);
    clip.start = newStart;
    return { moved: true, destTime: params.destTime };
  },

  "edit.cut": function(params) {
    // Razor a clip at a specific timeline time. Splits both the targeted
    // video track AND the matching audio track so linked GoPro clips stay
    // in sync. Required fix: app.enableQE() must run before accessing qe
    // in Premiere 2024+, and razor times must be passed as STRING ticks.
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    // Enable QE — required in modern Premiere versions before qe.* is usable
    try { app.enableQE(); } catch(e) {}
    if (typeof qe === "undefined" || !qe.project) {
      return { error: "QE not available. app.enableQE() failed." };
    }

    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return { error: "QE active sequence unavailable" };

    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var timeTicks = String(_secondsToTicks(params.time));

    var videoCut = false, audioCut = false;

    // Razor on the requested video track
    try {
      var qeVTrack = qeSeq.getVideoTrackAt(trackIdx);
      if (qeVTrack && qeVTrack.razor) {
        qeVTrack.razor(timeTicks);
        videoCut = true;
      }
    } catch(e) {}

    // Also razor the matching audio track so linked GoPro audio stays in sync.
    // Skip if params.videoOnly is true (e.g., for split edits).
    if (!params.videoOnly) {
      try {
        var aIdx = (params.audioTrackIndex !== undefined) ? params.audioTrackIndex : trackIdx;
        var qeATrack = qeSeq.getAudioTrackAt(aIdx);
        if (qeATrack && qeATrack.razor) {
          qeATrack.razor(timeTicks);
          audioCut = true;
        }
      } catch(e) {}
    }

    if (!videoCut && !audioCut) {
      return { error: "Razor failed on both tracks. Check QE availability and track indices." };
    }

    // Move playhead to the cut for visual confirmation
    try { seq.setPlayerPosition(timeTicks); } catch(e) {}

    return { cut: true, time: params.time, trackIndex: trackIdx, videoCut: videoCut, audioCut: audioCut };
  },

  "edit.addTransition": function(params) {
    // Apply transition via QE DOM
    if (typeof QEApplication !== "undefined") {
      var qeSeq = QEApplication.project.getActiveSequence();
      var track = qeSeq.getVideoTrackAt(params.trackIndex);
      if (track) {
        var clip = track.getItemAt(params.clipIndex);
        if (clip) {
          var transitionName = _getTransitionName(params.transitionType);
          clip.addTransition(transitionName, params.position === "start", params.duration);
        }
      }
    }
    return { applied: true };
  },

  "edit.addText": function(params) {
    // Add an Essential Graphics text overlay to the timeline.
    // FIX 2026-05-22: old handler returned `{added: true}` even when both methods
    // failed silently. Now verifies the clip actually landed by re-counting track
    // clips before/after, and enables QE before trying the fallback.
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 1;
    var startSec = (params.startTime !== undefined) ? params.startTime : 0;
    var durSec   = (params.duration  !== undefined) ? params.duration  : 5;
    var text     = params.text || '';
    if (!text) return { error: "text required" };

    var track = seq.videoTracks[trackIdx];
    if (!track) return { error: "Video track not found: V" + (trackIdx + 1) };

    var beforeCount = track.clips.numItems;

    // ── Method 0: MOGRT import (most reliable in Premiere 2024-2026) ──
    // sequence.importMGT(path, ticks, vidTrackOffset, audTrackOffset) inserts
    // a Motion Graphics template and returns its trackItem. We then write the
    // caption text into its "Source Text" / first editable property. This is
    // the only path Adobe officially supports for scripted titles in recent
    // versions, so it's tried first whenever a template path is supplied.
    var method0Err = null;
    var mogrtPath = params.mogrtPath || null;
    if (mogrtPath) {
      try {
        var startTicks = Math.round(startSec * 254016000000);
        var mItem = seq.importMGT(mogrtPath, String(startTicks), trackIdx, 0);
        if (mItem) {
          // Set duration
          try {
            var endT = new Time(); endT.seconds = startSec + durSec;
            mItem.end = endT;
          } catch(eDur) {}
          // Write the text into the MOGRT's editable component(s)
          try {
            if (mItem.components) {
              for (var mc = 0; mc < mItem.components.numItems; mc++) {
                var mComp = mItem.components[mc];
                for (var mp = 0; mp < mComp.properties.numItems; mp++) {
                  var mProp = mComp.properties[mp];
                  if (mProp.displayName === 'Source Text' ||
                      mProp.displayName === 'Text' ||
                      mProp.displayName === 'Caption') {
                    try { mProp.setValue(text, true); } catch(eSet) {}
                  }
                }
              }
            }
          } catch(eTxt) {}
          if (track.clips.numItems > beforeCount) {
            return { added: true, method: 'importMGT', text: text, trackIndex: trackIdx, startTime: startSec, duration: durSec };
          }
          method0Err = "importMGT ran but track.clips count unchanged";
        } else {
          method0Err = "importMGT returned null";
        }
      } catch(e) {
        method0Err = "importMGT threw: " + e.message;
      }
    } else {
      method0Err = "no mogrtPath supplied (recommended path for reliable titles)";
    }

    // ── Method 1: native addTextClip (Premiere 2023+) ─────────────
    var method1Err = null;
    if (typeof track.addTextClip === 'function') {
      try {
        var tStart = new Time(); tStart.seconds = startSec;
        var tDur   = new Time(); tDur.seconds   = durSec;
        var newClip = track.addTextClip(text, tStart, tDur);

        // Style via Motion Graphics component properties
        if (newClip && newClip.components) {
          for (var c = 0; c < newClip.components.numItems; c++) {
            var comp = newClip.components[c];
            if (comp.displayName === 'Text' || comp.displayName === 'Graphics') {
              var props = comp.properties;
              for (var p = 0; p < props.numItems; p++) {
                var prop = props[p];
                try {
                  if (prop.displayName === 'Source Text') prop.setValue(text, true);
                  if (prop.displayName === 'Font Size')   prop.setValue(params.fontSize || 90, true);
                  if (prop.displayName === 'Fill Color')  prop.setValue([1,1,1,1], true);
                } catch(e) {}
              }
            }
          }
        }

        // Verify clip actually landed on the track (track.clips count increased)
        if (track.clips.numItems > beforeCount) {
          return { added: true, method: 'addTextClip', text: text, trackIndex: trackIdx, startTime: startSec, duration: durSec };
        }
        method1Err = "addTextClip returned without throwing but track.clips count unchanged (before=" + beforeCount + ", after=" + track.clips.numItems + ")";
      } catch(e) {
        method1Err = "addTextClip threw: " + e.message;
      }
    } else {
      method1Err = "track.addTextClip is not a function in this Premiere version";
    }

    // ── Method 2: QE DOM addTextClip (needs enableQE) ─────────────
    var method2Err = null;
    try { app.enableQE(); } catch(e) {}
    if (typeof qe !== "undefined" && qe.project) {
      try {
        var qeSeq   = qe.project.getActiveSequence();
        var qeTrack = qeSeq ? qeSeq.getVideoTrackAt(trackIdx) : null;
        if (qeTrack && typeof qeTrack.addTextClip === 'function') {
          var qeBefore = track.clips.numItems;
          qeTrack.addTextClip(text,
            String(Math.round(startSec * 254016000000)),
            String(Math.round(durSec   * 254016000000)));
          if (track.clips.numItems > qeBefore) {
            return { added: true, method: 'qe.addTextClip', text: text, trackIndex: trackIdx, startTime: startSec, duration: durSec };
          }
          method2Err = "qe.addTextClip ran but track.clips count unchanged";
        } else {
          method2Err = "qeTrack.addTextClip not available";
        }
      } catch(e) {
        method2Err = "qe.addTextClip threw: " + e.message;
      }
    } else {
      method2Err = "QE not initialized (app.enableQE failed)";
    }

    // All methods failed — return the diagnostic instead of lying
    return {
      added: false,
      error: "Text insertion failed. addTextClip is unavailable in this Premiere build.",
      method0Error: method0Err,
      method1Error: method1Err,
      method2Error: method2Err,
      premiereVersion: app.version,
      hint: "Premiere 2024+ removed scripted plain-text titles. Pass mogrtPath " +
            "(a .mogrt template exported from Essential Graphics) to edit_add_text " +
            "for reliable burned-in captions."
    };
  },

  // ── EXPORT ─────────────────────────────────────────────────────

  "export.media": function(params) {
    var seq = params.sequenceName
      ? _findSequence(params.sequenceName)
      : app.project.activeSequence;

    if (!seq) return { error: "No sequence found" };

    // Preset path map
    var presetMap = {
      'youtube_shorts_1080x1920': '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/YouTube 1080p HD.epr',
      'youtube_1080p_h264':       '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/YouTube 1080p HD.epr',
      'h264_high_quality':        '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/High Quality 1080 HD.epr',
      'tiktok_1080x1920':         '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/Mobile Device 1080p HD.epr',
      'instagram_reel_1080x1920': '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/Mobile Device 1080p HD.epr'
    };

    var presetPath = presetMap[params.preset] ||
      '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/YouTube 1080p HD.epr';

    // Ensure output dir exists
    var outFile = new File(params.outputPath);
    var outDir  = outFile.parent;
    if (!outDir.exists) outDir.create();

    // Queue in Adobe Media Encoder
    if (typeof app.encoder !== 'undefined') {
      try {
        app.encoder.launchEncoder();
        app.encoder.bind('onEncoderJobComplete', function(jobID, outputPath) {});
        var result = app.encoder.encodeSequence(
          seq,
          params.outputPath,
          presetPath,
          app.encoder.ENCODE_ENTIRE,
          false
        );
        return { started: true, queued: true, outputPath: params.outputPath, jobID: result || 'queued' };
      } catch(e) {
        return { error: 'AME error: ' + e.message };
      }
    }

    // Fallback: exportAsMediaDirect (no AME)
    try {
      seq.exportAsMediaDirect(params.outputPath, presetPath, app.encoder ? 1 : 0);
      return { started: true, queued: false, method: 'direct', outputPath: params.outputPath };
    } catch(e) {
      return { error: 'Export failed: ' + e.message };
    }
  },

  "export.clipAudio": function(params) {
    // Export an audio-only WAV of a sequence range for Whisper/transcription consumption.
    // Writes to a sandbox-accessible path so external tools (whisper, Python) can read it
    // even when /Volumes/Pro 3/ is blocked by macOS FDA.
    // params:
    //   sequenceName: string (optional, default = active)
    //   startSec, endSec: number (sequence-relative seconds)
    //   outputPath:  string (absolute file path; default ~/Downloads/cache/<auto>.wav)
    //   preset: 'wav_48k_16bit' (default) | 'aac_48k_128' | 'aiff_48k'

    var seq = params.sequenceName
      ? _findSequence(params.sequenceName)
      : app.project.activeSequence;
    if (!seq) return { error: "Sequence not found" };

    if (typeof params.startSec !== "number" || typeof params.endSec !== "number") {
      return { error: "startSec and endSec required (numbers, seconds)" };
    }
    if (params.endSec <= params.startSec) {
      return { error: "endSec must be > startSec" };
    }
    if (!params.outputPath) return { error: "outputPath required" };

    // Preset filename map (resolved cross-version against candidate AME roots
    // below — fixes Codex PR #2 review #2: don't hard-code AME 2026 paths).
    var presetFiles = {
      'wav_48k_16bit': { folder: '3F3F3F3F_57415645', file: 'Waveform Audio 48kHz 16-bit.epr' },
      'aac_48k_128':   { folder: '3F3F3F3F_574D5620', file: 'Audio Only, 48kHz 128kbps.epr' },
      'aiff_48k':      { folder: '3F3F3F3F_41494646', file: 'AIFF 48kHz.epr' }
    };
    var presetName = params.preset || 'wav_48k_16bit';
    var presetSpec = presetFiles[presetName];
    if (!presetSpec) return { error: "Unknown preset: " + presetName + " (use one of " + Object.keys(presetFiles).join(", ") + ")" };

    // Resolve preset path. Priority:
    //   1. Caller-provided absolute presetPath override (any version/platform)
    //   2. Probe known AME install locations across versions + macOS/Windows
    //   3. Probe user's custom AME preset dir (~/Documents/Adobe/...)
    var presetPath = null;
    var probed = [];
    if (params.presetPath) {
      probed.push(params.presetPath);
      if ((new File(params.presetPath)).exists) presetPath = params.presetPath;
    }
    if (!presetPath) {
      // Candidate AME install roots, newest first. Add new years here as Adobe releases.
      var ameRoots = [
        '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets/',
        '/Applications/Adobe Media Encoder 2025/Adobe Media Encoder 2025.app/Contents/MediaIO/systempresets/',
        '/Applications/Adobe Media Encoder 2024/Adobe Media Encoder 2024.app/Contents/MediaIO/systempresets/',
        '/Applications/Adobe Media Encoder 2023/Adobe Media Encoder 2023.app/Contents/MediaIO/systempresets/',
        // Windows install locations (ExtendScript on Windows uses forward slashes too)
        'C:/Program Files/Adobe/Adobe Media Encoder 2026/MediaIO/systempresets/',
        'C:/Program Files/Adobe/Adobe Media Encoder 2025/MediaIO/systempresets/',
        'C:/Program Files/Adobe/Adobe Media Encoder 2024/MediaIO/systempresets/',
        // User-custom preset dirs
        '~/Documents/Adobe/Adobe Media Encoder/26.0/Presets/',
        '~/Documents/Adobe/Adobe Media Encoder/25.0/Presets/',
        '~/Documents/Adobe/Adobe Media Encoder/24.0/Presets/'
      ];
      for (var r = 0; r < ameRoots.length; r++) {
        var candidate = ameRoots[r] + presetSpec.folder + '/' + presetSpec.file;
        probed.push(candidate);
        if ((new File(candidate)).exists) { presetPath = candidate; break; }
        // Some user dirs lack the folder hash — try flat path too
        var flatCandidate = ameRoots[r] + presetSpec.file;
        probed.push(flatCandidate);
        if ((new File(flatCandidate)).exists) { presetPath = flatCandidate; break; }
      }
    }
    if (!presetPath) {
      return {
        error: "No AME audio preset found for '" + presetName + "'. Searched " + probed.length + " candidate paths across AME 2023-2026 (macOS + Windows) and user preset dirs.",
        probedPaths: probed,
        hint: "Pass an explicit `presetPath` param pointing to your Waveform Audio preset .epr file, or install Adobe Media Encoder."
      };
    }

    // Save existing in/out so we can restore after export
    var origIn = null, origOut = null;
    try {
      if (seq.getInPointAsTime) origIn = seq.getInPointAsTime().ticks;
      if (seq.getOutPointAsTime) origOut = seq.getOutPointAsTime().ticks;
    } catch(e) {}

    // Helper: restore in/out then return the supplied error object.
    // Used by every early-return path AFTER in/out mutation so sequence state
    // is never left dirty (fixes Codex PR #2 review #3).
    function _restoreAndReturn(errObj) {
      if (origIn !== null) { try { seq.setInPoint(origIn); } catch(e) {} }
      if (origOut !== null) { try { seq.setOutPoint(origOut); } catch(e) {} }
      return errObj;
    }

    // Set work area to requested range
    try {
      seq.setInPoint(_secondsToTicks(params.startSec));
      seq.setOutPoint(_secondsToTicks(params.endSec));
    } catch(e) {
      // In/out may have been partially mutated — restore defensively
      return _restoreAndReturn({ error: "Failed to set in/out points: " + e.message });
    }

    // Ensure output dir exists
    var outFile = new File(params.outputPath);
    var outDir = outFile.parent;
    if (!outDir.exists) {
      try { outDir.create(); }
      catch(e) { return _restoreAndReturn({ error: "Cannot create output dir: " + outDir.fsName + " (" + e.message + ")" }); }
    }
    if (!outDir.exists) {
      // create() can return without throwing yet still fail (permissions, etc.)
      return _restoreAndReturn({ error: "Output dir does not exist after create(): " + outDir.fsName });
    }

    // Export via exportAsMediaDirect — work area mode (1)
    var exportResult;
    try {
      exportResult = seq.exportAsMediaDirect(params.outputPath, presetPath, 1);
    } catch(e) {
      // Restore in/out before bailing
      if (origIn !== null) { try { seq.setInPoint(origIn); } catch(e2) {} }
      if (origOut !== null) { try { seq.setOutPoint(origOut); } catch(e2) {} }
      return { error: "exportAsMediaDirect threw: " + e.message };
    }

    // Restore original in/out
    if (origIn !== null) { try { seq.setInPoint(origIn); } catch(e) {} }
    if (origOut !== null) { try { seq.setOutPoint(origOut); } catch(e) {} }

    // Wait briefly for the file system to flush
    $.sleep(500);

    if (!outFile.exists) {
      return {
        error: "Export reported done but file not at " + params.outputPath,
        exportResult: String(exportResult),
        hint: "Check Premiere render queue or AME logs. The preset may have failed silently."
      };
    }

    return {
      exported: true,
      outputPath: params.outputPath,
      startSec: params.startSec,
      endSec: params.endSec,
      durationSec: params.endSec - params.startSec,
      preset: presetName,
      sequenceName: seq.name,
      fileSizeBytes: outFile.length
    };
  },

  "export.frame": function(params) {
    var seq = app.project.activeSequence;
    if (seq) {
      seq.setPlayerPosition(_secondsToTicks(params.time));
      seq.exportFramePNG(params.time, params.outputPath);
    }
    return { path: params.outputPath };
  },

  // ── COLOR GRADING ─────────────────────────────────────────────
  // Single-clip Lumetri grade. Accepts settings either flattened on params
  // (params.basic / params.creative) OR nested under params.settings — the
  // MCP color-grader sends { settings: {...} }, older callers send flat.
  "color.applyLumetri": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var clipIdx  = (params.clipIndex !== undefined) ? params.clipIndex : 0;
    var settings = params.settings ? params.settings : params;

    var qeSeq = null;
    try { qeSeq = QEApplication.project.getActiveSequence(); } catch(e) {}

    var r = _applyLumetriToClip(seq, qeSeq, trackIdx, clipIdx, settings);
    if (r.error) return r;
    return { applied: r.applied, clipIndex: clipIdx };
  },

  // FIX 2026-05-29: full-timeline grading used to loop in the MCP server,
  // firing one WebSocket round-trip PER clip. On 14-16 4K clips that blew
  // past the MCP tool-call timeout every time. This handler does the whole
  // loop inside ExtendScript in a SINGLE round-trip so it returns once, fast.
  // Applies the same Lumetri grade to every clip on every video track (or a
  // specific track if params.trackIndex is given).
  "color.applyTimelineGrade": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    var settings = params.settings ? params.settings : params;

    var qeSeq = null;
    try { qeSeq = QEApplication.project.getActiveSequence(); } catch(e) {}

    var tracksToDo = [];
    if (params.trackIndex !== undefined) {
      tracksToDo.push(params.trackIndex);
    } else {
      for (var t = 0; t < seq.videoTracks.numTracks; t++) tracksToDo.push(t);
    }

    var clipsAffected = 0;
    var failures = [];
    for (var ti = 0; ti < tracksToDo.length; ti++) {
      var tIdx = tracksToDo[ti];
      var track = seq.videoTracks[tIdx];
      if (!track) continue;
      var n = track.clips.numItems;
      for (var ci = 0; ci < n; ci++) {
        var rr = _applyLumetriToClip(seq, qeSeq, tIdx, ci, settings);
        if (rr.error) {
          failures.push("V" + tIdx + ":" + ci + " " + rr.error);
        } else {
          clipsAffected++;
        }
      }
    }

    return { clipsAffected: clipsAffected, failures: failures };
  },

  // ── INTROSPECTION ─────────────────────────────────────────────
  // Live JSX version + every registered handler, so the preflight knows
  // exactly what this engine can do before any edit call.
  "_info": function() {
    var handlers = [];
    for (var key in PremiereBridge) {
      if (PremiereBridge.hasOwnProperty(key)) handlers.push(key);
    }
    return {
      jsxVersion: BRIDGE_JSX_VERSION,
      app: "premiere",
      appVersion: app.version,
      handlers: handlers,
      handlerCount: handlers.length
    };
  },

  // ── RAW EVAL ──────────────────────────────────────────────────
  "_eval": function(params) {
    try {
      var fn = new Function(params.script);
      var result = fn();
      return { evalResult: (result !== undefined) ? String(result) : "undefined" };
    } catch(e) {
      return { error: "Eval error: " + e.message };
    }
  }
};

// ── Helper Functions ─────────────────────────────────────────────────────

function _findSequence(name) {
  var proj = app.project;
  for (var i = 0; i < proj.sequences.numSequences; i++) {
    if (proj.sequences[i].name === name) return proj.sequences[i];
  }
  return null;
}

function _findProjectItem(name) {
  return _searchBin(app.project.rootItem, name);
}

function _searchBin(bin, name) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var item = bin.children[i];
    if (item.name === name) return item;
    if (item.type === ProjectItemType.BIN) {
      var found = _searchBin(item, name);
      if (found) return found;
    }
  }
  return null;
}

function _secondsToTicks(seconds) {
  // Premiere uses ticks (254016000000 ticks per second)
  return Math.round(seconds * 254016000000);
}

// Apply a Lumetri grade to ONE clip. Shared by color.applyLumetri (single
// clip) and color.applyTimelineGrade (whole timeline, single round-trip).
// `settings` is { basic:{...}, creative:{...} }.
function _applyLumetriToClip(seq, qeSeq, trackIdx, clipIdx, settings) {
  var track = seq.videoTracks[trackIdx];
  if (!track || clipIdx >= track.clips.numItems) {
    return { error: "Clip not found at V" + trackIdx + ":" + clipIdx };
  }
  var clip = track.clips[clipIdx];

  // Add Lumetri Color via QE DOM if not already present.
  try {
    if (qeSeq) {
      var qeTrack = qeSeq.getVideoTrackAt(trackIdx);
      var qeClip = qeTrack.getItemAt(clipIdx);
      qeClip.addVideoEffect(
        QEApplication.project.getVideoEffectByName("Lumetri Color")
      );
    }
  } catch(e) { /* may already have it */ }

  var basicMap = {
    "temperature": "Color Temperature",
    "tint": "Tint",
    "exposure": "Exposure",
    "contrast": "Contrast",
    "highlights": "Highlight",
    "shadows": "Shadow",
    "whites": "White",
    "blacks": "Black"
  };
  var creativeMap = {
    "vibrance": "Vibrance",
    "saturation": "Saturation"
  };

  // Find Lumetri component on the clip
  var components = clip.components;
  var lumetri = null;
  for (var ci = 0; ci < components.numItems; ci++) {
    if (components[ci].displayName === "Lumetri Color") {
      lumetri = components[ci];
      break;
    }
  }
  if (!lumetri) return { error: "Lumetri Color effect not found on clip" };

  var applied = [];

  if (settings && settings.basic) {
    for (var key in settings.basic) {
      var propName = basicMap[key];
      if (!propName) continue;
      for (var pi = 0; pi < lumetri.properties.numItems; pi++) {
        var prop = lumetri.properties[pi];
        if (prop.displayName === propName) {
          try {
            prop.setValue(settings.basic[key], true);
            applied.push(key + "=" + settings.basic[key]);
          } catch(e) {
            applied.push(key + "=FAILED:" + e.message);
          }
          break;
        }
      }
    }
  }

  if (settings && settings.creative) {
    for (var cKey in settings.creative) {
      var cPropName = creativeMap[cKey];
      if (!cPropName) continue;
      for (var cpi = 0; cpi < lumetri.properties.numItems; cpi++) {
        var cProp = lumetri.properties[cpi];
        if (cProp.displayName === cPropName) {
          try {
            cProp.setValue(settings.creative[cKey], true);
            applied.push(cKey + "=" + settings.creative[cKey]);
          } catch(e) {
            applied.push(cKey + "=FAILED:" + e.message);
          }
          break;
        }
      }
    }
  }

  return { applied: applied };
}

// Find a built-in .sqpreset matching requested dimensions + frame rate.
// Searches Adobe Premiere Pro 2026 → 2023. Returns absolute path or null.
// Used by timeline.create to avoid hanging on missing-preset modals.
function _findDefaultPreset(width, height, frameRate) {
  var versions = ["2026", "2025", "2024", "2023"];
  var fpsTokens = _fpsTokens(frameRate);
  var dimToken  = _dimToken(width, height);

  for (var i = 0; i < versions.length; i++) {
    var base = "/Applications/Adobe Premiere Pro " + versions[i] +
               "/Adobe Premiere Pro " + versions[i] +
               ".app/Contents/Settings/SequencePresets";
    var f = new Folder(base);
    if (!f.exists) continue;

    // 1) Try exact dim + fps match
    var match = _searchPreset(f, dimToken, fpsTokens, true);
    if (match) return match;
    // 2) Fall back to dim match only
    match = _searchPreset(f, dimToken, null, true);
    if (match) return match;
    // 3) Last resort — any .sqpreset in this version
    match = _searchPreset(f, null, null, true);
    if (match) return match;
  }
  return null;
}

function _fpsTokens(fps) {
  if (!fps) return null;
  // 60 → ["59.94","60"], 30 → ["29.97","30"], 24 → ["23.976","24"]
  if (fps == 60) return ["59.94", "60"];
  if (fps == 30) return ["29.97", "30"];
  if (fps == 24) return ["23.976", "24"];
  if (fps == 50) return ["50"];
  if (fps == 25) return ["25"];
  return [String(fps)];
}

function _dimToken(w, h) {
  if (h == 2160) return "2160p";
  if (h == 1080) return "1080p";
  if (h == 720)  return "720p";
  if (h == 1920 && w == 1080) return "9x16";
  return null;
}

function _searchPreset(folder, dimToken, fpsTokens, recurse) {
  try {
    var files = folder.getFiles();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f instanceof Folder) {
        if (recurse) {
          var hit = _searchPreset(f, dimToken, fpsTokens, true);
          if (hit) return hit;
        }
      } else if (f.name.indexOf(".sqpreset") > -1) {
        var name = f.name;
        if (dimToken && name.indexOf(dimToken) === -1) continue;
        if (fpsTokens) {
          var fpsHit = false;
          for (var k = 0; k < fpsTokens.length; k++) {
            if (name.indexOf(fpsTokens[k]) > -1) { fpsHit = true; break; }
          }
          if (!fpsHit) continue;
        }
        return f.fsName;
      }
    }
  } catch(e) {}
  return null;
}

function _getTransitionName(type) {
  var map = {
    "cross_dissolve": "Cross Dissolve",
    "dip_to_black": "Dip to Black",
    "dip_to_white": "Dip to White",
    "film_dissolve": "Film Dissolve",
    "morph_cut": "Morph Cut",
    "push": "Push",
    "slide": "Slide",
    "wipe": "Wipe"
  };
  return map[type] || "Cross Dissolve";
}

function _getExportPresetPath(preset) {
  // Map preset names to AME preset file paths
  var presetMap = {
    "youtube_1080p_h264": "YouTube 1080p Full HD.epr",
    "youtube_4k_h264": "YouTube 2160p 4K Ultra HD.epr",
    "prores_422": "Apple ProRes 422.epr",
    "prores_4444": "Apple ProRes 4444.epr",
    "h264_high_quality": "H.264 - Match Source - High bitrate.epr"
  };
  return presetMap[preset] || "Match Source - High bitrate.epr";
}

// ── Command Dispatcher ───────────────────────────────────────────────────
// Called by the CEP panel's WebSocket handler

function executeCommand(commandStr) {
  try {
    var parsed = JSON.parse(commandStr);
    var handler = PremiereBridge[parsed.command];
    if (handler) {
      var result = handler(parsed.params || {});
      return JSON.stringify({ id: parsed.id, result: result });
    } else {
      return JSON.stringify({ id: parsed.id, error: "Unknown command: " + parsed.command });
    }
  } catch (e) {
    return JSON.stringify({ id: 0, error: "ExtendScript Error: " + e.message });
  }
}
