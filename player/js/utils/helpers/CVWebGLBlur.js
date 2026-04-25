// Two-pass separable Gaussian blur implemented with WebGL 1.
//
// The consumer of lottie-web supplies a WebGL rendering context (typically
// the same one their app already uses for its own GPU work) via the
// `webglContext` render config option. Lottie borrows that context to
// build the blurred frame for a layer and carefully restores any state it
// touched so the host application can keep rendering without surprises.
//
// The blurred layer pixels come back to the Canvas2D pipeline through
// `putImageData`, which keeps every other layer/composite/mask path in
// CVBaseElement working unchanged.

var KERNEL_TAPS = 17;
var KERNEL_RADIUS = 8;
var MAX_SIGMA_PER_PASS = 4;

var VERTEX_SHADER = [
  'attribute vec2 a_position;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = a_position * 0.5 + 0.5;',
  '  gl_Position = vec4(a_position, 0.0, 1.0);',
  '}',
].join('\n');

var FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform sampler2D u_image;',
  'uniform vec2 u_texelDir;',
  'uniform float u_weights[' + KERNEL_TAPS + '];',
  'varying vec2 v_uv;',
  'void main() {',
  '  vec4 sum = vec4(0.0);',
  '  for (int i = 0; i < ' + KERNEL_TAPS + '; i++) {',
  '    float offset = float(i - ' + KERNEL_RADIUS + ');',
  '    sum += texture2D(u_image, v_uv + u_texelDir * offset) * u_weights[i];',
  '  }',
  '  gl_FragColor = sum;',
  '}',
].join('\n');

function compileShader(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('CVWebGLBlur shader compile failed: ' + log);
  }
  return shader;
}

function buildProgram(gl) {
  var vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  var fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  var program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    var log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('CVWebGLBlur program link failed: ' + log);
  }
  return program;
}

function computeWeights(sigma) {
  var weights = new Float32Array(KERNEL_TAPS);
  var twoSigmaSq = 2 * sigma * sigma;
  var sum = 0;
  for (var i = 0; i < KERNEL_TAPS; i += 1) {
    var x = i - KERNEL_RADIUS;
    var w = Math.exp(-(x * x) / twoSigmaSq);
    weights[i] = w;
    sum += w;
  }
  for (var j = 0; j < KERNEL_TAPS; j += 1) {
    weights[j] /= sum;
  }
  return weights;
}

function makeTexture(gl, width, height) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeFbo(gl, texture) {
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return fbo;
}

function CVWebGLBlur(gl) {
  this.gl = gl;
  this.program = null;
  this.quadBuffer = null;
  this.attribLocations = null;
  this.uniformLocations = null;
  this.pingTex = null;
  this.pongTex = null;
  this.pingFbo = null;
  this.pongFbo = null;
  this.uploadTex = null;
  this.fboWidth = 0;
  this.fboHeight = 0;
}

CVWebGLBlur.prototype.init = function () {
  var gl = this.gl;
  this.program = buildProgram(gl);
  this.attribLocations = {
    a_position: gl.getAttribLocation(this.program, 'a_position'),
  };
  this.uniformLocations = {
    u_image: gl.getUniformLocation(this.program, 'u_image'),
    u_texelDir: gl.getUniformLocation(this.program, 'u_texelDir'),
    u_weights: gl.getUniformLocation(this.program, 'u_weights[0]'),
  };
  this.quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  this.uploadTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this.uploadTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

CVWebGLBlur.prototype.ensureFbos = function (width, height) {
  if (this.pingTex && this.fboWidth === width && this.fboHeight === height) {
    return;
  }
  var gl = this.gl;
  if (this.pingFbo) gl.deleteFramebuffer(this.pingFbo);
  if (this.pongFbo) gl.deleteFramebuffer(this.pongFbo);
  if (this.pingTex) gl.deleteTexture(this.pingTex);
  if (this.pongTex) gl.deleteTexture(this.pongTex);
  this.pingTex = makeTexture(gl, width, height);
  this.pongTex = makeTexture(gl, width, height);
  this.pingFbo = makeFbo(gl, this.pingTex);
  this.pongFbo = makeFbo(gl, this.pongTex);
  this.fboWidth = width;
  this.fboHeight = height;
};

CVWebGLBlur.prototype.saveState = function () {
  var gl = this.gl;
  var saved = {
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    viewport: gl.getParameter(gl.VIEWPORT),
    scissorEnabled: gl.getParameter(gl.SCISSOR_TEST),
    blendEnabled: gl.getParameter(gl.BLEND),
    depthEnabled: gl.getParameter(gl.DEPTH_TEST),
    cullEnabled: gl.getParameter(gl.CULL_FACE),
    ditherEnabled: gl.getParameter(gl.DITHER),
    unpackFlipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
    unpackPremultiplyAlpha: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
    unpackAlignment: gl.getParameter(gl.UNPACK_ALIGNMENT),
  };
  gl.activeTexture(gl.TEXTURE0);
  saved.texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  return saved;
};

CVWebGLBlur.prototype.restoreState = function (saved) {
  var gl = this.gl;
  gl.useProgram(saved.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, saved.texture0);
  gl.activeTexture(saved.activeTexture);
  gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
  if (saved.scissorEnabled) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
  if (saved.blendEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (saved.depthEnabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (saved.cullEnabled) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  if (saved.ditherEnabled) gl.enable(gl.DITHER); else gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.unpackFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, saved.unpackPremultiplyAlpha);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, saved.unpackAlignment);
};

CVWebGLBlur.prototype.runPass = function (srcTex, dstFbo, weights, dirX, dirY, width, height) {
  var gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(this.uniformLocations.u_image, 0);
  gl.uniform2f(this.uniformLocations.u_texelDir, dirX / width, dirY / height);
  gl.uniform1fv(this.uniformLocations.u_weights, weights);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

// Apply Gaussian blur of `sigma` (in canvas pixels) to `sourceCanvas`.
// On return the same canvas holds the blurred pixels. Drawing transform
// and composite state of the supplied 2d context are preserved.
//
// The final pass renders into the host's WebGL canvas drawing buffer,
// which is then transferred back via `ctx.drawImage(glCanvas, ...)`.
// This avoids the slow `gl.readPixels` + `putImageData` round-trip and
// the GPU stalls it triggers. The host's drawing buffer is treated as
// scratch space, matching the contract that lottie-web is borrowing the
// context temporarily.
CVWebGLBlur.prototype.blur = function (sourceCanvas, sourceCtx, sigma) {
  if (!sigma || sigma <= 0) return;
  var width = sourceCanvas.width;
  var height = sourceCanvas.height;
  if (width === 0 || height === 0) return;

  if (!this.program) {
    this.init();
  }
  var gl = this.gl;
  if (gl.isContextLost && gl.isContextLost()) return;

  var glCanvas = gl.canvas;
  var prevCanvasW = glCanvas.width;
  var prevCanvasH = glCanvas.height;
  if (prevCanvasW !== width) glCanvas.width = width;
  if (prevCanvasH !== height) glCanvas.height = height;

  var saved = this.saveState();
  try {
    this.ensureFbos(width, height);

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.attribLocations.a_position);
    gl.vertexAttribPointer(this.attribLocations.a_position, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.uploadTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

    // Large sigmas need multiple passes; the kernel only spans ±KERNEL_RADIUS texels.
    var passSigma = sigma;
    var passes = 1;
    if (passSigma > MAX_SIGMA_PER_PASS) {
      passes = Math.ceil((passSigma * passSigma) / (MAX_SIGMA_PER_PASS * MAX_SIGMA_PER_PASS));
      passSigma /= Math.sqrt(passes);
    }
    var weights = computeWeights(passSigma);

    var srcTex = this.uploadTex;
    for (var p = 0; p < passes; p += 1) {
      this.runPass(srcTex, this.pingFbo, weights, 1, 0, width, height);
      var isLastPass = p === passes - 1;
      if (isLastPass) {
        // The final vertical pass writes directly to the WebGL canvas's
        // default framebuffer, so the result is available to drawImage.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pingTex);
        gl.uniform1i(this.uniformLocations.u_image, 0);
        gl.uniform2f(this.uniformLocations.u_texelDir, 0, 1 / height);
        gl.uniform1fv(this.uniformLocations.u_weights, weights);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } else {
        this.runPass(this.pingTex, this.pongFbo, weights, 0, 1, width, height);
        srcTex = this.pongTex;
      }
    }
    // Make sure GL has actually executed before the 2D side reads the buffer.
    gl.flush();
  } finally {
    this.restoreState(saved);
  }

  // ctx.drawImage handles the Y-flip from WebGL's bottom-up convention.
  var prevTransform = sourceCtx.getTransform();
  var prevComposite = sourceCtx.globalCompositeOperation;
  var prevAlpha = sourceCtx.globalAlpha;
  var prevFilter = sourceCtx.filter;
  sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
  sourceCtx.globalCompositeOperation = 'copy';
  sourceCtx.globalAlpha = 1;
  sourceCtx.filter = 'none';
  sourceCtx.drawImage(glCanvas, 0, 0, width, height);
  sourceCtx.filter = prevFilter;
  sourceCtx.globalAlpha = prevAlpha;
  sourceCtx.globalCompositeOperation = prevComposite;
  sourceCtx.setTransform(prevTransform);

  // Restore the host canvas dimensions (this clears the drawing buffer; the
  // host code is expected to repaint its own content on its next frame).
  if (prevCanvasW !== width) glCanvas.width = prevCanvasW;
  if (prevCanvasH !== height) glCanvas.height = prevCanvasH;
};

CVWebGLBlur.prototype.destroy = function () {
  var gl = this.gl;
  if (!gl) return;
  if (this.pingFbo) gl.deleteFramebuffer(this.pingFbo);
  if (this.pongFbo) gl.deleteFramebuffer(this.pongFbo);
  if (this.pingTex) gl.deleteTexture(this.pingTex);
  if (this.pongTex) gl.deleteTexture(this.pongTex);
  if (this.uploadTex) gl.deleteTexture(this.uploadTex);
  if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
  if (this.program) gl.deleteProgram(this.program);
  this.gl = null;
};

export default CVWebGLBlur;
