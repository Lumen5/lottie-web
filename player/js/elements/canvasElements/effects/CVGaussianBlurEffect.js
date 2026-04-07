function CVGaussianBlurEffect(effectElements, elem) {
  this.filterManager = effectElements;
  this.globalData = elem.globalData;
  this.filterString = '';
}

CVGaussianBlurEffect.prototype.renderFrame = function () {
  // Empirical value, matching AE's blur appearance.
  var kBlurrinessToSigma = 0.3;
  var canvasScale = this.globalData.transformCanvas.sx;
  var sigma = this.filterManager.effectElements[0].p.v * kBlurrinessToSigma * canvasScale;

  // Dimensions mapping:
  //
  //   1 -> horizontal & vertical
  //   2 -> horizontal only
  //   3 -> vertical only
  //
  // The Canvas API doesn't support separate X/Y blur like SVG,
  // so we use the maximum sigma.
  var dimensions = this.filterManager.effectElements[1].p.v;
  var sigmaX = (dimensions == 3) ? 0 : sigma; // eslint-disable-line eqeqeq
  var sigmaY = (dimensions == 2) ? 0 : sigma; // eslint-disable-line eqeqeq
  var maxSigma = Math.max(sigmaX, sigmaY);

  this.filterString = maxSigma > 0 ? 'blur(' + maxSigma + 'px)' : '';
};

export default CVGaussianBlurEffect;
