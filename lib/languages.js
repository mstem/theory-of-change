// The languages a reader can ask the analysis to be written in. This is separate
// from the page bundles in locales/: a page translation needs a reviewed bundle,
// while the model can write these well enough to offer before any page exists.
//
// The value is the name the prompts use. Portuguese says European, because a
// bare "Portuguese" can come back Brazilian.
export const OUTPUT_LANGUAGES = Object.freeze({
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'European Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ro: 'Romanian',
  el: 'Greek',
  cs: 'Czech',
  hu: 'Hungarian',
  sv: 'Swedish',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ar: 'Arabic'
});

// How the analysis addresses the reader, where the language has a choice. It
// matches the page bundle, which says "a sua". Only the analysis takes it: a
// directory card has no reader to address, and given one it invents a "your".
export const ANALYSIS_REGISTER = Object.freeze({
  pt: "in the formal register that addresses the reader as 'a sua'"
});

export const DEFAULT_OUTPUT_LANGUAGE = 'en';

// The code comes from the browser and the name goes into a prompt, so only a code
// on the list ever comes out of here. A region tag reduces to its language.
export function outputLanguage(value) {
  if (typeof value !== 'string') return DEFAULT_OUTPUT_LANGUAGE;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(OUTPUT_LANGUAGES, code) ? code : DEFAULT_OUTPUT_LANGUAGE;
}
