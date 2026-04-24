# Step 1 Plan: Honest, Reproducible Embedding-Backed Seeding

## Summary

Implement `docs/NEXT_STEPS.md` item 1 only: upgrade `scripts/seed.py` from a
random-vector-only generator into a reproducible two-mode seed pipeline, where
real OpenAI embeddings are the default eval/demo path and random vectors remain
an explicit smoke-only mode. This step stops at code, tests, and docs; it does
not include the first eval-dataset upload, SAM cutover, or deployed proof run.

## Key Changes

### Seed pipeline behavior

- Keep a single entrypoint in `scripts/seed.py`, but refactor it into four
  explicit phases:
  1. deterministic source-record generation
  2. vector generation (`openai` or `random`)
  3. Lance write/index build
  4. manifest emission
- Replace nondeterministic `uuid.uuid4()` incident IDs with stable IDs derived
  from `seed + row_index` so identical inputs regenerate identical records.
- Replace the current loose template generator with a deterministic scenario
  catalog:
  - canonical concepts
  - multiple paraphrase templates per concept
  - near-miss templates with overlapping keywords but different meanings
  - intentional `city_code` / `doc_type` combinations so filtered retrieval
    stays meaningful
- Preserve the current Lance table schema exactly:
  - `incident_id`
  - `timestamp`
  - `city_code`
  - `doc_type`
  - `text_content`
  - `vector`
- Persist the pre-embedding source corpus to
  `output_dir/<table_name>.source.parquet` before embedding.
- Do not add a resumable per-batch embedding cache in this step; the source
  parquet is the only intermediate artifact.
- `--force` becomes a full regeneration switch for this table's local artifacts:
  source parquet, final Lance table, and manifest are all overwritten together.

### CLI and manifest interfaces

- Add `--embedding-mode {openai,random}` with default `openai`.
- Keep `random` as an explicit smoke/infra mode only; update help text and docs
  to say it is not valid evidence of retrieval quality.
- Add `--embedding-model` with default `text-embedding-3-small`.
- Validate the selected model against a local known-model map and require it to
  resolve to dimension `1536` in this step; reject models that would produce a
  non-1536 dataset.
- Require `OPENAI_API_KEY` only when `--embedding-mode openai`.
- Lower the default `--rows` from `100000` to `2000` so the default run is
  cheap enough for an embedding-backed eval corpus; larger smoke or benchmark
  runs must opt in explicitly.
- Keep the existing large-run confirmation, but make its warning text mention
  OpenAI cost only in `openai` mode.
- Emit `output_dir/<table_name>.seed-manifest.json` with:
  - row count
  - seed
  - embedding mode
  - embedding model or `null` for random mode
  - vector dimension
  - source parquet path
  - Lance dataset path
  - generation timestamp
  - upload candidate/live URI fields when upload mode is used

### Embedding implementation

- Do not add the OpenAI Python SDK.
- Call `https://api.openai.com/v1/embeddings` directly from Python, mirroring
  the current `mcp-bridge` approach.
- Batch inputs in fixed-size requests with default batch size `32`.
- Add timeout plus bounded retry/backoff for transient failures only:
  - network errors
  - HTTP `429`
  - HTTP `5xx`
- Validate every embedding response strictly:
  - batch count matches input count
  - every vector is present
  - every vector length is `1536`
- Convert embeddings to `float32` before writing the DataFrame / Lance table.

### Docs and wording cleanup

- Update `README.md`, `docs/DATA_SPEC.md`, `docs/ARCHITECTURE.md`, and
  `docs/PROJECT_STATE.md` to describe:
  - the new `openai` default path
  - the explicit `random` smoke path
  - the required `OPENAI_API_KEY`
  - the default model and 1536-dimension assumption
  - the new local source/manifest artifacts
- Update `docs/NEXT_STEPS.md` so Step 1's acceptance language matches the
  implemented mode split and manifest output.
- Fix stale wording in deployed-proof docs that still refers to proof-path work
  as "NEXT_STEPS step 1"; rename that wording so backlog numbering stays
  aligned with the active `NEXT_STEPS.md`.

## Test Plan

- Add `tests/test_seed.py` using the existing `unittest` + importlib loading
  pattern already used for the proof scripts.
- Add deterministic-generation tests:
  - same seed => identical incident IDs, metadata, and text bodies
  - different seeds => different records
- Add CLI/config validation tests:
  - `openai` mode fails without `OPENAI_API_KEY`
  - `random` mode works without API credentials
  - unsupported or wrong-dimension model fails fast
- Add embedding HTTP tests with mocks:
  - successful batched response preserves order
  - malformed JSON / missing embeddings fail cleanly
  - wrong vector length fails cleanly
  - transient failures retry and then succeed
  - non-retriable failures stop immediately
- Add manifest tests:
  - `random` manifest records `embedding_mode=random`
  - `openai` manifest records model/dimension/path fields correctly
  - upload metadata is included only when upload mode runs
- Add one tiny end-to-end local build test with a mocked embedder to confirm
  the final Lance dataset and manifest are both written as expected.

## Assumptions

- "This step" means `docs/NEXT_STEPS.md` item 1 only.
- The default model is `text-embedding-3-small` because it already matches the
  MCP bridge and current Lambda query-vector contract.
- Step 1 does not change Lambda code, API contract, SAM config, or the live S3
  dataset URI.
- The corpus remains synthetic in Step 1, but it becomes intentionally semantic
  and eval-friendly; labeled query evaluation is deferred to the later
  relevance-harness step.
