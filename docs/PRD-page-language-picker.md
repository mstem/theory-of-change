# PRD: page-language picker

## Problem

The page language comes only from the browser's `Accept-Language` header. A reader whose browser guess is wrong (a Portuguese speaker on an English-language laptop, a visitor on a borrowed machine) has no visible way to change it. `?lang=pt` works on production but only for one visit, and nobody can see it. The server already reads a saved choice from a `locale_pref` cookie before the browser header, but nothing on the page writes that cookie.

## Success criteria

1. A reader can switch the page between every committed page translation (today English and Portuguese) from a visible control.
2. The choice sticks: the next visit renders in the chosen language from the first byte, with no flash of the other language.
3. Text the reader has already typed into the theory fields survives the switch.
4. Switching never starts a paid analysis on its own.
5. A new committed bundle appears in the picker with no code change.

## Scope

In:

- Each language shown in its own name ("English", "Português"), because the reader who needs the picker may not read the language the page is currently in.
- Each option is a plain link to `/?lang=<code>`, so it works without scripts for one visit. With scripts, a click first writes `locale_pref=lang=<code>` (one year, `Path=/`, `SameSite=Lax`, `Secure` on https), the same format the `localize` package's `writePreference` writes and `detectFromRequest` reads.
- The server lists the options from the committed bundles (`listBundles()` plus English) in the existing i18n data block, so nothing is hard-coded in the page.
- Before the reload, typed theory fields and the place field are kept in `sessionStorage` and put back after it, without running anything.
- If results are on screen, the reader lands back on the empty form with their theory filled in. Rerunning is their call, and a cached run is free.
- Tests: the options in the data block match the committed bundles; a `locale_pref` cookie picks the bundle over `Accept-Language`; an unknown cookie value falls back to the header.

Out:

- Remembering country or city in the cookie (the `localize` format allows it; nothing here needs it).
- Changing the analysis-language menu. It keeps its own remembered choice; a reader who never touched it gets the new page language as the default.
- Arabic page translation and right-to-left layout.

## Edge cases

- **Cookies refused.** The `?lang=` link still switches that one visit.
- **A cached page in a shared cache.** The page already sends `Vary: Accept-Language, Cookie`.
- **One language only.** If only English were committed, the picker hides itself.

## Build plan

1. Server: add the page-language list to the data block. Tests first, including the cookie precedence test.
2. Client: render the picker, write the cookie on click, keep and restore the typed fields.
3. Markup and CSS at the agreed place, following `design.md` and the existing footer styles.
4. Check locally in a browser with an English `Accept-Language`: switch to Português, reload, open a new tab, confirm Portuguese from the first paint and the typed theory restored.
5. PR, deploy, check production.

## Decisions (2026-10-19)

- The picker sits in both footers: the line under the hero, after "About this project", and the results footer, after "MIT License".
- It gets an accessible name: "Page language" / "Idioma da página". Each link carries its own `lang` attribute.
