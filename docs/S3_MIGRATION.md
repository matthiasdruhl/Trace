# Trace S3 migration guide

Last updated: 2026-04-21

## Purpose

This document explains how to migrate Trace from the current S3-backed Lance dataset generated with the older random-vector pipeline to a new embedding-backed dataset without losing the value of the existing bucket contents.

The main point is:

- the current random-vector dataset is still useful
- it is the **random-vector smoke dataset** (smoke / infra only): **not** evaluation data and **not** a basis for relevance or demo truth claims
- the **embedding-backed eval dataset** must live at a separate S3 prefix so deployment, debugging, and judging claims stay clean

Using a **new prefix / URI** for the eval build is safer than mutating objects under the smoke URI in place: it avoids ambiguity about which vectors are live, and it plays better with Lambda dataset cache and cutover (see [Cache and cutover](#cache-and-cutover)).

## Known AWS layout (Trace project)

These are the concrete URIs operators should use when talking about the shared `trace-vault` bucket:

| Role | S3 URI | Notes |
| --- | --- | --- |
| **Random-vector smoke dataset** (smoke / infra) | `s3://trace-vault/uber_audit.lance/` | Created by the older random-vector seed script. **Keep at this exact prefix** for plumbing, permissions, deployment smoke, and rollback. **Do not describe or use as eval data.** |
| **Embedding-backed eval dataset** (target) | `s3://trace-vault/trace/eval/lance/` | New prefix for semantically meaningful retrieval evaluation and honest demos—not populated until you generate and upload a real embedding-backed dataset. |

**Do not:**

- move or copy the **`uber_audit.lance/`** tree into `trace/eval/lance/` and treat it as eval (it would still be random vectors)
- overwrite or delete **`uber_audit.lance/`** in place to “upgrade” it to embeddings—keep the random-vector smoke objects at **`s3://trace-vault/uber_audit.lance/`** for rollback and infra checks; put the new build under **`trace/eval/lance/`**
- mutate objects under an existing prefix expecting Lambda to “see” the change immediately—prefer a **new prefix or URI** for cutover so cache and canonical URI behavior stay predictable (see [Cache and cutover](#cache-and-cutover))

The generic layout patterns later in this doc (`trace/smoke/lance/`, etc.) are naming guidance for *new* buckets or greenfield prefixes. In this account, the legacy smoke dataset already lives at `uber_audit.lance/`; **leave it there** and add eval data beside it rather than forcing a rename first.

## Current situation

The current deployed or uploaded S3 dataset was created by the older seed pipeline that generates random vectors. That means:

- the dataset is valid as a Lance dataset
- the Lambda can still open it and search it
- the S3 permissions, URI wiring, caching behavior, and general deployment path can still be tested against it
- the results from that dataset do not meaningfully prove semantic retrieval quality

This is not a failure state. It just means the existing dataset belongs in the "infrastructure validation" category rather than the "semantic evaluation and demo" category.

## Current migration status

As of 2026-04-21, the migration is **not complete yet**.

What is true right now:

- the old random-vector smoke dataset exists at `s3://trace-vault/uber_audit.lance/`
- that smoke dataset should be preserved and clearly labeled as smoke / infra data
- the intended future eval prefix is `s3://trace-vault/trace/eval/lance/`

What has **not** happened yet:

- the new embedding-backed eval dataset has **not** yet been uploaded to `s3://trace-vault/trace/eval/lance/`
- the SAM stack / Lambda environment has **not** yet been repointed from `uber_audit.lance` to the new eval prefix
- a real end-to-end validation run against an embedding-backed S3 dataset has **not** yet been completed
- semantic-quality claims should therefore still be considered premature

Practical consequence:

- `s3://trace-vault/uber_audit.lance/` remains the current smoke / infra dataset
- `s3://trace-vault/trace/eval/lance/` should still be treated as the **planned target**, not an active validated dataset, until the remaining steps below are completed

## What the current random-vector S3 dataset is still useful for

Keep the current dataset around unless storage cost is a serious issue. It is still valuable for:

- validating S3 permissions and IAM policies
- validating `TRACE_LANCE_S3_URI` or `TRACE_S3_BUCKET` plus `TRACE_LANCE_PREFIX`
- proving the Lambda can open and cache a remote Lance dataset
- exercising API Gateway, Lambda, and MCP bridge plumbing
- regression-testing request validation, auth, and metadata filtering
- smoke-testing deployment updates without regenerating a new dataset every time
- reproducing operational issues that are unrelated to retrieval quality
- benchmarking certain parts of the runtime path such as warm versus cold opens

It is especially useful as a stable known-good fixture when debugging:

- S3 access denied issues
- dataset open failures
- prefix mismatch mistakes
- Lance dataset promotion mistakes
- cache and warm-container behavior

## What the current random-vector dataset should not be used for

Do not use the current dataset as the primary basis for:

- claims that Trace has strong semantic retrieval quality
- benchmark tables about relevance
- judge-facing demos that depend on "meaningful nearest neighbors"
- comparisons against keyword search or naive RAG
- examples intended to prove that embeddings are working well

If the underlying vectors are random, then semantic-quality claims will be weak even if the rest of the architecture is strong.

## Migration goals

The migration should accomplish all of the following:

1. preserve the existing random-vector dataset as a stable infra fixture
2. create a new embedding-backed dataset under a separate prefix
3. allow easy switching between smoke data and semantic-eval data
4. avoid ambiguous benchmark or demo results
5. keep rollback simple if the new dataset has an issue

## Recommended S3 layout

Use separate prefixes for separate purposes. Do not overwrite the old dataset in place unless there is a strong reason to do so.

For **Trace’s current bucket**, treat `s3://trace-vault/uber_audit.lance/` as the fixed smoke prefix and put new embedding-backed data under **`s3://trace-vault/trace/eval/lance/`** (not inside `uber_audit.lance/`).

Recommended pattern (greenfield or future buckets):

- `s3://<bucket>/trace/smoke/lance/`
- `s3://<bucket>/trace/eval/lance/`
- `s3://<bucket>/trace/demo/lance/`

Suggested meaning:

- `smoke`: current random-vector dataset for plumbing and regression checks
- `eval`: embedding-backed dataset used for retrieval metrics and baseline comparisons
- `demo`: embedding-backed dataset used for judge-facing demos if you want a separate curated dataset

If you only want two prefixes, that is also fine:

- `smoke` for the old random-vector dataset
- `eval` for the new embedding-backed dataset

Many deployments still use the legacy layout `s3://<bucket>/uber_audit.lance/` for that smoke dataset. Treat it like a fixed infra fixture; load new work at a disjoint prefix (for example `trace/eval/lance`) instead of replacing those objects in place.

### SAM deployment (`template.yaml`)

The stack parameters **`TraceDataBucketName`** and **`TraceLancePrefix`** set all of the following together:

- Lambda env **`TRACE_S3_BUCKET`**, **`TRACE_LANCE_PREFIX`**, and **`TRACE_LANCE_S3_URI`** (`s3://<bucket>/<prefix>` with slashes normalized at runtime)
- IAM **`s3:GetObject`** on `arn:aws:s3:::<bucket>/<prefix>/*` and **`s3:ListBucket`** constrained to that prefix

The Rust handler treats **`TRACE_LANCE_S3_URI` as canonical** when it is set (see `lambda-engine/src/config.rs`); the template always sets it from the same parameters as the IAM policy, so there is no bucket or prefix drift inside a single stack revision.

Changing **`TraceLancePrefix`** on redeploy switches the live dataset and updates permissions—no application code change required. The stack output **`TraceDatasetS3Uri`** echoes the resolved URI for manifests and runbooks.

## Naming and labeling guidance

Be explicit in docs and environment notes:

- call the old dataset "random-vector smoke dataset" or "infra dataset"
- call the new dataset "embedding-backed eval dataset" or "semantic demo dataset"

Do not refer to both as just "the Trace dataset." That makes future debugging and presentation much harder.

## Safe migration strategy

### Phase 1: Preserve the old dataset

Do this first:

- identify the current S3 URI or bucket plus prefix used by the deployed Lambda
- write that exact location down in a team note or environment note
- label it as the smoke or infra dataset
- do not delete it
- do not overwrite it during the migration

If the current deployment already points at the old dataset, leave it there until the new dataset is validated.

### Phase 2: Create a new embedding-backed dataset locally

Before uploading anything new:

- update the seed or ingestion pipeline to support real embeddings
- decide which embedding model will be used
- generate a new local Lance dataset with real text-derived vectors
- confirm the local dataset can be opened and searched
- run a few sanity checks with known semantically related queries

What to verify locally before upload:

- the vector dimension matches `TRACE_QUERY_VECTOR_DIM`
- the dataset schema still matches the Lambda expectations
- the index build succeeds
- filtered and unfiltered searches behave plausibly
- the dataset is small enough to upload and test cheaply if this is the first semantic-eval pass

Current status:

- this phase is still pending
- `scripts/seed.py` still generates random vectors, so it should not yet be used to populate the eval prefix if the goal is semantic-quality validation

### Phase 3: Upload to a new S3 prefix

Upload the new dataset to a separate prefix such as:

- `s3://<bucket>/trace/eval/lance/`

Do not upload it to the old smoke prefix.

Do **not** copy or `aws s3 sync` the **`uber_audit.lance/`** tree into `trace/eval/lance/` as a shortcut—that only duplicates random vectors under a new path. The eval prefix must receive a **new** embedding-backed build from the corrected pipeline.

If the seed script supports staging and promotion:

- upload to a staging location first
- validate the uploaded objects
- promote into the target eval prefix only after the upload is complete

If the script does not yet support a clean distinction between smoke and eval prefixes, add that before making the new dataset your main demo target.

Current status:

- this upload has not happened yet for `s3://trace-vault/trace/eval/lance/`
- do not treat that prefix as live until a corrected embedding-backed dataset is actually uploaded there

### Phase 4: Validate the new prefix without cutting over production

Before changing the main deployment:

- point a local or temporary environment at the new eval prefix
- run `POST /search` against the eval dataset
- test the MCP bridge against the same endpoint
- run a small set of known queries and save the outputs
- confirm filtering still works the same way
- confirm the result quality is meaningfully better than the random-vector dataset

This is the point where you should also start building:

- a small set of golden queries
- an evaluation harness
- baseline comparisons

Current status:

- this remote validation has not happened yet against a real embedding-backed S3 dataset
- any current deployed proof work should still be interpreted as smoke / infra validation if it points at `s3://trace-vault/uber_audit.lance/`

### Phase 5: Cut over demo or primary evaluation environments

Once the eval dataset is validated:

- update the environment variable used by the demo or primary evaluation stack
- redeploy if necessary
- confirm the live service is now reading from the new prefix
- rerun the golden-path queries
- record the exact S3 URI used in the demo

At this stage, the old smoke dataset should remain available for rollback and debugging.

Current status:

- this cutover has not happened yet
- the live stack should remain on the current smoke dataset until the eval prefix is populated and validated

### Phase 6: Keep rollback simple

If the new dataset causes an issue:

- point the environment back to the smoke prefix
- redeploy or restart as needed
- investigate using the old known-good fixture

Because the old dataset was not overwritten, rollback is just a config switch rather than a data recovery exercise.

Current status:

- rollback remains simple because the old smoke dataset is still in place and untouched

## Environment variable updates

Trace supports either:

- `TRACE_LANCE_S3_URI`
- or `TRACE_S3_BUCKET` plus `TRACE_LANCE_PREFIX`

Recommended approach:

- use `TRACE_LANCE_S3_URI` for the clearest cutover path
- set it explicitly to the smoke or eval dataset depending on the environment

Examples:

- smoke environment (generic):
  - `TRACE_LANCE_S3_URI=s3://<bucket>/trace/smoke/lance/`
- smoke environment (**current Trace bucket**, legacy random-vector dataset):
  - `TRACE_LANCE_S3_URI=s3://trace-vault/uber_audit.lance/`
- eval or demo environment:
  - `TRACE_LANCE_S3_URI=s3://<bucket>/trace/eval/lance/`
  - for Trace after upload: `TRACE_LANCE_S3_URI=s3://trace-vault/trace/eval/lance/`

Current status:

- the first value is the currently valid deployed smoke target
- the second Trace-specific eval value is still a future cutover target until the new dataset has been uploaded and validated

If you are using `TRACE_S3_BUCKET` and `TRACE_LANCE_PREFIX` instead:

- keep the bucket constant if you want
- switch only the prefix
- document the exact prefix in deployment notes

## Recommended environment split

If you have more than one stack or deployment target, use them intentionally:

- local smoke: can still use mock embeddings or small generated data
- deployed smoke stack: points at the old random-vector S3 dataset
- deployed eval stack: points at the new embedding-backed S3 dataset
- demo stack: points at whichever embedding-backed dataset is most stable and impressive

If you only have one deployed stack, keep it on the smoke dataset until the new eval dataset is confirmed. Then cut over deliberately and document the change.

## Concrete migration checklist

### A. Capture the current state

- identify the current bucket name
- identify the current dataset prefix
- identify which deployment currently points to it
- confirm whether `TRACE_LANCE_S3_URI` or the bucket plus prefix pair is being used
- label the current dataset as `smoke` or `infra`

### B. Prepare the new semantic dataset path

- choose a new prefix such as `trace/eval/lance/`
- confirm the Lambda role already has access or update IAM permissions if needed
- confirm the seed pipeline can generate real embeddings
- confirm the embedding dimension matches runtime expectations

### C. Generate and validate locally

- generate the embedding-backed dataset locally
- build the Lance index
- run local search checks
- verify a few hand-selected semantic queries
- verify a few filtered queries

### D. Upload safely

- upload to the new eval prefix, not the current smoke prefix
- verify the object layout looks correct
- verify the Lance dataset opens remotely

### E. Validate remotely

- point a temporary or eval deployment at the new prefix
- run API and MCP smoke checks
- run semantic-quality sanity checks
- save representative request and response examples

### F. Cut over the right environment

- update `TRACE_LANCE_S3_URI` or the prefix config
- redeploy
- rerun golden queries
- note the exact cutover date and URI

### G. Preserve rollback

- keep the old smoke dataset untouched
- keep its URI documented
- do not delete it until the new dataset has been stable for a while

## Suggested doc and repo updates to accompany the migration

After the migration, update:

- `docs/PROJECT_STATE.md`
  - clarify that the old random-vector dataset remains useful only for structural validation
  - note whether an embedding-backed dataset now exists
- `docs/ARCHITECTURE.md`
  - explain the distinction between smoke datasets and semantic-eval datasets
- `docs/NEXT_STEPS.md`
  - check off or revise the ingestion and relevance-proof items as they are completed
- `README.md`
  - add a sentence that local or smoke data can use simplified vectors, but demos and evals should use real embeddings

## Benchmark and judging guidance after migration

Once the new eval dataset exists:

- use the smoke dataset for deployment and operational checks
- use the eval dataset for relevance metrics
- use the demo dataset or eval dataset for polished examples

Keep benchmark categories separate:

- infrastructure benchmarks:
  - cold starts
  - warm starts
  - memory usage
  - S3 read behavior
- retrieval benchmarks:
  - `Recall@k`
  - `Precision@k`
  - filtered-query accuracy
  - baseline comparisons

Do not mix smoke-dataset operational numbers with semantic-eval relevance claims without clearly labeling the difference.

## Cache and cutover

The Lambda resolves and caches the Lance dataset by **canonical S3 URI**. In-place edits to objects behind an unchanged URI can leave callers validating **stale** state until caches refresh or containers recycle.

**Prefer:** upload a new dataset to a **new prefix** (for example `s3://trace-vault/trace/eval/lance/`) and **repoint** `TRACE_LANCE_S3_URI` / `TraceLancePrefix` after validation—rather than replacing files under `uber_audit.lance/` and expecting immediate consistency.

## Operator sequence (trace-vault → embedding eval)

Use this **seven-step** sequence for the **current** bucket and prefixes:

1. **Preserve the old dataset** — do nothing that deletes or rewrites **`s3://trace-vault/uber_audit.lance/`**; do not move it into `trace/eval/lance/`.
2. **Label it as smoke** — in runbooks and team notes, call it the **random-vector smoke dataset** / **smoke / infra** data; **not** eval and **not** semantic-retrieval proof.
3. **Generate the embedding-backed eval dataset locally** — real vectors from text; dimension aligned with `TRACE_QUERY_VECTOR_DIM`; verify search locally before upload.
4. **Upload to the new eval prefix** — **`s3://trace-vault/trace/eval/lance/`** only; never upload the eval build into **`uber_audit.lance/`** or “promote” random-vector trees into `trace/eval/lance/`.
5. **Validate there** — point a local stack, temporary env, or isolated config at the eval URI; run `POST /search`, MCP, and (when applicable) `prove_deployed_path.py` **before** any production cutover.
6. **Repoint stack / Lambda only after validation** — set `TRACE_LANCE_S3_URI` or `TraceDataBucketName` + `TraceLancePrefix` to the eval URI **only after** step 5 passes.
7. **Keep the old prefix for rollback** — leave **`s3://trace-vault/uber_audit.lance/`** intact; rollback is repointing config back to that smoke URI, not restoring lost data.

Status note:

- as of 2026-04-21, the project is between steps 2 and 4 of this sequence:
  - the old dataset has been identified and should be treated as smoke
  - the new eval dataset has not yet been generated, uploaded, validated, or cut over

**Why a new prefix beats in-place mutation:** a distinct eval URI makes it obvious which dataset is live, avoids mixing random-vector and embedding-backed objects under one path, and reduces cache/cutover surprises (see [Cache and cutover](#cache-and-cutover)).

## Common mistakes to avoid

- overwriting the old dataset in place before the new one is validated
- using one prefix for both smoke and semantic-eval use cases
- forgetting to update IAM or deployment config for the new prefix
- benchmarking relevance on the random-vector dataset
- presenting random-vector search results as proof of semantic quality
- failing to record which stack points at which dataset
- changing the dataset and the code at the same time, which makes debugging harder

## Minimal recommended path if time is tight

If you need the fastest safe migration:

1. keep **`s3://trace-vault/uber_audit.lance/`** exactly where it is and relabel it mentally as `smoke`
2. use **`s3://trace-vault/trace/eval/lance/`** as the new eval prefix (create on first upload)
3. generate one embedding-backed dataset locally
4. upload it to that eval prefix only
5. point a non-primary or temporary deployment at it
6. validate with a handful of golden queries
7. only then switch the main demo environment

This gets you most of the benefit without forcing a risky in-place replacement.

## Recommended status labels

Use simple labels in notes, env files, or deployment docs:

- `smoke`: structurally valid random-vector dataset for infra checks
- `eval`: embedding-backed dataset for retrieval metrics
- `demo`: embedding-backed dataset curated for presentation quality

## Final recommendation

Do not think of the current random-vector bucket contents as wasted work. Think of them as a stable infrastructure fixture.

The right move is not to delete or hide that dataset. The right move is to:

- preserve it
- relabel it honestly
- create a new embedding-backed dataset beside it
- cut over in a controlled, reversible way

That will give Trace a cleaner technical story, a cleaner demo story, and a much stronger basis for relevance claims.
