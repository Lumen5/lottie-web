import getBlendMode from '../../utils/helpers/blendModes';
import Matrix from '../../3rd_party/transformation-matrix';
import WGLEffects from './WGLEffects';
import WGLMaskElement from './WGLMaskElement';
import effectTypes from '../../utils/helpers/effectTypes';

// Layer base for the WebGL renderer.  Mirrors CVBaseElement but drops the
// 2D-canvas track-matte / luma-matte buffer logic — that pipeline relies on
// CanvasRenderingContext2D buffers and globalCompositeOperation, neither of
// which apply to a WebGL pipeline.  Track mattes are an MVP no-op.

function WGLBaseElement() {
}

WGLBaseElement.prototype = {
  createElements: function () {},
  initRendererElement: function () {},
  createContainerElements: function () {
    this.canvasContext = this.globalData.canvasContext;
    this.transformCanvas = this.globalData.transformCanvas;
    this.renderableEffectsManager = new WGLEffects(this);
    this.searchEffectTransforms();
  },
  createContent: function () {},
  setBlendMode: function () {
    var globalData = this.globalData;
    if (globalData.blendMode !== this.data.bm) {
      globalData.blendMode = this.data.bm;
      // Tracked for diagnostics; the actual compositing happens at endLayer
      // time via a shader pass.  The CSS-style enum is also assigned here so
      // any state-tracking that mirrors CanvasRenderingContext2D stays in sync.
      var blendModeValue = getBlendMode(this.data.bm);
      globalData.canvasContext.globalCompositeOperation = blendModeValue;
    }
  },
  createRenderableComponents: function () {
    this.maskManager = new WGLMaskElement(this.data, this);
    this.transformEffects = this.renderableEffectsManager.getEffects(effectTypes.TRANSFORM_EFFECT);
  },
  hideElement: function () {
    if (!this.hidden && (!this.isInRange || this.isTransparent)) {
      this.hidden = true;
    }
  },
  showElement: function () {
    if (this.isInRange && !this.isTransparent) {
      this.hidden = false;
      this._isFirstFrame = true;
      this.maskManager._isFirstFrame = true;
    }
  },
  prepareLayer: function () {},
  exitLayer: function () {},
  renderFrame: function (forceRender) {
    if (this.hidden || this.data.hd) {
      return;
    }
    if (this.data.td === 1 && !forceRender) {
      return;
    }
    this.renderTransform();
    this.renderRenderable();
    this.renderLocalTransform();
    this.setBlendMode();
    var forceRealStack = this.data.ty === 0;
    var blendMode = +(this.data.bm) || 0;
    var matteMode = +(this.data.tt) || 0;
    // The blur effect manager (WGLGaussianBlurEffect) writes per-axis sigmas
    // onto the element during renderRenderable above.  Default to 0 so non-
    // blur layers don't trigger isolation.
    var blurX = +(this._blurSigmaX) || 0;
    var blurY = +(this._blurSigmaY) || 0;
    // Lottie blend modes 1..11, track mattes (tt 1..4), and a non-zero
    // Gaussian blur each force the layer to render into its own FBO so the
    // appropriate composite/effect shaders can sample it.  Mode 0 / no blur /
    // no matte fall through to the direct-draw path.
    var hasBlend = blendMode >= 1 && blendMode <= 11;
    var hasMatte = matteMode >= 1 && matteMode <= 4;
    var hasBlur = blurX > 0 || blurY > 0;
    var needsIsolation = hasBlend || hasMatte || hasBlur;
    var renderer = this.globalData.renderer;
    var ctx = this.globalData.canvasContext;

    if (needsIsolation) {
      ctx.beginLayer();
    }

    renderer.save(forceRealStack);
    renderer.ctxTransform(this.finalTransform.localMat.props);
    if (!needsIsolation) {
      renderer.ctxOpacity(this.finalTransform.localOpacity);
    }
    this.renderInnerContent();
    renderer.restore(forceRealStack);

    var matteFBO = null;
    if (hasMatte && this.comp) {
      // The matte source layer is referenced either by data.tp (track-matte
      // parent index) or by the layer immediately above (data.ind - 1).  It
      // is normally hidden because td === 1; we force-render it into its own
      // FBO so the matte shader can sample it.
      var matteRef = ('tp' in this.data) ? this.data.tp : this.data.ind - 1;
      var matteLayer = this.comp.getElementById(matteRef);
      if (matteLayer) {
        ctx.beginMatte();
        matteLayer.renderFrame(true);
        matteFBO = ctx.endMatte();
      }
    }

    if (needsIsolation) {
      ctx.endLayer({
        blurX: blurX,
        blurY: blurY,
        matteFBO: matteFBO,
        matteMode: matteMode,
        blendMode: blendMode,
        opacity: this.finalTransform.localOpacity,
      });
    }

    if (this.maskManager.hasMasks) {
      this.globalData.renderer.restore(true);
    }
    if (this._isFirstFrame) {
      this._isFirstFrame = false;
    }
  },
  destroy: function () {
    this.canvasContext = null;
    this.data = null;
    this.globalData = null;
    if (this.maskManager) this.maskManager.destroy();
  },
  mHelper: new Matrix(),
};
WGLBaseElement.prototype.hide = WGLBaseElement.prototype.hideElement;
WGLBaseElement.prototype.show = WGLBaseElement.prototype.showElement;

export default WGLBaseElement;
