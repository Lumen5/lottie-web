import {
  extendPrototype,
} from '../../utils/functionExtensions';
import {
  createSizedArray,
} from '../../utils/helpers/arrays';
import PropertyFactory from '../../utils/PropertyFactory';
import WebGLRendererBase from '../../renderers/WebGLRendererBase';
import WGLBaseElement from './WGLBaseElement';
import ICompElement from '../CompElement';

function WGLCompElement(data, globalData, comp) {
  this.completeLayers = false;
  this.layers = data.layers;
  this.pendingElements = [];
  this.elements = createSizedArray(this.layers.length);
  this.initElement(data, globalData, comp);
  this.tm = data.tm ? PropertyFactory.getProp(this, data.tm, 0, globalData.frameRate, this) : { _placeholder: true };
}

extendPrototype([WebGLRendererBase, ICompElement, WGLBaseElement], WGLCompElement);

WGLCompElement.prototype.renderInnerContent = function () {
  // Composition bounds clip would be implemented via gl.scissor; in MVP we
  // rely on the parent renderer's scissor against the outer composition.
  var i;
  var len = this.layers.length;
  for (i = len - 1; i >= 0; i -= 1) {
    if (this.completeLayers || this.elements[i]) {
      this.elements[i].renderFrame();
    }
  }
};

WGLCompElement.prototype.destroy = function () {
  var i;
  var len = this.layers.length;
  for (i = len - 1; i >= 0; i -= 1) {
    if (this.elements[i]) {
      this.elements[i].destroy();
    }
  }
  this.layers = null;
  this.elements = null;
};

WGLCompElement.prototype.createComp = function (data) {
  return new WGLCompElement(data, this.globalData, this);
};

export default WGLCompElement;
