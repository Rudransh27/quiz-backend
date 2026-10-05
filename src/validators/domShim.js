// src/validators/domShim.js
//
// Just enough of the browser's DOMParser / document.evaluate / XPathResult
// surface for the code-card validators (xbrlValidators.js, generated from the
// frontend's original src/utils/validators.js) to run unchanged on the
// server, on top of @xmldom/xmldom + xpath.
//
// Browser semantics reproduced here:
//  • DOMParser.parseFromString never throws on malformed XML — it returns a
//    document containing a <parsererror> element. @xmldom/xmldom throws (or
//    reports errors), so failures are converted into exactly that shape.
//  • document.evaluate(expr, ctx, resolver, type, result) accepts a plain
//    function as the namespace resolver; xpath.js wants an object with
//    lookupNamespaceURI, so a function resolver is wrapped.
const { DOMParser: XmlDomParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

const XPathResult = xpath.XPathResult;

const toResolver = (resolver) => {
  if (!resolver) return null;
  if (typeof resolver === 'function') return { lookupNamespaceURI: resolver };
  return resolver;
};

function attachEvaluate(doc) {
  if (doc && typeof doc.evaluate !== 'function') {
    doc.evaluate = (expression, contextNode, resolver, type, result) =>
      xpath.evaluate(expression, contextNode || doc, toResolver(resolver), type, result || null);
  }
  return doc;
}

function parserErrorDocument() {
  const doc = new XmlDomParser().parseFromString('<parsererror>Invalid XML</parsererror>', 'application/xml');
  return attachEvaluate(doc);
}

class DOMParser {
  parseFromString(source, mimeType) {
    let hadError = false;
    let doc = null;
    try {
      doc = new XmlDomParser({
        onError: (level) => {
          if (level === 'error' || level === 'fatalError') hadError = true;
        },
      }).parseFromString(String(source ?? ''), mimeType || 'application/xml');
    } catch (err) {
      hadError = true;
    }
    if (hadError || !doc || !doc.documentElement) return parserErrorDocument();
    return attachEvaluate(doc);
  }
}

module.exports = { DOMParser, XPathResult };
