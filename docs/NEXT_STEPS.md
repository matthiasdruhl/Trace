# Trace next steps

Last updated: 2026-04-28

This is the active prioritized backlog for Trace.

It is intentionally optimized for the current goal:

- maximize the odds of winning the Handshake x OpenAI Codex Creator Challenge

That means the next steps are not just about backend completeness. They are
ordered around what will most improve:

- clarity
- usefulness
- creativity
- execution
- polish

Use `docs/PROJECT_STATE.md` for a detailed snapshot of what already exists.
Use `docs/COMPETITION_STRATEGY.md`, `docs/DEMO_PLAN.md`, and
`docs/PITCH_VIDEO_PLAN.md` for scoring-oriented guidance.

## Status terms

- `Complete`: the milestone already has real evidence or shipped artifacts in this repo/workspace
- `Partially complete`: some enabling code or docs exist, but the milestone still needs visible deliverables
- `Not implemented yet`: still backlog

## What is already complete

These are no longer the main bottlenecks:

1. Ingestion and retrieval alignment
Status: `Complete`

- deterministic source-record generation exists
- `openai` is the default embedding path
- `random` remains explicit smoke mode only
- source parquet and seed manifests are emitted for provenance

2. Eval dataset path
Status: `Complete`

- the embedding-backed eval dataset was generated, validated, and uploaded
- the active eval dataset is `s3://trace-vault/trace/eval/lance/`
- the smoke dataset remains `s3://trace-vault/uber_audit.lance/`

3. Deployed proof path
Status: `Complete`

- deployed HTTP proof and MCP proof both exist
- proof fixtures are committed
- `trace-eval` has a successful full proof run

4. Local retrieval relevance harness
Status: `Complete`

- a labeled local relevance harness exists
- baseline comparisons exist
- at least one real report has been generated

These are important foundations, but they should no longer dominate planning.

## Highest-priority next steps

These are the best scoring opportunities now.

## 1. Clarify the product story everywhere

Status: `Complete`

Why this matters:

- Trace currently reads as technically credible, but the user, workflow, and
  value proposition are still too implicit
- this is the fastest path to improving challenge scores for clarity and usefulness

What to do:

- pick one primary persona and use it consistently everywhere
- add a short "Problem / User / Why existing search fails / Why Trace" section to the README
- make the hybrid-search value proposition explicit in top-level docs
- add one short architecture visual that explains the system in seconds, not minutes

Definition of done:

- a new reader can understand who Trace is for and why it matters in under one minute
- the README, demo, pitch, and top-level docs all tell the same story
- Trace no longer reads like generic search infrastructure
- Trace reads like an investigation workflow, not just a retrieval engine

Recommended output:

- README rewrite
- one concise architecture visual
- consistent language across docs and demo copy

## 2. Build a strong demo surface

Status: `Complete`

Why this matters:

- judges will score what they can understand quickly
- a polished front door can improve clarity, execution, and polish more than more hidden backend work

What shipped:

- keep the existing React app, but redesign it from a generic search page into an investigation workspace
- reduce the oversized marketing/hero treatment and move faster into the active workflow
- expose one primary search path with a clear left-to-right or top-to-bottom investigation narrative
- make the page feel like an operator desk: request, applied scope, surfaced evidence, and defensible handoff
- add visible structured filters and a compact summary of the interpreted scope
- show result metadata, provenance, and a visible explanation or handoff layer without overstating model certainty
- introduce one memorable signature visual such as:
  - evidence timeline
  - evidence ladder
  - jurisdiction / document-type summary strip
  - compact "Trace reasoning" panel
- promote one top lead or primary finding above the rest of the results so the demo has an immediate "aha" moment
- turn generic result cards into evidence cards with stronger hierarchy, clearer labels, and visible filter-match context
- improve motion and sequencing so the app feels active during search, interpretation, and result assembly
- design empty, loading, error, and no-result states as intentional parts of the demo, not fallback leftovers
- make the frontend feel polished enough that a judge remembers it after a short demo

Definition of done:

- there is one primary demo path that is easy to show live
- a viewer can see semantic retrieval plus filtering in action without needing implementation context
- the product feels intentional rather than stitched together
- the product visibly helps someone move from query to defensible action
- the main demo includes at least one reliable explanation or handoff moment that proves Trace is more than search plus filters
- the UI feels like an investigation command center rather than a generic search screen
- one memorable visual or interaction makes the product easier to recall after judging

Recommended output:

- polished web UI with a stronger investigation-workspace layout
- baseline explanation or evidence-handoff experience integrated into the main flow
- one signature visual or interaction that makes the demo more memorable
- stable screenshots or short recordings for fallback use

Current note:

- the baseline Step 2 redesign is now in place
- the next highest-value frontend work is proof-of-value packaging, pitch-ready
  polish, and any stronger follow-on trust or explainability layer

## 3. Create a side-by-side proof of value

Status: `Complete`

Why this matters:

- Trace becomes much more compelling when the advantage is shown instead of described
- this is one of the best ways to boost usefulness and creativity scores

What shipped:

- a committed proof pack now exists under `docs/PROOF_OF_VALUE.md`
- `insurance-keyword-gap` shows the insurance lapse workflow where `keyword_only` returned `0/3` labeled positives and Trace returned `3/3`
- `insurance-scope-gap` shows the Chicago insurance workflow where semantic-only retrieval kept the right intent but only `3/5` top rows stayed in scope, while Trace kept `5/5`
- the machine-readable snapshot now lives under `fixtures/eval/proof_of_value_snapshot.json`
- each artifact includes a brief templated operator handoff note so the investigation layer is visible without implying a separate model-generated proof step

Definition of done:

- at least one side-by-side comparison artifact is committed
- the advantage of Trace is legible in seconds
- the artifact is stable enough to reuse in the pitch video

Recommended output:

- one comparison table, screenshot set, or fixture-backed visual
- supporting copy that explains what each mode missed

## 4. Package benchmark and evaluation evidence for judges

Status: `Partially complete`

Why this matters:

- Trace already has useful local relevance evidence, but it is not yet packaged into memorable claims
- judges need a few quotable numbers, not just runbooks

What to do:

- extract one or two simple retrieval-eval claims from the local harness
- add benchmark evidence for cold start, warm latency, memory, and cost-per-query
- clearly separate smoke/infra measurements from semantic-quality evidence
- summarize the methodology in one compact doc or README section

Definition of done:

- Trace has one or two numbers that can be repeated in the README and pitch
- benchmark notes are real, scoped, and easy to defend
- retrieval-eval claims are clearly bounded to the current corpus

Recommended output:

- benchmark summary doc or section
- one short "what we measured" table
- one short "what the current numbers mean" paragraph

## 5. Tighten deployment and operator documentation

Status: `Partially complete`

Why this matters:

- the current repo has the right ingredients, but the operator story is still spread across several docs
- this supports execution quality and reduces demo risk

What to do:

- consolidate environment setup guidance for Lambda, MCP bridge, and local evaluation
- tighten rollback and troubleshooting guidance
- document dataset refresh and embedding-regeneration workflows clearly
- keep the proof rerun path explicit and easy to follow

Definition of done:

- an operator can go from local dataset generation to deployed proof without guessing
- the active docs feel current and non-duplicative
- rollback and troubleshooting steps are easy to find

Recommended output:

- refined `README.md`
- refined `docs/DEPLOYMENT_RUNBOOK.md`
- refined proof and setup guidance with less duplication

## 6. Harden deployed proof automation

Status: `Partially complete`

Why this matters:

- the proof path works, but it can become easier to rerun and safer to trust
- this helps execution and reduces the chance of demo surprises

What to do:

- add more focused integration coverage for direct HTTP and MCP validation paths
- add a better replay/smoke mode for saved fixtures or reduced checks
- improve CI-safe dry-run or mock coverage
- decide what belongs in CI versus manual or release-time verification

Definition of done:

- the proof path is easy to rerun before demos and releases
- regressions in proof behavior can be caught without always requiring live AWS validation
- the verification process feels intentional, not ad hoc

## 7. Add one memorable trust or explainability feature

Status: `Not implemented yet`

Why this matters:

- after the baseline explanation or handoff layer exists in the core demo, this is the chance to make that capability more memorable
- it helps raise creativity and polish without changing the core architecture

Strong options:

- "why this matched" explanations
- plain-English explanation of active filters
- natural-language-to-safe-filter translation
- a short investigation summary generated from retrieved evidence

Decision rule:

- assume the core demo already contains a baseline explanation or handoff moment from Step 2
- choose one stronger or more memorable version, do it well, and make sure it supports the main demo rather than distracting from it

Definition of done:

- the demo has one memorable trust or explainability feature beyond the baseline explanation layer
- the feature improves trust, understanding, or workflow usefulness

## 8. Prepare the finalist pitch path now

Status: `Not implemented yet`

Why this matters:

- if Trace reaches the top 10, the pitch bonus can affect the final outcome
- projects that are easy to pitch usually score better earlier too

What to do:

- lock the three-minute story early
- build the demo around that story instead of bolting it on later
- prepare screenshots and backup visuals for every key demo moment
- choose one memorable closing line and reuse it

Definition of done:

- there is a rehearsable three-minute script
- every part of the demo has a backup visual
- the product story, demo flow, and pitch all reinforce the same message

## Suggested execution order

If time is available, the recommended order is:

1. clarify the product story everywhere
2. build the demo surface
3. create the side-by-side proof of value
4. package benchmark and evaluation evidence
5. tighten deployment and operator docs
6. harden deployed proof automation
7. add one trust or explainability feature
8. prepare the finalist pitch path

## What to deprioritize for now

These may still be good ideas, but they are lower-value right now:

- broad platform expansion without a clearer demo story
- reopening the filtering architecture or ingestion architecture
- adding many extra personas or workflows
- deep infrastructure work that judges will not directly see
- large roadmap branches that dilute the main product pitch

## Practical acceptance test

Before submission, Trace should ideally satisfy all of these:

- a new reader can explain who it is for
- a new reader can explain why keyword-only search is not enough
- the product has a clear and polished front door
- at least one artifact proves why Trace is better than weaker baselines
- the demo is reliable and easy to understand
- the README and pitch tell the same story

If any of those are still "not yet," the next best work is probably product
clarity, demo design, or polish rather than more hidden backend depth.
