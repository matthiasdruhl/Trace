# Final steps (beyond NEXT_STEPS)

Last updated: 2026-04-28

This document is **not** a duplicate of [NEXT_STEPS.md](./NEXT_STEPS.md).
`NEXT_STEPS` is the **in-repo execution backlog** covering the remaining build,
docs, proof-hardening, trust-feature, and pitch-prep work.

**Final steps** are **submission- and judge-facing** moves that improve how
fast reviewers understand Trace, remember it, and succeed when trying it.
Complete `NEXT_STEPS` first where it overlaps; use this list so the
**competition story**, **Codex fit**, and **first-minute experience** are as
strong as the engineering.

Related: [COMPETITION_STRATEGY.md](./COMPETITION_STRATEGY.md),
[DEMO_PLAN.md](./DEMO_PLAN.md), and
[PITCH_VIDEO_PLAN.md](./PITCH_VIDEO_PLAN.md).

---

## 1. Make the Codex challenge story impossible to miss

Judges should see **why this entry fits a Codex x OpenAI competition**, not
only that the system is technically serious.

**Do:**

- Add a short section in the README or submission landing copy called
  **How operators use Codex with Trace**.
- Show the real loop clearly: natural-language case intake ->
  `search_cold_archive` via MCP -> structured scope -> surfaced evidence ->
  handoff back into the investigation workflow.
- Include one screenshot or a ~20 second screen capture of that loop using
  Codex/Cursor plus the Trace UI or MCP tool output.

**Outcome:** Stronger **Creativity** and **Clarity** without expanding backend
scope just for the sake of it.

---

## 2. Optimize the first 60 seconds for reviewers

**Do:**

- Add a **"Start here for judges"** block at the top of the README: one-line
  problem, who it is for, links to the **live demo or recording**, **primary
  proof artifact**, and **one architecture** visual.
- Use **three fixed demo queries**, each with **one line** on what the viewer
  should notice, not just the query text.
- Point directly to the strongest current assets:
  `docs/PROOF_OF_VALUE.md`, `docs/BENCHMARK_EVIDENCE.md`, and the main app
  demo.

**Outcome:** Better **Clarity** and **Usefulness** for both human and
automated screening.

---

## 3. Remove activation energy (Execution / Polish)

Strangers should succeed on the **first** attempt.

**Do:**

- Provide at least one strong path: **devcontainer or one-shot setup**,
  **hosted demo**, and/or **recorded full walkthrough**.
- Add a **Judge path** document with numbered steps only:
  open X -> click Y -> expect Z.
- Prefer the deployed app and stable artifacts as the primary reviewer path.
  Keep local setup as a secondary path, not the first thing judges see.

**Outcome:** Higher **Execution** and **Polish** scores, plus fewer silent
failures.

---

## 4. Pre-answer comparison shopping (Usefulness / Clarity)

**Do:**

- Add a tight **"Why not X?"** box with a few sentences total:
  - keyword-only search
  - "just ChatGPT over records"
  - generic RAG without enforced operational scope
- Keep each line to **one sentence** plus a pointer to the proof table or
  benchmark artifact.
- Anchor the comparison to Trace's real differentiator: semantic retrieval plus
  constrained metadata scope plus a defensible evidence handoff path.

**Outcome:** Reduces "another vector demo" labeling and reinforces value.

---

## 5. Memorable brand glue (Creativity / Polish)

**Do:**

- Use **one recurring name** for a case or incident that appears in the UI,
  proof doc, and pitch.
- Use **one signature UI moment** that is **named** and repeated across the
  README, demo, and video.
- Reuse the same memorable proof stories already committed in
  `docs/PROOF_OF_VALUE.md` so the README, demo, and pitch all reinforce the
  same examples.

**Outcome:** Better recall when judges compare many entries.

---

## 6. Finalist insurance (Round 3 before you need it)

**Do:**

- Prepare **B-roll**: screenshots or static slides for **every** pitch beat so
  a bad network day does not sink the recording.
- Prepare a **~30 second** version of the story.
- Keep **explicit boundaries** where the product does **not** claim certainty,
  such as "why this matched"; that reads as maturity to technical judges.
- Keep the benchmark line consistent everywhere with
  `docs/BENCHMARK_EVIDENCE.md` so the README, demo, and pitch do not drift.

**Outcome:** Protects and raises **Round 3** video scoring when Step 8 in
`NEXT_STEPS` is done.

---

## 7. Contest hygiene

**Do:**

- Re-read **official rules** for allowed hosting, API keys, attribution, and
  the required submission bundle.
- Add **only** an authentic **Handshake**-related hook if it fits the product;
  skip forced tie-ins.
- Make sure any public demo or recording uses the bounded claim language
  already established in the proof and benchmark docs.

**Outcome:** Avoids unnecessary disqualification or credibility loss.

---

## If time is short: prioritize these three

1. **Codex-visible workflow + one visual** (section 1).
2. **Zero-friction judge path** (section 3).
3. **"Why not X?" + one named demo story** (sections 4 and 5).

These three usually lift **Clarity**, **Usefulness**, and memorability without
building a second product.
