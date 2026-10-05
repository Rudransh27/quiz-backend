// tests/sandboxStrip.test.js
//
// "Server feedback" HTML modules: learners receive the module without its
// answer key; authors and the grader still see the full HTML.
const fs = require('fs');
const path = require('path');
const { extractSandboxKey, usesServerFeedback, stripSandboxKey } = require('../src/services/grading/sandboxKey');
const { normalizeCardForClient } = require('../src/utils/learnerCard');

const FIX = path.join(__dirname, 'fixtures', 'sandbox');
const META = '<meta name="orbit-feedback" content="server">';
const optIn = (html) => html.replace(/<head[^>]*>/i, (h) => `${h}${META}`);
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.html'));

test('the opt-in meta is detected', () => {
  expect(usesServerFeedback(`<head>${META}</head>`)).toBe(true);
  expect(usesServerFeedback("<meta content='server' name='orbit-feedback'>")).toBe(false); // name must come first (documented form)
  expect(usesServerFeedback('<head></head>')).toBe(false);
});

test.each(fixtures)('%s: every answer is removed, nothing else breaks', (file) => {
  const html = optIn(fs.readFileSync(path.join(FIX, file), 'utf8'));
  const full = extractSandboxKey(html);
  expect(full.ok).toBe(true);
  const stripped = stripSandboxKey(html);
  expect(stripped).not.toMatch(/data-correct\s*=/i);
  // no correct option index / text survives anywhere in the learner copy
  full.answerKey.questions.filter((q) => q.correctText).forEach((q) => {
    expect(stripped.includes(`data-correct="${q.correctText}"`)).toBe(false);
  });
  expect(stripped).not.toMatch(/["']?correct["']?\s*:\s*\d/);
  // the module's questions/options are still there
  full.answerKey.questions.filter((q) => q.questionText).slice(0, 3).forEach((q) => {
    expect(stripped).toContain(q.questionText.slice(0, 20).replace(/"/g, '\\"').slice(0, 10));
  });
});

test('learners get the stripped copy, authors the full one; non-opted modules unchanged', () => {
  const html = optIn(fs.readFileSync(path.join(FIX, fixtures[0]), 'utf8'));
  const card = { _id: 'c1', card_type: 'html_sandbox', content: { htmlSource: html } };
  expect(normalizeCardForClient(card, { includeAnswers: false }).content.htmlSource).toBe(stripSandboxKey(html));
  expect(normalizeCardForClient(card, { includeAnswers: true }).content.htmlSource).toBe(html);
  const legacy = fs.readFileSync(path.join(FIX, fixtures[0]), 'utf8');
  const legacyCard = { _id: 'c2', card_type: 'html_sandbox', content: { htmlSource: legacy } };
  expect(normalizeCardForClient(legacyCard, { includeAnswers: false }).content.htmlSource).toBe(legacy);
});
