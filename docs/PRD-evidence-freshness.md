# PRD: Grounded evidence

- Status: sections 1 and 2 signed off 10 September 2026; steps 1, 2 and 4 built
- Author: drafted 10 September 2026, revised same day
- Owner: Matt Stempeck

## Problem

`/api/analyze` asks Opus 4.8 to name three pieces of evidence for and three against a theory of change, plus three historical examples. Every one comes out of the model's training data. On stable topics that is fine. On fast-moving ones it ships stale claims with a confident citation attached.

The case that triggered this: the tool returned "Low AI reliance for voting — few voters currently rely on AI chatbots for election logistics; reach is a major limiting factor", cited to Pew Research Center AI adoption surveys 2023–2024. By September 2026 that is wrong in both directions it could be checked:

- Pew, February 2026: 49% of US adults use AI chatbots, up from 33% in 2024.
- Demos, May 2026: 1 in 5 UK adults used an AI chatbot or AI search to look up information about the 7 May 2026 local and devolved elections.

The failure is not that the model was wrong. It answered correctly from what it knew. The failure is that the tool presented a two-year-old figure as current, with no attempt to check.

This matters more than a normal accuracy bug because the product's whole proposition is that it weighs evidence. A citation that looks precise and is two years out of date is worse than no citation.

## Approach

Derive the claims from the sources, rather than generating claims and then checking them.

This is the correction that matters, and it is bigger than freshness. The current prompt asks for three items in `evidence_for` and three in `evidence_against`, so the model decides what column it is filling, writes a claim to fit, and attaches a citation to it afterwards. Under that order the citation is decoration. It is chosen to support a claim that already exists, which is exactly how "few voters rely on AI chatbots" came to be filed as supporting evidence with Pew's name on it.

Under source-first ordering the question never arises. You search, you read what the sources actually found, and each finding lands in the column its content supports. Demos found that 20% of UK adults used AI to look up election information and that 49% do not trust it for that purpose. That is evidence *against* a theory resting on low AI reliance. It would have been filed correctly on the first pass, because the column is a property of what the source says, not a slot chosen in advance.

So search is not a freshness patch bolted onto a claim-first generator. It inverts the generation order:

1. Search for what is actually known about the question.
2. Read what the sources found.
3. State each finding, with its source and its date.
4. Assign it to the column it supports.

Two earlier drafts are superseded. The first proposed tagging claims `stable` or `moving` and re-checking the moving ones; the second proposed always searching but kept the claim-first order and treated a reversed claim as an awkward edge case needing UI work. Both were patches on the wrong layer.

## The fixed 3/3 quota has to go

`server.js:290` requires exactly three items in every array. Combined with claim-first ordering that is a fabrication mandate: when the real evidence is lopsided, the model must invent three items for the thin side anyway. Grounding in real sources does not fix this on its own — it means the invented items now arrive with genuine citations attached, which is worse, because they look checkable.

If claims are derived from sources, the split cannot be specified in advance. The counts have to follow the evidence.

**Decided 10 September 2026: a floor rather than a quota.** Zero to three items per column, three being a ceiling rather than a requirement, with an explicit empty state where a side genuinely has nothing. "No substantial evidence against this was found" is a real and useful finding for a tool whose job is weighing evidence. Rendering it honestly is better than three manufactured counterpoints.

This touches the frontend, which assumed three cards per column. Done in step 1: `renderEvidenceColumn` renders a variable number of cards and an empty state that reads as a finding.

## Weighing sources against each other

Once claims come from sources, the judgment moves to which sources to trust and cite. Newer is not better by default; a tool that always led with the most recent citation would be a different kind of wrong from the one being fixed.

**Recency governs claims about a quantity that moves.** Adoption rates, usage shares, polling, prices, headcounts, error rates. A 2024 figure for how many people use a technology is superseded by a 2026 figure, full stop. This is the class the AI-elections claim falls into.

**Standing governs claims about a mechanism or an effect.** Whether framing changes attitudes, whether nonviolent campaigns outperform violent ones, whether contact reduces prejudice. A landmark, replicated, peer-reviewed finding is not displaced by one recent survey, a preprint, or a single-country study. Chenoweth and Stephan's 3.5% finding does not get overwritten because something newer exists.

**When a recent finding genuinely contradicts an established one, both get stated.** Under source-first ordering this needs no special handling: two sources disagree, so two findings exist, and they land in opposite columns on their own. A contested mechanism is a real state of the evidence and the tool should show it as one.

**Weigh the source, not just the date.** A national statistical agency, a peer-reviewed journal, or an established survey programme outranks a think-tank blog post, which outranks a vendor's own research, whatever the publication dates.

**Prefer the primary source over coverage of it.** If search surfaces a news article about a study, cite the study.

## Success criteria

1. On a theory of change about AI, a claim overtaken by 2026 research comes back with the 2026 figure. Test case: the AI-chatbots-and-elections claim above.
2. On a theory of change resting on a landmark finding, that finding is still returned and is not displaced by something newer and weaker. Test case: the 3.5% rule.
3. Where recent work genuinely contradicts established work, both appear rather than one silently winning. Test case: a claim where 2026 evidence reverses a 2023 consensus.
4. Every claim is what its cited source actually found. Spot-check: pull ten citations at random and read them. A claim the source does not support is a failure of this feature even if the source is current and reputable.
5. Where the evidence is genuinely lopsided, the thin column is short or empty rather than padded. Test case: a theory of change with strong one-sided support.
6. Every evidence item and historical example carries the year of its evidence.
7. Added cost stays under $0.06 per uncached analysis.
8. The user sees something within a second of submitting, even though the first token now takes longer.

## Scope

**In**

- `web_search_20260209` on the `/api/analyze` call, with a `max_uses` cap.
- Source-first prompt ordering: search, read, state the finding, then assign the column.
- Replacing the fixed 3/3 quota with evidence-led counts, and a frontend that renders a variable number of cards per column plus an honest empty state.
- An `as_of` year on each evidence item and historical example. Free, and it makes the age of a claim visible whether or not search found anything.
- The stature-versus-recency rubric above, written into the prompt.
- A loading state that covers the new pre-token gap.
- Cost and search-count logging.

**Out**

- Per-claim volatility tagging and the `/api/freshen` endpoint. Superseded by this draft.
- Changing the model. `server.js:310` already runs `claude-opus-4-8`.
- Searching `assumptions`, `mechanisms`, or `probing_questions`. Analytical, not empirical, nothing to date.
- Verifying that a claim is *true*. This grounds claims in current sources; it does not adjudicate them. Different and much larger problem.
- Backfilling analyses already in the 24-hour cache.
- Non-English sources beyond whatever search returns unprompted. No translation pass.

## Constraints and dependencies

**Which model, and the cutoff question.** No Claude model has "no knowledge cutoff" — every one has a training cutoff, and a newer model moves the cliff rather than removing it. What closes the gap is the server-side **web search tool**, which runs on Anthropic's infrastructure and is a per-request tool declaration, not a property of the model. The question is therefore which models can carry the current variant:

- `web_search_20260209` — current, with dynamic filtering. Requires Opus 5, Opus 4.8/4.7/4.6, Sonnet 5, or Sonnet 4.6. Code execution runs under the hood, so `code_execution` must **not** also be declared in `tools`.
- `web_search_20250305` — basic variant, for older and smaller models.

`server.js:310` runs `claude-opus-4-8`, which supports `20260209`. `/api/source-url` (`server.js:482`) runs Haiku 4.5, which does not, and that is why it carries the basic tool. Nothing about this feature requires changing either model.

**Cost.** $10 per 1,000 searches plus tokens for retrieved content, roughly $0.02 per search. At `max_uses: 3` an uncached analysis adds about $0.06 on top of generation. The existing 24-hour analyze cache (`CACHE_TTL_MS`, `server.js:187`, disk-persisted) absorbs repeats, so cost scales with distinct theories of change rather than with page loads.

**Latency is the real price of this change.** Search adds 4–5 seconds per lookup, measured during the source-URL work. Putting it on the main call means time to first token goes from under a second to somewhere around 5–15 seconds depending on how many searches the model runs. The current UI streams almost immediately and that is what users feel. This needs a genuine loading state — the "looking up…" treatment already built for source URLs is the closest existing pattern.

**Rate limiting.** **Decided 11 September 2026.** Two guards, since one uncached analysis costs about $0.58 rather than the $0.06 estimated here. `/api/analyze` is capped at 5 requests per 15 minutes per IP, down from 20, which is about $2.90 per IP per window and still more theories than one sitting produces. On top of that a global ceiling of $25 of new analyses per UTC day (`DAILY_BUDGET_USD`), counted from `msg.usage` at list prices and held on disk beside the analyze cache so a redeploy does not hand the next visitor a fresh budget. Past the ceiling, anything already in the 24-hour cache still answers and a new theory gets told to come back tomorrow. Inside the day's ceiling, citation lookups get a slice of their own (`DAILY_LOOKUP_BUDGET_USD`, default $5) rather than the run of it: they cost cents, fire several times on one page and need no account, so on a shared ceiling an afternoon of clicking could spend the day the analyses needed. An analysis always has at least $20 available.

**Edge cases**

- Search finds nothing relevant. Fall back to the model's own knowledge and set `as_of` honestly. Do not fabricate a recent citation to satisfy the rubric.
- A source contradicts the theory of change rather than supporting it. Not an edge case under source-first ordering — it is an `evidence_against` item, which is what that column is for. The Demos finding is this case and belongs there on the first pass.
- A source is genuinely ambiguous, or supports the theory on one measure and undercuts it on another. Pew's 2026 chatbot adoption data is like this: it raises reach, which cuts against a low-reliance premise, while saying nothing about election use specifically. State what the source measured and let the column follow that, rather than forcing a reading the source does not support.
- Server-tool errors do not raise. Web search failures come back HTTP 200 with an error object inside the result block. Handle explicitly or the analysis silently degrades to ungrounded output with no signal.
- `textFromContent` (`server.js`, added for source URLs) exists because `parseSourceUrl` uses a greedy `/\{[\s\S]*\}/`. The analyze response has the same shape problem once search blocks are present: the JSON is no longer the whole of the content. Join text blocks only, and check the frontend's accumulating parser against a response that contains search blocks before assuming it holds.
- A curl 403 or 406 against a returned URL is not a dead link. bipartisanpolicy.org and ericachenoweth.com both bot-block curl. Do not add a liveness check that treats it as failure.
- The model may spend all its searches on the first evidence item. `max_uses` caps total searches, not their distribution. Watch for this in step 2.

## Build plan

1. **Reorder the prompt.** Rewrite `/api/analyze` to instruct source-first generation: find what is known, state each finding with its source and date, then assign the column. Add `as_of` to the evidence and historical-example objects and the source-weighting rubric to the prompt. Replace the fixed 3/3 quota with evidence-led counts. No search yet, no cost — the ordering change is worth testing on the model's own knowledge first, because it is the half of the fix that does not depend on search working.
2. **Attach search.** Add `web_search_20260209` with `max_uses: 3` to the analyze call. Verify the streamed response still parses on the frontend with search blocks present, and that server-tool errors are caught rather than swallowed.

   Built 11 September 2026. Measured on the AI-elections test case: three searches, no search errors, and four findings split two and two rather than three and three, all cited to 2024 and 2025 work the model could not have known. Two things came out of the run that step 3 and step 4 need. The model opens with a sentence about what it is going to search for, before the JSON, so the buffer is no longer JSON and nothing else; `extractJsonObject` in `public/app.js` now takes the first complete brace-balanced span rather than everything between the outer braces. And the whole call took 7 minutes 44 seconds, against the 5 to 15 seconds this document estimated. First token arrived in 2.4 seconds, but it was the narration, not content. One sample, worth repeating before drawing the cap from it.

   A second run, 11 September 2026, on a basic income theory, with `msg.usage` now logged: **$0.5838**, from 92,269 input tokens, 3,699 output tokens and 3 searches. Criterion 7 asks for under $0.06 of added cost. The searches themselves are 3 cents of that; the retrieved content re-read on each pass of the server-side tool loop is the other 46 cents. 6 minutes 36 seconds end to end.

   **Caching the tool loop, 11 September 2026.** The bill is not the searches, it is their results being read again on every pass of the server-side tool loop. Web search writes its own cache entry after each result block, but only when the request is already caching, so the analyze call now marks its prompt with `cache_control`. A run measured afterwards billed 10 input tokens against 30,626 read from cache, which is the loop re-reading its own results about four times over and now paying a tenth for it. That run cost $0.159 where its own token counts put it at about $0.29 uncached, so roughly 45 percent off, and it came back in 56 seconds. The prompt is 1,131 tokens against a 1,024-token minimum on Opus 4.8, so the margin is 107 tokens: shorten the prompt and caching stops silently, visible only as `cache_write=0` in the analyze log line.

   That run also showed the failure this feature can have without anyone noticing. The model spent its three searches, got nothing usable back, wrote "the web_search tool has hit a hard usage cap for this session and is not recovering", and answered from training data. The turn ended cleanly, the JSON was well formed, three searches were billed, and no error block appeared, so the analysis was indistinguishable from a grounded one. `webSearchUsage` now counts the results returned as well as the searches made, and an analysis that got zero results back warns. Grounded and ungrounded answers are the same price.
3. **Tune the cap and the rubric together** against the three test cases in the success criteria. `max_uses` and the rubric wording interact — a tight cap makes the model ration searches in ways that change which claims get grounded.
4. **Loading state.** Cover the pre-token gap. This is now a several-second wait on a surface that previously responded instantly.

   Built 11 September 2026. The wait shows the searches themselves, one line each, as the model issues them: the `q:<keywords>` notation it writes before the JSON arrives seconds after submitting, where the first content does not arrive for a minute or more. Only that notation is rendered. When a search fails the model drops back into prose about rate limits, which is it talking to itself rather than to the reader, so `extractSearchQueries` matches the notation and ignores everything else. The block also gets height of its own and is scrolled into view as it opens, because it sits below a tall hero and was otherwise half under the fold with nothing able to scroll it clear, which reads as though the button did nothing.
5. **Tests.** Parser coverage for a response containing search blocks, the search-error path, and the cap. Fixtures for all three test cases as regressions, matching the existing 104-test suite.
6. **Measure in production for a week.** Searches per analysis, added cost per analysis, time to first token. Then revisit the cap and the rate limit.

## Open questions

1. ~~How does the frontend render variable counts?~~ Resolved in step 1. Still open: the empty-state wording is hardcoded English in `public/app.js`, because interface translation (commit 4fa4854) has not merged yet. It needs a `locales/en.json` key once it does.
2. Is there a floor below which the analysis is not worth showing? If search surfaces one weak source on each side, the honest output is thin, and thin may read as broken.
3. Is `max_uses: 3` right? Under source-first ordering searches are no longer per-claim — they are the input to the whole analysis, so the cap now determines how much the model knows before it writes anything, not how many claims get checked. That probably argues for a higher cap than the per-claim framing did.
4. Should `as_of` be shown on every claim, or only where age matters? A year on a landmark 1970s study is noise; hiding it on a 2024 adoption figure defeats the point.
5. Does the 24-hour analyze cache stay at 24 hours? Longer saves money now that each miss costs about $0.06; shorter keeps fast-moving topics fresher. These now pull against each other in a way they did not before.
6. ~~Is the latency acceptable, or does this need to stream ungrounded output first and revise in place?~~ **Decided 10 September 2026: grounded but slow.** No revise-in-place. Under source-first ordering it would mean claims visibly jumping between columns as sources land, which is worse than a wait. Step 4's loading state now has to carry the whole gap.
