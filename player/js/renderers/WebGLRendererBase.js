import {
  extendPrototype,
} from '../utils/functionExtensions';
import {
  createSizedArray,
} from '../utils/helpers/arrays';
import createTag from '../utils/helpers/html_elements';
import SVGRenderer from './SVGRenderer';
import BaseRenderer from './BaseRenderer';
import CVShapeElement from '../elements/canvasElements/CVShapeElement';
import CVTextElement from '../elements/canvasElements/CVTextElement';
import CVImageElement from '../elements/canvasElements/CVImageElement';
import CVSolidElement from '../elements/canvasElements/CVSolidElement';

function WebGLRendererBase() {
}
extendPrototype([BaseRenderer], WebGLRendererBase);

WebGLRendererBase.prototype.createShape = function (data) {
  return new CVShapeElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createText = function (data) {
  return new CVTextElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createImage = function (data) {
  return new CVImageElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createSolid = function (data) {
  return new CVSolidElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createNull = SVGRenderer.prototype.createNull;

// 2D canvas pass-through helpers (elements draw into an offscreen 2D canvas
// that we later upload to a GL texture).
WebGLRendererBase.prototype.ctxTransform = function (props) {
  if (props[0] === 1 && props[1] === 0 && props[4] === 0 && props[5] === 1 && props[12] === 0 && props[13] === 0) {
    return;
  }
  this.canvasContext.transform(props[0], props[1], props[4], props[5], props[12], props[13]);
};

WebGLRendererBase.prototype.ctxOpacity = function (op) {
  this.canvasContext.globalAlpha *= op < 0 ? 0 : op;
};

WebGLRendererBase.prototype.ctxFillStyle = function (value) {
  this.canvasContext.fillStyle = value;
};

WebGLRendererBase.prototype.ctxStrokeStyle = function (value) {
  this.canvasContext.strokeStyle = value;
};

WebGLRendererBase.prototype.ctxLineWidth = function (value) {
  this.canvasContext.lineWidth = value;
};

WebGLRendererBase.prototype.ctxLineCap = function (value) {
  this.canvasContext.lineCap = value;
};

WebGLRendererBase.prototype.ctxLineJoin = function (value) {
  this.canvasContext.lineJoin = value;
};

WebGLRendererBase.prototype.ctxMiterLimit = function (value) {
  this.canvasContext.miterLimit = value;
};

WebGLRendererBase.prototype.ctxFill = function (rule) {
  this.canvasContext.fill(rule);
};

WebGLRendererBase.prototype.ctxFillRect = function (x, y, w, h) {
  this.canvasContext.fillRect(x, y, w, h);
};

WebGLRendererBase.prototype.ctxStroke = function () {
  this.canvasContext.stroke();
};

WebGLRendererBase.prototype.reset = function () {
  if (!this.renderConfig.clearCanvas) {
    this.canvasContext.restore();
    return;
  }
  this.contextData.reset();
};

WebGLRendererBase.prototype.save = function () {
  this.canvasContext.save();
};

WebGLRendererBase.prototype.restore = function (actionFlag) {
  if (!this.renderConfig.clearCanvas) {
    this.canvasContext.restore();
    return;
  }
  if (actionFlag) {
    this.globalData.blendMode = 'source-over';
  }
  this.contextData.restore(actionFlag);
};

// WebGL helpers
var QUAD_VERTEX_SHADER = [
  'attribute vec2 a_position;',
  'attribute vec2 a_texCoord;',
  'varying vec2 v_texCoord;',
  'void main() {',
  '  gl_Position = vec4(a_position, 0.0, 1.0);',
  '  v_texCoord = a_texCoord;',
  '}',
].join('\n');

var QUAD_FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform sampler2D u_texture;',
  'varying vec2 v_texCoord;',
  'void main() {',
  '  gl_FragColor = texture2D(u_texture, v_texCoord);',
  '}',
].join('\n');

function compileShader(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('WebGL shader compile failed: ' + info);
  }
  return shader;
}

function linkProgram(gl, vsSource, fsSource) {
  var vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  var program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    var info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('WebGL program link failed: ' + info);
  }
  return program;
}

WebGLRendererBase.prototype.initWebGL = function () {
  var gl = this.gl;
  this.glProgram = linkProgram(gl, QUAD_VERTEX_SHADER, QUAD_FRAGMENT_SHADER);
  this.glAttribs = {
    position: gl.getAttribLocation(this.glProgram, 'a_position'),
    texCoord: gl.getAttribLocation(this.glProgram, 'a_texCoord'),
  };
  this.glUniforms = {
    texture: gl.getUniformLocation(this.glProgram, 'u_texture'),
  };

  // Fullscreen quad (clip-space) and matching texture coordinates.
  // The texture is flipped vertically so that the 2D canvas (which has y-down
  // origin) appears the right way up in WebGL (y-up clip space).
  this.glPositionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.glPositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
  ]), gl.STATIC_DRAW);

  this.glTexCoordBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, this.glTexCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 1,
    1, 1,
    0, 0,
    0, 0,
    1, 1,
    1, 0,
  ]), gl.STATIC_DRAW);

  this.glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
};

WebGLRendererBase.prototype.presentToWebGL = function () {
  var gl = this.gl;
  if (!gl) {
    return;
  }
  var sourceCanvas = this.offscreenCanvas;
  var glCanvas = this.glCanvas;
  if (glCanvas.width !== sourceCanvas.width || glCanvas.height !== sourceCanvas.height) {
    glCanvas.width = sourceCanvas.width;
    glCanvas.height = sourceCanvas.height;
  }

  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(this.glProgram);

  gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
  gl.uniform1i(this.glUniforms.texture, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, this.glPositionBuffer);
  gl.enableVertexAttribArray(this.glAttribs.position);
  gl.vertexAttribPointer(this.glAttribs.position, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, this.glTexCoordBuffer);
  gl.enableVertexAttribArray(this.glAttribs.texCoord);
  gl.vertexAttribPointer(this.glAttribs.texCoord, 2, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
};

WebGLRendererBase.prototype.configAnimation = function (animData) {
  if (this.animationItem.wrapper) {
    // The visible container is a WebGL canvas; the actual drawing happens on
    // an offscreen 2D canvas that we upload as a texture each frame.
    this.glCanvas = createTag('canvas');
    var containerStyle = this.glCanvas.style;
    containerStyle.width = '100%';
    containerStyle.height = '100%';
    var origin = '0px 0px 0px';
    containerStyle.transformOrigin = origin;
    containerStyle.mozTransformOrigin = origin;
    containerStyle.webkitTransformOrigin = origin;
    containerStyle['-webkit-transform'] = origin;
    containerStyle.contentVisibility = this.renderConfig.contentVisibility;
    this.animationItem.wrapper.appendChild(this.glCanvas);
    if (this.renderConfig.className) {
      this.glCanvas.setAttribute('class', this.renderConfig.className);
    }
    if (this.renderConfig.id) {
      this.glCanvas.setAttribute('id', this.renderConfig.id);
    }
    this.animationItem.container = this.glCanvas;

    var glOptions = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      // Preserve so external readers (puppeteer screenshots, gl.readPixels)
      // see the last drawn frame rather than a cleared buffer.
      preserveDrawingBuffer: true,
    };
    this.gl = this.glCanvas.getContext('webgl', glOptions)
      || this.glCanvas.getContext('experimental-webgl', glOptions);
    if (!this.gl) {
      throw new Error('WebGL is not supported in this environment.');
    }

    this.offscreenCanvas = createTag('canvas');
    this.canvasContext = this.offscreenCanvas.getContext('2d');
    this.initWebGL();
  } else {
    // Allow callers to provide an existing WebGL context. We still need a 2D
    // canvas to rasterize into.
    this.gl = this.renderConfig.context;
    this.glCanvas = this.gl.canvas;
    this.offscreenCanvas = createTag('canvas');
    this.canvasContext = this.offscreenCanvas.getContext('2d');
    this.initWebGL();
  }
  this.contextData.setContext(this.canvasContext);
  this.data = animData;
  this.layers = animData.layers;
  this.transformCanvas = {
    w: animData.w,
    h: animData.h,
    sx: 0,
    sy: 0,
    tx: 0,
    ty: 0,
  };
  this.setupGlobalData(animData, document.body);
  this.globalData.canvasContext = this.canvasContext;
  this.globalData.renderer = this;
  this.globalData.isDashed = false;
  this.globalData.progressiveLoad = this.renderConfig.progressiveLoad;
  this.globalData.transformCanvas = this.transformCanvas;
  this.elements = createSizedArray(animData.layers.length);

  this.updateContainerSize();
};

WebGLRendererBase.prototype.updateContainerSize = function (width, height) {
  this.reset();
  var elementWidth;
  var elementHeight;
  if (width) {
    elementWidth = width;
    elementHeight = height;
    this.offscreenCanvas.width = elementWidth;
    this.offscreenCanvas.height = elementHeight;
  } else {
    if (this.animationItem.wrapper && this.glCanvas) {
      elementWidth = this.animationItem.wrapper.offsetWidth;
      elementHeight = this.animationItem.wrapper.offsetHeight;
    } else {
      elementWidth = this.glCanvas.width;
      elementHeight = this.glCanvas.height;
    }
    this.offscreenCanvas.width = elementWidth * this.renderConfig.dpr;
    this.offscreenCanvas.height = elementHeight * this.renderConfig.dpr;
  }
  this.glCanvas.width = this.offscreenCanvas.width;
  this.glCanvas.height = this.offscreenCanvas.height;

  var elementRel;
  var animationRel;
  if (this.renderConfig.preserveAspectRatio.indexOf('meet') !== -1 || this.renderConfig.preserveAspectRatio.indexOf('slice') !== -1) {
    var par = this.renderConfig.preserveAspectRatio.split(' ');
    var fillType = par[1] || 'meet';
    var pos = par[0] || 'xMidYMid';
    var xPos = pos.substr(0, 4);
    var yPos = pos.substr(4);
    elementRel = elementWidth / elementHeight;
    animationRel = this.transformCanvas.w / this.transformCanvas.h;
    if ((animationRel > elementRel && fillType === 'meet') || (animationRel < elementRel && fillType === 'slice')) {
      this.transformCanvas.sx = elementWidth / (this.transformCanvas.w / this.renderConfig.dpr);
      this.transformCanvas.sy = elementWidth / (this.transformCanvas.w / this.renderConfig.dpr);
    } else {
      this.transformCanvas.sx = elementHeight / (this.transformCanvas.h / this.renderConfig.dpr);
      this.transformCanvas.sy = elementHeight / (this.transformCanvas.h / this.renderConfig.dpr);
    }

    if (xPos === 'xMid' && ((animationRel < elementRel && fillType === 'meet') || (animationRel > elementRel && fillType === 'slice'))) {
      this.transformCanvas.tx = ((elementWidth - this.transformCanvas.w * (elementHeight / this.transformCanvas.h)) / 2) * this.renderConfig.dpr;
    } else if (xPos === 'xMax' && ((animationRel < elementRel && fillType === 'meet') || (animationRel > elementRel && fillType === 'slice'))) {
      this.transformCanvas.tx = (elementWidth - this.transformCanvas.w * (elementHeight / this.transformCanvas.h)) * this.renderConfig.dpr;
    } else {
      this.transformCanvas.tx = 0;
    }
    if (yPos === 'YMid' && ((animationRel > elementRel && fillType === 'meet') || (animationRel < elementRel && fillType === 'slice'))) {
      this.transformCanvas.ty = ((elementHeight - this.transformCanvas.h * (elementWidth / this.transformCanvas.w)) / 2) * this.renderConfig.dpr;
    } else if (yPos === 'YMax' && ((animationRel > elementRel && fillType === 'meet') || (animationRel < elementRel && fillType === 'slice'))) {
      this.transformCanvas.ty = ((elementHeight - this.transformCanvas.h * (elementWidth / this.transformCanvas.w))) * this.renderConfig.dpr;
    } else {
      this.transformCanvas.ty = 0;
    }
  } else if (this.renderConfig.preserveAspectRatio === 'none') {
    this.transformCanvas.sx = elementWidth / (this.transformCanvas.w / this.renderConfig.dpr);
    this.transformCanvas.sy = elementHeight / (this.transformCanvas.h / this.renderConfig.dpr);
    this.transformCanvas.tx = 0;
    this.transformCanvas.ty = 0;
  } else {
    this.transformCanvas.sx = this.renderConfig.dpr;
    this.transformCanvas.sy = this.renderConfig.dpr;
    this.transformCanvas.tx = 0;
    this.transformCanvas.ty = 0;
  }
  this.transformCanvas.props = [this.transformCanvas.sx, 0, 0, 0, 0, this.transformCanvas.sy, 0, 0, 0, 0, 1, 0, this.transformCanvas.tx, this.transformCanvas.ty, 0, 1];
  this.ctxTransform(this.transformCanvas.props);
  this.canvasContext.beginPath();
  this.canvasContext.rect(0, 0, this.transformCanvas.w, this.transformCanvas.h);
  this.canvasContext.closePath();
  this.canvasContext.clip();

  this.renderFrame(this.renderedFrame, true);
};

WebGLRendererBase.prototype.destroy = function () {
  if (this.renderConfig.clearCanvas && this.animationItem.wrapper) {
    this.animationItem.wrapper.innerText = '';
  }
  var i;
  var len = this.layers ? this.layers.length : 0;
  for (i = len - 1; i >= 0; i -= 1) {
    if (this.elements[i] && this.elements[i].destroy) {
      this.elements[i].destroy();
    }
  }
  this.elements.length = 0;
  if (this.gl) {
    if (this.glTexture) this.gl.deleteTexture(this.glTexture);
    if (this.glPositionBuffer) this.gl.deleteBuffer(this.glPositionBuffer);
    if (this.glTexCoordBuffer) this.gl.deleteBuffer(this.glTexCoordBuffer);
    if (this.glProgram) this.gl.deleteProgram(this.glProgram);
  }
  this.gl = null;
  this.glCanvas = null;
  this.offscreenCanvas = null;
  this.canvasContext = null;
  this.globalData.canvasContext = null;
  this.animationItem.container = null;
  this.destroyed = true;
};

WebGLRendererBase.prototype.renderFrame = function (num, forceRender) {
  if ((this.renderedFrame === num && this.renderConfig.clearCanvas === true && !forceRender) || this.destroyed || num === -1) {
    return;
  }
  this.renderedFrame = num;
  this.globalData.frameNum = num - this.animationItem._isFirstFrame;
  this.globalData.frameId += 1;
  this.globalData._mdf = !this.renderConfig.clearCanvas || forceRender;
  this.globalData.projectInterface.currentFrame = num;

  var i;
  var len = this.layers.length;
  if (!this.completeLayers) {
    this.checkLayers(num);
  }

  for (i = len - 1; i >= 0; i -= 1) {
    if (this.completeLayers || this.elements[i]) {
      this.elements[i].prepareFrame(num - this.layers[i].st);
    }
  }
  if (this.globalData._mdf) {
    if (this.renderConfig.clearCanvas === true) {
      this.canvasContext.clearRect(0, 0, this.transformCanvas.w, this.transformCanvas.h);
    } else {
      this.save();
    }
    for (i = len - 1; i >= 0; i -= 1) {
      if (this.completeLayers || this.elements[i]) {
        this.elements[i].renderFrame();
      }
    }
    if (this.renderConfig.clearCanvas !== true) {
      this.restore();
    }
    this.presentToWebGL();
  }
  this.renderConfig.bufferManager.releaseAll();
};

WebGLRendererBase.prototype.buildItem = function (pos) {
  var elements = this.elements;
  if (elements[pos] || this.layers[pos].ty === 99) {
    return;
  }
  var element = this.createItem(this.layers[pos], this, this.globalData);
  elements[pos] = element;
  element.initExpressions();
};

WebGLRendererBase.prototype.checkPendingElements = function () {
  while (this.pendingElements.length) {
    var element = this.pendingElements.pop();
    element.checkParenting();
  }
};

WebGLRendererBase.prototype.hide = function () {
  this.animationItem.container.style.display = 'none';
};

WebGLRendererBase.prototype.show = function () {
  this.animationItem.container.style.display = 'block';
};

export default WebGLRendererBase;
