/*
    json2.jsx — minimal JSON polyfill for Adobe ExtendScript (ES3 engines, e.g. After Effects).
    Public domain. Provides JSON.stringify() and JSON.parse() when the engine lacks them.
    Kept deliberately simple/ES3-safe (no exotic Unicode regex) so it parses in AE's engine.
    parse() uses eval() — acceptable here because payloads originate from our own bridge.
*/
if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    function quote(s) {
        var c, i, l = s.length, r = '"';
        for (i = 0; i < l; i += 1) {
            c = s.charAt(i);
            if (c === '"') { r += '\\"'; }
            else if (c === '\\') { r += '\\\\'; }
            else if (c === '\b') { r += '\\b'; }
            else if (c === '\f') { r += '\\f'; }
            else if (c === '\n') { r += '\\n'; }
            else if (c === '\r') { r += '\\r'; }
            else if (c === '\t') { r += '\\t'; }
            else if (c < ' ') {
                r += '\\u' + ('0000' + s.charCodeAt(i).toString(16)).slice(-4);
            } else {
                r += c;
            }
        }
        return r + '"';
    }

    function str(value) {
        var t = typeof value, parts, i, k, sv, isArr;

        if (value === null) { return 'null'; }
        if (t === 'number') { return isFinite(value) ? String(value) : 'null'; }
        if (t === 'boolean') { return String(value); }
        if (t === 'string') { return quote(value); }
        if (t === 'object') {
            if (typeof value.toJSON === 'function') { return str(value.toJSON()); }
            parts = [];
            isArr = (value instanceof Array) ||
                (Object.prototype.toString.call(value) === '[object Array]');
            if (isArr) {
                for (i = 0; i < value.length; i += 1) {
                    sv = str(value[i]);
                    parts.push(sv === undefined ? 'null' : sv);
                }
                return '[' + parts.join(',') + ']';
            }
            for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                    sv = str(value[k]);
                    if (sv !== undefined) {
                        parts.push(quote(k) + ':' + sv);
                    }
                }
            }
            return '{' + parts.join(',') + '}';
        }
        return undefined; // functions / undefined are omitted
    }

    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value) {
            return str(value);
        };
    }

    if (typeof JSON.parse !== 'function') {
        JSON.parse = function (text) {
            return eval('(' + String(text) + ')');
        };
    }
}());
