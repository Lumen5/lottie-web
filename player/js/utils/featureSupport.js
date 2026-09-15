const featureSupport = (function () {
  var ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  var isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|Edge|OPR|Opera|Firefox|FxiOS/i.test(ua);
  var ob = {
    maskType: true,
    svgLumaHidden: true,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    // Safari (desktop and iOS) doesn't support `blur()` via Canvas2D `ctx.filter`.
    // When false, the canvas renderer falls back to a WebGL blur path
    // (provided that the consumer has supplied a WebGL context via renderConfig).
    canvasFilterBlur: !isSafari,
  };
  if (/MSIE 10/i.test(ua) || /MSIE 9/i.test(ua) || /rv:11.0/i.test(ua) || /Edge\/\d./i.test(ua)) {
    ob.maskType = false;
  }
  if (/firefox/i.test(ua)) {
    ob.svgLumaHidden = false;
  }
  return ob;
}());

export default featureSupport;
