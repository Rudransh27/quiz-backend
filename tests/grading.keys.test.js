// tests/grading.keys.test.js
//
// Answer-key extraction on the REAL html_sandbox modules exported from the
// local database (tests/fixtures/sandbox/*.html — both authoring families),
// plus the pure graders. No database needed.
const fs = require('fs');
const path = require('path');
const { extractSandboxKey } = require('../src/services/grading/sandboxKey');
const { parseHtmlSandboxPoints } = require('../src/utils/pointsCalculator');
const { gradeSandboxQuestion, gradeQuiz, resolveMcqKey } = require('../src/services/grading/graders');
const { buildAnswerKey } = require('../src/services/grading/answerKey');
const { parseJsLiteral, JsLiteralError } = require('../src/services/grading/jsLiteral');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sandbox');
const fixture = (id) => fs.readFileSync(path.join(FIXTURE_DIR, `${id}.html`), 'utf8');

const FIXTURES = {
  '6a56681466a0f877e0725c64': { family: 'jsArray', questions: 9, mcq: 5, fill: 0, descriptive: 4, points: 65 }, // Carbon NITI AI 2
  '6a567442bd99e9e44689e1bb': { family: 'jsArray', questions: 9, mcq: 5, fill: 0, descriptive: 4, points: 65 }, // Carbon NITI AI 1
  '6a6718f664793dba17b0f150': { family: 'quizBank', questions: 13, mcq: 13, fill: 0, descriptive: 0, points: 65 }, // Know Your Competitor (ans())
  '6a67199064793dba17b0f277': { family: 'quizBank', questions: 8, mcq: 8, fill: 0, descriptive: 0, points: 40 }, // 3 Sisters (JS-built buttons)
  '6a67284faa7c79ed1b4319ba': { family: 'quizBank', questions: 12, mcq: 9, fill: 3, descriptive: 0, points: 66 }, // Beyond the Mandate (ansM + fill-blank + retry)
};

describe('html_sandbox answer-key extraction (real modules)', () => {
  test.each(Object.entries(FIXTURES))('%s extracts the expected key', (id, expected) => {
    const html = fixture(id);
    const result = extractSandboxKey(html);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      family: expected.family,
      questionCount: expected.questions,
      mcqCount: expected.mcq,
      fillBlankCount: expected.fill,
      descriptiveCount: expected.descriptive,
      maxPoints: expected.points,
    });
    // The "worth" preview and what grading can award must always agree.
    expect(result.answerKey.maxPoints).toBe(parseHtmlSandboxPoints(html).total);
    expect(result.answerKey.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const q of result.answerKey.questions.filter((x) => x.type === 'mcq')) {
      expect(q.optionKeys).toContain(q.correctKey);
      expect(q.options.length).toBe(q.optionKeys.length);
    }
  });

  test('Family A (DOM options): letters and option text agree with the module markup', () => {
    const { answerKey } = extractSandboxKey(fixture('6a6718f664793dba17b0f150'));
    const b1 = answerKey.questions.find((q) => q.id === 'b1');
    expect(b1).toMatchObject({ type: 'mcq', points: 5, correctKey: 'B' });
    expect(b1.options[1]).toBe('The Netherlands');
  });

  test('Family A (JS-built buttons): options come from the questions array, cross-checked with data-correct', () => {
    const { answerKey } = extractSandboxKey(fixture('6a67199064793dba17b0f277'));
    const q1 = answerKey.questions.find((q) => q.id === 'q1');
    expect(q1.correctKey).toBe('C');
    expect(q1.options[2]).toMatch(/^OneStream computes your consolidated numbers/);
  });

  test('Family A fill-blank keeps every accepted alternative', () => {
    const { answerKey } = extractSandboxKey(fixture('6a67284faa7c79ed1b4319ba'));
    const q9 = answerKey.questions.find((q) => q.id === 'q9');
    expect(q9).toMatchObject({ type: 'fill-blank', points: 7, correctText: 'us|united states|usa' });
  });

  test('Family B uses the module\'s own q<index> ids', () => {
    const { answerKey } = extractSandboxKey(fixture('6a567442bd99e9e44689e1bb'));
    expect(answerKey.questions.map((q) => q.id)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']);
    expect(answerKey.questions[0]).toMatchObject({ type: 'mcq', correctKey: 'C', points: 5 });
    expect(answerKey.questions[5]).toMatchObject({ type: 'descriptive', points: 10 });
  });

  test('a module with no question bank is rejected with a clear reason', () => {
    const result = extractSandboxKey('<html><body><h1>Just slides</h1><script>let x = 1;</script></body></html>');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No gradable questions found/);
  });

  test('data-correct that is not one of the options is rejected', () => {
    const html = `<div id="quizBank"><div class="qblock" data-id="q1" data-type="mcq" data-points="5" data-correct="E"></div></div>
      <ul id="qo-q1"><li><button class="q-opt"><span class="q-l">A</span>One</button></li><li><button class="q-opt"><span class="q-l">B</span>Two</button></li></ul>`;
    const result = extractSandboxKey(html);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not one of its options/);
  });

  test('a non-literal question bank is never executed — it is just not found', () => {
    global.__pwned = false;
    const html = '<script>const Q = [{type:"mc", q:"x", opts:["a","b"], correct:(globalThis.__pwned = true, 0)}];</script>';
    const result = extractSandboxKey(html);
    expect(result.ok).toBe(false);
    expect(global.__pwned).toBe(false);
  });
});

describe('literal-only JS parser', () => {
  test('parses literals with comments, trailing commas and escapes', () => {
    const { value } = parseJsLiteral("[ {a:'x\\u2019y', 'b': [1, 2.5, -3,], c: true, d: null}, /* c */ `t` // e\n ]");
    expect(value).toEqual([{ a: 'x’y', b: [1, 2.5, -3], c: true, d: null }, 't']);
  });
  test.each([
    ['function call', '[foo()]'],
    ['identifier', '[window]'],
    ['template interpolation', '[`${x}`]'],
    ['spread', '[...a]'],
  ])('rejects %s', (_, src) => {
    expect(() => parseJsLiteral(src)).toThrow(JsLiteralError);
  });
  test('a __proto__ key cannot reach the prototype chain', () => {
    const { value } = parseJsLiteral('{"__proto__": {"polluted": true}}');
    expect(({}).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe('graders', () => {
  const key = extractSandboxKey(fixture('6a67284faa7c79ed1b4319ba')).answerKey;
  const byId = (id) => key.questions.find((q) => q.id === id);

  test('MCQ accepts the option letter or the exact option text', () => {
    const q1 = byId('q1');
    expect(gradeSandboxQuestion(q1, 'B').isCorrect).toBe(true);
    expect(gradeSandboxQuestion(q1, 'b').isCorrect).toBe(true);
    expect(gradeSandboxQuestion(q1, q1.options[1]).isCorrect).toBe(true);
    expect(gradeSandboxQuestion(q1, 'A').isCorrect).toBe(false);
    expect(gradeSandboxQuestion(q1, 'Z')).toMatchObject({ isCorrect: false, recognized: false });
    expect(resolveMcqKey(q1, '   ')).toBeNull();
  });

  test('fill-blank mirrors the module: trimmed, case-insensitive, any accepted alternative', () => {
    const q9 = byId('q9');
    expect(gradeSandboxQuestion(q9, '  United States ').isCorrect).toBe(true);
    expect(gradeSandboxQuestion(q9, 'USA').isCorrect).toBe(true);
    expect(gradeSandboxQuestion(q9, 'Canada').isCorrect).toBe(false);
    expect(gradeSandboxQuestion(q9, '').isCorrect).toBe(false);
    expect(gradeSandboxQuestion(q9, 'us'.repeat(200)).isCorrect).toBe(false); // over the length cap
  });

  test('descriptive answers are pending manual grading, never auto-scored', () => {
    const famB = extractSandboxKey(fixture('6a567442bd99e9e44689e1bb')).answerKey;
    expect(gradeSandboxQuestion(famB.questions[5], 'anything at all')).toMatchObject({ isCorrect: null, points: 0, pending: true });
  });

  test('quiz key from either stored format', () => {
    expect(buildAnswerKey('quiz', { question: 'q', options: ['a', 'b'], correctIndex: 1, explanation: 'e' }).answerKey)
      .toEqual({ correctIndex: 1, explanation: 'e' });
    expect(buildAnswerKey('quiz', { text: JSON.stringify({ options: ['a', 'b', 'c'], correctAnswerIndex: 2, explanationHint: 'h' }) }).answerKey)
      .toEqual({ correctIndex: 2, explanation: 'h' });
    expect(gradeQuiz({ correctIndex: 2 }, { selectedOption: 2 })).toMatchObject({ ok: true, isCorrect: true, points: 5 });
    expect(gradeQuiz({ correctIndex: 2 }, { selectedOption: 'x' }).ok).toBe(false);
  });
});
