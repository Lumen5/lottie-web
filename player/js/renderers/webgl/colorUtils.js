// Color parsing helpers for the WebGL renderer.
//
// CV* elements pass colors as canvas-style strings: "rgb(r,g,b)", "rgba(r,g,b,a)"
// or "#rrggbb". We parse to a normalised [r, g, b, a] vec4 (0..1) for shaders.

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function parseHex(str) {
  var hex = str.charAt(0) === '#' ? str.slice(1) : str;
  if (hex.length === 3) {
    var r = parseInt(hex.charAt(0) + hex.charAt(0), 16) / 255;
    var g = parseInt(hex.charAt(1) + hex.charAt(1), 16) / 255;
    var b = parseInt(hex.charAt(2) + hex.charAt(2), 16) / 255;
    return [r, g, b, 1];
  }
  if (hex.length >= 6) {
    var r6 = parseInt(hex.slice(0, 2), 16) / 255;
    var g6 = parseInt(hex.slice(2, 4), 16) / 255;
    var b6 = parseInt(hex.slice(4, 6), 16) / 255;
    var a6 = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r6, g6, b6, a6];
  }
  return [0, 0, 0, 1];
}

function parseFunctional(str) {
  var open = str.indexOf('(');
  var close = str.indexOf(')');
  if (open === -1 || close === -1) return [0, 0, 0, 1];
  var parts = str.slice(open + 1, close).split(',');
  var r = parseFloat(parts[0]) / 255;
  var g = parseFloat(parts[1]) / 255;
  var b = parseFloat(parts[2]) / 255;
  var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
}

function parseColor(value) {
  if (!value) return [0, 0, 0, 0];
  if (typeof value !== 'string') {
    // Could be a CanvasGradient stub or unsupported value; treat as transparent.
    return [0, 0, 0, 0];
  }
  if (value.charAt(0) === '#') return parseHex(value);
  if (value.indexOf('rgb') === 0) return parseFunctional(value);
  return [0, 0, 0, 1];
}

export default parseColor;
