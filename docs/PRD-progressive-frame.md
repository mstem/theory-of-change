# PRD — Show the frame before the evidence arrives

Status: built and measured 2026-09-12.

Measured on the first live run, theory "teaching media literacy in schools" to "fewer people sharing false claims":

| | before | after |
|---|---|---|
| first content on screen | end of the search phase | 1.0s |
| diagram, mechanisms, assumptions, questions complete | end of the search phase | 8.6s |
| evidence and history complete | 364s | 364s |
| cost | $0.16 to $0.30 | $0.217 ($0.015 frame + $0.202 grounded) |

The frame call wrote 511 output tokens and the grounded call 2,434, with 3 searches and 93,069 cached input tokens read, so the grounded prompt still qualifies for caching. The provisional score was 52 Moderate and the sourced score 62 Moderate, a 10-point move, which the page states in words.

## Problem

`server.js:407` tells the model "Search the web before you write anything", so the whole analysis waits behind the search phase. The progressive renderer in `public/app.js:814` already streams each section the moment its JSON key completes, but it never gets the chance: the first character of JSON only arrives after the last search returns. A live run takes from a minute upwards, and for all of it the reader gets a list of `q:` lines and then the entire page in one burst.

Only two of the seven sections actually need the searches. The diagram, summary, mechanisms, assumptions and probing questions are gated by a sentence in the prompt, not by any data they depend on.

## Success criteria

1. Diagram, summary, mechanisms, assumptions and probing questions are on screen in under 15 seconds. The real figure gets measured on the first run rather than assumed.
2. Evidence and historical examples land no later than they do today.
3. The strength score shown early reads as provisional while the grounded call is still running, and settles visibly when the grounded score arrives.
4. Cost per run stays within about $0.05 of today's $0.16 to $0.30.
5. No run can leave a half-filled page with no explanation. If either call fails, the page says which part is missing.

## Scope

In:

- Split `/api/analyze` into two model calls that run in parallel and share one SSE response.
- Frame call, no tools: `strength`, `strength_label`, `summary`, `assumptions`, `mechanisms`, `probing_questions`.
- Grounded call, `web_search` as today: `strength`, `strength_label`, `evidence_for`, `evidence_against`, `historical_examples`.
- Client: one buffer per stream, its own section order and rendered-set, and a merge rule for the two scores.
- A confirming state on the strength badge and diagram arrow while the grounded call runs.
- Cache entry holds both streams.
- Tests for the split, the protocol, the cache round trip and the score revision.

Out:

- The search cap stays at 3 (tuned in step 3 of `PRD-evidence-freshness.md`).
- The evidence sourcing rules in the prompt are copied across unchanged.
- Citation lookups and their budget slice are untouched.
- The grounded call does not revise the summary. The frame's summary stands for the life of the page.

## Design

### Server

One endpoint, two `client.messages.stream()` calls started back to back, both writing into the same response. Every SSE frame gains a stream tag:

```
data: {"chunk":"...","s":"frame"}
data: {"chunk":"...","s":"grounded"}
data: {"done":true,"s":"frame"}
data: {"done":true}          // both finished
```

The budget check and `reserveSpend()` happen once, before either call starts. Each call settles its own cost into the day with `settleSpend`, so the existing meter arithmetic does not change shape. The frame call costs roughly $0.01 (no searches, about 1,000 tokens in and 900 out at the Opus 4.8 prices in `server.js:196`); the grounded call carries what an analysis costs today minus the output it no longer writes.

Both prompts keep the "always emit every key" sentence. `progressive-render-optional-keys` in project memory is the reason: an absent key and one still streaming are the same `null` to `extractCompleteJsonValue`, and either stalls the loop.

### Client

`buffer` becomes `buffers = { frame: '', grounded: '' }`. `tryProgressiveRender` takes a stream name and walks only that stream's key order:

```
FRAME_SECTIONS    = ['strength','strength_label','summary','assumptions','mechanisms','probing_questions']
GROUNDED_SECTIONS = ['strength','strength_label','evidence_for','evidence_against','historical_examples']
```

`_renderedSections` and `_partialData` stay shared, so the diagram still renders once `strength`, `strength_label` and `summary` are all present regardless of which stream supplied them. The rendered-set gets a stream prefix on the two shared keys so the grounded score is not skipped as already rendered.

The final pass parses both buffers and merges them, grounded winning on shared keys, before `renderResults` and `scheduleRelatedCategories`.

### The provisional score

The frame call writes a score from model knowledge. The grounded call writes one after reading its search results. Until the grounded score arrives the diagram renders with the frame's value and the strength badge carries a confirming state; when it arrives the arrow's stroke weight, opacity and dash pattern transition to the grounded values and the badge drops the confirming state.

The confirming state reuses the shimmer already on `.skel` (`public/index.html:540`) applied to the badge, plus one line of text ("Checking this against sources"). `design.md` bans fake live indicators, and this one is driven by whether the grounded stream is actually still open, so it qualifies. No pulsing dot regardless.

If the two scores differ the number and the arrow animate to the new value rather than snapping. A move that a reader would notice is also stated in words: when the label changes or the score moves by 10 points or more, a line under the badge reads "First read: 72 Moderate. After checking sources: 45 Weak." A smaller move transitions silently, because a 3-point drift is noise and narrating it would teach readers to distrust a number that did not really change.

## Constraints, dependencies, edge cases

- **Prompt caching minimum.** Today's prompt is about 1,130 tokens against a 1,024-token minimum on this model, and it only just qualifies. The frame prompt is shorter and will fall under, so `cache_control` comes off that call rather than paying the 1.25x write premium for a cache that never reads. The grounded prompt keeps the marker and keeps its `cache_write` line in the analyze log as the check that it still qualifies.
- **Frame fails, grounded succeeds.** The grounded call also emits `strength`, `strength_label`, so the diagram still renders, without a summary. The summary area shows a short line saying that part could not be written.
- **Grounded fails, frame succeeds.** The frame stays on screen. Both evidence columns and the history section render a failure line rather than sitting on skeletons, and the badge drops the confirming state to unconfirmed rather than pretending the check finished.
- **Both fail.** The existing error banner, unchanged.
- **Cache format.** Entries become `{frame, grounded}` instead of a single `text`. Entries already on disk have `text` and are skipped on load; the TTL is 24 hours, so the old shape drains itself within a day of the deploy.
- **Two reservations, one budget.** Both calls reserve before starting so a burst of concurrent analyses cannot read a budget that running analyses have committed but not reported.
- **i18n.** Two new keys in `locales/en.json`: the confirming line and the per-section failure line. They pass through the `localize` package the same as the rest.

## Build plan

1. Split the prompt into two, keeping the sourcing rules intact in the grounded half. Pin both with tests the way `test/unit.test.js` already pins the "always emit both keys" sentence.
2. Server: run both calls, tag every SSE frame, settle both costs, log one line per call.
3. Cache: store and replay both streams, skip legacy entries on load.
4. Client: two buffers, per-stream section order, merged final parse.
5. Client: confirming state on the badge, transition when the grounded score lands.
6. Failure paths for each of the three combinations.
7. Tests, then the smoke test against a date-stamped input.
8. Deploy through the Coolify `/deploy` call (a push alone does not deploy this project) and check the first live run's timings and cost in the logs.

Roughly half a day.

## Decisions taken

1. Probing questions sit in the frame call and are ungrounded. Confirmed 2026-09-12: they read as prompts for the reader rather than claims, so the loss of grounding does not cost anything a reader would act on.
2. A score move the reader would notice is stated in words rather than transitioned silently. Confirmed 2026-09-12. Threshold: the label changed, or the score moved by 10 points or more.
