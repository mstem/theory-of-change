// Translation bundles: where they live, how they are validated, how they are
// cached.
//
// Two layers, because the Dockerfile is COPY . . with no volume, so anything
// written at runtime is destroyed on the next deploy:
//
//   locales/       committed, hand written or hand reviewed. Read only.
//   LOCALES_DIR    generated output, on a mounted volume.
//
// The committed file wins, which is how a generated bundle graduates into
// source of truth: review it, copy it into locales/, commit.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPO_LOCALES = join(__dirname, '..', 'locales');
const CACHE_DIR = process.env.CACHE_DIR || join(__dirname, '..', '.cache');
export const RUNTIME_LOCALES = process.env.LOCALES_DIR || join(CACHE_DIR, 'locales');

export const REFERENCE_KEY = 'en';

// A bundle key comes from a request, so its shape is a security boundary: it is
// interpolated into a file path. bundleKey() upstream already constrains it,
// but this module does not get to assume its caller did that.
const KEY_PATTERN = /^[a-z]{2,8}(-[A-Z][a-z]{3})?$/;

export function isBundleKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function bundlePath(dir, key, kind) {
  if (!isBundleKey(key)) return null;
  const name = kind === 'suggestions' ? `${key}.suggestions.json` : `${key}.json`;
  const path = resolve(dir, name);
  // Belt and braces: even with the pattern above, a path that escapes its
  // directory is never opened.
  if (path !== join(resolve(dir), name) || !path.startsWith(resolve(dir) + sep)) return null;
  return path;
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Absent, unreadable or corrupt all mean the same thing to a caller: there
    // is no bundle here, fall back.
    return null;
  }
}

let reference = null;

/** The English bundle: the set of keys every translation must cover. */
export function referenceBundle() {
  if (!reference) {
    reference = readJson(bundlePath(REPO_LOCALES, REFERENCE_KEY, 'bundle'));
    if (!reference) throw new Error(`locales/${REFERENCE_KEY}.json is missing or invalid; it is the source of truth`);
  }
  return reference;
}

/**
 * Validates a candidate translation against the reference.
 *
 * Called before anything is written, because a partially translated bundle is
 * worse than none: it looks cached, so it is never retried, and it renders a
 * half-English page forever.
 *
 * @returns {string[]} problems, empty when the bundle is usable.
 */
export function validateBundle(candidate) {
  const problems = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return ['not an object'];
  }

  const expected = referenceBundle();
  for (const key of Object.keys(expected)) {
    if (key === '_meta') continue;
    const value = candidate[key];
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`${key} is missing or empty`);
    }
  }

  const extra = Object.keys(candidate).filter((key) => key !== '_meta' && !(key in expected));
  if (extra.length) problems.push(`unknown keys: ${extra.join(', ')}`);

  // The headline carries the app's only input fields. A template with the wrong
  // number of slots would drop one of them out of the page entirely.
  const headline = candidate['headline.template'];
  if (typeof headline === 'string') {
    problems.push(...headlineProblems(headline));
  }

  // Only <strong> is allowed, and only where the reference already had it.
  // Everything else here is model output rendered into a page.
  for (const [key, value] of Object.entries(candidate)) {
    if (key === '_meta' || typeof value !== 'string') continue;
    const tags = value.match(/<[^>]*>/g) ?? [];
    for (const tag of tags) {
      if (!/^<\/?strong>$/i.test(tag)) problems.push(`${key} contains disallowed markup: ${tag}`);
    }
    if (tags.length && !/<[^>]*>/.test(expected[key] ?? '')) {
      problems.push(`${key} adds markup the source does not have`);
    }
  }

  const factor = candidate._meta?.charWidthFactor;
  if (factor !== undefined && !(typeof factor === 'number' && factor > 0 && factor <= 4)) {
    problems.push('_meta.charWidthFactor must be a number between 0 and 4');
  }

  return problems;
}

export const HEADLINE_MAX_LINES = 4;

/** Shared with the client renderer, which applies the same rule to the bundle it is handed. */
export function headlineProblems(template) {
  const problems = [];
  const x = (template.match(/\{X\}/g) ?? []).length;
  const y = (template.match(/\{Y\}/g) ?? []).length;
  if (x !== 1) problems.push(`headline.template needs exactly one {X}, found ${x}`);
  if (y !== 1) problems.push(`headline.template needs exactly one {Y}, found ${y}`);
  const lines = template.split('\n').length;
  if (lines > HEADLINE_MAX_LINES) problems.push(`headline.template has ${lines} lines, at most ${HEADLINE_MAX_LINES} fit`);
  return problems;
}

const parsed = new Map();

/**
 * The bundle for a key, or null when there is none. The committed copy wins
 * over generated output so a hand review is never overwritten by a machine.
 */
export function getBundle(key, kind = 'bundle') {
  if (!isBundleKey(key)) return null;
  const cacheKey = `${kind}:${key}`;
  if (parsed.has(cacheKey)) return parsed.get(cacheKey);

  const bundle =
    readJson(bundlePath(REPO_LOCALES, key, kind)) ?? readJson(bundlePath(RUNTIME_LOCALES, key, kind));

  // A generated bundle is validated on read as well as on write, because the
  // file may have been hand edited since, or written by an older build.
  if (bundle && kind === 'bundle' && key !== REFERENCE_KEY) {
    const problems = validateBundle(bundle);
    if (problems.length) {
      console.warn(`locale ${key} is not usable, falling back to ${REFERENCE_KEY}: ${problems[0]}`);
      parsed.set(cacheKey, null);
      return null;
    }
  }

  parsed.set(cacheKey, bundle ?? null);
  return bundle ?? null;
}

/** Drops the parse cache, so a newly written bundle is picked up. */
export function forgetBundle(key) {
  if (key === undefined) parsed.clear();
  else for (const kind of ['bundle', 'suggestions']) parsed.delete(`${kind}:${key}`);
}

let runtimeWritable = null;

/**
 * Persists a generated bundle. Returns false rather than throwing when the
 * directory is not writable: the app still works, it just re-translates after
 * every deploy, and that is worth a warning rather than a failed request.
 */
export function writeBundle(key, bundle, kind = 'bundle') {
  if (!isBundleKey(key)) return false;
  const path = bundlePath(RUNTIME_LOCALES, key, kind);
  if (!path) return false;

  try {
    mkdirSync(RUNTIME_LOCALES, { recursive: true });
    // Written to a temporary name and renamed, so a reader never sees a
    // half-written file.
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(bundle, null, 2));
    renameSync(temporary, path);
    forgetBundle(key);
    runtimeWritable = true;
    return true;
  } catch (err) {
    if (runtimeWritable !== false) {
      console.warn(`cannot write to ${RUNTIME_LOCALES} (${err.message}); translations will not survive a restart`);
      runtimeWritable = false;
    }
    return false;
  }
}

/** Every key with a usable bundle, committed or generated. */
export function listBundles() {
  const keys = new Set();
  for (const dir of [REPO_LOCALES, RUNTIME_LOCALES]) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^([a-z]{2,8}(?:-[A-Z][a-z]{3})?)\.json$/.exec(entry);
      if (match) keys.add(match[1]);
    }
  }
  return [...keys].sort();
}
