// Native WebGL renderer for Lottie.
//
// All geometry is drawn through real WebGL draw calls — there is no offscreen
// 2D canvas rasterization step. Shape paths are tessellated into triangles
// (renderers/webgl/Tessellator.js), uploaded to a vertex buffer, and rendered
// via custom shader programs (renderers/webgl/WebGLContext2D.js). Image layers
// upload their bitmap as a texture and draw a textured quad.
//
// Element classes live in elements/webglElements/ and are independent of the
// canvas renderer's CV* classes. Shared utilities (ShapePropertyFactory,
// ShapeTransformManager, ShapeModifiers, BaseElement, TransformElement, …)
// are reused — those are renderer-agnostic and parse Lottie animation data,
// they do not perform rendering.

import {
  extendPrototype,
} from '../utils/functionExtensions';
import {
  createSizedArray,
} from '../utils/helpers/arrays';
import createTag from '../utils/helpers/html_elements';
import SVGRenderer from './SVGRenderer';
import BaseRenderer from './BaseRenderer';
import WGLShapeElement from '../elements/webglElements/WGLShapeElement';
import WGLTextElement from '../elements/webglElements/WGLTextElement';
import WGLImageElement from '../elements/webglElements/WGLImageElement';
import WGLSolidElement from '../elements/webglElements/WGLSolidElement';
import WebGLContext2D from './webgl/WebGLContext2D';

function WebGLRendererBase() {
}
extendPrototype([BaseRenderer], WebGLRendererBase);

WebGLRendererBase.prototype.createShape = function (data) {
  return new WGLShapeElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createText = function (data) {
  return new WGLTextElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createImage = function (data) {
  return new WGLImageElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createSolid = function (data) {
  return new WGLSolidElement(data, this.globalData, this);
};

WebGLRendererBase.prototype.createNull = SVGRenderer.prototype.createNull;

// State / draw forwarders. CV* analogues live on CanvasRendererBase; ours
// route to WGLContextData, which forwards to the WebGLContext2D adapter, which
// emits real WebGL draw calls.
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

WebGLRendererBase.prototype.configAnimation = function (animData) {
  if (this.animationItem.wrapper) {
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
      preserveDrawingBuffer: true,
    };
    this.gl = this.glCanvas.getContext('webgl', glOptions)
      || this.glCanvas.getContext('experimental-webgl', glOptions);
    if (!this.gl) {
      throw new Error('WebGL is not supported in this environment.');
    }
  } else {
    this.gl = this.renderConfig.context;
    this.glCanvas = this.gl.canvas;
  }

  this.canvasContext = new WebGLContext2D(this.gl);
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
    this.glCanvas.width = elementWidth;
    this.glCanvas.height = elementHeight;
  } else {
    if (this.animationItem.wrapper && this.glCanvas) {
      elementWidth = this.animationItem.wrapper.offsetWidth;
      elementHeight = this.animationItem.wrapper.offsetHeight;
    } else {
      elementWidth = this.glCanvas.width;
      elementHeight = this.glCanvas.height;
    }
    this.glCanvas.width = elementWidth * this.renderConfig.dpr;
    this.glCanvas.height = elementHeight * this.renderConfig.dpr;
  }

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
  if (this.canvasContext) this.canvasContext.destroy();
  this.canvasContext = null;
  this.gl = null;
  this.glCanvas = null;
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
    this.canvasContext.beginFrame(this.glCanvas.width, this.glCanvas.height);
    this.contextData.reset();
    this.ctxTransform(this.transformCanvas.props);
    // Scissor to composition bounds (gl.scissor takes pixel coordinates).
    this.canvasContext.setScissor(
      this.transformCanvas.tx,
      this.transformCanvas.ty,
      this.transformCanvas.w * this.transformCanvas.sx,
      this.transformCanvas.h * this.transformCanvas.sy
    );

    for (i = len - 1; i >= 0; i -= 1) {
      if (this.completeLayers || this.elements[i]) {
        this.elements[i].renderFrame();
      }
    }
    // All layers have rendered into the root FBO; present it to the canvas.
    this.canvasContext.endFrame();
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
