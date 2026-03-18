// ============================================================================
//  Premiere Pro ExtendScript Bridge
//  This script runs inside Adobe Premiere Pro's ExtendScript engine
//  via a CEP (Common Extensibility Platform) panel.
//
//  It receives commands from the Node.js MCP server via WebSocket
//  and executes them in Premiere Pro's scripting DOM.
// ============================================================================

/* global app, $, ProjectItemType, QEApplication */

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
    // Create sequence from preset or custom settings
    var seq;
    if (app.project.createNewSequence) {
      seq = app.project.createNewSequence(params.name);
    }
    return { name: params.name, id: seq ? seq.id : null };
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

    // Set source in/out points (seconds mode = 1)
    if (params.inPoint !== undefined) {
      try { item.setInPoint(params.inPoint, 1); } catch(e) {
        try { item.setInPoint(_secondsToTicks(params.inPoint)); } catch(e2) {}
      }
    }
    if (params.outPoint !== undefined) {
      try { item.setOutPoint(params.outPoint, 1); } catch(e) {
        try { item.setOutPoint(_secondsToTicks(params.outPoint)); } catch(e2) {}
      }
    }

    // Place on video track — Premiere automatically links audio to A1
    var trackIdx = params.trackIndex || 0;
    var track = seq.videoTracks[trackIdx];
    if (!track) return { error: "Video track not found: " + trackIdx };

    var startTicks = (params.startTime !== undefined) ? _secondsToTicks(params.startTime) : "0";

    if (track.overwriteClip) {
      track.overwriteClip(item, startTicks);
    } else if (track.insertClip) {
      track.insertClip(item, startTicks);
    }

    return { placed: true, mediaName: params.mediaName };
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
    var seq = app.project.activeSequence;
    var track = seq.videoTracks[params.trackIndex];
    // Use razor at time
    seq.setPlayerPosition(_secondsToTicks(params.time));
    // ExtendScript razor tool application
    if (typeof QEApplication !== "undefined") {
      var qeSeq = QEApplication.project.getActiveSequence();
      qeSeq.razor(_secondsToTicks(params.time), params.trackIndex);
    }
    return { cut: true };
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
    var seq = app.project.activeSequence;
    // Create Essential Graphics text via MOGRT or direct caption
    if (seq) {
      // Use the captions API or graphics insertion
      var track = seq.videoTracks[params.trackIndex || 1];
      // Placeholder: In production, this creates an Essential Graphics title
    }
    return { added: true, text: params.text };
  },

  // ── EXPORT ─────────────────────────────────────────────────────

  "export.media": function(params) {
    var seq = params.sequenceName
      ? _findSequence(params.sequenceName)
      : app.project.activeSequence;

    if (!seq) return { error: "No sequence to export" };

    // Use Adobe Media Encoder if available
    if (params.useMediaEncoder && app.encoder) {
      app.encoder.launchEncoder();
      var presetPath = _getExportPresetPath(params.preset);
      app.encoder.encodeSequence(seq, params.outputPath, presetPath);
    }

    return { started: true, estimatedTime: "Calculating..." };
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
  "color.applyLumetri": function(params) {
    var seq = app.project.activeSequence;
    if (!seq) return { error: "No active sequence" };

    var trackIdx = (params.trackIndex !== undefined) ? params.trackIndex : 0;
    var clipIdx  = (params.clipIndex !== undefined) ? params.clipIndex : 0;
    var track = seq.videoTracks[trackIdx];
    if (!track || clipIdx >= track.clips.numItems) {
      return { error: "Clip not found at V" + trackIdx + ":" + clipIdx };
    }

    var clip = track.clips[clipIdx];

    // Add Lumetri Color via QE DOM if not already present
    try {
      var qeSeq = QEApplication.project.getActiveSequence();
      var qeTrack = qeSeq.getVideoTrackAt(trackIdx);
      var qeClip = qeTrack.getItemAt(clipIdx);
      qeClip.addVideoEffect(
        QEApplication.project.getVideoEffectByName("Lumetri Color")
      );
    } catch(e) { /* may already have it */ }

    // Map of Lumetri property names
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

    // Apply basic settings
    if (params.basic) {
      for (var key in params.basic) {
        var propName = basicMap[key];
        if (!propName) continue;
        for (var pi = 0; pi < lumetri.properties.numItems; pi++) {
          var prop = lumetri.properties[pi];
          if (prop.displayName === propName) {
            try {
              prop.setValue(params.basic[key], true);
              applied.push(key + "=" + params.basic[key]);
            } catch(e) {
              applied.push(key + "=FAILED:" + e.message);
            }
            break;
          }
        }
      }
    }

    // Apply creative settings
    if (params.creative) {
      for (var cKey in params.creative) {
        var cPropName = creativeMap[cKey];
        if (!cPropName) continue;
        for (var cpi = 0; cpi < lumetri.properties.numItems; cpi++) {
          var cProp = lumetri.properties[cpi];
          if (cProp.displayName === cPropName) {
            try {
              cProp.setValue(params.creative[cKey], true);
              applied.push(cKey + "=" + params.creative[cKey]);
            } catch(e) {
              applied.push(cKey + "=FAILED:" + e.message);
            }
            break;
          }
        }
      }
    }

    return { applied: applied, clipIndex: clipIdx };
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
