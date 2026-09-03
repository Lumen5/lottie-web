const ExpressionSandbox = (function () {
  'use strict';

  var SCOPE_ARG = '$sbx_scope';
  var KEY_ARG = '$sbx_key';
  var INTERNAL_PREFIX = '$sbx_';
  var RESULT_NAME = '$bm_rt';

  function buildLookup(names) {
    var map = {};
    var i;
    for (i = 0; i < names.length; i += 1) {
      map[names[i]] = true;
    }
    return map;
  }

  function contains(map, name) {
    return Object.prototype.hasOwnProperty.call(map, name);
  }

  var DENIED_PROPERTIES = buildLookup([
    'constructor',
    'prototype',
    'caller',
    'callee',
    'arguments',
    'bind',
    'call',
    'apply',
    'elem',
    'comp',
    'globalData',
    'renderer',
    'animationItem',
    'renderConfig',
    'imageLoader',
    'audioController',
    'fontManager',
    'container',
    'wrapper',
    'canvasContext',
    'defs',
    'svgElement',
    'layerElement',
    'baseElement',
    'layerInterface',
    'compInterface',
    'projectInterface',
    'compositions',
    'ownerDocument',
    'ownerSVGElement',
    'defaultView',
    'contentWindow',
    'contentDocument',
    'parentNode',
    'parentElement',
    'style',
    'src',
  ]);

  var REJECTED_KEYWORDS = buildLookup([
    'with',
    'import',
    'export',
    'super',
    'debugger',
    'enum',
  ]);

  var RESERVED_IDENTIFIERS = buildLookup([
    'eval',
    'arguments',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'static',
    'yield',
  ]);

  var KEYWORDS = buildLookup([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'default',
    'delete',
    'do',
    'else',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'in',
    'instanceof',
    'let',
    'new',
    'null',
    'return',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
  ]);

  var VALUE_KEYWORDS = buildLookup([
    'this',
    'true',
    'false',
    'null',
  ]);

  var REGEX_PRECEDING_KEYWORDS = buildLookup([
    'case',
    'delete',
    'do',
    'else',
    'in',
    'instanceof',
    'new',
    'return',
    'throw',
    'typeof',
    'void',
  ]);

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  function isIdentifierStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
  }

  function isIdentifierPart(ch) {
    return isIdentifierStart(ch) || isDigit(ch);
  }

  function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ';
  }

  function isDeniedProperty(name) {
    return name.charAt(0) === '_' || contains(DENIED_PROPERTIES, name);
  }

  function guardKey(key) {
    var typeOfKey = typeof key;
    if (typeOfKey === 'string') {
      if (isDeniedProperty(key)) {
        throw new Error('Expression is not allowed to access "' + key + '"');
      }
      return key;
    }
    if (typeOfKey === 'number' || typeOfKey === 'boolean' || typeOfKey === 'symbol' || key === null || key === undefined) {
      return key;
    }
    var name = String(key);
    if (isDeniedProperty(name)) {
      throw new Error('Expression is not allowed to access "' + name + '"');
    }
    return name;
  }

  function analyze(source) {
    var output = '';
    var usedNames = {};
    var ownNames = {};
    var brackets = [];
    var braceDepth = 0;
    var parenDepth = 0;
    var lastToken = '';
    var lastTokenType = '';
    var declarationKind = '';
    var declarationBrace = 0;
    var declarationParen = 0;
    var expectsDeclarationName = false;
    var index = 0;
    var len = source.length;

    function fail(message) {
      throw new Error('Expression rejected by sandbox: ' + message);
    }

    function isAtDeclarationDepth() {
      return braceDepth === declarationBrace && parenDepth === declarationParen;
    }

    function endDeclaration() {
      declarationKind = '';
      expectsDeclarationName = false;
    }

    function isBindingPatternStart() {
      return expectsDeclarationName && isAtDeclarationDepth()
        && (declarationKind === 'var' || declarationKind === 'let' || declarationKind === 'const');
    }

    function isAnonymousDefinition() {
      return expectsDeclarationName && isAtDeclarationDepth()
        && (declarationKind === 'function' || declarationKind === 'class');
    }

    function isMemberBase() {
      if (lastTokenType === 'identifier' || lastTokenType === 'property' || lastTokenType === 'number' || lastTokenType === 'string' || lastTokenType === 'regex') {
        return true;
      }
      if (lastTokenType === 'keyword') {
        return contains(VALUE_KEYWORDS, lastToken);
      }
      return lastToken === ')' || lastToken === ']' || lastToken === '}' || lastToken === '?.';
    }

    function isRegexPosition() {
      if (lastTokenType === 'identifier' || lastTokenType === 'property' || lastTokenType === 'number' || lastTokenType === 'string' || lastTokenType === 'regex') {
        return false;
      }
      if (lastTokenType === 'keyword') {
        return contains(REGEX_PRECEDING_KEYWORDS, lastToken);
      }
      return lastToken !== ')' && lastToken !== ']' && lastToken !== '}' && lastToken !== '++' && lastToken !== '--';
    }

    function pushToken(text, type) {
      output += text;
      lastToken = text;
      lastTokenType = type;
    }

    function readString(quote) {
      var start = index;
      index += 1;
      while (index < len) {
        var ch = source.charAt(index);
        if (ch === '\\') {
          index += 2;
        } else if (ch === quote) {
          index += 1;
          pushToken(source.substring(start, index), 'string');
          return;
        } else if (ch === '\n' || ch === '\r') {
          fail('unterminated string literal');
        } else {
          index += 1;
        }
      }
      fail('unterminated string literal');
    }

    function readRegex() {
      var start = index;
      var inClass = false;
      index += 1;
      while (index < len) {
        var ch = source.charAt(index);
        if (ch === '\\') {
          index += 2;
        } else if (ch === '[') {
          inClass = true;
          index += 1;
        } else if (ch === ']') {
          inClass = false;
          index += 1;
        } else if (ch === '/' && !inClass) {
          index += 1;
          while (index < len && isIdentifierPart(source.charAt(index))) {
            index += 1;
          }
          pushToken(source.substring(start, index), 'regex');
          return;
        } else if (ch === '\n' || ch === '\r') {
          fail('unterminated regular expression');
        } else {
          index += 1;
        }
      }
      fail('unterminated regular expression');
    }

    function readDigits() {
      while (index < len && (isDigit(source.charAt(index)) || source.charAt(index) === '_')) {
        index += 1;
      }
    }

    function readNumber() {
      var start = index;
      var radixPrefix = source.charAt(index) === '0' && 'xXoObB'.indexOf(source.charAt(index + 1)) !== -1;
      if (radixPrefix) {
        index += 2;
        while (index < len && isIdentifierPart(source.charAt(index))) {
          index += 1;
        }
      } else {
        readDigits();
        if (source.charAt(index) === '.') {
          index += 1;
          readDigits();
        }
        if (source.charAt(index) === 'e' || source.charAt(index) === 'E') {
          index += 1;
          if (source.charAt(index) === '+' || source.charAt(index) === '-') {
            index += 1;
          }
          readDigits();
        }
        if (source.charAt(index) === 'n') {
          index += 1;
        }
      }
      pushToken(source.substring(start, index), 'number');
    }

    function readIdentifier() {
      var start = index;
      while (index < len && isIdentifierPart(source.charAt(index))) {
        index += 1;
      }
      var word = source.substring(start, index);

      if (lastToken === '.' || lastToken === '?.') {
        if (isDeniedProperty(word)) {
          fail('access to property "' + word + '" is not allowed');
        }
        pushToken(word, 'property');
        return;
      }
      if (word.indexOf(INTERNAL_PREFIX) === 0) {
        fail('identifiers starting with ' + INTERNAL_PREFIX + ' are reserved');
      }
      if (contains(REJECTED_KEYWORDS, word) || contains(RESERVED_IDENTIFIERS, word)) {
        fail('"' + word + '" is not allowed');
      }
      if (contains(KEYWORDS, word)) {
        if (word === 'var' || word === 'let' || word === 'const' || word === 'function' || word === 'class') {
          declarationKind = word;
          declarationBrace = braceDepth;
          declarationParen = parenDepth;
          expectsDeclarationName = true;
        } else {
          endDeclaration();
        }
        pushToken(word, 'keyword');
        return;
      }

      if (expectsDeclarationName && isAtDeclarationDepth()) {
        if (declarationKind === 'var') {
          usedNames[word] = true;
        } else {
          ownNames[word] = true;
        }
        expectsDeclarationName = false;
        if (declarationKind === 'function' || declarationKind === 'class') {
          endDeclaration();
        }
      } else {
        usedNames[word] = true;
      }
      pushToken(word, 'identifier');
    }

    function readComment() {
      var start = index;
      if (source.charAt(index + 1) === '/') {
        while (index < len && source.charAt(index) !== '\n') {
          index += 1;
        }
      } else {
        index += 2;
        while (index < len && !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')) {
          index += 1;
        }
        if (index >= len) {
          fail('unterminated comment');
        }
        index += 2;
      }
      output += source.substring(start, index);
    }

    while (index < len) {
      var ch = source.charAt(index);
      var next = source.charAt(index + 1);

      if (isWhitespace(ch)) {
        output += ch;
        index += 1;
      } else if (ch === '/' && (next === '/' || next === '*')) {
        readComment();
      } else if (ch === '`') {
        fail('template literals are not allowed');
      } else if (ch === '"' || ch === '\'') {
        readString(ch);
      } else if (ch === '/' && isRegexPosition()) {
        readRegex();
      } else if (isDigit(ch) || (ch === '.' && isDigit(next))) {
        readNumber();
      } else if (isIdentifierStart(ch)) {
        readIdentifier();
      } else if (ch === '?' && next === '.' && !isDigit(source.charAt(index + 2))) {
        index += 2;
        pushToken('?.', 'punctuator');
      } else if (ch === '[') {
        if (isBindingPatternStart()) {
          fail('destructuring declarations are not supported');
        }
        var guarded = isMemberBase();
        brackets.push({ close: ']', guarded: guarded });
        index += 1;
        output += guarded ? '[' + KEY_ARG + '(' : '[';
        lastToken = '[';
        lastTokenType = 'punctuator';
      } else if (ch === ']') {
        var openBracket = brackets.pop();
        if (!openBracket || openBracket.close !== ']') {
          fail('unbalanced brackets');
        }
        index += 1;
        output += openBracket.guarded ? ')]' : ']';
        lastToken = ']';
        lastTokenType = 'punctuator';
      } else if (ch === '(') {
        if (isAnonymousDefinition()) {
          endDeclaration();
        }
        brackets.push({ close: ')' });
        parenDepth += 1;
        index += 1;
        pushToken('(', 'punctuator');
      } else if (ch === ')') {
        var openParen = brackets.pop();
        if (!openParen || openParen.close !== ')') {
          fail('unbalanced parentheses');
        }
        parenDepth -= 1;
        index += 1;
        pushToken(')', 'punctuator');
        if (declarationKind && parenDepth < declarationParen) {
          endDeclaration();
        }
      } else if (ch === '{') {
        if (isBindingPatternStart()) {
          fail('destructuring declarations are not supported');
        }
        if (isAnonymousDefinition()) {
          endDeclaration();
        }
        brackets.push({ close: '}' });
        braceDepth += 1;
        index += 1;
        pushToken('{', 'punctuator');
      } else if (ch === '}') {
        var openBrace = brackets.pop();
        if (!openBrace || openBrace.close !== '}') {
          fail('unbalanced braces');
        }
        braceDepth -= 1;
        index += 1;
        pushToken('}', 'punctuator');
        if (declarationKind && braceDepth < declarationBrace) {
          endDeclaration();
        }
      } else if (ch === ';') {
        if (declarationKind && isAtDeclarationDepth()) {
          endDeclaration();
        }
        index += 1;
        pushToken(';', 'punctuator');
      } else if (ch === ',') {
        if (declarationKind && declarationKind !== 'function' && declarationKind !== 'class' && isAtDeclarationDepth()) {
          expectsDeclarationName = true;
        }
        index += 1;
        pushToken(',', 'punctuator');
      } else if ((ch === '+' || ch === '-') && next === ch) {
        index += 2;
        pushToken(ch + ch, 'punctuator');
      } else if (ch.charCodeAt(0) > 127) {
        fail('non-ascii identifiers are not allowed');
      } else {
        index += 1;
        if (declarationKind && ch === '=') {
          expectsDeclarationName = false;
        }
        pushToken(ch, 'punctuator');
      }
    }

    if (brackets.length) {
      fail('unbalanced brackets');
    }

    return {
      code: output,
      usedNames: usedNames,
      ownNames: ownNames,
    };
  }

  function buildPrologue(scopeNames, analysis) {
    var boundNames = [];
    var localNames = [];
    var boundLookup = {};
    var i;
    var name;

    for (i = 0; i < scopeNames.length; i += 1) {
      name = scopeNames[i];
      if (!contains(analysis.ownNames, name)) {
        boundNames.push(name + '=' + SCOPE_ARG + '.' + name);
        boundLookup[name] = true;
      }
    }

    var used = analysis.usedNames;
    used[RESULT_NAME] = true;
    var usedList = Object.keys(used);
    for (i = 0; i < usedList.length; i += 1) {
      name = usedList[i];
      if (!contains(boundLookup, name) && !contains(analysis.ownNames, name)) {
        localNames.push(name);
      }
    }

    var prologue = '';
    if (boundNames.length) {
      prologue += 'var ' + boundNames.join(',') + ';';
    }
    if (localNames.length) {
      prologue += 'var ' + localNames.join(',') + ';';
    }
    if (contains(used, 'posterizeTime') && !contains(analysis.ownNames, 'posterizeTime') && !contains(boundLookup, 'posterizeTime')) {
      prologue += 'function posterizeTime(framesPerSecond){'
        + 'time=framesPerSecond===0?0:Math.floor(time*framesPerSecond)/framesPerSecond;'
        + SCOPE_ARG + '.time=time;'
        + 'value=valueAtTime(time);'
        + SCOPE_ARG + '.value=value;'
        + '}';
    }
    return prologue;
  }

  function compileExpression(source, scope) {
    var analysis = analyze(source);
    var prologue = buildPrologue(Object.keys(scope), analysis);
    var body = '"use strict";' + prologue + '\n' + analysis.code + '\n;return ' + RESULT_NAME + ';';
    var compiled = new Function(SCOPE_ARG, KEY_ARG, body); // eslint-disable-line no-new-func

    return function runExpression(runtimeScope) {
      return compiled.call(undefined, runtimeScope, guardKey);
    };
  }

  return {
    compileExpression: compileExpression,
  };
}());

export default ExpressionSandbox;
