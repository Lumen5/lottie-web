import {
  createSizedArray,
} from '../../utils/helpers/arrays';

import ShapePropertyFactory from '../../utils/shapes/ShapeProperty';
import MaskElement from '../../mask';

function CVMaskElement(data, element) {
  this.data = data;
  this.element = element;
  this.masksProperties = this.data.masksProperties || [];
  this.viewData = createSizedArray(this.masksProperties.length);
  var i;
  var len = this.masksProperties.length;
  var hasMasks = false;
  for (i = 0; i < len; i += 1) {
    if (this.masksProperties[i].mode !== 'n') {
      hasMasks = true;
    }
    this.viewData[i] = ShapePropertyFactory.getShapeProp(this.element, this.masksProperties[i], 3);
  }
  this.hasMasks = hasMasks;
  if (hasMasks) {
    this.element.addRenderableComponent(this);
  }
}

CVMaskElement.prototype.renderFrame = function () {
  if (!this.hasMasks) {
    return;
  }
  var transform = this.element.finalTransform.mat;
  var ctx = this.element.canvasContext;
  var i;
  var len = this.masksProperties.length;
  var pt;
  var pts;
  var data;
  var hasInvertedMask = false;
  ctx.beginPath();
  for (i = 0; i < len; i += 1) {
    var mask = this.masksProperties[i];
    if (mask.mode !== 'n') {
      // 's' (subtract) carves the path out of the layer; the per-mask 'inv'
      // flag inverts that. Two flips cancel, so XOR them.
      var inverted = (mask.mode === 's') !== !!mask.inv;
      if (inverted) {
        hasInvertedMask = true;
        ctx.moveTo(0, 0);
        ctx.lineTo(this.element.globalData.compSize.w, 0);
        ctx.lineTo(this.element.globalData.compSize.w, this.element.globalData.compSize.h);
        ctx.lineTo(0, this.element.globalData.compSize.h);
        ctx.lineTo(0, 0);
      }
      data = this.viewData[i].v;
      pt = transform.applyToPointArray(data.v[0][0], data.v[0][1], 0);
      ctx.moveTo(pt[0], pt[1]);
      var j;
      var jLen = data._length;
      for (j = 1; j < jLen; j += 1) {
        pts = transform.applyToTriplePoints(data.o[j - 1], data.i[j], data.v[j]);
        ctx.bezierCurveTo(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]);
      }
      pts = transform.applyToTriplePoints(data.o[j - 1], data.i[0], data.v[0]);
      ctx.bezierCurveTo(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]);
    }
  }
  this.element.globalData.renderer.save(true);
  // Use even-odd so the outer rect and the path cancel inside the path,
  // independent of the mask path's winding direction.
  ctx.clip(hasInvertedMask ? 'evenodd' : 'nonzero');
};

CVMaskElement.prototype.getMaskProperty = MaskElement.prototype.getMaskProperty;

CVMaskElement.prototype.destroy = function () {
  this.element = null;
};

export default CVMaskElement;
