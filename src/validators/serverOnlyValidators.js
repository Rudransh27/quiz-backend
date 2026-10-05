// src/validators/serverOnlyValidators.js
//
// Validators that exist only on the server. validateReferencePart1 is used by
// a live code card but was never part of the frontend's validators.js — in
// the browser that card's validator was undefined, so no answer could ever
// pass. Its rules come from the old backend codeValidator.js unchanged,
// except that the learner-supplied xlink:label is regex-escaped before it is
// embedded in the second pattern (unescaped, a crafted label could inject a
// catastrophic-backtracking pattern and stall the server).
const { DOMParser } = require('./domShim');

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validateReferencePart1(userInput) {
  const xmlDoc = new DOMParser().parseFromString(userInput, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
    return {
      isCorrect: false,
      error: '❌ Invalid XML format. Please ensure your syntax is correct and well-formed.',
    };
  }

  // Regex to match the complete <link:reference> resource
  const referenceRegex = /<link:reference[^>]*xlink:role="http:\/\/www\.xbrl\.org\/2003\/role\/reference"[^>]*xlink:type="resource"[^>]*xlink:label="([^"]+)"[^>]*>\s*<ref:Standard>IFRS 15<\/ref:Standard>\s*<ref:Paragraph>10<\/ref:Paragraph>\s*<\/link:reference>/is;
  const referenceMatch = userInput.match(referenceRegex);
  if (!referenceMatch) {
    return {
      isCorrect: false,
      error: '❌ Missing or incorrect <link:reference> element. Check the role, type, label, and content of <ref:Standard> and <ref:Paragraph>.',
    };
  }

  const referenceLabel = referenceMatch[1];
  const arcRegex = new RegExp(`<link:referenceArc[^>]*xlink:from="loc_Revenue"[^>]*xlink:to="${escapeRegExp(referenceLabel)}"[^>]*xlink:arcrole="http://www.xbrl.org/2003/arcrole/concept-reference"[^>]*xlink:type="arc"[^>]*\\/>`, 'is');
  if (!userInput.match(arcRegex)) {
    return {
      isCorrect: false,
      error: `❌ Missing or incorrect <link:referenceArc>. The 'xlink:from' attribute should be 'loc_Revenue', and the 'xlink:to' attribute should match the label you defined for your reference resource (${referenceLabel}).`,
    };
  }

  return {
    isCorrect: true,
    error: '✅ Excellent! The concept is now correctly linked to its reference.',
  };
}

module.exports = { validateReferencePart1 };
