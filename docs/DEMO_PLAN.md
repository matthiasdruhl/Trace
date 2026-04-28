# Trace demo plan

Last updated: 2026-04-28

This document defines the recommended demo structure for Trace in the
Handshake x OpenAI Codex Creator Challenge. The goal is not to show every
feature. The goal is to make the value obvious fast.

## 1. Demo objective

A strong Trace demo should prove three things in under two minutes:

- keyword search is not enough for this workflow
- semantic search alone can still be too broad
- Trace's investigation workflow finds, explains, and narrows the right evidence

## 2. Recommended audience framing

Primary persona:

- Maya Chen, a senior trust and safety or compliance investigator at a mobility platform

Default audience story:

- a trust and safety or compliance investigator needs to search archived incident records
- the archive is large, language is inconsistent, and the operator often knows only partial context
- the operator needs trustworthy results quickly, not just approximate matches
- the operator ultimately needs a defensible handoff, not a loose pile of results

Use that framing consistently in the spoken demo, README, and UI copy.

## 3. Ideal live-demo sequence

### Segment 1: establish the problem

Suggested script:

"Maya is trying to respond to a case escalation, but the exact words
in the query often do not appear in the records. Keyword search can miss the
right evidence, and semantic search without filters can still return results
that are too broad for a real investigation or regulator response."

Keep this segment under 20 seconds.

### Segment 2: show the core Trace win

Recommended first query:

- pick one memorable natural-language query where keyword matching is weak but the semantic intent is strong

What to show:

- the query
- the interpreted case request or visible filters if available
- the top Trace results
- why those results are relevant even if wording differs
- provenance or record metadata

Goal:

- demonstrate that Trace understands the investigation intent, not just exact terms

### Segment 3: show why filters matter

Recommended second query:

- use a similar query but add a clear metadata constraint such as `city_code`,
  `doc_type`, or a date/timestamp window

What to show:

- without the filter, results are broader
- with the filter, the result set becomes operationally useful
- every returned row obeys the investigation constraint
- the operator is now closer to an evidence handoff instead of more manual search work

Goal:

- prove that Trace is not "just semantic search"

### Segment 4: close with proof and trust

What to say briefly:

- the search runs against a deployed Lambda-backed Lance dataset on S3
- the same path is exposed through an MCP bridge
- the repo includes proof artifacts and local relevance evaluation, not just a mock UI
- the AI layer is visible through interpreted filters, explanations, or a short investigation summary

Goal:

- convert the demo from "nice prototype" to "credible product"

## 4. Demo assets to prepare

Prepare these before submission:

- three memorable example queries
- one query where keyword search fails visibly
- one query where semantic plus metadata filtering matters visibly
- one AI-assisted explanation or handoff moment
- one screenshot or stable fixture per key demo moment
- one short architecture visual
- one benchmark or eval summary line

## 5. Recommended query set

Trace should have a small fixed set of queries that are reused everywhere:

- README examples
- UI quick-start examples
- live demo
- pitch video
- stable fixtures

Target set size:

- three to five examples total

Each example should have a job:

- one proves semantic advantage
- one proves filtering advantage
- one proves practical operator value and supports an evidence handoff

## 6. UI recommendations for the demo surface

If a small UI is built, prioritize these elements:

- one prominent search box
- visible safe filter controls
- copyable example queries
- visible interpreted filters or case framing
- readable result cards
- metadata badges
- a visible "why this matched" explanation
- a short evidence handoff or investigation summary
- result timing and count
- helpful no-results guidance

Avoid demo clutter. One strong flow is better than a broad dashboard.

## 7. Side-by-side comparison artifact

This is one of the highest-value demo additions.

Build a simple comparison table or visual for one case:

- keyword-only result quality
- semantic-only result quality
- Trace hybrid result quality

For each mode, show:

- what was retrieved
- what was missed
- why the Trace output is the best operational answer

The committed proof pack now lives in `docs/PROOF_OF_VALUE.md`.

Use these two artifact IDs everywhere:

- `insurance-keyword-gap`
- `insurance-scope-gap`

This artifact can be used in the README, pitch video, and judge-facing docs.
When quoting it live, describe it as selected local retrieval evidence from the
committed eval corpus, not as a broad benchmark or deployed-path proof.

## 8. Demo failure-prevention checklist

Before any recording or live demo:

- use fixed example queries that have already passed proof checks
- confirm the deployed path still works
- have screenshots or stable fixtures ready as fallback
- keep one local fallback demo path in case cloud setup misbehaves
- avoid typing complex filters live if a safer preset UI is available
- do not rely on explaining hidden implementation details to rescue clarity
- keep the AI-assisted explanation or handoff moment deterministic enough to demo confidently

## 9. Success criteria

A winning demo should make a viewer think:

- "I immediately get the problem"
- "I can see why this is better than normal search"
- "I can see how this helps someone finish the investigation, not just search faster"
- "This feels real and trustworthy"
- "I can imagine someone using this"

If the demo only proves that the backend works, it is not yet strong enough.
