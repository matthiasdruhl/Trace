# Trace next steps

Last updated: 2026-04-24

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

Status: `Not implemented yet`

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

Recommended output:

- README rewrite
- one concise architecture visual
- consistent language across docs and demo copy

## 2. Build a strong demo surface

Status: `Not implemented yet`

Why this matters:

- judges will score what they can understand quickly
- a polished front door can improve clarity, execution, and polish more than more hidden backend work

What to do:

- build a small user-facing UI or a very polished walkthrough surface
- expose a single obvious search flow
- add visible filter controls or safe structured inputs
- show result metadata, provenance, and optionally "why this matched"
- handle empty states and invalid inputs gracefully

Definition of done:

- there is one primary demo path that is easy to show live
- a viewer can see semantic retrieval plus filtering in action without needing implementation context
- the product feels intentional rather than stitched together

Recommended output:

- lightweight web UI or equivalent polished demo surface
- stable screenshots or short recordings for fallback use

## 3. Create a side-by-side proof of value

Status: `Not implemented yet`

Why this matters:

- Trace becomes much more compelling when the advantage is shown instead of described
- this is one of the best ways to boost usefulness and creativity scores

What to do:

- create one example where keyword search fails but Trace succeeds
- create one example where semantic-only retrieval is too broad but semantic plus metadata filtering succeeds
- package both into a comparison artifact that can be reused in the README, demo, and pitch

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

- this is a good opportunity to raise creativity and polish without changing the core architecture
- it helps Trace feel like a product instead of a backend

Strong options:

- "why this matched" explanations
- plain-English explanation of active filters
- natural-language-to-safe-filter translation
- a short investigation summary generated from retrieved evidence

Decision rule:

- choose one, do it well, and make sure it supports the main demo rather than distracting from it

Definition of done:

- the demo has one memorable feature beyond "search returns rows"
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
