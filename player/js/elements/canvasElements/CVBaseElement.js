import assetManager from '../../utils/helpers/assetManager';
import getBlendMode from '../../utils/helpers/blendModes';
import Matrix from '../../3rd_party/transformation-matrix';
import CVEffects from './CVEffects';
import CVMaskElement from './CVMaskElement';
import effectTypes from '../../utils/helpers/effectTypes';

function CVBaseElement() {
}

var operationsMap = {
  1: 'source-in',
  2: 'source-out',
  3: 'source-in',
  4: 'source-out',
};

CVBaseElement.prototype = {
  createElements: function () {},
  initRendererElement: function () {},
  createContainerElements: function () {
    // If the layer is masked we will use two buffers to store each different states of the drawing
    // This solution is not ideal for several reason. But unfortunately, because of the recursive
    // nature of the render tree, it's the only simple way to make sure one inner mask doesn't override an outer mask.
    // TODO: try to reduce the size of these buffers to the size of the composition contaning the layer
    // It might be challenging because the layer most likely is transformed in some way
    if (this.data.tt >= 1) {
      if (this.data.tt >= 3 && !document._isProxy) {
        assetManager.loadLumaCanvas();
      }
    }
    this.canvasContext = this.globalData.canvasContext;
    this.transformCanvas = this.globalData.transformCanvas;
    this.renderableEffectsManager = new CVEffects(this);
    this.searchEffectTransforms();
  },
  createContent: function () {},
  setBlendMode: function () {
    var globalData = this.globalData;
    if (globalData.blendMode !== this.data.bm) {
      globalData.blendMode = this.data.bm;
      var blendModeValue = getBlendMode(this.data.bm);
      globalData.canvasContext.globalCompositeOperation = blendModeValue;
    }
  },
  createRenderableComponents: function () {
    this.maskManager = new CVMaskElement(this.data, this);
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
  clearCanvas: function (canvasContext) {
    canvasContext.clearRect(
      this.transformCanvas.tx,
      this.transformCanvas.ty,
      this.transformCanvas.w * this.transformCanvas.sx,
      this.transformCanvas.h * this.transformCanvas.sy
    );
  },
  isIsolated: function () {
    // The layer needs to render to an offscreen buffer (isolated group) when
    // it has a track matte, or when a shape/text layer with opacity below 1
    // contains overlapping fills/strokes that would otherwise alpha-blend
    // with each other and produce darker intersections (mismatching SVG's
    // group-opacity semantics). Compositions, images, solids and other layer
    // types are left alone to preserve their existing rendering behavior.
    if (this.data.tt >= 1) {
      return true;
    }
    var ty = this.data.ty;
    return (ty === 4 || ty === 5) && this.finalTransform.localOpacity < 1;
  },
  prepareLayer: function () {
    if (this.isIsolated()) {
      this.globalDrawingBufferCanvas = this.globalData.renderConfig.bufferManager.allocate(this.canvasContext.canvas.width, this.canvasContext.canvas.height);
      var globalDrawingBufferCanvasCtx = this.globalDrawingBufferCanvas.getContext('2d');
      this.clearCanvas(globalDrawingBufferCanvasCtx);
      // on the first buffer we store the current state of the global drawing
      globalDrawingBufferCanvasCtx.drawImage(this.canvasContext.canvas, 0, 0);
      // The next four lines are to clear the canvas
      // TODO: Check if there is a way to clear the canvas without resetting the transform
      this.currentTransform = this.canvasContext.getTransform();
      this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      this.clearCanvas(this.canvasContext);
      this.canvasContext.setTransform(this.currentTransform);
    }
  },
  exitLayer: function () {
    if (this.isIsolated()) {
      var contentOfCurrentLayerCanvas = this.globalData.renderConfig.bufferManager.allocate(this.canvasContext.canvas.width, this.canvasContext.canvas.height);
      // On the second buffer we store the current state of the global drawing
      // that only contains the content of this layer
      // (if it is a composition, it also includes the nested layers)
      var contentOfCurrentLayerCanvasCtx = contentOfCurrentLayerCanvas.getContext('2d');
      this.clearCanvas(contentOfCurrentLayerCanvasCtx);
      contentOfCurrentLayerCanvasCtx.drawImage(this.canvasContext.canvas, 0, 0);
      // We clear the canvas again
      this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      this.clearCanvas(this.canvasContext);
      this.canvasContext.setTransform(this.currentTransform);
      if (this.data.tt >= 1) {
        // We draw the mask
        const mask = this.comp.getElementById('tp' in this.data ? this.data.tp : this.data.ind - 1);
        mask.renderFrame(true);
        // We draw the second buffer (that contains the content of this layer)
        this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);

        // If the mask is a Luma matte, we need to do two extra painting operations
        // the _isProxy check is to avoid drawing a fake canvas in workers that will throw an error
        if (this.data.tt >= 3 && !document._isProxy) {
          // We copy the painted mask to a buffer that has a color matrix filter applied to it
          // that applies the rgb values to the alpha channel
          var lumaBuffer = assetManager.getLumaCanvas(this.canvasContext.canvas);
          var lumaBufferCtx = lumaBuffer.getContext('2d');
          lumaBufferCtx.drawImage(this.canvasContext.canvas, 0, 0);
          this.clearCanvas(this.canvasContext);
          // we repaint the context with the mask applied to it
          this.canvasContext.drawImage(lumaBuffer, 0, 0);
        }
        this.canvasContext.globalCompositeOperation = operationsMap[this.data.tt];
      } else {
        this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);
      }
      // The layer opacity is applied here (not during child rendering) so that
      // overlapping shapes within the layer are treated as an isolated group,
      // matching SVG's group-opacity semantics.
      var prevAlpha = this.canvasContext.globalAlpha;
      this.canvasContext.globalAlpha = prevAlpha * this.finalTransform.localOpacity;
      this.canvasContext.drawImage(contentOfCurrentLayerCanvas, 0, 0);
      this.canvasContext.globalAlpha = prevAlpha;
      // We finally draw the first buffer (that contains the content of the global drawing)
      // We use destination-over to draw the global drawing below the current layer
      this.canvasContext.globalCompositeOperation = 'destination-over';
      this.canvasContext.drawImage(this.globalDrawingBufferCanvas, 0, 0);
      this.canvasContext.setTransform(this.currentTransform);
      // We reset the globalCompositeOperation to source-over, the standard type of operation
      this.canvasContext.globalCompositeOperation = 'source-over';

      this.globalData.renderConfig.bufferManager.release(this.globalDrawingBufferCanvas);
      this.globalData.renderConfig.bufferManager.release(contentOfCurrentLayerCanvas);
    }
  },
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
    this.prepareLayer();
    this.globalData.renderer.save(forceRealStack);
    this.globalData.renderer.ctxTransform(this.finalTransform.localMat.props);
    if (!this.isIsolated()) {
      this.globalData.renderer.ctxOpacity(this.finalTransform.localOpacity);
    }
    this.renderInnerContent();
    this.globalData.renderer.restore(forceRealStack);
    this.exitLayer();
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
    this.maskManager.destroy();
  },
  mHelper: new Matrix(),
};
CVBaseElement.prototype.hide = CVBaseElement.prototype.hideElement;
CVBaseElement.prototype.show = CVBaseElement.prototype.showElement;

export default CVBaseElement;
