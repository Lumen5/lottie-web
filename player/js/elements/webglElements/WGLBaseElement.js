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
      // Recorded for parity with CV — effective blend modes need shader work.
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
    this.globalData.renderer.save(forceRealStack);
    this.globalData.renderer.ctxTransform(this.finalTransform.localMat.props);
    this.globalData.renderer.ctxOpacity(this.finalTransform.localOpacity);
    this.renderInnerContent();
    this.globalData.renderer.restore(forceRealStack);
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
