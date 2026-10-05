// src/services/grading/sandboxKey.js
//
// Extracts a server-side answer key from an html_sandbox card's authored
// HTML — statically. The module's own JavaScript is NEVER executed here:
// Family A is read as HTML (node-html-parser), Family B's question array is
// read with the literal-only parser in ./jsLiteral.js.
//
// Two authoring families are recognised:
//
//  A. "quizBank": a hidden <div id="quizBank"> holding one
//     .qblock[data-id][data-type][data-points][data-correct] per question.
//     MCQ options come from the rendered `#qo-<id> .q-opt` buttons (letter in
//     .q-l), or — for modules that build their buttons in JS — from a
//     literal array of {opts|options, correct} items in the page script.
//
//  B. "jsArray": a literal `const Q = [{type:'mc'|'text', q, opts, correct}]`
//     bank, with question ids 'q' + index (the module's own submit format).
//
// Point values come from the SAME tables pointsCalculator.js uses for the
// "how much is this worth" preview, so the preview and what grading can
// actually award always agree (a test asserts this per fixture).

const crypto = require('crypto');
const { parse } = require('node-html-parser');
const { findLiteralArrayDeclarations } = require('./jsLiteral');
const {
  QBLOCK_TYPE_POINTS,
  QUIZ_QUESTION_POINTS,
  DESCRIPTIVE_QUESTION_POINTS,
} = require('../../utils/pointsCalculator');

const MCQ_TYPES = new Set(['mcq', 'mc', 'true_false']);
const FILL_BLANK_TYPES = new Set(['fill-blank', 'fill_blank']);

class SandboxKeyError extends Error {}

const letterFor = (index) => String.fromCharCode(65 + index);

const contentHashOf = (htmlSource) =>
  crypto.createHash('sha256').update(String(htmlSource || ''), 'utf8').digest('hex');

const normalizeType = (raw) => {
  const t = String(raw || '').trim().toLowerCase();
  if (MCQ_TYPES.has(t)) return 'mcq';
  if (FILL_BLANK_TYPES.has(t)) return 'fill-blank';
  return 'descriptive';
};

// Mirrors the modules' own getMcqOptions(): key = .q-l text, text = the
// button's textContent with that key removed once, trimmed.
function readDomOptions(root, qid) {
  const list = root.querySelector(`#qo-${qid}`);
  if (!list) return null;
  const buttons = list.querySelectorAll('.q-opt');
  if (!buttons.length) return null;
  return buttons.map((btn) => {
    const keyEl = btn.querySelector('.q-l');
    const key = keyEl ? keyEl.text.trim() : '';
    const text = btn.text.replace(key, '').trim();
    return { key, text };
  });
}

// For quizBank modules that render their MCQ buttons from a JS array (no
// #qo-<id> markup), find a literal array whose items look like questions.
function findJsOptionBank(htmlSource, expectedLength) {
  const decls = findLiteralArrayDeclarations(htmlSource);
  return decls
    .map((d) => d.value)
    .find((arr) =>
      Array.isArray(arr) &&
      arr.length === expectedLength &&
      arr.every((item) => item && typeof item === 'object' && Array.isArray(item.opts || item.options)));
}

function extractQuizBank(htmlSource, root) {
  const bank = root.querySelector('#quizBank');
  if (!bank) return null;
  const blocks = bank.querySelectorAll('.qblock');
  if (!blocks.length) return null;

  const questions = [];
  const seen = new Set();
  for (const block of blocks) {
    const id = (block.getAttribute('data-id') || '').trim();
    if (!id) throw new SandboxKeyError('A #quizBank .qblock has no data-id.');
    if (seen.has(id)) throw new SandboxKeyError(`Duplicate question id "${id}" in #quizBank.`);
    seen.add(id);

    const rawType = (block.getAttribute('data-type') || '').trim().toLowerCase();
    const type = normalizeType(rawType);
    const rawPoints = block.getAttribute('data-points');
    // Same rule as pointsCalculator.parseQuizBankMetadataPoints: an explicit
    // data-points wins (including 0); otherwise the type's default weight.
    const points = rawPoints !== undefined && /^-?\d+$/.test(String(rawPoints).trim())
      ? (parseInt(rawPoints, 10) || 0)
      : (QBLOCK_TYPE_POINTS[rawType] ?? 0);
    const correct = (block.getAttribute('data-correct') || '').trim();
    const qtext = block.querySelector('.qtext');

    questions.push({
      id,
      type,
      points,
      correctKey: type === 'mcq' ? correct.toUpperCase() : null,
      correctText: type === 'fill-blank' ? correct : null,
      options: null,
      questionText: qtext ? qtext.text.trim() : '',
    });
  }

  // Attach MCQ options: rendered DOM first, JS literal bank as fallback.
  const mcqs = questions.filter((q) => q.type === 'mcq');
  const missingDom = [];
  for (const q of mcqs) {
    const opts = readDomOptions(root, q.id);
    if (opts) {
      q.options = opts.map((o) => o.text);
      q.optionKeys = opts.map((o) => o.key.toUpperCase());
    } else {
      missingDom.push(q);
    }
  }
  if (missingDom.length) {
    const jsBank = findJsOptionBank(htmlSource, questions.length) || findJsOptionBank(htmlSource, mcqs.length);
    if (!jsBank) {
      throw new SandboxKeyError(`No answer options found for MCQ question(s): ${missingDom.map((q) => q.id).join(', ')}.`);
    }
    const byPosition = jsBank.length === questions.length ? questions : mcqs;
    for (const q of missingDom) {
      // Modules map 'q<N>' → bank[N-1]; otherwise fall back to position.
      const m = /^q(\d+)$/.exec(q.id);
      const idx = m ? parseInt(m[1], 10) - 1 : byPosition.indexOf(q);
      const item = jsBank[idx];
      if (!item) throw new SandboxKeyError(`No answer options found for MCQ question ${q.id}.`);
      const opts = (item.opts || item.options).map((t) => String(t));
      q.options = opts;
      q.optionKeys = opts.map((_, i) => letterFor(i));
      if (Number.isInteger(item.correct) && letterFor(item.correct) !== q.correctKey) {
        throw new SandboxKeyError(
          `Question ${q.id}: data-correct="${q.correctKey}" disagrees with the script's correct option (${letterFor(item.correct)}).`);
      }
    }
  }

  for (const q of questions) {
    if (q.type === 'mcq') {
      if (!q.correctKey) throw new SandboxKeyError(`MCQ question ${q.id} has no data-correct.`);
      if (!q.optionKeys.includes(q.correctKey)) {
        throw new SandboxKeyError(`MCQ question ${q.id}: data-correct="${q.correctKey}" is not one of its options (${q.optionKeys.join(', ')}).`);
      }
    }
    if (q.type === 'fill-blank' && !q.correctText) {
      throw new SandboxKeyError(`Fill-in-the-blank question ${q.id} has no data-correct.`);
    }
  }
  return { family: 'quizBank', questions };
}

function extractJsArray(htmlSource) {
  const decls = findLiteralArrayDeclarations(htmlSource);
  const bank = decls.find((d) =>
    Array.isArray(d.value) && d.value.length > 0 &&
    d.value.every((item) => item && typeof item === 'object' && typeof item.type === 'string') &&
    d.value.some((item) => 'q' in item || 'questionText' in item || 'opts' in item || 'correct' in item));
  if (!bank) return null;

  const questions = bank.value.map((item, qi) => {
    const type = normalizeType(item.type);
    const id = 'q' + qi; // the module's own submit id format
    if (type === 'mcq') {
      const opts = Array.isArray(item.opts) ? item.opts.map(String) : null;
      if (!opts || !opts.length) throw new SandboxKeyError(`MCQ question ${id} has no options.`);
      if (!Number.isInteger(item.correct) || item.correct < 0 || item.correct >= opts.length) {
        throw new SandboxKeyError(`MCQ question ${id} has no valid correct option index.`);
      }
      return {
        id, type, points: QUIZ_QUESTION_POINTS,
        correctKey: letterFor(item.correct), correctText: null,
        options: opts, optionKeys: opts.map((_, i) => letterFor(i)),
        questionText: String(item.q || item.questionText || ''),
      };
    }
    // Same weights as pointsCalculator.parseHtmlSandboxPoints's array scan:
    // anything that isn't an MCQ is a descriptive, admin-graded question.
    return {
      id, type: 'descriptive', points: DESCRIPTIVE_QUESTION_POINTS,
      correctKey: null, correctText: null, options: null, optionKeys: null,
      questionText: String(item.q || item.questionText || ''),
    };
  });
  return { family: 'jsArray', questions };
}

function summarize(family, questions) {
  const count = (t) => questions.filter((q) => q.type === t).length;
  const maxPoints = questions.reduce((s, q) => s + (q.points || 0), 0);
  const autoPoints = questions.filter((q) => q.type !== 'descriptive').reduce((s, q) => s + (q.points || 0), 0);
  const parts = [`${questions.length} question${questions.length === 1 ? '' : 's'}`];
  if (count('mcq')) parts.push(`${count('mcq')} MCQ`);
  if (count('fill-blank')) parts.push(`${count('fill-blank')} fill-in-the-blank`);
  if (count('descriptive')) parts.push(`${count('descriptive')} descriptive (manual grading)`);
  parts.push(`${maxPoints} pts`);
  return {
    family,
    questionCount: questions.length,
    mcqCount: count('mcq'),
    fillBlankCount: count('fill-blank'),
    descriptiveCount: count('descriptive'),
    maxPoints,
    autoPoints,
    label: parts.join(' · '),
  };
}

// Returns { ok: true, answerKey, summary } or { ok: false, error }.
function extractSandboxKey(htmlSource) {
  if (!htmlSource || typeof htmlSource !== 'string' || !htmlSource.trim()) {
    return { ok: false, error: 'The HTML module is empty.' };
  }
  try {
    const root = parse(htmlSource, { comment: false, blockTextElements: { script: true, style: true } });
    const result = extractQuizBank(htmlSource, root) || extractJsArray(htmlSource);
    if (!result) {
      return {
        ok: false,
        error: 'No gradable questions found. Add a hidden <div id="quizBank"> with .qblock[data-id][data-type][data-points][data-correct] entries, or a `const Q = [...]` question array.',
      };
    }
    const summary = summarize(result.family, result.questions);
    const answerKey = {
      family: result.family,
      questions: result.questions.map(({ questionText, ...q }) => ({ ...q, questionText })),
      maxPoints: summary.maxPoints,
      autoPoints: summary.autoPoints,
      contentHash: contentHashOf(htmlSource),
    };
    return { ok: true, answerKey, summary };
  } catch (err) {
    if (err instanceof SandboxKeyError) return { ok: false, error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 🔒 Learner copy without the answers ("server feedback" modules)
// ---------------------------------------------------------------------------
// A module that declares <meta name="orbit-feedback" content="server"> asks
// Orbit whether each answer is right (window.orbitCheck → the grading API)
// instead of checking it in-page, so the copy a learner's browser receives
// can have the key removed and nobody can read it in DevTools:
//   • quizBank family: every data-correct="…" attribute;
//   • literal question arrays (const Q = [...] / the option bank): each
//     item's `correct` value becomes null.
// The admin copy (and the server's answerKey) keep the full HTML.
const SERVER_FEEDBACK_META = /<meta\s+[^>]*name\s*=\s*["']orbit-feedback["'][^>]*content\s*=\s*["']server["'][^>]*>/i;

function usesServerFeedback(htmlSource) {
  return typeof htmlSource === 'string' && SERVER_FEEDBACK_META.test(htmlSource);
}

function stripSandboxKey(htmlSource) {
  let html = String(htmlSource || '').replace(/\sdata-correct\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Replace array literals back-to-front so earlier offsets stay valid.
  const decls = findLiteralArrayDeclarations(html)
    .filter((d) => Array.isArray(d.value) && d.value.some((item) => item && typeof item === 'object' && 'correct' in item))
    .sort((a, b) => b.start - a.start);
  decls.forEach((d) => {
    const open = html.indexOf('[', d.start);
    const cleaned = d.value.map((item) => (item && typeof item === 'object' && 'correct' in item ? { ...item, correct: null } : item));
    html = html.slice(0, open) + JSON.stringify(cleaned) + html.slice(d.end);
  });
  return html;
}

module.exports = { extractSandboxKey, contentHashOf, SandboxKeyError, usesServerFeedback, stripSandboxKey };
