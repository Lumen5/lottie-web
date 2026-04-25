import {
  extendPrototype,
} from '../../utils/functionExtensions';
import RenderableElement from '../helpers/RenderableElement';
import BaseElement from '../BaseElement';
import TransformElement from '../helpers/TransformElement';
import HierarchyElement from '../helpers/HierarchyElement';
import FrameElement from '../helpers/FrameElement';
import WGLBaseElement from './WGLBaseElement';
import IImageElement from '../ImageElement';
import SVGShapeElement from '../svgElements/SVGShapeElement';

function WGLSolidElement(data, globalData, comp) {
  this.initElement(data, globalData, comp);
}
extendPrototype([BaseElement, TransformElement, WGLBaseElement, HierarchyElement, FrameElement, RenderableElement], WGLSolidElement);

WGLSolidElement.prototype.initElement = SVGShapeElement.prototype.initElement;
WGLSolidElement.prototype.prepareFrame = IImageElement.prototype.prepareFrame;

WGLSolidElement.prototype.renderInnerContent = function () {
  this.globalData.renderer.ctxFillStyle(this.data.sc);
  this.globalData.renderer.ctxFillRect(0, 0, this.data.sw, this.data.sh);
};

export default WGLSolidElement;
