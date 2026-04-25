# Trace competition strategy

Last updated: 2026-04-24

This document is not a general product roadmap. It is a scoring-oriented plan
for maximizing Trace's odds in the Handshake x OpenAI Codex Creator Challenge.

The key rule is simple:

- do not optimize only for backend completeness
- optimize for what judges and AI evaluators can understand, verify, and remember quickly

## 1. What judges need to believe fast

To score highly, Trace should feel obvious within the first minute:

- who it is for
- what painful workflow it improves
- why existing approaches miss important results
- why Trace's investigation workflow is better than plain search
- that the system actually works end to end

If those points are not legible immediately, technical depth alone will not be
enough to maximize the score.

## 2. Recommended product framing

Use one primary user and one primary workflow everywhere.

Recommended default positioning:

- User: regulatory, compliance, trust and safety, or audit operators investigating high-stakes archived cases
- Problem: keyword search misses related incidents when language differs, and naive semantic search alone is too loose for real operational decisions
- Solution: Trace combines semantic retrieval with constrained metadata filtering and AI-assisted evidence framing so operators can find, explain, and hand off the right archived records faster

Working positioning sentence:

> Trace is an AI-assisted investigation workflow for cold archives that helps
> compliance and trust teams find, explain, and hand off the right evidence
> fast even when exact keywords do not match.

Everything in the README, demo, UI, and pitch should reinforce one version of
that story.

## 3. Score-maximizing additions beyond the current engineering backlog

These items are not fully captured by `docs/NEXT_STEPS.md`, but they are high
leverage for competition scoring.

### Clarity

Highest-value additions:

- add a short "Problem / User / Why existing search fails / Why Trace" section to the README
- keep one concrete user persona throughout the project
- show one architecture diagram that explains the flow in a few seconds
- provide three memorable example queries with expected outcomes

Target outcome:

- a new reader should understand Trace without reading implementation docs

### Usefulness / value

Highest-value additions:

- show one workflow where keyword search fails but Trace succeeds
- show one workflow where semantic search alone is not enough, but semantic plus metadata filtering succeeds
- add one concise impact statement such as fewer missed incidents, faster triage, or more trustworthy archive investigation
- package the retrieval-eval result into one or two quotable metrics

Target outcome:

- judges should see a practical workflow improvement, not just a search stack

### Creativity

Highest-value additions:

- make the hybrid-search angle explicit rather than assuming judges will infer it
- add one memorable "why this matched" or "explain the result" feature
- consider a natural-language-to-safe-filter experience if it can be implemented cleanly
- make the MCP and Codex angle visible through an AI-assisted investigation handoff, not just a hidden bridge
- highlight that Trace is built for cold archives where exact wording often differs from the original query

Target outcome:

- the project should feel like a clear product insight, not a generic vector search demo

### Execution

Highest-value additions:

- keep the deployed proof path easy to rerun
- add a minimal polished interface or walkthrough surface
- make demo queries deterministic and tested
- make failures graceful: empty states, invalid filter messages, no-result guidance

Target outcome:

- the demo should feel reliable enough to show live without caveats

### Polish and thoughtfulness

Highest-value additions:

- result cards that expose filters, matched metadata, and provenance cleanly
- consistent naming across docs, scripts, UI, and pitch
- screenshots or short GIFs in the README
- an intentional demo path that starts strong without setup confusion

Target outcome:

- the project should feel like a real tool, not a bundle of components

## 4. Recommended competition workstreams

If time is available, the best scoring lift likely comes from the following
four workstreams.

### Workstream A: product story and repo presentation

Deliverables:

- README rewrite oriented around problem, user, and value
- one-paragraph differentiator against keyword-only search
- one-paragraph explanation of why filters matter
- one short visual architecture diagram

Why it matters:

- this is the fastest way to improve clarity and perceived usefulness

### Workstream B: demo surface

Deliverables:

- a small UI or polished walkthrough surface
- a fixed set of strong example queries
- visible filter controls or safe structured inputs
- result explanations or provenance indicators
- an investigation-summary or evidence-handoff moment that makes the AI layer visible

Why it matters:

- this produces the strongest gain across clarity, execution, and polish

### Workstream C: evidence and comparison

Deliverables:

- one side-by-side comparison of keyword-only, semantic-only, and Trace hybrid retrieval
- one or two quotable evaluation metrics from the local relevance harness
- one benchmark summary with limited but real deployment numbers

Why it matters:

- this turns architecture into evidence judges can trust

### Workstream D: finalist pitch readiness

Deliverables:

- a three-minute script
- a demo sequence designed around the script
- screenshots, captions, and fallback visuals
- one memorable sentence that explains why Trace stands out

Why it matters:

- if Trace reaches the top 10, this work can materially influence the final ranking

## 5. Suggested execution order

If the core backend remains stable, the highest expected-value order is:

1. sharpen the product framing around one user and one workflow
2. build or refine the demo surface
3. create a side-by-side comparison artifact that proves Trace's advantage
4. make the README and docs competition-legible
5. add lightweight explainability and trust details
6. package one or two benchmark and relevance numbers into a memorable summary
7. prepare the pitch assets early rather than after everything else

## 6. Concrete "win more often" checklist

Before submission, Trace should ideally have:

- a README that a non-specialist can understand in under a minute
- one dominant persona and workflow used consistently
- three demo queries with expected outcomes
- at least one side-by-side "keyword fails, Trace succeeds" artifact
- at least one "semantic alone is insufficient, filters matter" artifact
- one polished demo surface, even if minimal
- one memorable AI-native moment such as interpreted filters, why-this-matched, or an evidence handoff
- one or two quotable metrics
- one clean architecture visual
- one rehearsed three-minute pitch path

## 7. Anti-patterns to avoid

These can lower competition performance even if the repo gets technically stronger:

- adding more infrastructure depth without making the product easier to understand
- presenting Trace as generic vector search instead of an investigation workflow
- burying the best demo query under too much setup
- using too many personas or use cases at once
- shipping a strong backend with no polished front door
- relying on judges to infer the novelty instead of stating it directly

## 8. Practical success test

A strong challenge submission should let a judge answer "yes" to all of these:

- I know who this is for
- I know what problem it solves
- I can see why the current alternatives are worse
- I can see it working
- I can explain in one sentence why this project is special

If any of those answers is "not yet," the next best work is probably product
clarity, demo design, or polish rather than more hidden backend depth.
