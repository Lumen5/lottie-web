// Gaussian blur effect (Lottie effect type 29).
//
// Mirrors CVGaussianBlurEffect but emits state for the WebGL pipeline rather
// than a CSS filter string.  The element's _blurSigmaX / _blurSigmaY fields
// are read by WGLBaseElement.renderFrame, which forwards them to
// canvasContext.endLayer() to drive the separable Gaussian blur shader.
//
// Lottie blur dimensions (effect param index 1):
//   1 — horizontal & vertical
//   2 — horizontal only
//   3 — vertical only
//
// The 0.3 multiplier matches AE's "blurriness" → sigma mapping used by the
// canvas renderer.

function WGLGaussianBlurEffect(effectElements, elem) {
  this.filterManager = effectElements;
  this.element = elem;
  this.globalData = elem.globalData;
}

WGLGaussianBlurEffect.prototype.renderFrame = function () {
  var kBlurrinessToSigma = 0.3;
  var canvasScale = this.globalData.transformCanvas.sx;
  var sigma = this.filterManager.effectElements[0].p.v * kBlurrinessToSigma * canvasScale;
  var dimensions = this.filterManager.effectElements[1].p.v;
  this.element._blurSigmaX = (dimensions == 3) ? 0 : sigma; // eslint-disable-line eqeqeq
  this.element._blurSigmaY = (dimensions == 2) ? 0 : sigma; // eslint-disable-line eqeqeq
};

export default WGLGaussianBlurEffect;
