import {
  extendPrototype,
} from '../utils/functionExtensions';
import Matrix from '../3rd_party/transformation-matrix';
import WebGLRendererBase from './WebGLRendererBase';
import WGLContextData from '../elements/webglElements/WGLContextData';
import WGLCompElement from '../elements/webglElements/WGLCompElement';
import bufferManager from '../utils/helpers/bufferManager';

function WebGLRenderer(animationItem, config) {
  this.animationItem = animationItem;
  this.renderConfig = {
    clearCanvas: (config && config.clearCanvas !== undefined) ? config.clearCanvas : true,
    context: (config && config.context) || null,
    progressiveLoad: (config && config.progressiveLoad) || false,
    preserveAspectRatio: (config && config.preserveAspectRatio) || 'xMidYMid meet',
    imagePreserveAspectRatio: (config && config.imagePreserveAspectRatio) || 'xMidYMid slice',
    contentVisibility: (config && config.contentVisibility) || 'visible',
    className: (config && config.className) || '',
    id: (config && config.id) || '',
    bufferManager: bufferManager,
    runExpressions: !config || config.runExpressions === undefined || config.runExpressions,
  };
  this.renderConfig.dpr = (config && config.dpr) || 1;
  if (this.animationItem.wrapper) {
    this.renderConfig.dpr = (config && config.dpr) || window.devicePixelRatio || 1;
  }
  this.renderedFrame = -1;
  this.globalData = {
    frameNum: -1,
    _mdf: false,
    renderConfig: this.renderConfig,
    currentGlobalAlpha: -1,
  };
  this.contextData = new WGLContextData();
  this.elements = [];
  this.pendingElements = [];
  this.transformMat = new Matrix();
  this.completeLayers = false;
  this.rendererType = 'webgl';
  if (this.renderConfig.clearCanvas) {
    this.ctxTransform = this.contextData.transform.bind(this.contextData);
    this.ctxOpacity = this.contextData.opacity.bind(this.contextData);
    this.ctxFillStyle = this.contextData.fillStyle.bind(this.contextData);
    this.ctxStrokeStyle = this.contextData.strokeStyle.bind(this.contextData);
    this.ctxLineWidth = this.contextData.lineWidth.bind(this.contextData);
    this.ctxLineCap = this.contextData.lineCap.bind(this.contextData);
    this.ctxLineJoin = this.contextData.lineJoin.bind(this.contextData);
    this.ctxMiterLimit = this.contextData.miterLimit.bind(this.contextData);
    this.ctxFill = this.contextData.fill.bind(this.contextData);
    this.ctxFillRect = this.contextData.fillRect.bind(this.contextData);
    this.ctxStroke = this.contextData.stroke.bind(this.contextData);
    this.save = this.contextData.save.bind(this.contextData);
  }
  this.animationItem.addEventListener('error', function (event) {
    if (event.type === 'renderFrameError') {
      this.renderConfig.bufferManager.releaseAll();
    }
  }.bind(this));
}
extendPrototype([WebGLRendererBase], WebGLRenderer);

WebGLRenderer.prototype.createComp = function (data) {
  return new WGLCompElement(data, this.globalData, this);
};

export default WebGLRenderer;
