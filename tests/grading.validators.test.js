// tests/grading.validators.test.js
//
// Code-card validator parity: the server's validator set
// (src/validators/xbrlValidators.js, generated) must give the same verdict
// as the frontend's original validators.js — the rules learners were graded
// by in the browser.
//
//  1. Drift guard: the generated server file equals a fresh generation from
//     the current frontend source (so nobody edits one and forgets the other).
//  2. Verdict parity: the frontend source, loaded directly, and the server
//     set agree on real answers — every code card's starter snippet (all must
//     fail) and the stored learner answer from the local DB (whose browser
//     verdict was recorded at the time).
//
// The frontend file is evaluated against the same DOM shim (Node has no
// browser DOMParser); a DOM-engine difference between the browser and
// @xmldom/xmldom would not show up here — that is what the browser
// run-through covers.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'xbrl-quiz-app', 'src', 'utils', 'validators.js');
const SERVER_GENERATED = path.join(__dirname, '..', 'src', 'validators', 'xbrlValidators.js');
const serverValidators = require('../src/validators');
const fixtures = require('./fixtures/code-cards.json');

const hasClient = fs.existsSync(CLIENT_SRC);
const maybe = hasClient ? describe : describe.skip;

function loadClientValidators() {
  // Same mechanical ESM → CJS transform as the sync script, into a temp
  // module next to the shim so `require('./domShim')` resolves.
  const text = fs.readFileSync(CLIENT_SRC, 'utf8');
  const names = [...text.matchAll(/^export function (\w+)\s*\(/gm)].map((m) => m[1]);
  const body = text.replace(/^export function /gm, 'function ');
  const shim = path.join(__dirname, '..', 'src', 'validators', 'domShim.js').replace(/\\/g, '/');
  const tmp = path.join(os.tmpdir(), `client-validators-${process.pid}.js`);
  fs.writeFileSync(tmp, `const { DOMParser, XPathResult } = require(${JSON.stringify(shim)});\nconst console = { ...globalThis.console, log() {} };\n${body}\nmodule.exports = { ${names.join(', ')} };\n`);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

maybe('code validator parity (server vs frontend source)', () => {
  test('generated server validators are in sync with the frontend source (run scripts/sync-validators.js if this fails)', () => {
    const { generate } = require('../scripts/sync-validators');
    const fresh = generate(fs.readFileSync(CLIENT_SRC, 'utf8')).code;
    const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
    expect(normalizeEol(fs.readFileSync(SERVER_GENERATED, 'utf8'))).toBe(normalizeEol(fresh));
  });

  test('every validator referenced by a code card exists on the server', () => {
    const missing = fixtures.cards.filter((c) => typeof serverValidators[c.validator] !== 'function');
    expect(missing).toEqual([]);
  });

  const client = loadClientValidators();
  const shared = fixtures.cards.filter((c) => typeof client[c.validator] === 'function' && c.starter);

  test.each(shared.map((c) => [c.validator, c]))('%s: starter snippet fails identically on both', (_, card) => {
    const s = serverValidators[card.validator](card.starter);
    const c = client[card.validator](card.starter);
    expect(s.isCorrect).toBe(false);
    expect(Boolean(s.isCorrect)).toBe(Boolean(c.isCorrect));
    expect(s.error).toBe(c.error);
  });

  test('stored learner answers get the verdict the browser gave them', () => {
    const byId = new Map(fixtures.cards.map((c) => [c.cardId, c]));
    for (const a of fixtures.answers) {
      const card = byId.get(a.cardId);
      expect(Boolean(serverValidators[card.validator](a.answer).isCorrect)).toBe(a.browserVerdict);
      if (typeof client[card.validator] === 'function') {
        expect(Boolean(client[card.validator](a.answer).isCorrect)).toBe(a.browserVerdict);
      }
    }
  });

  test('a fixed snippet passes on both (unitRef)', () => {
    const fixed = '<xbrli:unit id="u1"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>\n<ex:Revenue contextRef="c1" unitRef="u1" decimals="0">100000</ex:Revenue>';
    expect(serverValidators.validateUnitRefAnswer(fixed).isCorrect).toBe(true);
    expect(client.validateUnitRefAnswer(fixed).isCorrect).toBe(true);
  });

  test('malformed XML is a clean failure, never a throw', () => {
    for (const name of Object.keys(client)) {
      expect(() => serverValidators[name]('<<not xml')).not.toThrow();
    }
  });
});

describe('server-only validators', () => {
  test('validateReferencePart1 is safe against a regex-injection label', () => {
    const evil = '<link:reference xlink:role="http://www.xbrl.org/2003/role/reference" xlink:type="resource" xlink:label="(a+)+$"><ref:Standard>IFRS 15</ref:Standard><ref:Paragraph>10</ref:Paragraph></link:reference>' + 'a'.repeat(40);
    const t0 = Date.now();
    expect(serverValidators.validateReferencePart1(evil).isCorrect).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
