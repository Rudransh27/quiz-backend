// src/services/grading/jsLiteral.js
//
// A tiny, read-only parser for JavaScript *literal* syntax — arrays, objects,
// strings, numbers, booleans, null — used to read an html_sandbox module's
// own question bank (e.g. `const Q = [{type:'mc', opts:[...], correct:2}]`)
// WITHOUT executing any of the module's JS on the server.
//
// Anything that isn't a plain literal (a function call, an identifier
// reference, a `${}` template interpolation, a spread, arithmetic...) makes
// the parse fail with a JsLiteralError instead of being evaluated, so a
// module whose bank isn't a pure literal is reported as "key not
// extractable" rather than being guessed at.

class JsLiteralError extends Error {}

const MAX_DEPTH = 32;

function parseJsLiteral(source, startIndex = 0) {
  let i = startIndex;
  const src = String(source);

  const fail = (msg) => {
    throw new JsLiteralError(`${msg} at offset ${i}`);
  };

  const skipWs = () => {
    while (i < src.length) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿' || ch === ' ') {
        i++;
      } else if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) fail('Unterminated comment');
        i = end + 2;
      } else {
        break;
      }
    }
  };

  const parseString = () => {
    const quote = src[i];
    i++;
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === quote) {
        i++;
        return out;
      }
      if (quote === '`' && ch === '$' && src[i + 1] === '{') fail('Template interpolation is not a literal');
      if (ch === '\\') {
        const next = src[i + 1];
        i += 2;
        switch (next) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '0': out += '\0'; break;
          case '\n': break; // line continuation
          case '\r': if (src[i] === '\n') i++; break;
          case 'x': {
            const hex = src.slice(i, i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('Bad \\x escape');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
            break;
          }
          case 'u': {
            if (src[i] === '{') {
              const close = src.indexOf('}', i);
              const hex = src.slice(i + 1, close);
              if (close === -1 || !/^[0-9a-fA-F]{1,6}$/.test(hex)) fail('Bad \\u{} escape');
              out += String.fromCodePoint(parseInt(hex, 16));
              i = close + 1;
            } else {
              const hex = src.slice(i, i + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad \\u escape');
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            }
            break;
          }
          default:
            if (next === undefined) fail('Unterminated string');
            out += next;
        }
        continue;
      }
      if ((ch === '\n' || ch === '\r') && quote !== '`') fail('Unterminated string');
      out += ch;
      i++;
    }
    return fail('Unterminated string');
  };

  const parseNumber = () => {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!m) fail('Bad number');
    i += m[0].length;
    return Number(m[0]);
  };

  const parseIdentifier = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 256));
    if (!m) fail('Expected identifier');
    i += m[0].length;
    return m[0];
  };

  const parseValue = (depth) => {
    if (depth > MAX_DEPTH) fail('Nesting too deep');
    skipWs();
    const ch = src[i];
    if (ch === '[') return parseArray(depth + 1);
    if (ch === '{') return parseObject(depth + 1);
    if (ch === '"' || ch === "'" || ch === '`') return parseString();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return parseNumber();
    const word = parseIdentifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === 'undefined') return undefined;
    return fail(`Non-literal identifier "${word}"`);
  };

  const parseArray = (depth) => {
    i++; // [
    const out = [];
    for (;;) {
      skipWs();
      if (src[i] === ']') { i++; return out; }
      if (src.startsWith('...', i)) fail('Spread is not a literal');
      out.push(parseValue(depth));
      skipWs();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return out; }
      fail('Expected , or ]');
    }
  };

  const parseObject = (depth) => {
    i++; // {
    const out = {};
    for (;;) {
      skipWs();
      if (src[i] === '}') { i++; return out; }
      if (src.startsWith('...', i)) fail('Spread is not a literal');
      let key;
      const ch = src[i];
      if (ch === '"' || ch === "'") key = parseString();
      else if (ch >= '0' && ch <= '9') key = String(parseNumber());
      else key = parseIdentifier();
      skipWs();
      if (src[i] !== ':') fail('Expected : (shorthand properties are not literals)');
      i++;
      // Own-property write via defineProperty so a "__proto__" key can't
      // reach the prototype chain.
      Object.defineProperty(out, key, { value: parseValue(depth), enumerable: true, writable: true, configurable: true });
      skipWs();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return out; }
      fail('Expected , or }');
    }
  };

  const value = parseValue(0);
  return { value, end: i };
}

// Finds every top-level `const|let|var NAME = [ ... ]` declaration in a
// script blob and returns the ones whose initializer parses as a pure
// literal. Declarations whose initializer isn't a literal are skipped.
const ARRAY_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;

function findLiteralArrayDeclarations(source) {
  const src = String(source || '');
  const found = [];
  ARRAY_DECL.lastIndex = 0;
  let m;
  while ((m = ARRAY_DECL.exec(src)) !== null) {
    const openIndex = m.index + m[0].length - 1;
    try {
      const { value, end } = parseJsLiteral(src, openIndex);
      found.push({ name: m[1], value, start: m.index, end });
      ARRAY_DECL.lastIndex = end;
    } catch (err) {
      if (!(err instanceof JsLiteralError)) throw err;
      // Not a pure literal — keep scanning after the opening bracket.
    }
  }
  return found;
}

module.exports = { parseJsLiteral, findLiteralArrayDeclarations, JsLiteralError };
