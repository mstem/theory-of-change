import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const bundle = JSON.parse(readFileSync(join(root, 'locales', 'en.json'), 'utf8'));
const markup = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const script = readFileSync(join(root, 'public', 'app.js'), 'utf8');

const keys = Object.keys(bundle).filter((key) => key !== '_meta');

function referencedKeys() {
  const found = new Set();
  for (const match of markup.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) found.add(match[1]);
  for (const match of markup.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(',')) found.add(pair.split(':')[1].trim());
  }
  // Any quoted literal in the script counts, not only one inside a t() call:
  // a key is often handed to a helper instead, as headline.wordX is.
  for (const key of keys) {
    if (script.includes(`'${key}'`) || script.includes(`"${key}"`)) found.add(key);
  }
  return found;
}

// Keys the client never names as a literal in a t() call, each for a stated
// reason. Anything falling out of this list is a key nobody uses.
const NOT_REFERENCED_BY_THE_CLIENT = {
  'meta.title': 'substituted into the page by the server',
  'meta.description': 'substituted into the page by the server',
  'meta.socialTitle': 'substituted into the page by the server',
  'headline.placeholderX': 'rendered by CSS from data-placeholder; a variable name, not a word',
  'headline.placeholderY': 'rendered by CSS from data-placeholder; a variable name, not a word',
  'strength.Strong': 'reached through the dynamic key strength.${label}',
  'strength.Moderate': 'reached through the dynamic key strength.${label}',
  'strength.Weak': 'reached through the dynamic key strength.${label}',
  'strength.Speculative': 'reached through the dynamic key strength.${label}',
  'error.connection': 'wired when the server starts returning error codes',
  'error.generic': 'wired when the server starts returning error codes',
  'error.server': 'wired when the server starts returning error codes',
  'error.noJson': 'wired when the server starts returning error codes',
  'error.parse': 'wired when the server starts returning error codes',
  'error.INPUT_REQUIRED': 'wired when the server starts returning error codes',
  'error.INPUT_TOO_LONG': 'wired when the server starts returning error codes',
  'error.RATE_LIMITED': 'wired when the server starts returning error codes',
  'error.SERVICE_UNAVAILABLE': 'wired when the server starts returning error codes'
};

test('every key the page asks for exists in the bundle', () => {
  // The bug this catches is a typo in a data-i18n attribute or a t() call,
  // which fails silently: the element simply keeps its English text, and
  // nothing anywhere reports it.
  const missing = [...referencedKeys()].filter((key) => !keys.includes(key));
  assert.deepEqual(missing, [], `keys referenced but absent from locales/en.json: ${missing.join(', ')}`);
});

test('every key in the bundle is either used or accounted for', () => {
  const referenced = referencedKeys();
  const unexplained = keys.filter(
    (key) => !referenced.has(key) && !(key in NOT_REFERENCED_BY_THE_CLIENT)
  );
  assert.deepEqual(
    unexplained,
    [],
    `keys nothing uses; wire them up or delete them: ${unexplained.join(', ')}`
  );
});

test('the accounted-for list has no stale entries of its own', () => {
  // Otherwise the list above quietly becomes a place where deleted keys live on.
  const referenced = referencedKeys();
  const stale = Object.keys(NOT_REFERENCED_BY_THE_CLIENT).filter(
    (key) => !keys.includes(key) || referenced.has(key)
  );
  assert.deepEqual(stale, [], `no longer exempt: ${stale.join(', ')}`);
});

test('every string the markup carries as fallback matches the bundle', () => {
  // The English text stays in the markup so the page reads correctly with no
  // script and before the bundle is applied. If it drifts from en.json, the two
  // disagree and whichever the reader sees depends on timing.
  const mismatched = [];
  for (const match of markup.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    const [, key, text] = match;
    if (!(key in bundle)) continue;
    if (text.trim() !== bundle[key].trim()) mismatched.push(`${key}: markup has "${text.trim()}"`);
  }
  assert.deepEqual(mismatched, [], mismatched.join(' | '));
});

test('the headline template in the bundle is one the renderer accepts', () => {
  const template = bundle['headline.template'];
  assert.equal((template.match(/\{X\}/g) || []).length, 1);
  assert.equal((template.match(/\{Y\}/g) || []).length, 1);
  assert.ok(template.split('\n').length <= 4);
});

test('the markup still holds the two slots the renderer moves', () => {
  // renderHeadline relocates these rather than rebuilding them, which is what
  // keeps the autocomplete and the blinking cursor bound. Renaming either id
  // would silently leave the headline empty.
  for (const id of ['headline', 'wrap-x', 'wrap-y', 'word-x', 'word-y', 'field-x', 'field-y']) {
    assert.ok(markup.includes(`id="${id}"`), `#${id} should still be in the markup`);
  }
});
