const ExpressionRealm = (function () {
  'use strict';

  var FUNCTION_CONSTRUCTOR_SOURCES = [
    'return (function () {}).constructor',
    'return (async function () {}).constructor',
    'return (function* () {}).constructor',
    'return (async function* () {}).constructor',
  ];

  var FROZEN_INTRINSICS = [
    'Object',
    'Function',
    'Array',
    'String',
    'Number',
    'BigInt',
    'Boolean',
    'Symbol',
    'Math',
    'JSON',
    'Date',
    'RegExp',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Proxy',
    'Reflect',
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
  ];

  var resolved = false;
  var realmFunction = null;

  function collectFunctionConstructors(compile) {
    var constructors = [];
    var i;
    for (i = 0; i < FUNCTION_CONSTRUCTOR_SOURCES.length; i += 1) {
      try {
        constructors.push(compile(FUNCTION_CONSTRUCTOR_SOURCES[i])());
      } catch (error) {
        // this kind of function is not supported by the runtime
      }
    }
    return constructors;
  }

  function neuterFunctionConstructors(constructors) {
    var i;
    for (i = 0; i < constructors.length; i += 1) {
      try {
        Object.defineProperty(constructors[i].prototype, 'constructor', {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } catch (error) {
        // already locked down
      }
    }
  }

  function freezeIntrinsics(realmWindow) {
    var i;
    var intrinsic;
    for (i = 0; i < FROZEN_INTRINSICS.length; i += 1) {
      try {
        intrinsic = realmWindow[FROZEN_INTRINSICS[i]];
        if (intrinsic) {
          Object.freeze(intrinsic);
          if (intrinsic.prototype) {
            Object.freeze(intrinsic.prototype);
          }
        }
      } catch (error) {
        // not available in this runtime
      }
    }
  }

  function removeGlobals(realmWindow) {
    var names = Object.getOwnPropertyNames(realmWindow);
    var i;
    for (i = 0; i < names.length; i += 1) {
      try {
        delete realmWindow[names[i]]; // eslint-disable-line no-param-reassign
      } catch (error) {
        // unforgeable properties stay, expressions shadow them by name
      }
    }
  }

  function isUsable(compile) {
    try {
      return compile('a', 'b', 'return a + b')(1, 2) === 3;
    } catch (error) {
      return false;
    }
  }

  function create() {
    if (typeof document === 'undefined' || !document.createElement || !document.documentElement) {
      return null;
    }
    var frame = null;
    var compile = null;
    try {
      frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(frame);
      var realmWindow = frame.contentWindow;
      if (realmWindow && typeof realmWindow.Function === 'function') {
        compile = realmWindow.Function;
        neuterFunctionConstructors(collectFunctionConstructors(compile));
        freezeIntrinsics(realmWindow);
        removeGlobals(realmWindow);
      }
    } catch (error) {
      compile = null;
    } finally {
      if (frame && frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    }
    return compile && isUsable(compile) ? compile : null;
  }

  function getCompiler() {
    if (!resolved) {
      resolved = true;
      realmFunction = create();
    }
    return realmFunction || Function;
  }

  return {
    getCompiler: getCompiler,
  };
}());

export default ExpressionRealm;
