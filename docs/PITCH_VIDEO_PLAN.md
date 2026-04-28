# Trace pitch video plan

Last updated: 2026-04-28

This document defines the recommended three-minute finalist pitch structure for
Trace.

The pitch should not try to explain the whole system. It should tell a clean
story that makes the project memorable.

## 1. Core message

Trace is an AI-assisted investigation workflow for cold archives that helps
compliance and trust teams find, explain, and hand off the right evidence fast.

That is the sentence the audience should remember.

## 2. Target three-minute structure

### 0:00 to 0:20 - problem

Explain:

- archived investigation records are hard to search with keywords alone
- the right record may describe the same issue using different language
- purely broad semantic search can still be noisy for real operational work
- investigators need a defensible answer, not just a better result list

Target line:

"Operators investigating historical incidents often know the intent of what
they need, but not the exact wording. Keyword search misses important evidence,
and broad semantic search alone is not precise enough for real workflows or
defensible handoffs."

### 0:20 to 0:40 - solution

Explain:

- Trace is purpose-built for cold archive investigation
- it combines semantic retrieval with safe metadata filtering
- it is designed to turn archive search into a more explainable investigation workflow

Target line:

"Trace solves that by combining semantic search with constrained filters and an
AI-assisted handoff flow, so teams can find the right archived records even
when wording differs, then narrow and explain the evidence they need."

### 0:40 to 1:50 - demo

Show:

- one query that demonstrates semantic advantage
- one filtered refinement that demonstrates operational precision
- result cards with metadata and provenance
- one AI-native explanation or handoff moment

Narration goals:

- explain what the user searched for
- explain why the result is correct
- explain what would have gone wrong with weaker search modes
- explain how Trace helps the investigator move from search to action

### 1:50 to 2:20 - credibility

Explain briefly:

- Rust Lambda search service
- Lance dataset on S3
- deployed HTTP endpoint
- MCP bridge for agent access
- proof tooling and local relevance evaluation

This section should reassure judges that the project is real without dragging
the pitch into architecture overload.

### 2:20 to 2:45 - why it stands out

Explain:

- not just vector search
- not just a demo wrapper
- hybrid retrieval built around a specific operator workflow
- clear value in high-stakes archival search tasks
- a visible AI layer that helps with trust and handoff, not just recall

Target line:

"What makes Trace stand out is that it is not generic search infrastructure. It
is a purpose-built investigation workflow that balances semantic flexibility
with structured control and explainable evidence handoff."

### 2:45 to 3:00 - close

Close with:

- who it is for
- the core workflow improvement
- why that matters

Target line:

"Trace makes cold archive investigation faster, more reliable, and more
trustworthy for teams who cannot afford to miss the right record or misread the
evidence."

## 3. Asset checklist

Prepare these before recording:

- one clean title slide
- one problem slide or visual
- one short architecture visual
- one polished live or recorded product demo
- one side-by-side comparison artifact
- one metric or benchmark slide sourced from `docs/BENCHMARK_EVIDENCE.md`
- one explanation or evidence-handoff visual
- one closing slide with the product promise

The committed side-by-side proof pack is `docs/PROOF_OF_VALUE.md`.
Use the same two artifact IDs in the pitch script and backup slides:

- `insurance-keyword-gap`
- `insurance-scope-gap`

When citing those artifacts, keep the claim boundary explicit: they are
selected local retrieval comparisons from the committed eval corpus, not a
broad benchmark or a deployed-path equivalence claim.
For the benchmark slide and spoken metric callout, reuse the canonical Step 4
wording from `docs/BENCHMARK_EVIDENCE.md` so the README, demo, and pitch all
quote the same bounded numbers.

## 4. Recording guidance

Keep the pitch strong by following these rules:

- lead with the user and problem, not the stack
- do not spend too long on architecture
- zoom in enough that search results are readable
- keep the cursor motion calm and intentional
- show one excellent flow rather than many partial flows
- record backup clips for every critical demo moment

## 5. What not to do

Avoid these common pitch mistakes:

- opening with technical implementation before the user problem
- trying to explain every subsystem
- using more than one main persona
- showing a query with unclear payoff
- relying on judges to infer why the project is useful
- ending without a memorable one-sentence summary

## 6. One-sentence close options

Candidate closing lines:

- "Trace helps investigators find, explain, and hand off the right archived evidence when exact keywords are not enough."
- "Trace brings semantic understanding, structured precision, and explainable handoff together for cold archive review."
- "Trace turns archive search from guesswork into a trustworthy investigation workflow."

Pick one and reuse it consistently in submission materials.
