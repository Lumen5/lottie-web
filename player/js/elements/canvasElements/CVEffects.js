import featureSupport from '../../utils/featureSupport';

var registeredEffects = {};

// Effect type id for Gaussian blur (matches lottie schema and registration in modules/canvas.js).
var GAUSSIAN_BLUR_EFFECT_ID = 29;

function CVEffects(elem) {
  var i;
  var len = elem.data.ef ? elem.data.ef.length : 0;
  this.filters = [];
  this.elem = elem;
  this.globalData = elem.globalData;
  // Total Gaussian sigma being applied this frame; populated in renderFrame
  // and consumed by the WebGL fallback hooks (preInnerRender / postInnerRender).
  this.webglBlurSigma = 0;
  // The 2D context that drawing was redirected away from while the WebGL blur
  // pass is in flight. Restored by postInnerRender.
  this._savedDrawingBuffer = null;
  this._savedTransform = null;
  var filterManager;
  // Parallel array tracking the lottie effect type id (e.g. 29 for blur),
  // separate from each filter's own `type` field which has its own meaning.
  this._effectTypeIds = [];
  for (i = 0; i < len; i += 1) {
    filterManager = null;
    var type = elem.data.ef[i].ty;
    if (registeredEffects[type]) {
      var Effect = registeredEffects[type].effect;
      filterManager = new Effect(elem.effectsManager.effectElements[i], elem);
    }
    if (filterManager) {
      this.filters.push(filterManager);
      this._effectTypeIds.push(type);
    }
  }
  if (this.filters.length) {
    elem.addRenderableComponent(this);
  }
}

CVEffects.prototype.renderFrame = function (_isFirstFrame) {
  var i;
  var len = this.filters.length;
  var canvasContext = this.globalData.canvasContext;
  var filterStrings = [];
  var blurSigma = 0;
  for (i = 0; i < len; i += 1) {
    this.filters[i].renderFrame(_isFirstFrame);
    if (this._effectTypeIds[i] === GAUSSIAN_BLUR_EFFECT_ID && this.filters[i].sigma) {
      blurSigma += this.filters[i].sigma;
    }
    if (this.filters[i].filterString) {
      filterStrings.push(this.filters[i].filterString);
    }
  }
  // When `ctx.filter` doesn't honor `blur()` (Safari) and the host app has
  // supplied a WebGL context, defer the blur to the WebGL post pass and
  // strip it from the Canvas2D filter string.
  var useWebGLBlur = !featureSupport.canvasFilterBlur && blurSigma > 0 && !!this.globalData.webglContext;
  this.webglBlurSigma = useWebGLBlur ? blurSigma : 0;
  if (useWebGLBlur) {
    filterStrings = filterStrings.filter(function (str) {
      return str.indexOf('blur(') !== 0;
    });
  }
  canvasContext.filter = filterStrings.length ? filterStrings.join(' ') : 'none';
};

// Called from CVBaseElement.renderFrame just before the layer's
// renderInnerContent runs. When a WebGL blur is needed we snapshot whatever
// is on the main canvas and clear it so the layer paints into a fresh buffer.
CVEffects.prototype.preInnerRender = function () {
  if (!this.webglBlurSigma) return;
  var canvasContext = this.globalData.canvasContext;
  var canvas = canvasContext.canvas;
  var bufferManager = this.globalData.renderConfig.bufferManager;
  this._savedDrawingBuffer = bufferManager.allocate(canvas.width, canvas.height);
  var savedCtx = this._savedDrawingBuffer.getContext('2d');
  savedCtx.setTransform(1, 0, 0, 1, 0, 0);
  savedCtx.clearRect(0, 0, this._savedDrawingBuffer.width, this._savedDrawingBuffer.height);
  savedCtx.drawImage(canvas, 0, 0);
  this._savedTransform = canvasContext.getTransform();
  canvasContext.setTransform(1, 0, 0, 1, 0, 0);
  canvasContext.clearRect(0, 0, canvas.width, canvas.height);
  canvasContext.setTransform(this._savedTransform);
};

// Called from CVBaseElement.renderFrame just after renderInnerContent.
// At this point the layer's pixels are on the main canvas alone; we run
// the WebGL blur against them and composite the saved background back in.
CVEffects.prototype.postInnerRender = function () {
  if (!this.webglBlurSigma) return;
  var canvasContext = this.globalData.canvasContext;
  var canvas = canvasContext.canvas;
  var bufferManager = this.globalData.renderConfig.bufferManager;

  var blur = this.globalData.getWebGLBlur && this.globalData.getWebGLBlur();
  if (blur) {
    try {
      blur.blur(canvas, canvasContext, this.webglBlurSigma);
    } catch (e) {
      // Failing the blur should not break the rest of the frame; the layer
      // simply renders unblurred.
    }
  }

  canvasContext.save();
  canvasContext.setTransform(1, 0, 0, 1, 0, 0);
  canvasContext.globalCompositeOperation = 'destination-over';
  canvasContext.globalAlpha = 1;
  canvasContext.filter = 'none';
  canvasContext.drawImage(this._savedDrawingBuffer, 0, 0);
  canvasContext.restore();

  bufferManager.release(this._savedDrawingBuffer);
  this._savedDrawingBuffer = null;
  this._savedTransform = null;
  this.webglBlurSigma = 0;
};

CVEffects.prototype.getEffects = function (type) {
  var i;
  var len = this.filters.length;
  var effects = [];
  for (i = 0; i < len; i += 1) {
    if (this.filters[i].type === type) {
      effects.push(this.filters[i]);
    }
  }
  return effects;
};

export function registerEffect(id, effect) {
  registeredEffects[id] = {
    effect,
  };
}

export default CVEffects;
