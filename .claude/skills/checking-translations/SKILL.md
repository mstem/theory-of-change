---
name: checking-translations
description: Use when adding a page language to theory-of-change, translating or editing anything in locales/, or when asked whether a translation is correct, natural or ready to ship.
---

# Checking translations

## Overview

Matt cannot read most of the languages this page ships in, and no native reviewer is usually on hand. A draft translation is therefore checked by a second, independent translation plus real-world usage, before it reaches him. Shipping on "the model wrote it" alone is not acceptable, and neither is waiting on a reviewer nobody has named.

## Decisions already made (do not re-ask)

| | Rule |
|---|---|
| Register | es "usted", fr "vous", de "Sie", it "Lei", pt "a sua", nl "je", pl impersonal forms. Other languages: ask Matt once, then add the row here. |
| Gender | Neutral wording where the language allows it ("pessoas imigrantes", "direitos laborais"). Otherwise alternate feminine and masculine across entries. No gender star, no "·e·", no "@" or "x" endings. |
| Region | The variant of the European country (pt-PT, es-ES). Every regional browser shares the one bundle. |
| Slots | `{X}` is the action someone takes ("organizing community action"), `{Y}` the change it is meant to cause ("climate stability"), `{Z}` the place. The headline asks how X will create Y in Z. |
| Arabic and other right-to-left languages | On hold until Matt names a native reviewer. |
| Writing rules | No em dashes, as in `pt.json`. |

## Files a language needs

1. `locales/xx.json`: every key of `en.json`, plus `_meta` (`language`, `dir`, `charWidthFactor`). The validator in `lib/i18n.js` rejects missing keys, extra keys, stray markup and a headline without one `{X}` and one `{Y}`.
2. `locales/xx.suggestions.json`: 30 `suggestions.x`, 30 `suggestions.y`, same order as English. A test fails without it.
3. `lib/languages.js`: an `ANALYSIS_REGISTER` entry, so the analysis addresses the reader the way the page does, and an `OUTPUT_LANGUAGES` name that states the country variant (`'European Portuguese'`, not `'Portuguese'`), or the model writes another country's variant. `analyzeCacheKey` keys on the language code, not the prompt, so runs cached under the old wording keep being served.
4. `public/app.js` `displayLocale`: map the code to its region (`pt` → `pt-PT`) if `Intl.DisplayNames` would otherwise give another country's names.
5. Tests: the route test for the language's first suggestion, like the `pt` one in `test/routes.test.js`.

## The check

1. **Draft** the bundle yourself.
2. **Blind second translation.** Dispatch a subagent that never sees the draft or any file: give it the English strings, the register, gender and region rules above, and the headline template in English and in the draft language. Ask for one line per string, with `| alt: … | reason` where it was torn.
3. **Compare line by line.** Ignore article and word-order differences. Everything else goes on a disputed list.
4. **Usage search** on each disputed line, in sources from that country: national press, government sites, the NGO that works on the topic (ILGA Portugal settled "LGBTI+"). The same pass flags other-country variants (Brazilian, Latin American) and old spellings. Record the URL that settled each line. A line no source settles stays disputed.
5. **Headline in context.** Build the full headline sentence with every X suggestion and a few Y suggestions and places. A suggestion that is grammatical alone but wrong in the slot gets rewritten.
6. **Render** locally at desktop and 375px wide with `?lang=xx`. Nothing still in English, nothing overflowing.
7. **Review file** for a native speaker: English and translation in two columns, disputed lines first, to Chrome Downloads.

## What Matt gets

Sort the disputed lines into two kinds:

- **Decisions** change what the page says or how it behaves: the headline template (with a sample sentence and its back-translation), a place or grammar limit the template cannot handle, register on buttons versus body text, identity terms and acronyms. Bring each one with both full wordings, the source for each, and your pick. Nothing in this group ships before he has seen it.
- **Wording**: two acceptable versions of the same line, which no source settled. Keep the drafter's pick and leave both versions in the review file. Give him the count per language, not the lines.

Also give him the lines the check changed, each with its source, and the path of the review file in Chrome Downloads (`theory-of-change-review-<code>.csv`).

Then ship one PR per language.

## Common mistakes

| Mistake | Fix |
|---|---|
| Letting the second translator see the draft | It then agrees with the draft. Pass only the English. |
| Searching sources from another country | Brazilian results do not settle European Portuguese. |
| Asking Matt to decide from labels | Show both wordings in full, with what each source said. |
| Bringing him every wording dispute | He does not read most of these languages. Wording disputes stay in the review file. |
