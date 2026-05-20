// MVP: effects pipeline for the WebGL renderer is a no-op. Layered effects
// (blur, drop shadow, etc.) need shader implementations and FBO ping-pong;
// they will be added later. We expose the same interface as CVEffects so that
// shared element code that calls effectsManager.getEffects() / renderFrame()
// keeps working unmodified.

var registeredEffects = {};

function WGLEffects(elem) {
  var i;
  var len = elem.data.ef ? elem.data.ef.length : 0;
  this.filters = [];
  this.globalData = elem.globalData;
  for (i = 0; i < len; i += 1) {
    var type = elem.data.ef[i].ty;
    if (registeredEffects[type]) {
      var Effect = registeredEffects[type].effect;
      var filterManager = new Effect(elem.effectsManager.effectElements[i], elem);
      this.filters.push(filterManager);
    }
  }
  if (this.filters.length) {
    elem.addRenderableComponent(this);
  }
}

WGLEffects.prototype.renderFrame = function (_isFirstFrame) {
  var i;
  var len = this.filters.length;
  for (i = 0; i < len; i += 1) {
    this.filters[i].renderFrame(_isFirstFrame);
  }
};

WGLEffects.prototype.getEffects = function (type) {
  var effects = [];
  var i;
  var len = this.filters.length;
  for (i = 0; i < len; i += 1) {
    if (this.filters[i].type === type) {
      effects.push(this.filters[i]);
    }
  }
  return effects;
};

export function registerEffect(id, effect) {
  registeredEffects[id] = { effect: effect };
}

export default WGLEffects;
