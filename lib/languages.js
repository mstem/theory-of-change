// The languages a reader can ask the analysis to be written in. This is separate
// from the page bundles in locales/: a page translation needs a reviewed bundle,
// while the model can write these well enough to offer before any page exists.
//
// The value is the name the prompts use. Where a language has a page, the name
// says which country's variant the page is written in, because a bare
// "Portuguese" can come back Brazilian and a bare "Spanish" Latin American.
export const OUTPUT_LANGUAGES = Object.freeze({
  en: 'English',
  es: 'Spanish as written in Spain',
  fr: 'French as written in France',
  de: 'German as written in Germany',
  it: 'Italian',
  pt: 'European Portuguese',
  nl: 'Dutch as written in the Netherlands',
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
// matches the page bundle in each language. Only the analysis takes it: a
// directory card has no reader to address, and given one it invents a "your".
export const ANALYSIS_REGISTER = Object.freeze({
  pt: "in the formal register that addresses the reader as 'a sua'",
  es: "in the formal register that addresses the reader as 'usted'",
  fr: "in the formal register that addresses the reader as 'vous'",
  de: "in the formal register that addresses the reader as 'Sie'",
  it: "in the formal register that addresses the reader as 'Lei'",
  nl: "in the informal register that addresses the reader as 'je'",
  pl: "addressing the reader with impersonal forms rather than 'Pan/Pani' or 'ty'"
});

export const DEFAULT_OUTPUT_LANGUAGE = 'en';

// The code comes from the browser and the name goes into a prompt, so only a code
// on the list ever comes out of here. A region tag reduces to its language.
export function outputLanguage(value) {
  if (typeof value !== 'string') return DEFAULT_OUTPUT_LANGUAGE;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(OUTPUT_LANGUAGES, code) ? code : DEFAULT_OUTPUT_LANGUAGE;
}
