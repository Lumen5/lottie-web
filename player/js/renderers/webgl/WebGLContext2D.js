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
//   - Mask paths are not yet supported.
//   - Track mattes (data.tt 1..4) are implemented: alpha, alpha-inverted,
//     luma, luma-inverted via a composite shader.
//   - Blend modes 1–11 are implemented (multiply, screen, overlay, darken,
//     lighten, color-dodge, color-burn, hard-light, soft-light, difference,
//     exclusion).  HSL modes (12–15) and modes ≥ 16 fall through to source-over.
//   - Gaussian blur effect (type 29) is implemented as a separable two-pass
//     shader with a fixed kernel radius.
//   - Strokes use butt caps and basic miter/overlap joins.
//   - Text rendering is a stub.

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

// Fullscreen quad shaders (clip-space, no per-vertex transform).  Used for
// presenting the root FBO and for compositing isolated-layer FBOs onto the
// outer target.
var FS_QUAD_VS = [
  'attribute vec2 a_position;',
  'attribute vec2 a_texCoord;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = a_texCoord;',
  '  gl_Position = vec4(a_position, 0.0, 1.0);',
  '}',
].join('\n');

// BLUR_FS: separable Gaussian blur — one pass along u_direction (either
// horizontal (1, 0) or vertical (0, 1)).  Caller runs the shader twice (one
// pass per axis) to get a 2D blur.  The kernel radius is fixed at 16 because
// WebGL 1.0 requires constant loop bounds; weights with |i| ≫ sigma fall to
// near-zero so a fixed-radius loop is fine for the sigma range we hit on
// typical Lottie blur effects.
var BLUR_FS = [
  'precision mediump float;',
  'varying vec2 v_uv;',
  'uniform sampler2D u_src;',
  'uniform vec2 u_pixelSize;',
  'uniform vec2 u_direction;',
  'uniform float u_sigma;',
  'void main() {',
  '  if (u_sigma <= 0.0) {',
  '    gl_FragColor = texture2D(u_src, v_uv);',
  '    return;',
  '  }',
  '  vec4 sum = vec4(0.0);',
  '  float weightSum = 0.0;',
  '  float twoSigmaSq = 2.0 * u_sigma * u_sigma;',
  '  for (int i = 0; i < 33; i++) {',
  '    float fi = float(i - 16);',
  '    float w = exp(-(fi * fi) / twoSigmaSq);',
  '    vec2 offset = u_direction * fi * u_pixelSize;',
  '    sum += texture2D(u_src, v_uv + offset) * w;',
  '    weightSum += w;',
  '  }',
  '  gl_FragColor = sum / weightSum;',
  '}',
].join('\n');

// MATTE_FS: applies a track-matte texture to a layer texture.
// modes (data.tt):
//   1 — alpha matte           (mask = matte alpha)
//   2 — alpha matte inverted  (mask = 1 − matte alpha)
//   3 — luma matte            (mask = luma of matte rgb, already weighted by
//                              its alpha because the texture is premultiplied)
//   4 — luma matte inverted   (mask = 1 − luma)
// The output is the layer texture multiplied by the per-pixel mask factor.
// Both inputs are premultiplied; multiplying both rgb and alpha by a scalar
// keeps the result premultiplied.
var MATTE_FS = [
  'precision mediump float;',
  'varying vec2 v_uv;',
  'uniform sampler2D u_src;',
  'uniform sampler2D u_matte;',
  'uniform int u_mode;',
  'const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);',
  'void main() {',
  '  vec4 src = texture2D(u_src, v_uv);',
  '  vec4 m = texture2D(u_matte, v_uv);',
  '  float factor = 1.0;',
  '  if (u_mode == 1) factor = m.a;',
  '  else if (u_mode == 2) factor = 1.0 - m.a;',
  '  else if (u_mode == 3) factor = dot(m.rgb, LUMA_W);',
  '  else if (u_mode == 4) factor = 1.0 - dot(m.rgb, LUMA_W);',
  '  gl_FragColor = src * factor;',
  '}',
].join('\n');

// COPY_FS: sample a texture, optionally scaled by u_alpha (premultiplied).
// Used for FBO→canvas presentation, FBO→FBO snapshots, and the source-over
// composite of an isolated layer onto its outer target.
var COPY_FS = [
  'precision mediump float;',
  'varying vec2 v_uv;',
  'uniform sampler2D u_src;',
  'uniform float u_alpha;',
  'void main() {',
  '  gl_FragColor = texture2D(u_src, v_uv) * u_alpha;',
  '}',
].join('\n');

// BLEND_FS: per-channel separable blend modes matching Lottie blend mode IDs
// 1–11 (multiply, screen, overlay, darken, lighten, color-dodge, color-burn,
// hard-light, soft-light, difference, exclusion).
//
// Both u_src and u_dst are premultiplied.  We unpremultiply the colour
// channels, run the per-channel blend formula, then composite the blended
// colour over the destination using the source's alpha (premultiplied
// source-over).  Opacity is multiplied into the source alpha before blending.
//
// IDs 12–15 (hue/saturation/colour/luminosity) and IDs 0/16+ fall through to
// plain source-over.
var BLEND_FS = [
  'precision mediump float;',
  'varying vec2 v_uv;',
  'uniform sampler2D u_src;',
  'uniform sampler2D u_dst;',
  'uniform float u_alpha;',
  'uniform int u_mode;',
  '',
  'float ovCh(float s, float d) {',
  '  return d < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);',
  '}',
  'float hlCh(float s, float d) {',
  '  return s < 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);',
  '}',
  'float slCh(float s, float d) {',
  '  if (s <= 0.5) {',
  '    return d - (1.0 - 2.0 * s) * d * (1.0 - d);',
  '  }',
  '  float dG = d <= 0.25',
  '    ? ((16.0 * d - 12.0) * d + 4.0) * d',
  '    : sqrt(d);',
  '  return d + (2.0 * s - 1.0) * (dG - d);',
  '}',
  'float dodgeCh(float s, float d) {',
  '  if (d <= 0.0) return 0.0;',
  '  if (s >= 1.0) return 1.0;',
  '  return min(1.0, d / (1.0 - s));',
  '}',
  'float burnCh(float s, float d) {',
  '  if (d >= 1.0) return 1.0;',
  '  if (s <= 0.0) return 0.0;',
  '  return 1.0 - min(1.0, (1.0 - d) / s);',
  '}',
  '',
  'void main() {',
  '  vec4 src = texture2D(u_src, v_uv) * u_alpha;',
  '  vec4 dst = texture2D(u_dst, v_uv);',
  '  vec3 sRGB = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);',
  '  vec3 dRGB = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);',
  '  vec3 b = sRGB;',
  '  if (u_mode == 1) b = sRGB * dRGB;', // multiply
  '  else if (u_mode == 2) b = sRGB + dRGB - sRGB * dRGB;', // screen
  '  else if (u_mode == 3) b = vec3(ovCh(sRGB.r, dRGB.r), ovCh(sRGB.g, dRGB.g), ovCh(sRGB.b, dRGB.b));',
  '  else if (u_mode == 4) b = min(sRGB, dRGB);', // darken
  '  else if (u_mode == 5) b = max(sRGB, dRGB);', // lighten
  '  else if (u_mode == 6) b = vec3(dodgeCh(sRGB.r, dRGB.r), dodgeCh(sRGB.g, dRGB.g), dodgeCh(sRGB.b, dRGB.b));',
  '  else if (u_mode == 7) b = vec3(burnCh(sRGB.r, dRGB.r), burnCh(sRGB.g, dRGB.g), burnCh(sRGB.b, dRGB.b));',
  '  else if (u_mode == 8) b = vec3(hlCh(sRGB.r, dRGB.r), hlCh(sRGB.g, dRGB.g), hlCh(sRGB.b, dRGB.b));',
  '  else if (u_mode == 9) b = vec3(slCh(sRGB.r, dRGB.r), slCh(sRGB.g, dRGB.g), slCh(sRGB.b, dRGB.b));',
  '  else if (u_mode == 10) b = abs(sRGB - dRGB);', // difference
  '  else if (u_mode == 11) b = sRGB + dRGB - 2.0 * sRGB * dRGB;', // exclusion
  '  float a = src.a;',
  '  vec3 outRgb = b * a + dst.rgb * (1.0 - a);',
  '  float outA = a + dst.a * (1.0 - a);',
  '  gl_FragColor = vec4(outRgb, outA);',
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

// FrameBuffer object — a colour-attachment-only render target, allocated at
// canvas size.  Layer-isolation FBOs (for blend modes, mattes, blur) borrow
// from a small pool keyed by size so we don't allocate every frame.
function createFrameBuffer(gl, w, h) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return {
    fbo: fbo, texture: tex, w: w, h: h,
  };
}

function destroyFrameBuffer(gl, fb) {
  if (!fb) return;
  if (fb.fbo) gl.deleteFramebuffer(fb.fbo);
  if (fb.texture) gl.deleteTexture(fb.texture);
}

function FBOPool(gl) {
  this.gl = gl;
  this._free = [];
  this._busy = [];
}
FBOPool.prototype.acquire = function (w, h) {
  for (var i = 0; i < this._free.length; i += 1) {
    var fb = this._free[i];
    if (fb.w === w && fb.h === h) {
      this._free.splice(i, 1);
      this._busy.push(fb);
      return fb;
    }
  }
  var made = createFrameBuffer(this.gl, w, h);
  this._busy.push(made);
  return made;
};
FBOPool.prototype.release = function (fb) {
  var idx = this._busy.indexOf(fb);
  if (idx >= 0) {
    this._busy.splice(idx, 1);
    this._free.push(fb);
  }
};
FBOPool.prototype.destroy = function () {
  var i;
  for (i = 0; i < this._free.length; i += 1) destroyFrameBuffer(this.gl, this._free[i]);
  for (i = 0; i < this._busy.length; i += 1) destroyFrameBuffer(this.gl, this._busy[i]);
  this._free.length = 0;
  this._busy.length = 0;
};

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

  // Fullscreen-quad programs and buffers used for layer-isolation composites.
  this._copyProgram = link(gl, FS_QUAD_VS, COPY_FS);
  this._copyLocs = {
    position: gl.getAttribLocation(this._copyProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this._copyProgram, 'a_texCoord'),
    src: gl.getUniformLocation(this._copyProgram, 'u_src'),
    alpha: gl.getUniformLocation(this._copyProgram, 'u_alpha'),
  };
  this._blendProgram = link(gl, FS_QUAD_VS, BLEND_FS);
  this._blendLocs = {
    position: gl.getAttribLocation(this._blendProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this._blendProgram, 'a_texCoord'),
    src: gl.getUniformLocation(this._blendProgram, 'u_src'),
    dst: gl.getUniformLocation(this._blendProgram, 'u_dst'),
    alpha: gl.getUniformLocation(this._blendProgram, 'u_alpha'),
    mode: gl.getUniformLocation(this._blendProgram, 'u_mode'),
  };
  this._matteProgram = link(gl, FS_QUAD_VS, MATTE_FS);
  this._matteLocs = {
    position: gl.getAttribLocation(this._matteProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this._matteProgram, 'a_texCoord'),
    src: gl.getUniformLocation(this._matteProgram, 'u_src'),
    matte: gl.getUniformLocation(this._matteProgram, 'u_matte'),
    mode: gl.getUniformLocation(this._matteProgram, 'u_mode'),
  };
  this._blurProgram = link(gl, FS_QUAD_VS, BLUR_FS);
  this._blurLocs = {
    position: gl.getAttribLocation(this._blurProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this._blurProgram, 'a_texCoord'),
    src: gl.getUniformLocation(this._blurProgram, 'u_src'),
    pixelSize: gl.getUniformLocation(this._blurProgram, 'u_pixelSize'),
    direction: gl.getUniformLocation(this._blurProgram, 'u_direction'),
    sigma: gl.getUniformLocation(this._blurProgram, 'u_sigma'),
  };

  // Static fullscreen quad in clip space (two triangles), with matching UVs.
  this._fsBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this._fsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  this._fsUVBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this._fsUVBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 1, 0, 0, 1,
    0, 1, 1, 0, 1, 1,
  ]), gl.STATIC_DRAW);

  // FBO pool + render-target stack.  All draws go to whichever FBO is on top
  // of the stack; layer isolation pushes new FBOs and pops them at composite
  // time.  When the stack is empty we render directly to the default
  // framebuffer (the visible WebGL canvas).
  this._fboPool = new FBOPool(gl);
  this._targetStack = [];
  this._rootFBO = null;

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

// Begin a new frame.  All layer rendering goes into a root FBO; endFrame()
// then presents that FBO to the visible canvas.  This indirection makes blend
// modes / mattes / blur tractable: the "outer target" for layer composites is
// always an FBO whose contents we can sample as a texture.
WebGLContext2D.prototype.beginFrame = function (width, height) {
  var gl = this.gl;
  this._rootFBO = this._fboPool.acquire(width, height);
  this._targetStack.length = 0;
  this._targetStack.push(this._rootFBO);
  gl.bindFramebuffer(gl.FRAMEBUFFER, this._rootFBO.fbo);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  this._transform = [1, 0, 0, 1, 0, 0];
  this._stack.length = 0;
  this._cmds.length = 0;
};

// Present the root FBO to the default framebuffer (the on-screen canvas).
WebGLContext2D.prototype.endFrame = function () {
  var gl = this.gl;
  var rootFBO = this._targetStack.pop();
  this._rootFBO = null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (rootFBO) {
    this._presentTextureToCurrent(rootFBO.texture, 1);
    this._fboPool.release(rootFBO);
  }
};

WebGLContext2D.prototype.setScissor = function (x, y, w, h) {
  var gl = this.gl;
  gl.enable(gl.SCISSOR_TEST);
  // gl.scissor uses bottom-left origin; we draw with top-left origin.
  var canvasH = gl.canvas.height;
  gl.scissor(Math.floor(x), Math.floor(canvasH - y - h), Math.ceil(w), Math.ceil(h));
};

// ─────────────────────────────────────────────────────────────────────────────
// Layer isolation.
//
// A layer with a non-trivial blend mode (or a track matte / blur — coming
// later) needs to draw into its own FBO so we can later composite the whole
// layer onto the parent target with the correct blend formula.  beginLayer()
// pushes a fresh transparent FBO; endLayer() pops it and runs a composite
// pass.
// ─────────────────────────────────────────────────────────────────────────────

WebGLContext2D.prototype._currentTarget = function () {
  return this._targetStack.length ? this._targetStack[this._targetStack.length - 1] : null;
};

WebGLContext2D.prototype._bindCurrentTarget = function () {
  var gl = this.gl;
  var t = this._currentTarget();
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  if (t) {
    gl.viewport(0, 0, t.w, t.h);
  } else {
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  }
};

WebGLContext2D.prototype.beginLayer = function () {
  var gl = this.gl;
  var w = gl.canvas.width;
  var h = gl.canvas.height;
  var fb = this._fboPool.acquire(w, h);
  this._targetStack.push(fb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
};

// Push a fresh FBO for rendering a track-matte source layer into.  Same
// mechanics as beginLayer; the separate name documents intent in the caller.
WebGLContext2D.prototype.beginMatte = function () {
  this.beginLayer();
};

// Pop the matte FBO and return it.  The caller passes it to endLayer({ matteFBO })
// which is responsible for releasing the FBO back to the pool.
WebGLContext2D.prototype.endMatte = function () {
  var fb = this._targetStack.pop();
  this._bindCurrentTarget();
  return fb;
};

// Pop the current isolation FBO and composite it onto the outer target.
//   opts.blurX, blurY — per-axis Gaussian blur sigmas (effect order: applied
//                       to the layer first, before matte and blend).
//   opts.matteFBO   — optional FBO produced by endMatte() (released here)
//   opts.matteMode  — Lottie matte mode (1..4) when matteFBO is provided
//   opts.blendMode  — Lottie blend-mode id (0 = source-over, 1..11 = shader)
//   opts.opacity    — final layer opacity multiplier (applied after matte)
WebGLContext2D.prototype.endLayer = function (opts) {
  var gl = this.gl;
  var layerFBO = this._targetStack.pop();
  if (!layerFBO) return;
  var blurX = (opts && opts.blurX) || 0;
  var blurY = (opts && opts.blurY) || 0;
  var matteFBO = opts && opts.matteFBO;
  var matteMode = (opts && opts.matteMode) || 0;
  var blendMode = (opts && opts.blendMode) || 0;
  var opacity = (opts && opts.opacity !== undefined) ? opts.opacity : 1;

  // Step 1: blur (per-axis separable Gaussian).  AE applies layer effects
  // before track matte and blend mode, so blur runs first.
  if (blurX > 0) {
    var hBlur = this._fboPool.acquire(layerFBO.w, layerFBO.h);
    this._drawBlurPass(layerFBO.texture, hBlur, blurX, 1, 0);
    this._fboPool.release(layerFBO);
    layerFBO = hBlur;
  }
  if (blurY > 0) {
    var vBlur = this._fboPool.acquire(layerFBO.w, layerFBO.h);
    this._drawBlurPass(layerFBO.texture, vBlur, blurY, 0, 1);
    this._fboPool.release(layerFBO);
    layerFBO = vBlur;
  }

  // Step 2: apply track matte (if any).  Result replaces layerFBO.
  if (matteFBO && matteMode >= 1 && matteMode <= 4) {
    var matted = this._fboPool.acquire(layerFBO.w, layerFBO.h);
    this._drawMatteComposite(layerFBO.texture, matteFBO.texture, matteMode, matted);
    this._fboPool.release(layerFBO);
    layerFBO = matted;
  }
  if (matteFBO) {
    this._fboPool.release(matteFBO);
  }

  // Step 3: composite (post-blur, post-matte) layer onto outer target with
  // blend mode and opacity.
  var outer = this._currentTarget();
  this._bindCurrentTarget();
  gl.disable(gl.SCISSOR_TEST);

  if (blendMode > 0 && blendMode <= 11 && outer) {
    // Snapshot the outer target so the blend shader can sample the
    // pre-existing destination while we write the blended result back.
    var dst = this._fboPool.acquire(outer.w, outer.h);
    this._copyFBOTexture(outer.texture, dst);
    this._bindCurrentTarget();
    this._drawBlendComposite(layerFBO.texture, dst.texture, blendMode, opacity);
    this._fboPool.release(dst);
  } else {
    // Plain source-over composite of the isolated layer onto the outer FBO,
    // honouring layer opacity.
    this._presentTextureToCurrent(layerFBO.texture, opacity);
  }

  this._fboPool.release(layerFBO);
};

// ─────────────────────────────────────────────────────────────────────────────
// Composite-pass primitives.
// ─────────────────────────────────────────────────────────────────────────────

WebGLContext2D.prototype._bindFullscreenAttribs = function (positionLoc, texCoordLoc) {
  var gl = this.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, this._fsBuffer);
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, this._fsUVBuffer);
  gl.enableVertexAttribArray(texCoordLoc);
  gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);
};

// Copy `srcTexture` into `dstFB` using the copy program with no blending.
WebGLContext2D.prototype._copyFBOTexture = function (srcTexture, dstFB) {
  var gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFB.fbo);
  gl.viewport(0, 0, dstFB.w, dstFB.h);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(this._copyProgram);
  this._bindFullscreenAttribs(this._copyLocs.position, this._copyLocs.texCoord);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.uniform1i(this._copyLocs.src, 0);
  gl.uniform1f(this._copyLocs.alpha, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.enable(gl.BLEND);
};

// Draw `srcTexture` (premultiplied) onto whichever framebuffer is currently
// bound, using premultiplied source-over blending and an opacity multiplier.
WebGLContext2D.prototype._presentTextureToCurrent = function (srcTexture, alpha) {
  var gl = this.gl;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(this._copyProgram);
  this._bindFullscreenAttribs(this._copyLocs.position, this._copyLocs.texCoord);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.uniform1i(this._copyLocs.src, 0);
  gl.uniform1f(this._copyLocs.alpha, alpha);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

// One axis of a separable Gaussian blur.  Reads srcTexture, writes dstFB.
// `sigma` is the standard deviation in pixels; (dirX, dirY) selects axis.
WebGLContext2D.prototype._drawBlurPass = function (srcTexture, dstFB, sigma, dirX, dirY) {
  var gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFB.fbo);
  gl.viewport(0, 0, dstFB.w, dstFB.h);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(this._blurProgram);
  this._bindFullscreenAttribs(this._blurLocs.position, this._blurLocs.texCoord);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.uniform1i(this._blurLocs.src, 0);
  gl.uniform2f(this._blurLocs.pixelSize, 1 / dstFB.w, 1 / dstFB.h);
  gl.uniform2f(this._blurLocs.direction, dirX, dirY);
  gl.uniform1f(this._blurLocs.sigma, sigma);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.enable(gl.BLEND);
};

// Run the matte composite shader: layer × matte_factor → dstFB.
// Used to apply a track matte (alpha or luma, optionally inverted) to a
// layer's FBO.  Blending is disabled because we're producing a fresh
// premultiplied output, not compositing onto an existing destination.
WebGLContext2D.prototype._drawMatteComposite = function (srcTexture, matteTexture, mode, dstFB) {
  var gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFB.fbo);
  gl.viewport(0, 0, dstFB.w, dstFB.h);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(this._matteProgram);
  this._bindFullscreenAttribs(this._matteLocs.position, this._matteLocs.texCoord);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.uniform1i(this._matteLocs.src, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, matteTexture);
  gl.uniform1i(this._matteLocs.matte, 1);
  gl.uniform1i(this._matteLocs.mode, mode);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
};

// Run the blend-mode shader: source = layer FBO, destination = outer
// snapshot, output → currently-bound framebuffer.  Blending is disabled
// because the shader itself produces the source-over composite of the
// blended colour with the destination.
WebGLContext2D.prototype._drawBlendComposite = function (srcTexture, dstTexture, mode, alpha) {
  var gl = this.gl;
  gl.disable(gl.BLEND);
  gl.useProgram(this._blendProgram);
  this._bindFullscreenAttribs(this._blendLocs.position, this._blendLocs.texCoord);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.uniform1i(this._blendLocs.src, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, dstTexture);
  gl.uniform1i(this._blendLocs.dst, 1);
  gl.uniform1f(this._blendLocs.alpha, alpha);
  gl.uniform1i(this._blendLocs.mode, mode);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
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
  if (this._copyProgram) gl.deleteProgram(this._copyProgram);
  if (this._blendProgram) gl.deleteProgram(this._blendProgram);
  if (this._matteProgram) gl.deleteProgram(this._matteProgram);
  if (this._blurProgram) gl.deleteProgram(this._blurProgram);
  if (this._vbo) gl.deleteBuffer(this._vbo);
  if (this._uvbo) gl.deleteBuffer(this._uvbo);
  if (this._fsBuffer) gl.deleteBuffer(this._fsBuffer);
  if (this._fsUVBuffer) gl.deleteBuffer(this._fsUVBuffer);
  if (this._fboPool) this._fboPool.destroy();
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
