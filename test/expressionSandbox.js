/**
 * Checks that expressions can only use the animation API exposed through the
 * scope, and that everything else (globals, host APIs, prototype escapes,
 * player internals) is unreachable.
 *
 * There is no separate realm in node, so the sandbox is checked here on top of
 * the plain Function constructor. The isolated realm is covered by
 * test/expressionSandboxBrowser.js.
 *
 * Run with: npm run test:sandbox
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sandboxPath = path.join(__dirname, '../player/js/utils/expressions/ExpressionSandbox.js');
const sandboxSource = fs.readFileSync(sandboxPath, 'utf8')
  .replace(
    "import ExpressionRealm from './ExpressionRealm';",
    'var ExpressionRealm = { getCompiler: function () { return Function; } };'
  )
  .replace(/export default ExpressionSandbox;/, 'return ExpressionSandbox;');
const ExpressionSandbox = new Function(sandboxSource)(); // eslint-disable-line no-new-func

const SCOPE_NAMES = [
  '$bm_div', '$bm_isInstanceOfArray', '$bm_mod', '$bm_mul', '$bm_neg', '$bm_sub', '$bm_sum',
  '$bm_transform', 'Array', 'Boolean', 'Date', 'Infinity', 'JSON', 'Math', 'NaN', 'Number',
  'RegExp', 'String', '_lottieGlobal', 'active', 'add', 'anchorPoint', 'clamp', 'comp', 'content',
  'createPath', 'degreesToRadians', 'degrees_to_radians', 'div', 'ease', 'easeIn', 'easeOut',
  'effect', 'framesToTime', 'fromComp', 'fromCompToSurface', 'fromWorld', 'hasParent', 'height',
  'hslToRgb', 'inPoint', 'index', 'isFinite', 'isNaN', 'key', 'length', 'linear', 'lookAt',
  'loopIn', 'loopInDuration', 'loopOut', 'loopOutDuration', 'loop_in', 'loop_out', 'mask', 'mod',
  'mul', 'name', 'nearestKey', 'normalize', 'numKeys', 'outPoint', 'parent', 'parseFloat',
  'parseInt', 'position', 'radiansToDegrees', 'radians_to_degrees', 'random', 'rgbToHsl',
  'rotation', 'scale', 'seedRandom', 'selectorValue', 'smooth', 'sourceRectAtTime', 'sub',
  'substr', 'substring', 'sum', 'text', 'textIndex', 'textTotal', 'thisComp', 'thisLayer',
  'thisProperty', 'time', 'timeToFrames', 'toComp', 'toWorld', 'transform', 'value', 'valueAtTime',
  'velocity', 'velocityAtTime', 'width', 'wiggle',
];

function createScope() {
  const scope = {};
  SCOPE_NAMES.forEach((name) => { scope[name] = undefined; });
  scope.Math = ExpressionSandbox.readOnly(Math);
  scope.Array = ExpressionSandbox.readOnly(Array);
  scope.Number = ExpressionSandbox.readOnly(Number);
  scope.String = ExpressionSandbox.readOnly(String);
  scope.JSON = ExpressionSandbox.readOnly(JSON);
  scope.parseInt = parseInt;
  scope.parseFloat = parseFloat;
  scope.time = 2;
  scope.value = 5;
  scope.valueAtTime = (t) => t;
  scope.clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  scope.sum = (a, b) => a + b;
  scope.div = (a, b) => a / b;
  scope.thisLayer = { _elem: { globalData: { defs: {} } }, index: 3 };
  return scope;
}

function run(source) {
  const scope = createScope();
  return ExpressionSandbox.compileExpression(source, scope)(scope);
}

const allowed = [
  ['returns a value', 'var $bm_rt;\n$bm_rt = clamp(value, 0, 100);', 5],
  ['multiple declarators', 'var $bm_rt;\nvar a = 2, b = 3;\n$bm_rt = a + b;', 5],
  ['loops', 'var $bm_rt;\nvar t = 0;\nfor (var i = 0; i < 3; i++) { t += i; }\n$bm_rt = t;', 3],
  ['try catch', 'var $bm_rt;\ntry { $bm_rt = value; } catch (e$$1) { $bm_rt = 0; }', 5],
  ['indexed access', 'var $bm_rt;\nvar arr = [1, 2, 2];\n$bm_rt = arr[0] + arr[arr.length - 1] + arr[1];', 5],
  ['block scoped declarations', 'var $bm_rt;\nlet a = 2;\nconst b = 3;\n$bm_rt = a + b;', 5],
  ['function declarations', 'var $bm_rt;\nfunction add2(x) { return x + 2; }\n$bm_rt = add2(3);', 5],
  ['function expressions', 'var $bm_rt;\n$bm_rt = [1, 4].map(function (x) { return x; }).reduce(function (a, b) { return a + b; }, 0);', 5],
  ['regular expressions', "var $bm_rt;\n$bm_rt = /a.c/.test('abc') ? 5 : 0;", 5],
  ['division after postfix', 'var $bm_rt;\nvar a = 9;\na++;\n$bm_rt = a / 2;', 5],
  ['object literals', 'var $bm_rt;\nvar o = { time: 1, value: 4 };\n$bm_rt = o.time + o.value;', 5],
  ['assignment without declaration', 'var $bm_rt;\nlocalValue = 5;\n$bm_rt = localValue;', 5],
  ['posterize time', 'var $bm_rt;\nposterizeTime(1);\n$bm_rt = 5;', 5],
  ['comments are inert', 'var $bm_rt;\n// [].constructor\n/* .constructor */\n$bm_rt = 5;', 5],
  ['animation api', 'var $bm_rt;\n$bm_rt = thisLayer.index + 2;', 5],
  ['read only intrinsics stay usable', 'var $bm_rt;\n$bm_rt = Math.floor(Math.PI) + Number("1") + new Array(1).length;', 5],
  ['constructing through intrinsics', "var $bm_rt;\n$bm_rt = JSON.parse('[1,4]')[0] + new Array(4).length;", 5],
];

const blocked = [
  ['prototype escape', "var $bm_rt;\n$bm_rt = [].constructor.constructor('return this')();"],
  ['prototype escape by key', "var $bm_rt;\n$bm_rt = []['constructor']['constructor']('return this')();"],
  ['prototype escape by computed key', "var $bm_rt;\nvar k = 'constr' + 'uctor';\n$bm_rt = [][k][k]('return this')();"],
  ['prototype escape from object literal', "var $bm_rt;\n$bm_rt = {}['constructor']['constructor']('return this')();"],
  ['prototype escape from boolean', "var $bm_rt;\n$bm_rt = true['constructor']['constructor']('return this')();"],
  ['prototype escape from function', "var $bm_rt;\nfunction f() {}\n$bm_rt = f['constructor']('return this')();"],
  ['prototype access', 'var $bm_rt;\n$bm_rt = Array.prototype;'],
  ['proto access', 'var $bm_rt;\n$bm_rt = [].__proto__;'],
  ['proto pollution', "var $bm_rt;\nvar o = {};\no['__proto__']['polluted'] = true;\n$bm_rt = 1;"],
  ['window', 'var $bm_rt;\n$bm_rt = window.document;'],
  ['globalThis', 'var $bm_rt;\n$bm_rt = globalThis.process;'],
  ['fetch', "var $bm_rt;\n$bm_rt = fetch('//example.com');"],
  ['XMLHttpRequest', 'var $bm_rt;\n$bm_rt = new XMLHttpRequest();'],
  ['timers', 'var $bm_rt;\n$bm_rt = setTimeout(function () {}, 0);'],
  ['eval', "var $bm_rt;\n$bm_rt = eval('this');"],
  ['indirect eval', "var $bm_rt;\nvar e = (0, eval);\n$bm_rt = e('this');"],
  ['Function', "var $bm_rt;\n$bm_rt = new Function('return this')();"],
  ['dynamic import', "var $bm_rt;\n$bm_rt = import('data:text/javascript,1');"],
  ['with statement', 'var $bm_rt;\nwith (Math) { $bm_rt = PI; }'],
  ['arguments', 'var $bm_rt;\nfunction f() { return arguments.callee.caller; }\n$bm_rt = f();'],
  ['template literals', 'var $bm_rt;\n$bm_rt = `${[].constructor}`;'],
  ['player element', 'var $bm_rt;\n$bm_rt = thisLayer._elem.globalData;'],
  ['player element by key', "var $bm_rt;\n$bm_rt = thisLayer['_elem']['globalData'];"],
  ['sandbox internals', 'var $bm_rt;\n$bm_rt = $sbx_scope;'],
  ['non ascii identifiers', 'var $bm_rt;\nvar ω = [];\n$bm_rt = ω["constructor"];'],
  ['mislexed division', 'var $bm_rt;\n$bm_rt = 1 / [].constructor / 1;'],
  ['arrow function constructor', "var $bm_rt;\nvar F = (() => {}).constructor;\n$bm_rt = new F('return this')();"],
  ['async function constructor', "var $bm_rt;\nvar F = (async function () {})['constructor'];\n$bm_rt = new F('return this')();"],
  ['generator function constructor', "var $bm_rt;\nvar F = (function* () {})['constructor'];\n$bm_rt = new F('return this')();"],
  ['async generator constructor', "var $bm_rt;\nvar F = (async function* () {})['constructor'];\n$bm_rt = new F('return this')();"],
  ['constructor of a passed animation object', "var $bm_rt;\n$bm_rt = thisLayer['constructor']('return this')();"],
  ['implicit global through sloppy this', 'var $bm_rt;\nfunction getGlobal() { return this; }\n$bm_rt = getGlobal();'],
  ['writing to a shared intrinsic', 'var $bm_rt;\nArray.isArray = function () { return true; };\n$bm_rt = 1;'],
  ['writing to Math', 'var $bm_rt;\nMath.floor = function () { return 0; };\n$bm_rt = 1;'],
  ['deleting from a shared intrinsic', 'var $bm_rt;\ndelete Math.floor;\n$bm_rt = 1;'],
  ['replacing an intrinsic prototype', 'var $bm_rt;\nMath.__proto__ = null;\n$bm_rt = 1;'],
];

function collectExpressions(directory) {
  const found = new Set();
  const visit = (item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item.x === 'string') {
      found.add(item.x);
    }
    Object.keys(item).forEach((keyName) => visit(item[keyName]));
  };
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectExpressions(full).forEach((expression) => found.add(expression));
    } else if (entry.name.endsWith('.json')) {
      try {
        visit(JSON.parse(fs.readFileSync(full, 'utf8')));
      } catch (error) {
        // not an animation file
      }
    }
  });
  return found;
}

let failures = 0;

function check(description, assertion) {
  try {
    assertion();
    console.log('ok    ' + description); // eslint-disable-line no-console
  } catch (error) {
    failures += 1;
    console.log('FAIL  ' + description + ' -> ' + error.message); // eslint-disable-line no-console
  }
}

allowed.forEach((testCase) => {
  check('allows ' + testCase[0], () => {
    assert.strictEqual(run(testCase[1]), testCase[2]);
  });
});

blocked.forEach((testCase) => {
  check('blocks ' + testCase[0], () => {
    let result;
    try {
      result = run(testCase[1]);
    } catch (error) {
      return;
    }
    assert.ok(result === undefined || result === null, 'expression returned ' + String(result));
  });
});

check('shared intrinsics stay intact after the attacks', () => {
  assert.strictEqual(Array.isArray([]), true);
  assert.strictEqual(Math.floor(1.7), 1);
});

collectExpressions(path.join(__dirname, 'animations')).forEach((expression) => {
  check('compiles bundled expression: ' + expression.split('\n')[1], () => {
    ExpressionSandbox.compileExpression(expression, createScope());
  });
});

if (failures) {
  console.log(failures + ' failed'); // eslint-disable-line no-console
  process.exit(1);
}
console.log('expression sandbox: all checks passed'); // eslint-disable-line no-console
