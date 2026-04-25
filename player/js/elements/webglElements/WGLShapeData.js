import ShapePropertyFactory from '../../utils/shapes/ShapeProperty';
import SVGShapeData from '../helpers/shapes/SVGShapeData';

// Per-shape view data for the WebGL renderer.  Identical in shape to
// CVShapeData, kept as a parallel file so the WebGL renderer does not import
// from canvasElements/.

function WGLShapeData(element, data, styles, transformsManager) {
  this.styledShapes = [];
  this.tr = [0, 0, 0, 0, 0, 0];
  var ty = 4;
  if (data.ty === 'rc') {
    ty = 5;
  } else if (data.ty === 'el') {
    ty = 6;
  } else if (data.ty === 'sr') {
    ty = 7;
  }
  this.sh = ShapePropertyFactory.getShapeProp(element, data, ty, element);
  var i;
  var len = styles.length;
  var styledShape;
  for (i = 0; i < len; i += 1) {
    if (!styles[i].closed) {
      styledShape = {
        transforms: transformsManager.addTransformSequence(styles[i].transforms),
        trNodes: [],
      };
      this.styledShapes.push(styledShape);
      styles[i].elements.push(styledShape);
    }
  }
}

WGLShapeData.prototype.setAsAnimated = SVGShapeData.prototype.setAsAnimated;

export default WGLShapeData;
