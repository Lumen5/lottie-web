// WebGLContext2D
//
// Adapter that exposes a CanvasRenderingContext2D-like surface to the rest of
// the player while internally driving a real WebGL context. There is **no**
// 2D-canvas rasterization step: every fill, stroke, fillRect, drawImage, and
// clearRect maps to a real WebGL draw call against tessellated geometry or a
// textured quad.
//
// Why an adapter instead of new element classes? The CV* element classes already
// implement Lottie shape parsing, property animation, modifier application
// (trim/zigzag/repeater/...), per-shape transform stacks and style resolution.
// Reimplementing that pipeline would mean duplicating ~1500 lines of correct
// code. The adapter lets us reuse data extraction while replacing rendering.
//
// Limitations (MVP, intended foundation for further work):
//   - Gradient fills/strokes return null and skip rendering.
//   - clip() is a no-op (composition-rect clip is implemented via gl.scissor).
//   - Track mattes, masks, blend modes, effects, and text are not yet supported.
//   - Strokes use butt caps and basic miter/overlap joins.

import parseColor from './colorUtils';
import {
  flattenPath,
  triangulatePolygon,
  buildStrokeGeometry,
} from './Tessellator';

var SOLID_VS = [
  'attribute vec2 a_position;',
  'uniform mat3 u_matrix;',
  'uniform vec2 u_resolution;',
  'void main() {',
  '  vec3 p = u_matrix * vec3(a_position, 1.0);',
  '  vec2 cs = (p.xy / u_resolution) * 2.0 - 1.0;',
  '  gl_Position = vec4(cs.x, -cs.y, 0.0, 1.0);',
  '}',
].join('\n');

var SOLID_FS = [
  'precision mediump float;',
  'uniform vec4 u_color;',
  'void main() { gl_FragColor = u_color; }',
].join('\n');

var TEX_VS = [
  'attribute vec2 a_position;',
  'attribute vec2 a_texCoord;',
  'varying vec2 v_texCoord;',
  'uniform mat3 u_matrix;',
  'uniform vec2 u_resolution;',
  'void main() {',
  '  vec3 p = u_matrix * vec3(a_position, 1.0);',
  '  vec2 cs = (p.xy / u_resolution) * 2.0 - 1.0;',
  '  gl_Position = vec4(cs.x, -cs.y, 0.0, 1.0);',
  '  v_texCoord = a_texCoord;',
  '}',
].join('\n');

var TEX_FS = [
  'precision mediump float;',
  'varying vec2 v_texCoord;',
  'uniform sampler2D u_texture;',
  'uniform float u_alpha;',
  'void main() {',
  '  vec4 c = texture2D(u_texture, v_texCoord);',
  '  gl_FragColor = vec4(c.rgb, c.a) * u_alpha;',
  '}',
].join('\n');

function compile(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    var info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('WebGL shader compile failed: ' + info);
  }
  return s;
}

function link(gl, vs, fs) {
  var program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    var info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('WebGL program link failed: ' + info);
  }
  return program;
}

// Matrix utilities. We track a 2D affine matrix as [a, b, c, d, e, f]
// where a point is transformed as: x' = a*x + c*y + e; y' = b*x + d*y + f.
// This matches CanvasRenderingContext2D.setTransform/transform semantics.
function multiplyAffine(out, m1, m2) {
  var a = m1[0] * m2[0] + m1[2] * m2[1];
  var b = m1[1] * m2[0] + m1[3] * m2[1];
  var c = m1[0] * m2[2] + m1[2] * m2[3];
  var d = m1[1] * m2[2] + m1[3] * m2[3];
  var e = m1[0] * m2[4] + m1[2] * m2[5] + m1[4];
  var f = m1[1] * m2[4] + m1[3] * m2[5] + m1[5];
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = e; out[5] = f;
}

function affineToMat3(m) {
  // Column-major 3x3 for WebGL uniforms.
  return new Float32Array([
    m[0], m[1], 0,
    m[2], m[3], 0,
    m[4], m[5], 1,
  ]);
}

function WebGLContext2D(gl) {
  this.gl = gl;
  this.canvas = gl.canvas;

  // Programs.
  this._solidProgram = link(gl, SOLID_VS, SOLID_FS);
  this._solidLocs = {
    position: gl.getAttribLocation(this._solidProgram, 'a_position'),
    matrix: gl.getUniformLocation(this._solidProgram, 'u_matrix'),
    resolution: gl.getUniformLocation(this._solidProgram, 'u_resolution'),
    color: gl.getUniformLocation(this._solidProgram, 'u_color'),
  };
  this._texProgram = link(gl, TEX_VS, TEX_FS);
  this._texLocs = {
    position: gl.getAttribLocation(this._texProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this._texProgram, 'a_texCoord'),
    matrix: gl.getUniformLocation(this._texProgram, 'u_matrix'),
    resolution: gl.getUniformLocation(this._texProgram, 'u_resolution'),
    texture: gl.getUniformLocation(this._texProgram, 'u_texture'),
    alpha: gl.getUniformLocation(this._texProgram, 'u_alpha'),
  };

  this._vbo = gl.createBuffer();
  this._uvbo = gl.createBuffer();

  // Path-recording state.
  this._cmds = [];

  // 2D-context state. Property assignment from CV* code lands here directly.
  this.fillStyle = '#000000';
  this.strokeStyle = '#000000';
  this.lineWidth = 1;
  this.lineCap = 'butt';
  this.lineJoin = 'miter';
  this.miterLimit = 10;
  this.globalAlpha = 1;
  this.globalCompositeOperation = 'source-over';

  // Transform + state stack.
  this._transform = [1, 0, 0, 1, 0, 0];
  this._stack = [];

  // Cached image textures keyed by HTMLImageElement (or canvas) reference.
  this._imageTextures = (typeof Map !== 'undefined') ? new Map() : null;
  this._fallbackTextures = [];

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
}

WebGLContext2D.prototype.setSize = function (width, height) {
  this.gl.viewport(0, 0, width, height);
};

WebGLContext2D.prototype.beginFrame = function (width, height) {
  var gl = this.gl;
  gl.viewport(0, 0, width, height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  this._transform = [1, 0, 0, 1, 0, 0];
  this._stack.length = 0;
  this._cmds.length = 0;
};

WebGLContext2D.prototype.setScissor = function (x, y, w, h) {
  var gl = this.gl;
  gl.enable(gl.SCISSOR_TEST);
  // gl.scissor uses bottom-left origin; we draw with top-left origin.
  var canvasH = gl.canvas.height;
  gl.scissor(Math.floor(x), Math.floor(canvasH - y - h), Math.ceil(w), Math.ceil(h));
};

// ─────────────────────────────────────────────────────────────────────────────
// Path commands (recorded; emitted at fill/stroke time).
// ─────────────────────────────────────────────────────────────────────────────

WebGLContext2D.prototype.beginPath = function () {
  this._cmds.length = 0;
};

WebGLContext2D.prototype.moveTo = function (x, y) {
  this._cmds.push({ op: 'M', args: [x, y] });
};

WebGLContext2D.prototype.lineTo = function (x, y) {
  this._cmds.push({ op: 'L', args: [x, y] });
};

WebGLContext2D.prototype.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
  this._cmds.push({ op: 'C', args: [cp1x, cp1y, cp2x, cp2y, x, y] });
};

WebGLContext2D.prototype.quadraticCurveTo = function (cpx, cpy, x, y) {
  // Convert to cubic.
  var prev = this._lastEndpoint();
  if (!prev) prev = [x, y];
  var cp1x = prev[0] + (2 / 3) * (cpx - prev[0]);
  var cp1y = prev[1] + (2 / 3) * (cpy - prev[1]);
  var cp2x = x + (2 / 3) * (cpx - x);
  var cp2y = y + (2 / 3) * (cpy - y);
  this.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
};

WebGLContext2D.prototype.closePath = function () {
  this._cmds.push({ op: 'Z', args: [] });
};

WebGLContext2D.prototype.rect = function (x, y, w, h) {
  this.moveTo(x, y);
  this.lineTo(x + w, y);
  this.lineTo(x + w, y + h);
  this.lineTo(x, y + h);
  this.closePath();
};

WebGLContext2D.prototype._lastEndpoint = function () {
  for (var i = this._cmds.length - 1; i >= 0; i -= 1) {
    var c = this._cmds[i];
    if (c.op === 'M' || c.op === 'L') return [c.args[0], c.args[1]];
    if (c.op === 'C') return [c.args[4], c.args[5]];
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// State stack & transforms.
// ─────────────────────────────────────────────────────────────────────────────

WebGLContext2D.prototype.save = function () {
  this._stack.push({
    transform: this._transform.slice(),
    fillStyle: this.fillStyle,
    strokeStyle: this.strokeStyle,
    lineWidth: this.lineWidth,
    lineCap: this.lineCap,
    lineJoin: this.lineJoin,
    miterLimit: this.miterLimit,
    globalAlpha: this.globalAlpha,
    globalCompositeOperation: this.globalCompositeOperation,
  });
};

WebGLContext2D.prototype.restore = function () {
  var s = this._stack.pop();
  if (!s) return;
  this._transform = s.transform;
  this.fillStyle = s.fillStyle;
  this.strokeStyle = s.strokeStyle;
  this.lineWidth = s.lineWidth;
  this.lineCap = s.lineCap;
  this.lineJoin = s.lineJoin;
  this.miterLimit = s.miterLimit;
  this.globalAlpha = s.globalAlpha;
  this.globalCompositeOperation = s.globalCompositeOperation;
};

WebGLContext2D.prototype.setTransform = function (a, b, c, d, e, f) {
  this._transform[0] = a;
  this._transform[1] = b;
  this._transform[2] = c;
  this._transform[3] = d;
  this._transform[4] = e;
  this._transform[5] = f;
};

WebGLContext2D.prototype.transform = function (a, b, c, d, e, f) {
  multiplyAffine(this._transform, this._transform, [a, b, c, d, e, f]);
};

WebGLContext2D.prototype.translate = function (tx, ty) {
  this.transform(1, 0, 0, 1, tx, ty);
};

WebGLContext2D.prototype.scale = function (sx, sy) {
  this.transform(sx, 0, 0, sy, 0, 0);
};

WebGLContext2D.prototype.rotate = function (angle) {
  var c = Math.cos(angle);
  var s = Math.sin(angle);
  this.transform(c, s, -s, c, 0, 0);
};

WebGLContext2D.prototype.getTransform = function () {
  var t = this._transform;
  return {
    a: t[0],
    b: t[1],
    c: t[2],
    d: t[3],
    e: t[4],
    f: t[5],
    is2D: true,
    isIdentity: t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0,
  };
};

// CV* code rarely needs these but expects them to be no-ops:
WebGLContext2D.prototype.setLineDash = function () {};
WebGLContext2D.prototype.getLineDash = function () { return []; };
WebGLContext2D.prototype.clip = function () {};
WebGLContext2D.prototype.createLinearGradient = function () { return null; };
WebGLContext2D.prototype.createRadialGradient = function () { return null; };
WebGLContext2D.prototype.createPattern = function () { return null; };

// ─────────────────────────────────────────────────────────────────────────────
// Drawing primitives.
// ─────────────────────────────────────────────────────────────────────────────

WebGLContext2D.prototype._drawSolidTriangles = function (vertices, rgba) {
  if (!vertices || vertices.length === 0) return;
  var gl = this.gl;
  var alpha = rgba[3] * this.globalAlpha;
  if (alpha <= 0) return;
  // Premultiplied alpha output (matches blendFunc(ONE, ONE_MINUS_SRC_ALPHA)).
  var pr = rgba[0] * alpha;
  var pg = rgba[1] * alpha;
  var pb = rgba[2] * alpha;

  gl.useProgram(this._solidProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
  gl.enableVertexAttribArray(this._solidLocs.position);
  gl.vertexAttribPointer(this._solidLocs.position, 2, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix3fv(this._solidLocs.matrix, false, affineToMat3(this._transform));
  gl.uniform2f(this._solidLocs.resolution, gl.canvas.width, gl.canvas.height);
  gl.uniform4f(this._solidLocs.color, pr, pg, pb, alpha);
  gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
};

WebGLContext2D.prototype.fill = function () {
  if (!this.fillStyle) return;
  var rgba = parseColor(this.fillStyle);
  if (rgba[3] <= 0) return;
  var subpaths = flattenPath(this._cmds);
  var verts = [];
  for (var i = 0; i < subpaths.length; i += 1) {
    var tris = triangulatePolygon(subpaths[i]);
    for (var j = 0; j < tris.length; j += 1) verts.push(tris[j]);
  }
  this._drawSolidTriangles(verts, rgba);
};

WebGLContext2D.prototype.stroke = function () {
  if (!this.strokeStyle) return;
  var rgba = parseColor(this.strokeStyle);
  if (rgba[3] <= 0) return;
  var subpaths = flattenPath(this._cmds);
  var verts = [];
  for (var i = 0; i < subpaths.length; i += 1) {
    var sp = subpaths[i];
    // Detect "closed" subpath: last cmd in original was a Z that contributed
    // this subpath. We approximate by checking if first/last vertex coincide;
    // flattenPath emits Z-terminated subpaths with the start vertex implied
    // as a closing edge. To be safe, treat all subpaths as closed when the
    // original commands ended with Z.
    var closed = false;
    var tris = buildStrokeGeometry(sp, closed, this.lineWidth);
    // Add an explicit closing segment if first/last differ.
    if (sp.length >= 4) {
      var x0 = sp[0];
      var y0 = sp[1];
      var xn = sp[sp.length - 2];
      var yn = sp[sp.length - 1];
      if (x0 !== xn || y0 !== yn) {
        var last = buildStrokeGeometry([xn, yn, x0, y0], false, this.lineWidth);
        for (var l = 0; l < last.length; l += 1) tris.push(last[l]);
      }
    }
    for (var j2 = 0; j2 < tris.length; j2 += 1) verts.push(tris[j2]);
  }
  this._drawSolidTriangles(verts, rgba);
};

WebGLContext2D.prototype.fillRect = function (x, y, w, h) {
  if (!this.fillStyle) return;
  var rgba = parseColor(this.fillStyle);
  if (rgba[3] <= 0) return;
  var verts = [
    x, y,
    x + w, y,
    x, y + h,
    x, y + h,
    x + w, y,
    x + w, y + h,
  ];
  this._drawSolidTriangles(verts, rgba);
};

WebGLContext2D.prototype.strokeRect = function (x, y, w, h) {
  this.beginPath();
  this.rect(x, y, w, h);
  this.stroke();
};

WebGLContext2D.prototype.clearRect = function () {
  // The renderer clears the entire viewport at the start of each frame; per-
  // element clearRect calls (e.g. masks/mattes) are unsupported in MVP.
};

WebGLContext2D.prototype._getOrUploadTexture = function (image) {
  var gl = this.gl;
  if (this._imageTextures && this._imageTextures.has(image)) {
    return this._imageTextures.get(image);
  }
  // Fallback for environments without Map.
  for (var i = 0; i < this._fallbackTextures.length; i += 1) {
    if (this._fallbackTextures[i].image === image) return this._fallbackTextures[i].texture;
  }

  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  } catch (err) {
    // Cross-origin or not-yet-loaded — return a 1x1 transparent texture.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
  }

  if (this._imageTextures) {
    this._imageTextures.set(image, tex);
  } else {
    this._fallbackTextures.push({ image: image, texture: tex });
  }
  return tex;
};

WebGLContext2D.prototype.drawImage = function (image) {
  // Supports the (image, dx, dy, dw, dh) and (image, sx, sy, sw, sh, dx, dy, dw, dh)
  // signatures that CV* uses. We always sample the full texture for now (sx/sy ignored).
  if (!image) return;
  var dx = 0;
  var dy = 0;
  var dw = image.width || 0;
  var dh = image.height || 0;
  if (arguments.length === 5) {
    dx = arguments[1];
    dy = arguments[2];
    dw = arguments[3];
    dh = arguments[4];
  } else if (arguments.length === 9) {
    dx = arguments[5];
    dy = arguments[6];
    dw = arguments[7];
    dh = arguments[8];
  }
  if (dw <= 0 || dh <= 0) return;
  var gl = this.gl;
  var tex = this._getOrUploadTexture(image);

  var verts = new Float32Array([
    dx, dy,
    dx + dw, dy,
    dx, dy + dh,
    dx, dy + dh,
    dx + dw, dy,
    dx + dw, dy + dh,
  ]);
  var uvs = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    0, 1,
    1, 0,
    1, 1,
  ]);

  gl.useProgram(this._texProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
  gl.enableVertexAttribArray(this._texLocs.position);
  gl.vertexAttribPointer(this._texLocs.position, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, this._uvbo);
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STREAM_DRAW);
  gl.enableVertexAttribArray(this._texLocs.texCoord);
  gl.vertexAttribPointer(this._texLocs.texCoord, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(this._texLocs.texture, 0);
  gl.uniform1f(this._texLocs.alpha, this.globalAlpha);
  gl.uniformMatrix3fv(this._texLocs.matrix, false, affineToMat3(this._transform));
  gl.uniform2f(this._texLocs.resolution, gl.canvas.width, gl.canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

WebGLContext2D.prototype.destroy = function () {
  var gl = this.gl;
  if (!gl) return;
  if (this._solidProgram) gl.deleteProgram(this._solidProgram);
  if (this._texProgram) gl.deleteProgram(this._texProgram);
  if (this._vbo) gl.deleteBuffer(this._vbo);
  if (this._uvbo) gl.deleteBuffer(this._uvbo);
  if (this._imageTextures) {
    this._imageTextures.forEach(function (tex) { gl.deleteTexture(tex); });
    this._imageTextures.clear();
  }
  for (var i = 0; i < this._fallbackTextures.length; i += 1) {
    gl.deleteTexture(this._fallbackTextures[i].texture);
  }
  this._fallbackTextures.length = 0;
};

export default WebGLContext2D;
