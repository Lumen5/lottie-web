import {
  extendPrototype,
} from '../../utils/functionExtensions';
import RenderableElement from '../helpers/RenderableElement';
import BaseElement from '../BaseElement';
import TransformElement from '../helpers/TransformElement';
import HierarchyElement from '../helpers/HierarchyElement';
import FrameElement from '../helpers/FrameElement';
import ITextElement from '../TextElement';
import WGLBaseElement from './WGLBaseElement';

// MVP: text rendering is not yet implemented in the WebGL renderer.
// Proper glyph rasterization needs an SDF/atlas font pipeline; the layer
// renders nothing for now.

function WGLTextElement(data, globalData, comp) {
  this.textSpans = [];
  this.values = {
    fill: 'rgba(0,0,0,0)',
    stroke: 'rgba(0,0,0,0)',
    sWidth: 0,
    fValue: '',
  };
  this.initElement(data, globalData, comp);
}
extendPrototype([BaseElement, TransformElement, WGLBaseElement, HierarchyElement, FrameElement, RenderableElement, ITextElement], WGLTextElement);

WGLTextElement.prototype.buildNewText = function () {};
WGLTextElement.prototype.createContent = function () {};
WGLTextElement.prototype.renderInnerContent = function () {};

export default WGLTextElement;
