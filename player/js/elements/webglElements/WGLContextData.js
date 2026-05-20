import {
  createTypedArray,
} from '../../utils/helpers/arrays';
import Matrix from '../../3rd_party/transformation-matrix';

// State stack for the WebGL renderer.  Mirrors CVContextData but communicates
// with a WebGLContext2D adapter (which routes draw commands to real WebGL
// programs) rather than a 2D canvas context.

function WebGLState() {
  this.opacity = -1;
  this.transform = createTypedArray('float32', 16);
  this.fillStyle = '';
  this.strokeStyle = '';
  this.lineWidth = '';
  this.lineCap = '';
  this.lineJoin = '';
  this.miterLimit = '';
  this.id = Math.random();
}

function WGLContextData() {
  this.stack = [];
  this.cArrPos = 0;
  this.cTr = new Matrix();
  var i;
  var len = 15;
  for (i = 0; i < len; i += 1) {
    this.stack[i] = new WebGLState();
  }
  this._length = len;
  this.nativeContext = null;
  this.transformMat = new Matrix();
  this.currentOpacity = 1;
  this.currentFillStyle = '';
  this.appliedFillStyle = '';
  this.currentStrokeStyle = '';
  this.appliedStrokeStyle = '';
  this.currentLineWidth = '';
  this.appliedLineWidth = '';
  this.currentLineCap = '';
  this.appliedLineCap = '';
  this.currentLineJoin = '';
  this.appliedLineJoin = '';
  this.appliedMiterLimit = '';
  this.currentMiterLimit = '';
}

WGLContextData.prototype.duplicate = function () {
  var newLength = this._length * 2;
  var i = 0;
  for (i = this._length; i < newLength; i += 1) {
    this.stack[i] = new WebGLState();
  }
  this._length = newLength;
};

WGLContextData.prototype.reset = function () {
  this.cArrPos = 0;
  this.cTr.reset();
  this.stack[this.cArrPos].opacity = 1;
};

WGLContextData.prototype.restore = function (forceRestore) {
  this.cArrPos -= 1;
  var current = this.stack[this.cArrPos];
  var transform = current.transform;
  var i;
  var arr = this.cTr.props;
  for (i = 0; i < 16; i += 1) {
    arr[i] = transform[i];
  }
  if (forceRestore) {
    this.nativeContext.restore();
    var prev = this.stack[this.cArrPos + 1];
    this.appliedFillStyle = prev.fillStyle;
    this.appliedStrokeStyle = prev.strokeStyle;
    this.appliedLineWidth = prev.lineWidth;
    this.appliedLineCap = prev.lineCap;
    this.appliedLineJoin = prev.lineJoin;
    this.appliedMiterLimit = prev.miterLimit;
  }
  this.nativeContext.setTransform(transform[0], transform[1], transform[4], transform[5], transform[12], transform[13]);
  if (forceRestore || (current.opacity !== -1 && this.currentOpacity !== current.opacity)) {
    this.nativeContext.globalAlpha = current.opacity;
    this.currentOpacity = current.opacity;
  }
  this.currentFillStyle = current.fillStyle;
  this.currentStrokeStyle = current.strokeStyle;
  this.currentLineWidth = current.lineWidth;
  this.currentLineCap = current.lineCap;
  this.currentLineJoin = current.lineJoin;
  this.currentMiterLimit = current.miterLimit;
};

WGLContextData.prototype.save = function (saveOnNativeFlag) {
  if (saveOnNativeFlag) {
    this.nativeContext.save();
  }
  var props = this.cTr.props;
  if (this._length <= this.cArrPos) {
    this.duplicate();
  }
  var current = this.stack[this.cArrPos];
  var i;
  for (i = 0; i < 16; i += 1) {
    current.transform[i] = props[i];
  }
  this.cArrPos += 1;
  var next = this.stack[this.cArrPos];
  next.opacity = current.opacity;
  next.fillStyle = current.fillStyle;
  next.strokeStyle = current.strokeStyle;
  next.lineWidth = current.lineWidth;
  next.lineCap = current.lineCap;
  next.lineJoin = current.lineJoin;
  next.miterLimit = current.miterLimit;
};

WGLContextData.prototype.setOpacity = function (value) {
  this.stack[this.cArrPos].opacity = value;
};

WGLContextData.prototype.setContext = function (value) {
  this.nativeContext = value;
};

WGLContextData.prototype.fillStyle = function (value) {
  if (this.stack[this.cArrPos].fillStyle !== value) {
    this.currentFillStyle = value;
    this.stack[this.cArrPos].fillStyle = value;
  }
};

WGLContextData.prototype.strokeStyle = function (value) {
  if (this.stack[this.cArrPos].strokeStyle !== value) {
    this.currentStrokeStyle = value;
    this.stack[this.cArrPos].strokeStyle = value;
  }
};

WGLContextData.prototype.lineWidth = function (value) {
  if (this.stack[this.cArrPos].lineWidth !== value) {
    this.currentLineWidth = value;
    this.stack[this.cArrPos].lineWidth = value;
  }
};

WGLContextData.prototype.lineCap = function (value) {
  if (this.stack[this.cArrPos].lineCap !== value) {
    this.currentLineCap = value;
    this.stack[this.cArrPos].lineCap = value;
  }
};

WGLContextData.prototype.lineJoin = function (value) {
  if (this.stack[this.cArrPos].lineJoin !== value) {
    this.currentLineJoin = value;
    this.stack[this.cArrPos].lineJoin = value;
  }
};

WGLContextData.prototype.miterLimit = function (value) {
  if (this.stack[this.cArrPos].miterLimit !== value) {
    this.currentMiterLimit = value;
    this.stack[this.cArrPos].miterLimit = value;
  }
};

WGLContextData.prototype.transform = function (props) {
  this.transformMat.cloneFromProps(props);
  var currentTransform = this.cTr;
  this.transformMat.multiply(currentTransform);
  currentTransform.cloneFromProps(this.transformMat.props);
  var trProps = currentTransform.props;
  this.nativeContext.setTransform(trProps[0], trProps[1], trProps[4], trProps[5], trProps[12], trProps[13]);
};

WGLContextData.prototype.opacity = function (op) {
  var currentOpacity = this.stack[this.cArrPos].opacity;
  currentOpacity *= op < 0 ? 0 : op;
  if (this.stack[this.cArrPos].opacity !== currentOpacity) {
    if (this.currentOpacity !== op) {
      this.nativeContext.globalAlpha = op;
      this.currentOpacity = op;
    }
    this.stack[this.cArrPos].opacity = currentOpacity;
  }
};

WGLContextData.prototype.fill = function (rule) {
  if (this.appliedFillStyle !== this.currentFillStyle) {
    this.appliedFillStyle = this.currentFillStyle;
    this.nativeContext.fillStyle = this.appliedFillStyle;
  }
  this.nativeContext.fill(rule);
};

WGLContextData.prototype.fillRect = function (x, y, w, h) {
  if (this.appliedFillStyle !== this.currentFillStyle) {
    this.appliedFillStyle = this.currentFillStyle;
    this.nativeContext.fillStyle = this.appliedFillStyle;
  }
  this.nativeContext.fillRect(x, y, w, h);
};

WGLContextData.prototype.stroke = function () {
  if (this.appliedStrokeStyle !== this.currentStrokeStyle) {
    this.appliedStrokeStyle = this.currentStrokeStyle;
    this.nativeContext.strokeStyle = this.appliedStrokeStyle;
  }
  if (this.appliedLineWidth !== this.currentLineWidth) {
    this.appliedLineWidth = this.currentLineWidth;
    this.nativeContext.lineWidth = this.appliedLineWidth;
  }
  if (this.appliedLineCap !== this.currentLineCap) {
    this.appliedLineCap = this.currentLineCap;
    this.nativeContext.lineCap = this.appliedLineCap;
  }
  if (this.appliedLineJoin !== this.currentLineJoin) {
    this.appliedLineJoin = this.currentLineJoin;
    this.nativeContext.lineJoin = this.appliedLineJoin;
  }
  if (this.appliedMiterLimit !== this.currentMiterLimit) {
    this.appliedMiterLimit = this.currentMiterLimit;
    this.nativeContext.miterLimit = this.appliedMiterLimit;
  }
  this.nativeContext.stroke();
};

export default WGLContextData;
