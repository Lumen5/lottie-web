// MVP: masks are not yet implemented in the WebGL renderer. They require
// stencil-buffer / FBO support to clip layer rendering correctly.  We expose
// the CVMaskElement interface so that WGLBaseElement can call it without
// special-casing — but hasMasks is always false, so renderFrame is a no-op.

function WGLMaskElement(data, element) {
  this.data = data;
  this.element = element;
  this.hasMasks = false;
}

WGLMaskElement.prototype.renderFrame = function () {};

WGLMaskElement.prototype.getMaskProperty = function () { return null; };

WGLMaskElement.prototype.destroy = function () {
  this.element = null;
};

export default WGLMaskElement;
