# Trace S3 migration guide

Last updated: 2026-04-20

## Purpose

This document explains how to migrate Trace from the current S3-backed Lance dataset generated with the older random-vector pipeline to a new embedding-backed dataset without losing the value of the existing bucket contents.

The main point is:

- the current random-vector dataset is still useful
- it should be treated as infrastructure or smoke-test data, not semantic-retrieval proof
- the new embedding-backed dataset should live at a separate S3 prefix so deployment, debugging, and judging claims stay clean

## Current situation

The current deployed or uploaded S3 dataset was created by the older seed pipeline that generates random vectors. That means:

- the dataset is valid as a Lance dataset
- the Lambda can still open it and search it
- the S3 permissions, URI wiring, caching behavior, and general deployment path can still be tested against it
- the results from that dataset do not meaningfully prove semantic retrieval quality

This is not a failure state. It just means the existing dataset belongs in the "infrastructure validation" category rather than the "semantic evaluation and demo" category.

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

Recommended pattern:

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

### Phase 3: Upload to a new S3 prefix

Upload the new dataset to a separate prefix such as:

- `s3://<bucket>/trace/eval/lance/`

Do not upload it to the old smoke prefix.

If the seed script supports staging and promotion:

- upload to a staging location first
- validate the uploaded objects
- promote into the target eval prefix only after the upload is complete

If the script does not yet support a clean distinction between smoke and eval prefixes, add that before making the new dataset your main demo target.

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

### Phase 5: Cut over demo or primary evaluation environments

Once the eval dataset is validated:

- update the environment variable used by the demo or primary evaluation stack
- redeploy if necessary
- confirm the live service is now reading from the new prefix
- rerun the golden-path queries
- record the exact S3 URI used in the demo

At this stage, the old smoke dataset should remain available for rollback and debugging.

### Phase 6: Keep rollback simple

If the new dataset causes an issue:

- point the environment back to the smoke prefix
- redeploy or restart as needed
- investigate using the old known-good fixture

Because the old dataset was not overwritten, rollback is just a config switch rather than a data recovery exercise.

## Environment variable updates

Trace supports either:

- `TRACE_LANCE_S3_URI`
- or `TRACE_S3_BUCKET` plus `TRACE_LANCE_PREFIX`

Recommended approach:

- use `TRACE_LANCE_S3_URI` for the clearest cutover path
- set it explicitly to the smoke or eval dataset depending on the environment

Examples:

- smoke environment:
  - `TRACE_LANCE_S3_URI=s3://<bucket>/trace/smoke/lance/`
- eval or demo environment:
  - `TRACE_LANCE_S3_URI=s3://<bucket>/trace/eval/lance/`

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

1. keep the current dataset exactly where it is and relabel it mentally as `smoke`
2. create a new `eval` prefix
3. generate one embedding-backed dataset locally
4. upload it to the new prefix
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
