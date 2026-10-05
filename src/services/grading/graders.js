// src/services/grading/graders.js
//
// Pure grading functions — answer key + learner answer in, verdict out. No
// database access here; services/grading/index.js handles persistence, XP
// and access control.
const validators = require('../../validators');
const { CARD_TYPE_POINTS } = require('../../utils/pointsCalculator');

const MAX_CODE_ANSWER_CHARS = 20000;
const MAX_TEXT_ANSWER_CHARS = 10000;
const MAX_FILL_BLANK_CHARS = 200;

const normalize = (s) => String(s ?? '')
  .normalize('NFKC')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// ---- quiz -----------------------------------------------------------------
function gradeQuiz(key, answer) {
  const selected = Number(answer?.selectedOption);
  if (!Number.isInteger(selected) || selected < 0) {
    return { ok: false, error: 'selectedOption must be a non-negative integer.' };
  }
  const isCorrect = selected === key.correctIndex;
  return {
    ok: true,
    isCorrect,
    points: isCorrect ? CARD_TYPE_POINTS.quiz : 0,
    stored: { selectedOption: selected },
  };
}

// ---- code -----------------------------------------------------------------
function gradeCode(key, answer) {
  const code = answer?.userCodeAnswer;
  if (typeof code !== 'string') return { ok: false, error: 'userCodeAnswer must be a string.' };
  if (code.length > MAX_CODE_ANSWER_CHARS) {
    return { ok: true, isCorrect: false, points: 0, error: `❌ Answer is too long (max ${MAX_CODE_ANSWER_CHARS} characters).`, stored: { userCodeAnswer: code.slice(0, MAX_CODE_ANSWER_CHARS) } };
  }
  const name = key.validator;
  const fn = Object.prototype.hasOwnProperty.call(validators, name) ? validators[name] : null;
  if (typeof fn !== 'function') {
    return { ok: false, error: `Unknown validator "${name}".`, status: 500 };
  }
  let verdict;
  try {
    verdict = fn(code) || {};
  } catch (err) {
    verdict = { isCorrect: false, error: '❌ Your answer could not be validated. Please check the XML is well-formed.' };
  }
  const isCorrect = verdict.isCorrect === true;
  return {
    ok: true,
    isCorrect,
    points: isCorrect ? CARD_TYPE_POINTS.code : 0,
    error: isCorrect ? null : (verdict.error || '❌ Not quite — check your answer.'),
    stored: { userCodeAnswer: code },
  };
}

// ---- html_sandbox question ------------------------------------------------
// `chosen` may be an option letter ("B", from the in-page bridge) or the
// option's text (what modules put in their submit payload's userAnswer).
function resolveMcqKey(q, chosen) {
  const raw = String(chosen ?? '').trim();
  if (!raw) return null;
  if (/^[A-Za-z]$/.test(raw)) {
    const letter = raw.toUpperCase();
    return q.optionKeys && q.optionKeys.includes(letter) ? letter : null;
  }
  if (!Array.isArray(q.options)) return null;
  const target = normalize(raw);
  const hits = q.options
    .map((text, i) => (normalize(text) === target ? q.optionKeys[i] : null))
    .filter(Boolean);
  return hits.length === 1 ? hits[0] : null;
}

function gradeSandboxQuestion(q, chosen) {
  if (q.type === 'descriptive') {
    const text = typeof chosen === 'string' ? chosen.slice(0, MAX_TEXT_ANSWER_CHARS) : '';
    return { isCorrect: null, points: 0, maxPoints: q.points, recognized: true, answer: text, pending: true };
  }
  if (q.type === 'mcq') {
    const key = resolveMcqKey(q, chosen);
    const isCorrect = key !== null && key === q.correctKey;
    return { isCorrect, points: isCorrect ? q.points : 0, maxPoints: q.points, recognized: key !== null, answer: key ?? (chosen ?? null) };
  }
  // fill-blank — mirrors the modules' own in-page check (case-insensitive
  // "contains one of the accepted answers"), so the learner never sees ✓
  // in the module and ✗ from the server for the same input.
  const value = normalize(chosen);
  const accepted = String(q.correctText || '').split('|').map(normalize).filter(Boolean);
  const isCorrect = value.length > 0 && value.length <= MAX_FILL_BLANK_CHARS && accepted.some((a) => value.includes(a));
  return { isCorrect, points: isCorrect ? q.points : 0, maxPoints: q.points, recognized: value.length > 0, answer: String(chosen ?? '').slice(0, MAX_FILL_BLANK_CHARS) };
}

// Display text for the correct answer, for metaFeedbackLogs/admin views.
function correctAnswerText(q) {
  if (q.type === 'mcq') {
    const i = q.optionKeys ? q.optionKeys.indexOf(q.correctKey) : -1;
    return i >= 0 && q.options ? q.options[i] : q.correctKey;
  }
  if (q.type === 'fill-blank') return String(q.correctText || '').split('|')[0];
  return null;
}

module.exports = {
  gradeQuiz,
  gradeCode,
  gradeSandboxQuestion,
  resolveMcqKey,
  correctAnswerText,
  normalize,
  MAX_CODE_ANSWER_CHARS,
};
