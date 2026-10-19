# PRD: analysis in the reader's language

## Problem

The page is translated (Portuguese since PR #27), but the analysis the model writes still comes back in English, and so do the Civic Tech Field Guide recommendations. A Portuguese reader gets a Portuguese page with an English result in the middle of it. The aim is many more languages, and page translations need a reviewed bundle each, so the analysis should not have to wait for those.

## Approach

The model writes the analysis in the chosen language directly. No translation service. The reader picks the language from a fixed list of languages the model writes well; it defaults to the page language. The list is one file, and adding a language is one line.

## Success criteria

1. A reader who picks a language gets every reader-facing string of the analysis in it: summary, assumptions, mechanisms, probing questions, evidence titles and descriptions, historical examples, sourced summary.
2. The Field Guide recommendation cards show their name and description in the same language.
3. The diagram and score still render: `strength_label` stays one of the four English values, and every JSON key stays English.
4. English readers get exactly what they get today, from the same cache entries.
5. A result in one language is never served from cache to a reader who asked for another.
6. A reader on the Portuguese page gets European Portuguese without touching the menu.

## Scope

In:

- `lib/languages.js`: the list of output languages, each a language code and the name the prompt uses. Portuguese is named "European Portuguese, in the formal register that addresses the reader as 'a sua'", because a bare "Portuguese" may come back Brazilian. Starting list: English, Spanish, French, German, Italian, Portuguese, Dutch, Polish, Romanian, Greek, Czech, Hungarian, Swedish, Ukrainian, Turkish, Arabic.
- `/api/analyze` and `/api/recommend` accept `lang`. Anything not on the list is treated as English, so the value never reaches a prompt as free text.
- One instruction added to both analysis prompts (frame and grounded): write every string value in that language, even though most sources are in English; keep JSON keys, `strength_label` and `as_of` as specified; keep `source` names, and the names of organisations, laws, studies and movements, in their original form.
- Cache key gains a `|||lang:<code>` segment for non-English only, so existing English entries still hit.
- The `analyze total` log line gains `lang=`.
- A language menu in the results header, next to Save as PDF and Share. Its options are labelled with the browser's own language names in the page language (`Intl.DisplayNames`), so they need no translation. It defaults to the page language when that is on the list, otherwise English. Changing it reruns the analysis in the new language, carrying any pushback note. The choice is remembered in the browser for the next theory.
- Recommendations: the curator service returns English cards (`name`, `description`, link). For a non-English language this server translates `name` and `description` with one Haiku call per response and caches each card by link plus language in memory. The Field Guide's category list is finite, so most cards become cache hits. Links are untouched. If translation fails, is over budget, or comes back malformed, the English cards are shown, never an empty section. The cost goes on the daily meter.
- The worksheet answers saved in the browser get a language suffix for non-English, because the probing questions differ by language and answers are stored by question number.
- Tests: language validation and fallback; prompt contains the language line only for non-English; cache keys differ by language and English keys are unchanged; card translation parsing, caching and fallback.

Out:

- DeepL or any translation API.
- The page-language picker. Separate PR after this one.
- Translating the Field Guide pages the cards link to. They stay in English on civictech.guide.
- `/api/source-url`. It looks up by `source` name, which stays in its original form.
- Server error strings (planned separately as error codes).
- New page translations, and right-to-left layout for Arabic output on a left-to-right page.

## Constraints and edge cases

- **Progressive render.** No new or optional JSON keys, so the streaming renderer is untouched.
- **Evidence is mostly English.** The instruction says to write in the chosen language regardless, and the smoke check confirms it on a real run.
- **Quality nobody can check.** For Greek, Hungarian, Arabic and others, nobody on the team can easily judge the output. Accepted with option B.
- **Arabic on a left-to-right page.** Arabic text will render inside left-to-right sections. Text direction is set per block with `dir="auto"` so each paragraph at least runs the right way.
- **Score drift.** Writing in another language could nudge the score. Scores already swing 32 to 58 on the same theory, so one side-by-side check is enough.
- **Cost.** Each language switch is a new run ($0.16 to $0.30) unless cached. The daily budget meter still caps total spend. Non-Latin scripts cost somewhat more per run.
- **Curator matching.** The text sent to the curator for matching includes the summary and mechanisms, which will now be in the chosen language. The curator matches with a model, so this should hold, but the smoke check looks at it.
- **Shared links** carry the theory, not the result or language, so the recipient gets their own default language.

## Build plan

1. `lib/languages.js` with tests.
2. Server: `lang` on analyze (prompt line, cache key, log field). Tests first.
3. Recommend: card translation with cache and English fallback. Tests first.
4. Client: language menu, `lang` on analyze, pushback and recommend calls, remembered choice, worksheet key suffix, `dir="auto"` on analysis text.
5. New string for the menu's accessible name in `en.json` and `pt.json`, drafted for approval.
6. Verify locally: Portuguese default, a switch to Spanish, an English run hitting an existing cache entry.
7. PR, deploy via the Coolify `/deploy` call, smoke-check production.

## Decisions (2026-10-15)

- Readers can pick the output language; it defaults to the page language.
- The menu offers a fixed list of languages the model writes well, not only translated page languages (option B).
- The page-language picker is a separate PR after this one.
- Portuguese is European Portuguese, formal "a sua" register.
