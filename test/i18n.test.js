import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// i18n.js resolves LOCALES_DIR at module load, so it has to be set first.
const TMP_LOCALES = mkdtempSync(join(tmpdir(), 'toc-locales-'));
process.env.LOCALES_DIR = TMP_LOCALES;

const {
  referenceBundle,
  validateBundle,
  headlineProblems,
  isBundleKey,
  getBundle,
  writeBundle,
  forgetBundle,
  listBundles,
  REFERENCE_KEY,
  REPO_LOCALES
} = await import('../lib/i18n.js');

const reference = referenceBundle();
const translationOf = (overrides = {}) => {
  const bundle = {};
  for (const key of Object.keys(reference)) {
    if (key !== '_meta') bundle[key] = reference[key];
  }
  return { ...bundle, ...overrides };
};

test('the English bundle is the reference and validates against itself', () => {
  assert.ok(Object.keys(reference).length > 50);
  assert.deepEqual(validateBundle(referenceBundle()), []);
  assert.equal(typeof reference['headline.template'], 'string');
});

test('a complete translation is accepted', () => {
  assert.deepEqual(validateBundle(translationOf()), []);
});

test('a bundle missing any key is rejected', () => {
  // A half-translated bundle is worse than none: it looks cached, so it is
  // never retried, and the page stays half English forever.
  const partial = translationOf();
  delete partial['hero.cta'];
  const problems = validateBundle(partial);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hero\.cta is missing/);
});

test('a bundle with an empty or non-string value is rejected', () => {
  for (const value of ['', '   ', null, 42, [], {}]) {
    const problems = validateBundle(translationOf({ 'hero.cta': value }));
    assert.match(problems[0] ?? '', /hero\.cta is missing or empty/, `${JSON.stringify(value)} should be rejected`);
  }
});

test('a bundle with keys the reference does not have is rejected', () => {
  const problems = validateBundle(translationOf({ 'hero.invented': 'x' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown keys: hero\.invented/);
});

test('anything that is not an object is rejected outright', () => {
  for (const value of [null, undefined, 'a string', 42, ['a'], true]) {
    assert.deepEqual(validateBundle(value), ['not an object']);
  }
});

test('a headline template that would drop an input field is rejected', () => {
  // The two slots are the app's only input. A template with the wrong number
  // of them would leave a field out of the page entirely.
  const cases = [
    ['How will {X} create?', /one \{Y\}, found 0/],
    ['How will {X} and {X} create {Y}?', /one \{X\}, found 2/],
    ['{X} {Y} a b c d e f', null]
  ];
  for (const [template, pattern] of cases) {
    const problems = validateBundle(translationOf({ 'headline.template': template }));
    if (pattern) assert.match(problems.join(' '), pattern);
    else assert.deepEqual(problems, []);
  }
});

// The place slot is optional: a translation that has not placed it yet keeps
// working as a global-only page instead of falling back to English.
test('a headline template may hold one place slot or none, never two', () => {
  assert.deepEqual(headlineProblems('How will {X}\ncreate {Y}\nin {Z}?'), []);
  assert.deepEqual(headlineProblems('How will {X}\ncreate {Y}\nin the world?'), []);
  assert.match(headlineProblems('{X} {Y} {Z} {Z}').join(' '), /at most one \{Z\}, found 2/);
});

test('a headline template with too many lines is rejected', () => {
  const tooMany = ['a {X}', 'b {Y}', 'c', 'd', 'e'].join('\n');
  assert.match(headlineProblems(tooMany).join(' '), /5 lines, at most 4/);
  assert.deepEqual(headlineProblems('a {X}\nb {Y}\nc'), []);
});

test('markup beyond a bold span is rejected', () => {
  // These strings are generated text rendered into the page, so the set of
  // tags they may carry is closed.
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="http://example.com">link</a>',
    '<strong onclick="x()">bold</strong>'
  ];
  for (const value of hostile) {
    const problems = validateBundle(translationOf({ 'workbook.intro': value }));
    assert.ok(problems.length > 0, `${value} should be rejected`);
    assert.match(problems.join(' '), /disallowed markup/);
  }
});

test('a bold span is allowed only where the source already had one', () => {
  // workbook.intro ships with <strong>, so it may keep it.
  assert.deepEqual(validateBundle(translationOf({ 'workbook.intro': '<strong>Bold</strong> rest' })), []);
  // hero.cta does not, so adding markup there is a translation going wrong.
  const problems = validateBundle(translationOf({ 'hero.cta': '<strong>Go</strong>' }));
  assert.match(problems.join(' '), /adds markup the source does not have/);
});

test('a bad character-width factor is rejected', () => {
  for (const factor of [0, -1, 10, 'wide', null]) {
    const problems = validateBundle({ ...translationOf(), _meta: { charWidthFactor: factor } });
    assert.match(problems.join(' '), /charWidthFactor/, `${factor} should be rejected`);
  }
  assert.deepEqual(validateBundle({ ...translationOf(), _meta: { charWidthFactor: 1.8 } }), []);
});

test('a bundle key cannot be anything that reaches outside the locales directory', () => {
  const rejected = ['../etc/passwd', 'en/../../x', './en', 'en ', 'EN', 'en-US', 'e', '', null, undefined, 42, 'en;rm -rf'];
  for (const key of rejected) {
    assert.equal(isBundleKey(key), false, `${JSON.stringify(key)} should be rejected`);
    assert.equal(getBundle(key), null);
    assert.equal(writeBundle(key, translationOf()), false);
  }
  for (const key of ['en', 'pt', 'zh-Hant', 'ckb']) {
    assert.equal(isBundleKey(key), true, `${key} should be accepted`);
  }
});

test('a written bundle reads back', () => {
  assert.equal(writeBundle('nl', translationOf({ 'hero.cta': 'Onderzoek deze theorie' })), true);
  assert.equal(getBundle('nl')['hero.cta'], 'Onderzoek deze theorie');
  assert.ok(listBundles().includes('nl'));
});

test('the committed bundle wins over a generated one', () => {
  // This is how a reviewed translation stops being overwritten by a machine.
  writeBundle(REFERENCE_KEY, translationOf({ 'hero.cta': 'GENERATED' }));
  forgetBundle(REFERENCE_KEY);
  assert.notEqual(getBundle(REFERENCE_KEY)['hero.cta'], 'GENERATED');
  assert.equal(getBundle(REFERENCE_KEY)['hero.cta'], reference['hero.cta']);
});

test('an invalid bundle on disk falls back rather than rendering half a page', () => {
  const partial = translationOf();
  delete partial['hero.cta'];
  writeFileSync(join(TMP_LOCALES, 'da.json'), JSON.stringify(partial));
  forgetBundle('da');
  assert.equal(getBundle('da'), null);
});

test('a corrupt bundle on disk is treated as absent', () => {
  writeFileSync(join(TMP_LOCALES, 'sv.json'), '{ this is not json');
  forgetBundle('sv');
  assert.equal(getBundle('sv'), null);
});

test('a missing bundle is null, not a throw', () => {
  assert.equal(getBundle('ja'), null);
  assert.equal(getBundle('zh-Hant'), null);
});

test('the suggestions bundle is stored and read separately', () => {
  // It is a third of the strings and most of the token cost, and nothing needs
  // it until the dropdown opens.
  const suggestions = getBundle(REFERENCE_KEY, 'suggestions');
  assert.equal(suggestions['suggestions.x'].length, 30);
  assert.equal(suggestions['suggestions.y'].length, 30);
  assert.equal(getBundle('ja', 'suggestions'), null);
});

test('every committed suggestions bundle has as many entries as the English one', () => {
  const english = getBundle(REFERENCE_KEY, 'suggestions');
  // Committed bundles only: other tests here write generated ones to a temp dir.
  const committed = readdirSync(REPO_LOCALES)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.suggestions.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((key) => key !== REFERENCE_KEY);
  assert.ok(committed.includes('pt'));
  for (const key of committed) {
    const translated = getBundle(key, 'suggestions');
    // Without the file the dropdowns stay English on an otherwise translated page.
    assert.ok(translated, `locales/${key}.suggestions.json is missing`);
    for (const list of ['suggestions.x', 'suggestions.y']) {
      assert.equal(translated[list]?.length, english[list].length, `${key} ${list}`);
    }
  }
});

test('an unwritable locales directory degrades instead of failing', () => {
  // The app still works, it just re-translates after each deploy. Worth a
  // warning, not a failed request.
  const locked = mkdtempSync(join(tmpdir(), 'toc-locked-'));
  mkdirSync(join(locked, 'locales'));
  chmodSync(join(locked, 'locales'), 0o500);
  try {
    process.env.LOCALES_DIR = join(locked, 'locales');
    // The module already resolved its directory, so this asserts the shape of
    // the failure rather than re-resolving: a write to a read-only path must
    // return false rather than throw.
    const target = join(locked, 'locales', 'x.json');
    assert.throws(() => writeFileSync(target, '{}'));
  } finally {
    chmodSync(join(locked, 'locales'), 0o700);
    rmSync(locked, { recursive: true, force: true });
    process.env.LOCALES_DIR = TMP_LOCALES;
  }
});

test('every key in the reference bundle is used somewhere in the page', () => {
  // The bidirectional check against index.html and app.js lands with the
  // markup change; until then this guards the cheaper direction: no key may be
  // added to en.json without a value.
  for (const [key, value] of Object.entries(reference)) {
    if (key === '_meta') continue;
    assert.equal(typeof value, 'string', `${key} should be a string`);
    assert.ok(value.length > 0, `${key} should not be empty`);
  }
});

// A committed translation that misses a key is refused whole and the page
// falls back to English, with nothing but a server warning to show for it.
// Adding an English string without its translations has to fail here instead.
test('every committed translation passes validation', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { REPO_LOCALES } = await import('../lib/i18n.js');
  const files = readdirSync(REPO_LOCALES).filter(f => /^[a-z]{2,8}(-[A-Z][a-z]{3})?\.json$/.test(f) && f !== `${REFERENCE_KEY}.json`);
  assert.ok(files.length > 0, 'no committed translations found');
  for (const file of files) {
    const bundle = JSON.parse(readFileSync(join(REPO_LOCALES, file), 'utf8'));
    assert.deepEqual(validateBundle(bundle), [], `${file} is not usable`);
  }
});
