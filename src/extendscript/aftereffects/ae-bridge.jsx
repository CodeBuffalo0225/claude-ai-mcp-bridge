// ===== JSON polyfill (json2.js by Douglas Crockford) =====
// Required because Adobe After Effects' ExtendScript engine has no native JSON object.
// Without this, JSON.parse / JSON.stringify throw 'JSON is undefined' and the bridge
// silently returns empty strings to the CEP panel.
//  json2.js
//  2023-05-10
//  Public Domain.
//  NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.

//  USE YOUR OWN COPY. IT IS EXTREMELY UNWISE TO LOAD CODE FROM SERVERS YOU DO
//  NOT CONTROL.

//  This file creates a global JSON object containing two methods: stringify
//  and parse. This file provides the ES5 JSON capability to ES3 systems.
//  If a project might run on IE8 or earlier, then this file should be included.
//  This file does nothing on ES5 systems.

//      JSON.stringify(value, replacer, space)
//          value       any JavaScript value, usually an object or array.
//          replacer    an optional parameter that determines how object
//                      values are stringified for objects. It can be a
//                      function or an array of strings.
//          space       an optional parameter that specifies the indentation
//                      of nested structures. If it is omitted, the text will
//                      be packed without extra whitespace. If it is a number,
//                      it will specify the number of spaces to indent at each
//                      level. If it is a string (such as "\t" or "&nbsp;"),
//                      it contains the characters used to indent at each level.
//          This method produces a JSON text from a JavaScript value.
//          When an object value is found, if the object contains a toJSON
//          method, its toJSON method will be called and the result will be
//          stringified. A toJSON method does not serialize: it returns the
//          value represented by the name/value pair that should be serialized,
//          or undefined if nothing should be serialized. The toJSON method
//          will be passed the key associated with the value, and this will be
//          bound to the value.

//          For example, this would serialize Dates as ISO strings.

//              Date.prototype.toJSON = function (key) {
//                  function f(n) {
//                      // Format integers to have at least two digits.
//                      return (n < 10)
//                          ? "0" + n
//                          : n;
//                  }
//                  return this.getUTCFullYear()   + "-" +
//                       f(this.getUTCMonth() + 1) + "-" +
//                       f(this.getUTCDate())      + "T" +
//                       f(this.getUTCHours())     + ":" +
//                       f(this.getUTCMinutes())   + ":" +
//                       f(this.getUTCSeconds())   + "Z";
//              };

//          You can provide an optional replacer method. It will be passed the
//          key and value of each member, with this bound to the containing
//          object. The value that is returned from your method will be
//          serialized. If your method returns undefined, then the member will
//          be excluded from the serialization.

//          If the replacer parameter is an array of strings, then it will be
//          used to select the members to be serialized. It filters the results
//          such that only members with keys listed in the replacer array are
//          stringified.

//          Values that do not have JSON representations, such as undefined or
//          functions, will not be serialized. Such values in objects will be
//          dropped; in arrays they will be replaced with null. You can use
//          a replacer function to replace those with JSON values.

//          JSON.stringify(undefined) returns undefined.

//          The optional space parameter produces a stringification of the
//          value that is filled with line breaks and indentation to make it
//          easier to read.

//          If the space parameter is a non-empty string, then that string will
//          be used for indentation. If the space parameter is a number, then
//          the indentation will be that many spaces.

//          Example:

//          text = JSON.stringify(["e", {pluribus: "unum"}]);
//          // text is '["e",{"pluribus":"unum"}]'

//          text = JSON.stringify(["e", {pluribus: "unum"}], null, "\t");
//          // text is '[\n\t"e",\n\t{\n\t\t"pluribus": "unum"\n\t}\n]'

//          text = JSON.stringify([new Date()], function (key, value) {
//              return this[key] instanceof Date
//                  ? "Date(" + this[key] + ")"
//                  : value;
//          });
//          // text is '["Date(---current time---)"]'

//      JSON.parse(text, reviver)
//          This method parses a JSON text to produce an object or array.
//          It can throw a SyntaxError exception.

//          The optional reviver parameter is a function that can filter and
//          transform the results. It receives each of the keys and values,
//          and its return value is used instead of the original value.
//          If it returns what it received, then the structure is not modified.
//          If it returns undefined then the member is deleted.

//          Example:

//          // Parse the text. Values that look like ISO date strings will
//          // be converted to Date objects.

//          myData = JSON.parse(text, function (key, value) {
//              var a;
//              if (typeof value === "string") {
//                  a =
//   /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(value);
//                  if (a) {
//                      return new Date(Date.UTC(
//                         +a[1], +a[2] - 1, +a[3], +a[4], +a[5], +a[6]
//                      ));
//                  }
//                  return value;
//              }
//          });

//          myData = JSON.parse(
//              "[\"Date(09/09/2001)\"]",
//              function (key, value) {
//                  var d;
//                  if (
//                      typeof value === "string"
//                      && value.slice(0, 5) === "Date("
//                      && value.slice(-1) === ")"
//                  ) {
//                      d = new Date(value.slice(5, -1));
//                      if (d) {
//                          return d;
//                      }
//                  }
//                  return value;
//              }
//          );

//  This is a reference implementation. You are free to copy, modify, or
//  redistribute.

/*jslint
    eval, for, this
*/

/*property
    JSON, apply, call, charCodeAt, getUTCDate, getUTCFullYear, getUTCHours,
    getUTCMinutes, getUTCMonth, getUTCSeconds, hasOwnProperty, join,
    lastIndex, length, parse, prototype, push, replace, slice, stringify,
    test, toJSON, toString, valueOf
*/


// Create a JSON object only if one does not already exist. We create the
// methods in a closure to avoid creating global variables.

if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    "use strict";

    var rx_one = /^[\],:{}\s]*$/;
    var rx_two = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
    var rx_three = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
    var rx_four = /(?:^|:|,)(?:\s*\[)+/g;
    var rx_escapable = /[\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
    var rx_dangerous = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;

    function f(n) {
        // Format integers to have at least two digits.
        return (n < 10)
            ? "0" + n
            : n;
    }

    function this_value() {
        return this.valueOf();
    }

    if (typeof Date.prototype.toJSON !== "function") {

        Date.prototype.toJSON = function () {

            return isFinite(this.valueOf())
                ? (
                    this.getUTCFullYear()
                    + "-"
                    + f(this.getUTCMonth() + 1)
                    + "-"
                    + f(this.getUTCDate())
                    + "T"
                    + f(this.getUTCHours())
                    + ":"
                    + f(this.getUTCMinutes())
                    + ":"
                    + f(this.getUTCSeconds())
                    + "Z"
                )
                : null;
        };

        Boolean.prototype.toJSON = this_value;
        Number.prototype.toJSON = this_value;
        String.prototype.toJSON = this_value;
    }

    var gap;
    var indent;
    var meta;
    var rep;


    function quote(string) {

// If the string contains no control characters, no quote characters, and no
// backslash characters, then we can safely slap some quotes around it.
// Otherwise we must also replace the offending characters with safe escape
// sequences.

        rx_escapable.lastIndex = 0;
        return rx_escapable.test(string)
            ? "\"" + string.replace(rx_escapable, function (a) {
                var c = meta[a];
                return typeof c === "string"
                    ? c
                    : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\""
            : "\"" + string + "\"";
    }


    function str(key, holder) {

// Produce a string from holder[key].

        var i;          // The loop counter.
        var k;          // The member key.
        var v;          // The member value.
        var length;
        var mind = gap;
        var partial;
        var value = holder[key];

// If the value has a toJSON method, call it to obtain a replacement value.

        if (
            value
            && typeof value === "object"
            && typeof value.toJSON === "function"
        ) {
            value = value.toJSON(key);
        }

// If we were called with a replacer function, then call the replacer to
// obtain a replacement value.

        if (typeof rep === "function") {
            value = rep.call(holder, key, value);
        }

// What happens next depends on the value's type.

        switch (typeof value) {
        case "string":
            return quote(value);

        case "number":

// JSON numbers must be finite. Encode non-finite numbers as null.

            return (isFinite(value))
                ? String(value)
                : "null";

        case "boolean":
        case "null":

// If the value is a boolean or null, convert it to a string. Note:
// typeof null does not produce "null". The case is included here in
// the remote chance that this gets fixed someday.

            return String(value);

// If the type is "object", we might be dealing with an object or an array or
// null.

        case "object":

// Due to a specification blunder in ECMAScript, typeof null is "object",
// so watch out for that case.

            if (!value) {
                return "null";
            }

// Make an array to hold the partial results of stringifying this object value.

            gap += indent;
            partial = [];

// Is the value an array?

            if (Object.prototype.toString.apply(value) === "[object Array]") {

// The value is an array. Stringify every element. Use null as a placeholder
// for non-JSON values.

                length = value.length;
                for (i = 0; i < length; i += 1) {
                    partial[i] = str(i, value) || "null";
                }

// Join all of the elements together, separated with commas, and wrap them in
// brackets.

                v = partial.length === 0
                    ? "[]"
                    : gap
                        ? (
                            "[\n"
                            + gap
                            + partial.join(",\n" + gap)
                            + "\n"
                            + mind
                            + "]"
                        )
                        : "[" + partial.join(",") + "]";
                gap = mind;
                return v;
            }

// If the replacer is an array, use it to select the members to be stringified.

            if (rep && typeof rep === "object") {
                length = rep.length;
                for (i = 0; i < length; i += 1) {
                    if (typeof rep[i] === "string") {
                        k = rep[i];
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (
                                (gap)
                                    ? ": "
                                    : ":"
                            ) + v);
                        }
                    }
                }
            } else {

// Otherwise, iterate through all of the keys in the object.

                for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (
                                (gap)
                                    ? ": "
                                    : ":"
                            ) + v);
                        }
                    }
                }
            }

// Join all of the member texts together, separated with commas,
// and wrap them in braces.

            v = partial.length === 0
                ? "{}"
                : gap
                    ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
                    : "{" + partial.join(",") + "}";
            gap = mind;
            return v;
        }
    }

// If the JSON object does not yet have a stringify method, give it one.

    if (typeof JSON.stringify !== "function") {
        meta = {    // table of character substitutions
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            "\"": "\\\"",
            "\\": "\\\\"
        };
        JSON.stringify = function (value, replacer, space) {

// The stringify method takes a value and an optional replacer, and an optional
// space parameter, and returns a JSON text. The replacer can be a function
// that can replace values, or an array of strings that will select the keys.
// A default replacer method can be provided. Use of the space parameter can
// produce text that is more easily readable.

            var i;
            gap = "";
            indent = "";

// If the space parameter is a number, make an indent string containing that
// many spaces.

            if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                    indent += " ";
                }

// If the space parameter is a string, it will be used as the indent string.

            } else if (typeof space === "string") {
                indent = space;
            }

// If there is a replacer, it must be a function or an array.
// Otherwise, throw an error.

            rep = replacer;
            if (replacer && typeof replacer !== "function" && (
                typeof replacer !== "object"
                || typeof replacer.length !== "number"
            )) {
                throw new Error("JSON.stringify");
            }

// Make a fake root object containing our value under the key of "".
// Return the result of stringifying the value.

            return str("", {"": value});
        };
    }


// If the JSON object does not yet have a parse method, give it one.

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text, reviver) {

// The parse method takes a text and an optional reviver function, and returns
// a JavaScript value if the text is a valid JSON text.

            var j;

            function walk(holder, key) {

// The walk method is used to recursively walk the resulting structure so
// that modifications can be made.

                var k;
                var v;
                var value = holder[key];
                if (value && typeof value === "object") {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }


// Parsing happens in four stages. In the first stage, we replace certain
// Unicode characters with escape sequences. JavaScript handles many characters
// incorrectly, either silently deleting them, or treating them as line endings.

            text = String(text);
            rx_dangerous.lastIndex = 0;
            if (rx_dangerous.test(text)) {
                text = text.replace(rx_dangerous, function (a) {
                    return (
                        "\\u"
                        + ("0000" + a.charCodeAt(0).toString(16)).slice(-4)
                    );
                });
            }

// In the second stage, we run the text against regular expressions that look
// for non-JSON patterns. We are especially concerned with "()" and "new"
// because they can cause invocation, and "=" because it can cause mutation.
// But just to be safe, we want to reject all unexpected forms.

// We split the second stage into 4 regexp operations in order to work around
// crippling inefficiencies in IE's and Safari's regexp engines. First we
// replace the JSON backslash pairs with "@" (a non-JSON character). Second, we
// replace all simple value tokens with "]" characters. Third, we delete all
// open brackets that follow a colon or comma or that begin the text. Finally,
// we look to see that the remaining characters are only whitespace or "]" or
// "," or ":" or "{" or "}". If that is so, then the text is safe for eval.

            if (
                rx_one.test(
                    text
                        .replace(rx_two, "@")
                        .replace(rx_three, "]")
                        .replace(rx_four, "")
                )
            ) {

// In the third stage we use the eval function to compile the text into a
// JavaScript structure. The "{" operator is subject to a syntactic ambiguity
// in JavaScript: it can begin a block or an object literal. We wrap the text
// in parens to eliminate the ambiguity.

                j = eval("(" + text + ")");

// In the optional fourth stage, we recursively walk the new structure, passing
// each name/value pair to a reviver function for possible transformation.

                return (typeof reviver === "function")
                    ? walk({"": j}, "")
                    : j;
            }

// If the text is not JSON parseable, then a SyntaxError is thrown.

            throw new SyntaxError("JSON.parse");
        };
    }
}());

// ===== End JSON polyfill =====

// ============================================================================
//  After Effects ExtendScript Bridge
//  Runs inside AE's ExtendScript engine via CEP panel.
//  Handles comp creation, layer ops, keyframes, expressions, rendering.
// ============================================================================

/* global app, CompItem, ShapeLayer, TextLayer, CameraLayer, LightLayer */

var AEBridge = {

  // â”€â”€ PROJECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ COMPOSITIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  "comp.create": function(params) {
    var _dbg2 = new File("~/Desktop/ae_bridge_debug.txt");
    try { _dbg2.open("a"); _dbg2.writeln("  >> comp.create entered, name=" + params.name + " w=" + params.width + " h=" + params.height); _dbg2.close(); } catch(eDbg){}
    try {
      var _testComp = app.project.items.addComp(params.name, params.width || 1920, params.height || 1080, 1, params.duration || 10, params.frameRate || 30);
      try { _dbg2.open("a"); _dbg2.writeln("  >> addComp OK: " + _testComp.name); _dbg2.close(); } catch(eDbg){}
      return { name: _testComp.name };
    } catch(eAdd) {
      try { _dbg2.open("a"); _dbg2.writeln("  >> addComp THREW: " + eAdd.message + " line=" + eAdd.line); _dbg2.close(); } catch(eDbg){}
      return { error: "addComp threw: " + eAdd.message + " (line " + eAdd.line + ")" };
    }
    // ORIGINAL CODE BELOW (unreachable, kept for diff visibility):
    var _unreachable = function() {
    var comp = app.project.items.addComp(
      params.name,
      params.width || 1920,
      params.height || 1080,
      1, // pixel aspect ratio
      params.duration || 10,
      params.frameRate || 30
    );
    if (params.backgroundColor) {
      var bg = params.backgroundColor.replace("#", "");
      comp.bgColor = [
        parseInt(bg.substring(0, 2), 16) / 255,
        parseInt(bg.substring(2, 4), 16) / 255,
        parseInt(bg.substring(4, 6), 16) / 255
      ];
    }
    return { name: comp.name };
    }; // close _unreachable
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

  // â”€â”€ LAYERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ ANIMATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ TITLES & INTROS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ RENDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Helper Functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Command Dispatcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function executeCommand(commandStr) {
  // DIAGNOSTIC: write a breadcrumb file so we know we got here
  try {
    var dbg = new File("~/Desktop/ae_bridge_debug.txt");
    dbg.open("a");
    dbg.writeln(new Date().toString() + " | entered executeCommand | input length=" + (commandStr ? commandStr.length : "null"));
    dbg.writeln("  input: " + (commandStr ? commandStr.substring(0, 200) : "null"));
    dbg.close();
  } catch(dbgE) {}
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
    try { app.endUndoGroup(); } catch (e2) {}
    return JSON.stringify({ id: 0, error: "AE ExtendScript Error: " + (e.message || e.toString()) + " (line " + (e.line || "?") + ")" });
  }
}
