// ============================================================================
//  After Effects ExtendScript Bridge
//  Runs inside AE's ExtendScript engine via CEP panel.
//  Handles comp creation, layer ops, keyframes, expressions, rendering.
// ============================================================================

/* global app, CompItem, ShapeLayer, TextLayer, CameraLayer, LightLayer */

var AEBridge = {

  // ── PROJECT ────────────────────────────────────────────────────

  "project.open": function(params) {
    var file = new File(params.path);
    app.open(file);
    return { name: app.project.file ? app.project.file.name : "Untitled" };
  },

  "project.create": function(params) {
    app.newProject();
    return { name: params.name };
  },

  "project.importFootage": function(params) {
    var imported = [];
    for (var i = 0; i < params.files.length; i++) {
      var io = new ImportOptions(new File(params.files[i]));
      if (io.canImportAs(ImportAsType.FOOTAGE)) {
        io.importAs = ImportAsType.FOOTAGE;
        var item = app.project.importFile(io);
        imported.push(item.name);
      }
    }
    return { imported: imported };
  },

  // ── COMPOSITIONS ───────────────────────────────────────────────

  "comp.create": function(params) {
    var comp = app.project.items.addComp(
      params.name,
      params.width || 1920,
      params.height || 1080,
      1, // pixel aspect ratio
      params.duration || 10,
      params.frameRate || 30
    );
    return { name: comp.name, id: comp.id };
  },

  "comp.getInfo": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return { error: "No composition found" };

    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var layer = comp.layer(i);
      layers.push({
        index: i,
        name: layer.name,
        type: _getLayerType(layer),
        startTime: layer.startTime,
        duration: layer.outPoint - layer.inPoint,
        enabled: layer.enabled,
        solo: layer.solo,
        locked: layer.locked
      });
    }

    return {
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      layers: layers,
      layerCount: comp.numLayers
    };
  },

  // ── LAYERS ─────────────────────────────────────────────────────

  "layer.add": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    if (!comp) return { error: "No composition" };

    var layer;
    switch (params.layerType) {
      case "solid":
        var color = _hexToArray(params.color || "#000000");
        layer = comp.layers.addSolid(color, params.name || "Solid", comp.width, comp.height, 1, params.duration || comp.duration);
        break;
      case "text":
        layer = comp.layers.addText(params.text || "");
        if (params.name) layer.name = params.name;
        break;
      case "null":
        layer = comp.layers.addNull(params.duration || comp.duration);
        if (params.name) layer.name = params.name;
        break;
      case "shape":
        layer = comp.layers.addShape();
        if (params.name) layer.name = params.name;
        break;
      case "adjustment":
        layer = comp.layers.addSolid([1,1,1], params.name || "Adjustment", comp.width, comp.height, 1, params.duration || comp.duration);
        layer.adjustmentLayer = true;
        break;
      case "camera":
        layer = comp.layers.addCamera(params.name || "Camera", [comp.width/2, comp.height/2]);
        break;
      case "light":
        layer = comp.layers.addLight(params.name || "Light", [comp.width/2, comp.height/2]);
        break;
      case "footage":
        var item = _findProjectItem(params.footageItem);
        if (item) layer = comp.layers.add(item);
        break;
    }

    if (layer && params.startTime !== undefined) {
      layer.startTime = params.startTime;
    }

    return { index: layer ? layer.index : -1, name: layer ? layer.name : "unknown" };
  },

  "layer.transform": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    var layer = comp.layer(params.layerIndex);
    if (!layer) return { error: "Layer not found" };

    if (params.position) layer.transform.position.setValue(params.position);
    if (params.scale) layer.transform.scale.setValue(params.scale);
    if (params.rotation !== undefined) layer.transform.rotation.setValue(params.rotation);
    if (params.opacity !== undefined) layer.transform.opacity.setValue(params.opacity);
    if (params.anchorPoint) layer.transform.anchorPoint.setValue(params.anchorPoint);

    return { updated: true };
  },

  "layer.applyEffect": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    var layer = comp.layer(params.layerIndex);
    if (!layer) return { error: "Layer not found" };

    var effect = layer.Effects.addProperty(params.effectName);
    if (effect && params.parameters) {
      for (var key in params.parameters) {
        try {
          effect.property(key).setValue(params.parameters[key]);
        } catch(e) { /* property may not exist */ }
      }
    }

    return { applied: true, effectName: params.effectName };
  },

  // ── ANIMATION ──────────────────────────────────────────────────

  "animation.addKeyframe": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    var layer = comp.layer(params.layerIndex);
    var prop = layer.transform[params.property] || _findProperty(layer, params.property);

    if (!prop) return { error: "Property not found: " + params.property };

    prop.setValueAtTime(params.time, params.value);

    // Apply easing
    if (params.easing && params.easing !== "linear") {
      var keyIndex = prop.nearestKeyIndex(params.time);
      _applyEasing(prop, keyIndex, params.easing);
    }

    return { added: true, property: params.property, time: params.time };
  },

  "animation.addExpression": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    var layer = comp.layer(params.layerIndex);
    var prop = layer.transform[params.property] || _findProperty(layer, params.property);

    if (prop) {
      prop.expression = params.expression;
    }

    return { added: true };
  },

  "animation.applyPreset": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    var layer = comp.layer(params.layerIndex);
    if (!layer) return { error: "Layer not found" };

    _applyAnimationPreset(layer, params.preset, params.startTime, params.duration);
    return { applied: true, preset: params.preset };
  },

  // ── TITLES & INTROS ────────────────────────────────────────────

  "titles.createIntro": function(params) {
    var comp = app.project.items.addComp(
      params.channelName + "_Intro",
      1920, 1080, 1,
      params.duration || 5,
      30
    );

    var colors = params.colorScheme || { primary: "#FF0000", secondary: "#FFFFFF", accent: "#FFD700", background: "#000000" };

    // Background
    var bgColor = _hexToArray(colors.background);
    var bg = comp.layers.addSolid(bgColor, "BG", 1920, 1080, 1, params.duration);

    // Channel name text
    var textLayer = comp.layers.addText(params.channelName);
    var textDoc = textLayer.sourceText.value;
    textDoc.fontSize = 120;
    textDoc.fillColor = _hexToArray(colors.secondary);
    textDoc.font = "Montserrat-ExtraBold";
    textDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
    textLayer.sourceText.setValue(textDoc);
    textLayer.transform.position.setValue([960, 540]);

    // Animate based on style
    _applyIntroStyle(comp, textLayer, params.style, params.duration, colors);

    // Tagline
    if (params.tagline) {
      var tagLayer = comp.layers.addText(params.tagline);
      var tagDoc = tagLayer.sourceText.value;
      tagDoc.fontSize = 48;
      tagDoc.fillColor = _hexToArray(colors.accent);
      tagLayer.sourceText.setValue(tagDoc);
      tagLayer.transform.position.setValue([960, 650]);
      _applyAnimationPreset(tagLayer, "fade_in_up", 0.8, 0.5);
    }

    // Logo
    if (params.logoPath) {
      var logoFile = new File(params.logoPath);
      if (logoFile.exists) {
        var io = new ImportOptions(logoFile);
        var logoItem = app.project.importFile(io);
        var logoLayer = comp.layers.add(logoItem);
        logoLayer.transform.scale.setValue([30, 30]);
        logoLayer.transform.position.setValue([960, 350]);
        _applyAnimationPreset(logoLayer, "scale_bounce", 0, 0.8);
      }
    }

    return { compName: comp.name, layerCount: comp.numLayers };
  },

  // ── RENDER ─────────────────────────────────────────────────────

  "render.start": function(params) {
    var comp = params.compName ? _findComp(params.compName) : app.project.activeItem;
    if (!comp) return { error: "No composition to render" };

    var rq = app.project.renderQueue;
    var item = rq.items.add(comp);

    // Set output module
    var om = item.outputModule(1);
    om.file = new File(params.outputPath);

    // Set format
    _setRenderFormat(om, params.format || "prores_4444");

    // Start render
    rq.render();

    return { started: true, outputPath: params.outputPath };
  }
};

// ── Helper Functions ─────────────────────────────────────────────────────

function _findComp(name) {
  for (var i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i) instanceof CompItem && app.project.item(i).name === name) {
      return app.project.item(i);
    }
  }
  return null;
}

function _findProjectItem(name) {
  for (var i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i).name === name) return app.project.item(i);
  }
  return null;
}

function _findProperty(layer, propPath) {
  var parts = propPath.split(".");
  var current = layer;
  for (var i = 0; i < parts.length; i++) {
    current = current.property(parts[i]);
    if (!current) return null;
  }
  return current;
}

function _hexToArray(hex) {
  hex = hex.replace("#", "");
  return [
    parseInt(hex.substring(0, 2), 16) / 255,
    parseInt(hex.substring(2, 4), 16) / 255,
    parseInt(hex.substring(4, 6), 16) / 255
  ];
}

function _getLayerType(layer) {
  if (layer instanceof TextLayer) return "text";
  if (layer instanceof ShapeLayer) return "shape";
  if (layer instanceof CameraLayer) return "camera";
  if (layer instanceof LightLayer) return "light";
  if (layer.adjustmentLayer) return "adjustment";
  if (layer.nullLayer) return "null";
  return "footage";
}

function _applyEasing(prop, keyIndex, easing) {
  var ease;
  switch (easing) {
    case "ease_in":
      ease = new KeyframeEase(0.33, 75);
      prop.setTemporalEaseAtKey(keyIndex, [ease], [new KeyframeEase(0, 0)]);
      break;
    case "ease_out":
      ease = new KeyframeEase(0.33, 75);
      prop.setTemporalEaseAtKey(keyIndex, [new KeyframeEase(0, 0)], [ease]);
      break;
    case "ease_in_out":
      ease = new KeyframeEase(0.33, 75);
      prop.setTemporalEaseAtKey(keyIndex, [ease], [ease]);
      break;
  }
}

function _applyAnimationPreset(layer, presetName, startTime, duration) {
  var t = startTime || 0;
  var d = duration || 0.5;
  var pos = layer.transform.position;
  var scale = layer.transform.scale;
  var opacity = layer.transform.opacity;

  switch (presetName) {
    case "fade_in":
      opacity.setValueAtTime(t, 0);
      opacity.setValueAtTime(t + d, 100);
      break;
    case "fade_in_up":
      var origPos = pos.value;
      opacity.setValueAtTime(t, 0);
      opacity.setValueAtTime(t + d, 100);
      pos.setValueAtTime(t, [origPos[0], origPos[1] + 50]);
      pos.setValueAtTime(t + d, origPos);
      break;
    case "scale_pop":
      scale.setValueAtTime(t, [0, 0]);
      scale.setValueAtTime(t + d * 0.6, [110, 110]);
      scale.setValueAtTime(t + d, [100, 100]);
      break;
    case "scale_bounce":
      scale.setValueAtTime(t, [0, 0]);
      scale.setValueAtTime(t + d * 0.5, [120, 120]);
      scale.setValueAtTime(t + d * 0.7, [90, 90]);
      scale.setValueAtTime(t + d, [100, 100]);
      break;
    case "slide_in_left":
      var orig = pos.value;
      pos.setValueAtTime(t, [orig[0] - 1920, orig[1]]);
      pos.setValueAtTime(t + d, orig);
      break;
    case "glitch_in":
      opacity.setValueAtTime(t, 0);
      for (var g = 0; g < 5; g++) {
        opacity.setValueAtTime(t + (d * g / 5), g % 2 === 0 ? 100 : 0);
      }
      opacity.setValueAtTime(t + d, 100);
      break;
  }
}

function _applyIntroStyle(comp, textLayer, style, duration, colors) {
  // Each intro style creates different layer arrangements and animations
  switch (style) {
    case "modern_minimal":
      _applyAnimationPreset(textLayer, "scale_pop", 0.5, 0.6);
      // Add accent line
      var line = comp.layers.addShape();
      line.name = "Accent Line";
      var rect = line.content.addProperty("ADBE Vector Group");
      var shape = rect.content.addProperty("ADBE Vector Shape - Rect");
      shape.size.setValue([200, 4]);
      line.transform.position.setValue([960, 600]);
      _applyAnimationPreset(line, "fade_in", 0.8, 0.4);
      break;

    case "glitch_tech":
      _applyAnimationPreset(textLayer, "glitch_in", 0.3, 0.8);
      break;

    case "cinematic_epic":
      _applyAnimationPreset(textLayer, "fade_in", 1.0, 1.5);
      textLayer.transform.scale.setValueAtTime(0, [95, 95]);
      textLayer.transform.scale.setValueAtTime(duration, [105, 105]);
      break;

    default:
      _applyAnimationPreset(textLayer, "fade_in_up", 0.5, 0.6);
  }
}

function _setRenderFormat(outputModule, format) {
  // Set render format based on requested type
  var templates = {
    "prores_422": "Apple ProRes 422",
    "prores_4444": "Apple ProRes 4444",
    "h264": "H.264",
    "h265": "H.265",
    "png_sequence": "PNG Sequence"
  };
  var template = templates[format];
  if (template) {
    try { outputModule.applyTemplate(template); } catch(e) {}
  }
}

// ── Command Dispatcher ───────────────────────────────────────────────────

function executeCommand(commandStr) {
  try {
    var parsed = JSON.parse(commandStr);
    var handler = AEBridge[parsed.command];
    if (handler) {
      app.beginUndoGroup("MCP: " + parsed.command);
      var result = handler(parsed.params || {});
      app.endUndoGroup();
      return JSON.stringify({ id: parsed.id, result: result });
    } else {
      return JSON.stringify({ id: parsed.id, error: "Unknown command: " + parsed.command });
    }
  } catch (e) {
    app.endUndoGroup();
    return JSON.stringify({ id: 0, error: "AE ExtendScript Error: " + e.message });
  }
}
