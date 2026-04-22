"""
Generate deterministic synthetic Trace records, write a local Lance table with an
IVF-PQ vector index, and optionally upload that dataset to S3.

The seed pipeline now has two explicit vector-generation modes:

- `openai` (default): real embeddings generated from `text_content`
- `random`: deterministic smoke/infra vectors only

The pipeline also writes a source parquet file before embedding and a JSON
manifest describing the resulting dataset.

Dependencies: pip install -r scripts/requirements.txt -c scripts/constraints.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import lancedb
import numpy as np
import pandas as pd


CITY_CODES = [
    "NYC-TLC",
    "LON-TfL",
    "SF-CPUC",
    "PAR-VTC",
    "CHI-BACP",
    "MEX-SEMOVI",
    "SAO-DTP",
]

DOC_TYPES = [
    "Vehicle_Inspection_Audit",
    "Driver_Background_Flag",
    "Insurance_Lapse_Report",
    "City_Permit_Renewal",
    "Safety_Incident_Log",
    "Data_Privacy_Request",
]

VECTOR_DIM = 1536
DEFAULT_ROWS = 2_000
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_BATCH_SIZE = 32
DEFAULT_OPENAI_TIMEOUT_SEC = 30.0

OPENAI_EMBEDDING_MODELS: dict[str, int] = {
    "text-embedding-3-small": 1536,
    "text-embedding-ada-002": 1536,
    "text-embedding-3-large": 3072,
}

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
_OPENAI_MAX_ATTEMPTS = 5
_OPENAI_BACKOFF_SEC = (1.0, 2.0, 4.0, 8.0)

INSURANCE_PROVIDERS = [
    "Liberty Mutual Commercial",
    "Progressive Business Auto",
    "Travelers Fleet",
    "Nationwide Commercial",
    "Berkshire Hathaway Guard",
    "Chubb Commercial Auto",
]

GENERIC_FILLER_SENTENCES = [
    "The jurisdiction requires contemporaneous upload of corrected filings within the statutory window.",
    "Telematics retention policies must align with local data minimization rules and rider privacy expectations.",
    "Escalation to tier-2 enforcement may apply if remediation milestones are missed.",
    "Fleet operators are reminded that permit decals must remain visible and match active vehicle records.",
    "Background re-check cadence is governed by municipal addenda and may differ from corporate defaults.",
    "Incident narratives should reference trip IDs, timestamps, and any in-app safety tool activations.",
    "Cross-border trips may trigger supplemental reporting obligations under bilateral MOUs.",
    "Auditors may request raw inspection photos and third-party mechanic sign-off forms.",
    "Insurance certificates must explicitly name the platform entity and list applicable endorsements.",
    "Where a rider complaint overlaps with a vehicle defect, both tracks must be documented separately.",
    "Stale documentation in the partner portal can cause automatic trip throttling for affected drivers.",
    "City regulators may impose daily fines until proof of correction is uploaded and verified.",
    "Safety score thresholds are evaluated quarterly and can affect incentive eligibility.",
    "Data subject requests must be fulfilled within the timeline specified by regional privacy law.",
    "Permit renewals require payment confirmation and updated vehicle registration on file.",
]


@dataclass(frozen=True)
class Scenario:
    topic: str
    positive_doc_type: str
    near_miss_doc_type: str
    city_codes: tuple[str, ...]
    positive_templates: tuple[str, ...]
    near_miss_templates: tuple[str, ...]
    detail_sentences: tuple[str, ...]


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        topic="insurance_lapse",
        positive_doc_type="Insurance_Lapse_Report",
        near_miss_doc_type="City_Permit_Renewal",
        city_codes=("NYC-TLC", "SF-CPUC", "CHI-BACP", "MEX-SEMOVI"),
        positive_templates=(
            "Coverage for fleet vehicle VIN {vin} in {city_code} lapsed on {event_date}, and the platform suspended driver {driver_id} until a new certificate from {provider} is uploaded.",
            "An insurance compliance monitor in {city_code} flagged driver {driver_id} after commercial auto coverage from {provider} expired on {event_date} for vehicle VIN {vin}.",
            "A regulator-facing lapse report notes that vehicle VIN {vin} lost active commercial coverage with {provider} on {event_date}, forcing a temporary hold on driver {driver_id} in {city_code}.",
        ),
        near_miss_templates=(
            "Permit renewal staff in {city_code} confirmed that driver {driver_id} uploaded a fresh insurance certificate from {provider} on {event_date}; the keywords mention coverage documents, but there was no lapse or suspension.",
            "A permit checklist for VIN {vin} in {city_code} references insurance endorsements from {provider}, yet the record documents a successful renewal package rather than a policy expiration for driver {driver_id}.",
        ),
        detail_sentences=(
            "The compliance queue compares cancellation timestamps against the city's grace-period rules before any account hold is lifted.",
            "Operators must attach the reinstatement binder and update downstream audit logs before the vehicle can return to service.",
            "Near-duplicate notices often share insurer names and certificate language, which makes this concept useful for semantic evaluation.",
        ),
    ),
    Scenario(
        topic="vehicle_inspection_overdue",
        positive_doc_type="Vehicle_Inspection_Audit",
        near_miss_doc_type="Safety_Incident_Log",
        city_codes=("NYC-TLC", "LON-TfL", "PAR-VTC", "SAO-DTP"),
        positive_templates=(
            "An audit in {city_code} found that vehicle VIN {vin} missed its mandated inspection window, leaving driver {driver_id} with overdue corrective paperwork due by {event_date}.",
            "Inspectors in {city_code} marked VIN {vin} as overdue for a required safety inspection and opened an audit task for driver {driver_id} with a filing deadline of {event_date}.",
            "The compliance archive records a failed vehicle-inspection audit for VIN {vin}; driver {driver_id} must submit mechanic sign-off documents in {city_code} before {event_date}.",
        ),
        near_miss_templates=(
            "A safety incident follow-up in {city_code} references a post-collision inspection of VIN {vin}, but the record is an incident narrative for driver {driver_id}, not an overdue audit finding.",
            "Investigators logged inspection photos for VIN {vin} after an operational event in {city_code}; the text mentions inspections repeatedly, yet it is a safety incident case rather than an audit backlog item for driver {driver_id}.",
        ),
        detail_sentences=(
            "The city workflow checks odometer snapshots, third-party mechanic attestation, and decal visibility before closing the audit.",
            "These records are intentionally paired with near-miss incident notes that reuse words like inspection, mechanic, and photos.",
            "A missed inspection window can trigger temporary throttling even when the vehicle remains otherwise active in the fleet ledger.",
        ),
    ),
    Scenario(
        topic="background_flag",
        positive_doc_type="Driver_Background_Flag",
        near_miss_doc_type="Data_Privacy_Request",
        city_codes=("CHI-BACP", "SF-CPUC", "PAR-VTC", "LON-TfL"),
        positive_templates=(
            "A re-screening vendor raised a driver background flag for {driver_id} in {city_code} after a newly surfaced court record required manual review before {event_date}.",
            "Compliance staff in {city_code} escalated driver {driver_id} when a periodic background check returned a match that must be adjudicated before access is restored on {event_date}.",
            "The archive shows a background-review hold on driver {driver_id}; analysts in {city_code} must resolve the flagged screening result and document the outcome by {event_date}.",
        ),
        near_miss_templates=(
            "A privacy-export request in {city_code} asks for the screening history associated with driver {driver_id}; the text references background checks, but it concerns disclosure access rather than an active eligibility flag.",
            "Driver {driver_id} submitted a data-access request for past screening results in {city_code}. The wording overlaps with background-review terminology, yet there is no compliance hold or adjudication task.",
        ),
        detail_sentences=(
            "Manual reviewers distinguish new actionable findings from stale records that were already cleared during a prior adjudication cycle.",
            "These narratives intentionally share screening vocabulary with privacy requests so keyword overlap alone is a weak signal.",
            "Jurisdictions vary on how quickly a temporary hold must be communicated to the driver after the screening vendor responds.",
        ),
    ),
    Scenario(
        topic="permit_renewal_gap",
        positive_doc_type="City_Permit_Renewal",
        near_miss_doc_type="Vehicle_Inspection_Audit",
        city_codes=("NYC-TLC", "MEX-SEMOVI", "SAO-DTP", "PAR-VTC"),
        positive_templates=(
            "Permit coordinators in {city_code} warned that driver {driver_id} had not completed a city permit renewal for VIN {vin} before the {event_date} deadline.",
            "The regulatory archive records an incomplete permit renewal in {city_code}; driver {driver_id} must upload fee confirmation and registration details for VIN {vin} by {event_date}.",
            "A city-permit renewal reminder for driver {driver_id} in {city_code} notes that VIN {vin} cannot remain active unless the renewal packet is finalized before {event_date}.",
        ),
        near_miss_templates=(
            "An inspection audit in {city_code} mentions missing permit decals on VIN {vin}, but the case centers on inspection evidence for driver {driver_id} rather than an unfinished renewal filing.",
            "Mechanics photographed permit stickers during an inspection follow-up for VIN {vin} in {city_code}; the record contains permit language but is not a renewal backlog item for driver {driver_id}.",
        ),
        detail_sentences=(
            "Operators must reconcile fee receipts, vehicle registration, and decal serial numbers before a renewal can be marked complete.",
            "Permit-oriented terms often appear inside inspection records, which makes these near misses useful for judging semantic rank quality.",
            "The renewal workflow is deliberately paired with realistic city and vehicle metadata so filtered retrieval remains meaningful.",
        ),
    ),
    Scenario(
        topic="safety_incident",
        positive_doc_type="Safety_Incident_Log",
        near_miss_doc_type="Vehicle_Inspection_Audit",
        city_codes=("SF-CPUC", "CHI-BACP", "LON-TfL", "SAO-DTP"),
        positive_templates=(
            "A rider safety incident in {city_code} alleges that driver {driver_id} deviated from the expected route and triggered in-app safety tooling during a trip involving VIN {vin} on {event_date}.",
            "Investigators in {city_code} logged a safety incident after driver {driver_id} reported an unauthorized passenger and route deviation for VIN {vin} on {event_date}.",
            "The safety archive for {city_code} records an incident review tied to driver {driver_id}, VIN {vin}, and a trip on {event_date} that required escalation to a trust-and-safety analyst.",
        ),
        near_miss_templates=(
            "An inspection audit in {city_code} references safety checks, route logs, and VIN {vin}, but the record documents workshop verification steps rather than a rider or driver incident involving {driver_id}.",
            "Fleet auditors in {city_code} reviewed safety equipment and telematics for VIN {vin}; the wording overlaps with incident investigations, yet no active safety complaint was filed against driver {driver_id}.",
        ),
        detail_sentences=(
            "Investigators correlate app telemetry, rider outreach, and any emergency feature usage before closing the case.",
            "Near-miss inspection narratives intentionally reuse route, safety, and telematics language without describing an actual trip incident.",
            "This concept is designed to test both semantic similarity and the value of metadata filters such as city and doc type.",
        ),
    ),
    Scenario(
        topic="privacy_request",
        positive_doc_type="Data_Privacy_Request",
        near_miss_doc_type="Driver_Background_Flag",
        city_codes=("LON-TfL", "PAR-VTC", "MEX-SEMOVI", "NYC-TLC"),
        positive_templates=(
            "A privacy request in {city_code} asks the operator to delete rider-linked records associated with driver {driver_id} and VIN {vin} before the statutory response date of {event_date}.",
            "The archive shows a data-privacy deletion workflow in {city_code}; analysts must locate records tied to driver {driver_id} and confirm erasure milestones by {event_date}.",
            "Compliance staff in {city_code} opened a privacy case for driver {driver_id}, requiring a response on {event_date} about retained trip, support, and telematics data for VIN {vin}.",
        ),
        near_miss_templates=(
            "A driver-screening case in {city_code} mentions record retention and disclosure timing for driver {driver_id}, but the active work is a background-review hold rather than a deletion or access request.",
            "Background-review analysts in {city_code} documented how long screening records for driver {driver_id} must be retained. The vocabulary overlaps with privacy rules, yet no data-subject request was filed.",
        ),
        detail_sentences=(
            "The response package usually includes retention exceptions, search-scope notes, and escalation timestamps for any records that cannot be deleted immediately.",
            "These cases intentionally overlap with background and compliance language so a pure keyword baseline will often over-select the wrong rows.",
            "Privacy deadlines differ by jurisdiction, making city metadata important for filtered retrieval sanity checks.",
        ),
    ),
)


class EmbeddingGenerationError(RuntimeError):
    """Embedding generation failed or returned malformed data."""


def _random_vin(rng: np.random.Generator) -> str:
    alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"
    return "".join(rng.choice(list(alphabet), size=17))


def _random_driver_id(rng: np.random.Generator) -> str:
    return f"DRV-{rng.integers(0, 10**9):09d}"


def _random_case_id(rng: np.random.Generator) -> str:
    return f"CASE-{rng.integers(0, 10**8):08d}"


def _random_date_str(rng: np.random.Generator) -> str:
    y = int(rng.integers(2021, 2027))
    m = int(rng.integers(1, 13))
    d = int(rng.integers(1, 29))
    return f"{y:04d}-{m:02d}-{d:02d}"


def _random_retention_days(rng: np.random.Generator) -> int:
    return int(rng.integers(30, 731))


def _stable_incident_id(seed: int, row_index: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"trace-seed:{seed}:{row_index}"))


def _row_rng(seed: int, row_index: int) -> np.random.Generator:
    digest = hashlib.sha256(f"{seed}:{row_index}".encode("utf-8")).digest()
    seed_int = int.from_bytes(digest[:8], byteorder="big", signed=False)
    return np.random.default_rng(seed_int)


def _pick_one(options: tuple[str, ...] | list[str], rng: np.random.Generator) -> str:
    return str(options[int(rng.integers(0, len(options)))])


def _record_timestamp(rng: np.random.Generator) -> pd.Timestamp:
    start = pd.Timestamp("2021-01-01T00:00:00Z")
    end = pd.Timestamp("2026-04-01T00:00:00Z")
    span_seconds = int((end - start).total_seconds())
    offset = int(rng.integers(0, span_seconds + 1))
    return start + pd.to_timedelta(offset, unit="s")


def _render_record_text(
    scenario: Scenario,
    *,
    city_code: str,
    doc_type: str,
    rng: np.random.Generator,
    near_miss: bool,
) -> str:
    templates = scenario.near_miss_templates if near_miss else scenario.positive_templates
    target_words = int(rng.integers(200, 321))
    context = {
        "case_id": _random_case_id(rng),
        "city_code": city_code,
        "doc_type": doc_type,
        "driver_id": _random_driver_id(rng),
        "event_date": _random_date_str(rng),
        "provider": _pick_one(INSURANCE_PROVIDERS, rng),
        "retention_days": _random_retention_days(rng),
        "vin": _random_vin(rng),
    }
    parts = [_pick_one(templates, rng).format(**context)]
    word_count = len(parts[0].split())
    detail_pool = list(scenario.detail_sentences) + GENERIC_FILLER_SENTENCES
    while word_count < target_words:
        sentence = _pick_one(detail_pool, rng)
        parts.append(sentence)
        word_count += len(sentence.split())
    words = " ".join(parts).split()
    return " ".join(words[:target_words])


def build_source_dataframe(n_rows: int, seed: int) -> pd.DataFrame:
    records: list[dict[str, object]] = []
    for row_index in range(n_rows):
        rng = _row_rng(seed, row_index)
        scenario = SCENARIOS[int(rng.integers(0, len(SCENARIOS)))]
        near_miss = bool(rng.integers(0, 100) < 30)
        city_code = _pick_one(scenario.city_codes, rng)
        doc_type = (
            scenario.near_miss_doc_type if near_miss else scenario.positive_doc_type
        )
        text = _render_record_text(
            scenario,
            city_code=city_code,
            doc_type=doc_type,
            rng=rng,
            near_miss=near_miss,
        )
        records.append(
            {
                "incident_id": _stable_incident_id(seed, row_index),
                "timestamp": _record_timestamp(rng),
                "city_code": city_code,
                "doc_type": doc_type,
                "text_content": text,
            }
        )
    return pd.DataFrame.from_records(records)


def save_source_dataframe(df: pd.DataFrame, output_dir: Path, table_name: str) -> Path:
    path = source_parquet_path(output_dir, table_name)
    df.to_parquet(path, index=False)
    return path


def _random_vectors(n_rows: int, *, seed: int, dimensions: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed ^ 0x5EED5EED)
    vecs = rng.uniform(-1.0, 1.0, size=(n_rows, dimensions)).astype(np.float32)
    return [vecs[i] for i in range(n_rows)]


def _embedding_batch_chunks(texts: list[str], batch_size: int) -> list[list[str]]:
    return [texts[i : i + batch_size] for i in range(0, len(texts), batch_size)]


def _openai_urlopen(req: urllib.request.Request, timeout: float):
    return urllib.request.urlopen(req, timeout=timeout)


def _is_transient_openai_error(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code == 429 or 500 <= exc.code <= 599
    if isinstance(exc, urllib.error.URLError):
        return True
    return False


def _read_http_error_body(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _request_openai_embeddings(
    texts: list[str],
    *,
    api_key: str,
    model: str,
    timeout_sec: float,
) -> list[list[float]]:
    payload = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_EMBEDDINGS_URL,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with _openai_urlopen(req, timeout_sec) as resp:
        body = resp.read().decode("utf-8")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise EmbeddingGenerationError(
            f"OpenAI embeddings returned invalid JSON: {exc}"
        ) from exc

    if not isinstance(parsed, dict) or not isinstance(parsed.get("data"), list):
        raise EmbeddingGenerationError(
            "OpenAI embeddings response missing data list."
        )

    items = parsed["data"]
    if len(items) != len(texts):
        raise EmbeddingGenerationError(
            f"OpenAI embeddings returned {len(items)} vectors for {len(texts)} inputs."
        )

    indices_present = ["index" in item for item in items if isinstance(item, dict)]
    if len(indices_present) != len(items):
        raise EmbeddingGenerationError("OpenAI embeddings response items must be objects.")

    if any(indices_present) and not all(indices_present):
        raise EmbeddingGenerationError(
            "OpenAI embeddings response mixed indexed and non-indexed items."
        )

    vectors: list[list[float]]
    if all(indices_present):
        vectors = [None] * len(items)  # type: ignore[list-item]
        seen_indices: set[int] = set()
        for item in items:
            idx = item["index"]
            if not isinstance(idx, int):
                raise EmbeddingGenerationError(
                    f"OpenAI embeddings response returned non-integer index {idx!r}."
                )
            if idx < 0 or idx >= len(texts):
                raise EmbeddingGenerationError(
                    f"OpenAI embeddings response returned out-of-range index {idx}."
                )
            if idx in seen_indices:
                raise EmbeddingGenerationError(
                    f"OpenAI embeddings response returned duplicate index {idx}."
                )
            if not isinstance(item.get("embedding"), list):
                raise EmbeddingGenerationError(
                    f"OpenAI embeddings response missing embedding at index {idx}."
                )
            vectors[idx] = item["embedding"]
            seen_indices.add(idx)
        if any(vector is None for vector in vectors):
            raise EmbeddingGenerationError(
                "OpenAI embeddings response did not include embeddings for every input index."
            )
        return vectors

    if len(items) > 1:
        raise EmbeddingGenerationError(
            "OpenAI embeddings response omitted index for a batched request; cannot safely align embeddings to inputs."
        )

    vectors = []
    for idx, item in enumerate(items):
        if not isinstance(item.get("embedding"), list):
            raise EmbeddingGenerationError(
                f"OpenAI embeddings response missing embedding at index {idx}."
            )
        vectors.append(item["embedding"])
    return vectors


def generate_openai_embeddings(
    texts: list[str],
    *,
    api_key: str,
    model: str,
    expected_dim: int,
    batch_size: int = DEFAULT_EMBEDDING_BATCH_SIZE,
    timeout_sec: float = DEFAULT_OPENAI_TIMEOUT_SEC,
) -> list[np.ndarray]:
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    if not api_key.strip():
        raise EmbeddingGenerationError(
            "OPENAI_API_KEY is required for --embedding-mode openai."
        )

    vectors: list[np.ndarray] = []
    for batch in _embedding_batch_chunks(texts, batch_size):
        last_error: BaseException | None = None
        for attempt in range(1, _OPENAI_MAX_ATTEMPTS + 1):
            try:
                raw_vectors = _request_openai_embeddings(
                    batch,
                    api_key=api_key,
                    model=model,
                    timeout_sec=timeout_sec,
                )
                for idx, vector in enumerate(raw_vectors):
                    if len(vector) != expected_dim:
                        raise EmbeddingGenerationError(
                            f"Embedding at batch index {idx} has length {len(vector)}; expected {expected_dim}."
                        )
                    vectors.append(np.asarray(vector, dtype=np.float32))
                break
            except Exception as exc:  # pragma: no cover - exercised via tests
                last_error = exc
                if not _is_transient_openai_error(exc) or attempt >= _OPENAI_MAX_ATTEMPTS:
                    if isinstance(exc, urllib.error.HTTPError):
                        body = _read_http_error_body(exc)
                        raise EmbeddingGenerationError(
                            f"OpenAI embeddings failed with HTTP {exc.code}. {body}".strip()
                        ) from exc
                    if isinstance(exc, urllib.error.URLError):
                        raise EmbeddingGenerationError(
                            f"OpenAI embeddings request failed: {exc.reason}"
                        ) from exc
                    if isinstance(exc, EmbeddingGenerationError):
                        raise
                    raise EmbeddingGenerationError(
                        f"OpenAI embeddings request failed: {exc}"
                    ) from exc
                delay = _OPENAI_BACKOFF_SEC[attempt - 1]
                time.sleep(delay)
        else:  # pragma: no cover - defensive
            raise EmbeddingGenerationError(
                f"OpenAI embeddings request failed after retries: {last_error}"
            )
    return vectors


def generate_vectors(
    texts: list[str],
    *,
    embedding_mode: str,
    seed: int,
    model: str,
    api_key: str | None,
) -> list[np.ndarray]:
    if embedding_mode == "random":
        return _random_vectors(len(texts), seed=seed, dimensions=VECTOR_DIM)
    if embedding_mode != "openai":
        raise ValueError(f"Unsupported embedding mode: {embedding_mode}")
    return generate_openai_embeddings(
        texts,
        api_key=api_key or "",
        model=model,
        expected_dim=VECTOR_DIM,
    )


def build_vectorized_dataframe(
    source_df: pd.DataFrame,
    vectors: list[np.ndarray],
) -> pd.DataFrame:
    if len(source_df) != len(vectors):
        raise ValueError(
            f"Vector count {len(vectors)} does not match row count {len(source_df)}."
        )
    df = source_df.copy()
    df["vector"] = list(vectors)
    return df


def write_lance_table(
    df: pd.DataFrame,
    output_dir: Path,
    table_name: str,
    *,
    mode: str,
) -> Path:
    """
    Persist `df` to Lance and build an IVF-PQ index on `vector`.
    Returns the path to the `<name>.lance` directory.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(output_dir))
    table = db.create_table(table_name, df, mode=mode)

    n = len(df)
    if n < 256:
        return output_dir / f"{table_name}.lance"

    suggested_partitions = max(1, n // 4096)
    max_trainable_partitions = max(1, n - 1)
    num_partitions = min(256, max_trainable_partitions, suggested_partitions)
    num_sub_vectors = VECTOR_DIM // 8

    try:
        table.create_index(
            vector_column_name="vector",
            index_type="IVF_PQ",
            metric="l2",
            num_partitions=num_partitions,
            num_sub_vectors=num_sub_vectors,
        )
    except Exception as exc:
        if not _is_untrainable_ivf_pq_error(exc):
            raise
        print(
            f"Warning: Skipping IVF_PQ index; leaving table unindexed ({_exception_summary(exc)}).",
            file=sys.stderr,
        )
    return output_dir / f"{table_name}.lance"


def seed_manifest_path(output_dir: Path, table_name: str) -> Path:
    return output_dir / f"{table_name}.seed-manifest.json"


def source_parquet_path(output_dir: Path, table_name: str) -> Path:
    return output_dir / f"{table_name}.source.parquet"


def lance_dataset_path(output_dir: Path, table_name: str) -> Path:
    return output_dir / f"{table_name}.lance"


def local_artifact_paths(output_dir: Path, table_name: str) -> dict[str, Path]:
    return {
        "source parquet": source_parquet_path(output_dir, table_name),
        "seed manifest": seed_manifest_path(output_dir, table_name),
        "Lance table": lance_dataset_path(output_dir, table_name),
    }


def build_seed_manifest(
    *,
    table_name: str,
    rows: int,
    seed: int,
    embedding_mode: str,
    embedding_model: str | None,
    vector_dimension: int,
    source_parquet_path: Path,
    lance_dataset_path: Path,
    candidate_uri: str | None,
    live_uri: str | None,
    promote_to_live: bool,
) -> dict[str, object]:
    return {
        "table_name": table_name,
        "row_count": rows,
        "seed": seed,
        "embedding_mode": embedding_mode,
        "embedding_model": embedding_model,
        "vector_dimension": vector_dimension,
        "source_parquet_path": str(source_parquet_path),
        "lance_dataset_path": str(lance_dataset_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "upload_candidate_uri": None,
        "upload_live_uri": None,
        "promote_to_live": False,
        "requested_upload_candidate_uri": candidate_uri,
        "requested_upload_live_uri": live_uri,
        "requested_promote_to_live": promote_to_live,
    }


def write_seed_manifest(path: Path, manifest: dict[str, object]) -> None:
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def update_seed_manifest_publication_state(
    path: Path,
    *,
    candidate_uri: str | None = None,
    live_uri: str | None = None,
    promote_to_live: bool | None = None,
) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if candidate_uri is not None:
        manifest["upload_candidate_uri"] = candidate_uri
    if live_uri is not None:
        manifest["upload_live_uri"] = live_uri
    if promote_to_live is not None:
        manifest["promote_to_live"] = promote_to_live
    write_seed_manifest(path, manifest)


def build_seed_artifacts(
    *,
    rows: int,
    output_dir: Path,
    table_name: str,
    seed: int,
    write_mode: str,
    embedding_mode: str,
    embedding_model: str,
    api_key: str | None,
    candidate_uri: str | None = None,
    live_uri: str | None = None,
    promote_to_live: bool = False,
) -> tuple[pd.DataFrame, Path, Path]:
    source_df = build_source_dataframe(rows, seed)
    source_path = save_source_dataframe(source_df, output_dir, table_name)
    vectors = generate_vectors(
        list(source_df["text_content"]),
        embedding_mode=embedding_mode,
        seed=seed,
        model=embedding_model,
        api_key=api_key,
    )
    vector_df = build_vectorized_dataframe(source_df, vectors)
    lance_dir = write_lance_table(vector_df, output_dir, table_name, mode=write_mode)
    manifest = build_seed_manifest(
        table_name=table_name,
        rows=rows,
        seed=seed,
        embedding_mode=embedding_mode,
        embedding_model=embedding_model if embedding_mode == "openai" else None,
        vector_dimension=VECTOR_DIM,
        source_parquet_path=source_path,
        lance_dataset_path=lance_dir,
        candidate_uri=candidate_uri,
        live_uri=live_uri,
        promote_to_live=promote_to_live,
    )
    manifest_path = seed_manifest_path(output_dir, table_name)
    write_seed_manifest(manifest_path, manifest)
    return vector_df, source_path, manifest_path


def _exception_summary(exc: BaseException) -> str:
    text = " ".join(str(part).strip() for part in exc.args if str(part).strip()).strip()
    if not text:
        text = str(exc).strip()
    if not text:
        return exc.__class__.__name__
    return text.splitlines()[0]


def _is_untrainable_ivf_pq_error(exc: BaseException) -> bool:
    message = _exception_summary(exc).lower()
    if not message:
        return False

    size_markers = (
        "train",
        "training",
        "not enough",
        "insufficient",
        "too small",
        "too few",
        "requires at least",
        "smaller than",
        "minimum",
    )
    index_markers = (
        "ivf",
        "pq",
        "partition",
        "kmeans",
        "centroid",
        "sub-vector",
        "subvector",
    )
    return any(marker in message for marker in size_markers) and any(
        marker in message for marker in index_markers
    )


def _is_lance_manifest_file(path: Path) -> bool:
    n = path.name.lower()
    return n.endswith(".manifest") or n.endswith(".txn")


def _iter_local_files_ordered(local_root: Path) -> list[Path]:
    files = [p for p in local_root.rglob("*") if p.is_file()]
    files.sort(key=lambda p: (_is_lance_manifest_file(p), str(p)))
    return files


def _staging_run_id() -> str:
    return f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"


def get_aws_identity_for_upload() -> tuple[str, str, str | None]:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

    try:
        sts = boto3.client("sts")
        ident = sts.get_caller_identity()
        account = ident["Account"]
        arn = ident["Arn"]
        region = boto3.session.Session().region_name
        return str(account), str(arn), region
    except (ClientError, BotoCoreError, NoCredentialsError, KeyError):
        print(
            "Error: Could not resolve AWS identity. Check your AWS_PROFILE.",
            file=sys.stderr,
        )
        sys.exit(1)


def print_aws_identity_report(
    *,
    account_id: str,
    caller_arn: str,
    region: str | None,
    target_bucket: str,
) -> None:
    print()
    print("--- AWS Identity Report ---")
    print(f"  Account ID:      {account_id}")
    print(f"  Assumed role / user ARN: {caller_arn}")
    print(f"  Region:          {region or '(not set - check AWS_REGION / config)'}")
    print(f"  Target bucket:   {target_bucket}")
    print("---------------------------")
    print()


def upload_confirmation_bypass(yes_flag: bool) -> bool:
    if yes_flag:
        return True
    ci = os.environ.get("CI", "").strip().lower()
    return ci in ("true", "1", "yes")


def _parse_csv_allowlist(raw: str) -> set[str]:
    return {p.strip() for p in raw.split(",") if p.strip()}


def enforce_noninteractive_upload_allowance(
    account_id: str,
    bucket: str,
    *,
    yes_flag: bool,
    allow_account: str | None,
    allow_production_bucket: bool,
) -> None:
    if not upload_confirmation_bypass(yes_flag):
        return

    allow = (allow_account or "").strip()
    if allow:
        if not allow.isdigit() or len(allow) != 12:
            print("Error: --allow-account must be a 12-digit AWS account id.", file=sys.stderr)
            sys.exit(1)
        if allow != account_id:
            print(
                f"Error: --allow-account {allow!r} does not match STS account {account_id!r}.",
                file=sys.stderr,
            )
            sys.exit(1)
        return

    if allow_production_bucket:
        return

    env_accounts = _parse_csv_allowlist(os.environ.get("TRACE_SEED_ALLOWED_ACCOUNTS", ""))
    if account_id in env_accounts:
        return

    env_buckets = _parse_csv_allowlist(os.environ.get("TRACE_SEED_ALLOWED_BUCKETS", ""))
    if bucket in env_buckets:
        return

    print(
        "Error: Non-interactive upload (--yes or CI=true) requires an explicit production allowance. Options:\n"
        "  --allow-account <12-digit-aws-account-id>    (must match the identity report above)\n"
        "  --allow-production-bucket                    (acknowledge upload to the reported bucket)\n"
        "  Or set TRACE_SEED_ALLOWED_ACCOUNTS and/or TRACE_SEED_ALLOWED_BUCKETS (comma-separated).",
        file=sys.stderr,
    )
    sys.exit(1)


def confirm_upload_interactive_if_needed(yes_flag: bool) -> None:
    if upload_confirmation_bypass(yes_flag):
        return
    if sys.stdin.isatty():
        try:
            ans = input("Proceed with upload to this account? (y/N) ")
        except EOFError:
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        if ans.strip() != "y":
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        return
    print(
        "Error: Non-interactive environment: pass --yes (plus --allow-account or allowlist env / "
        "--allow-production-bucket), set CI=true with the same allowances, or run from a terminal.",
        file=sys.stderr,
    )
    sys.exit(1)


def preflight_s3_bucket_writable(bucket: str, probe_prefix: str) -> None:
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3")
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError as e:
        print(f"Error: S3 bucket not reachable or access denied: {bucket} ({e})", file=sys.stderr)
        sys.exit(1)

    probe_key = f"{probe_prefix.strip('/')}/.seed_write_probe_{uuid.uuid4().hex}"
    try:
        client.put_object(Bucket=bucket, Key=probe_key, Body=b"")
        client.delete_object(Bucket=bucket, Key=probe_key)
    except ClientError as e:
        print(f"Error: S3 bucket is not writable: {bucket} ({e})", file=sys.stderr)
        sys.exit(1)


_MAX_S3_UPLOAD_ATTEMPTS = 5
_S3_UPLOAD_BACKOFF_SEC = (1.0, 2.0, 4.0, 8.0)


def _is_transient_s3_upload_error(exc: BaseException) -> bool:
    from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

    if isinstance(exc, EndpointConnectionError):
        return True
    if isinstance(exc, BotoCoreError) and not isinstance(exc, ClientError):
        return True
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        meta = exc.response.get("ResponseMetadata") or {}
        status = meta.get("HTTPStatusCode")
        if status is not None:
            s = int(status)
            if s >= 500 or s == 408 or s == 429:
                return True
        if code in (
            "RequestTimeout",
            "RequestTimeTooSkewed",
            "Throttling",
            "SlowDown",
            "ServiceUnavailable",
            "InternalError",
            "TransactionConflict",
        ):
            return True
    return False


def upload_with_retries(
    client: object,
    bucket: str,
    key: str,
    local_path: Path,
    label: str,
) -> bool:
    local_path = local_path.resolve()
    for attempt in range(1, _MAX_S3_UPLOAD_ATTEMPTS + 1):
        print(f"[Retry {attempt}/{_MAX_S3_UPLOAD_ATTEMPTS}] Uploading {label}...")
        try:
            client.upload_file(str(local_path), bucket, key)
            return True
        except OSError as e:
            print(f"  Local file error ({label}): {e}", file=sys.stderr)
            return False
        except Exception as e:
            if not _is_transient_s3_upload_error(e) or attempt >= _MAX_S3_UPLOAD_ATTEMPTS:
                print(f"  Upload failed ({label}): {e}", file=sys.stderr)
                return False
            delay = _S3_UPLOAD_BACKOFF_SEC[attempt - 1]
            print(f"  Transient error; sleeping {delay:g}s then retry: {e}", file=sys.stderr)
            time.sleep(delay)
    return False


def cleanup_incomplete_staging(bucket: str, staging_prefix: str) -> None:
    sp = staging_prefix if staging_prefix.endswith("/") else staging_prefix + "/"
    uri = f"s3://{bucket}/{sp.rstrip('/')}/"
    print(f"Cleaning up incomplete staging data from {uri}...", file=sys.stderr)
    try:
        clear_s3_prefix(bucket, staging_prefix)
    except Exception as e:
        print(
            f"Warning: Could not remove staging prefix (check AWS credentials or network): {e}",
            file=sys.stderr,
        )


def _is_manifest_s3_key(key: str) -> bool:
    k = key.lower()
    return k.endswith(".manifest") or k.endswith(".txn")


def promote_staging_to_live_prefix(bucket: str, staging_prefix: str, live_base: str) -> None:
    import boto3
    from botocore.exceptions import ClientError

    sp = staging_prefix if staging_prefix.endswith("/") else staging_prefix + "/"
    lb = (live_base or "").strip().strip("/")
    if not lb:
        print("Error: Live prefix (s3-prefix) is empty; cannot promote.", file=sys.stderr)
        sys.exit(1)

    client = boto3.client("s3")
    keys: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=sp):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])

    if not keys:
        print("Error: Staging prefix is empty; nothing to promote.", file=sys.stderr)
        sys.exit(1)

    keys.sort(key=lambda k: (_is_manifest_s3_key(k), k))

    live_root = f"{lb}/"
    for src_key in keys:
        if not src_key.startswith(sp):
            continue
        rel = src_key[len(sp) :]
        dest_key = f"{live_root}{rel}"
        copy_src = {"Bucket": bucket, "Key": src_key}
        try:
            client.copy_object(
                Bucket=bucket,
                Key=dest_key,
                CopySource=copy_src,
                MetadataDirective="COPY",
            )
        except ClientError as e:
            print(f"Error: copy_object failed {src_key} -> {dest_key}: {e}", file=sys.stderr)
            raise


def confirm_promote_to_live_if_needed(yes_flag: bool, live_uri: str) -> None:
    if yes_flag:
        return
    if sys.stdin.isatty():
        try:
            ans = input(f"Promote candidate dataset to LIVE at {live_uri}? (y/N) ")
        except EOFError:
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        if ans.strip() != "y":
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        return
    print(
        "Error: --promote-to-live in a non-interactive session requires --yes (after reviewing identity).",
        file=sys.stderr,
    )
    sys.exit(1)


def enforce_promote_headless_allowance(args: argparse.Namespace) -> None:
    if not args.promote_to_live or not args.yes:
        return
    if args.allow_production_bucket:
        return
    if (args.allow_account or "").strip():
        return
    print(
        "Error: --promote-to-live with --yes requires --allow-production-bucket or --allow-account.",
        file=sys.stderr,
    )
    sys.exit(1)


def clear_s3_prefix(bucket: str, prefix: str) -> None:
    import boto3

    if not prefix:
        return
    prefix = prefix if prefix.endswith("/") else prefix + "/"
    client = boto3.client("s3")
    paginator = client.get_paginator("list_objects_v2")
    to_delete: list[dict[str, str]] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            to_delete.append({"Key": obj["Key"]})
            if len(to_delete) >= 900:
                client.delete_objects(
                    Bucket=bucket,
                    Delete={"Objects": to_delete, "Quiet": True},
                )
                to_delete.clear()
    if to_delete:
        client.delete_objects(Bucket=bucket, Delete={"Objects": to_delete, "Quiet": True})


def upload_lance_directory_to_staging_prefix(
    local_lance_dir: Path,
    bucket: str,
    staging_prefix: str,
) -> str | None:
    import boto3

    local_lance_dir = local_lance_dir.resolve()
    staging_prefix = staging_prefix if staging_prefix.endswith("/") else staging_prefix + "/"
    client = boto3.client("s3")
    paths = _iter_local_files_ordered(local_lance_dir)
    if not paths:
        print("Error: No files found under local Lance directory; nothing to upload.", file=sys.stderr)
        return None

    data_paths = [p for p in paths if not _is_lance_manifest_file(p)]
    manifest_paths = [p for p in paths if _is_lance_manifest_file(p)]

    ok = 0
    failed: list[str] = []

    def run_batch(batch: list[Path], phase: str) -> bool:
        nonlocal ok
        for path in batch:
            rel = path.relative_to(local_lance_dir)
            rel_s = rel.as_posix()
            key = f"{staging_prefix}{rel_s}"
            label = f"{rel_s} ({phase})"
            if upload_with_retries(client, bucket, key, path, label):
                ok += 1
            else:
                failed.append(rel_s)
                return False
        return True

    if not run_batch(data_paths, "data"):
        print(
            f"Uploaded {ok} files successfully, {len(failed)} files failed.",
            file=sys.stderr,
        )
        print(
            "Skipping manifest upload - staging prefix may be incomplete; do not promote this dataset.",
            file=sys.stderr,
        )
        return None

    if manifest_paths and not run_batch(manifest_paths, "manifest"):
        print(
            f"Uploaded {ok} files successfully, {len(failed)} files failed.",
            file=sys.stderr,
        )
        return None

    print(f"Uploaded {ok} files successfully, {len(failed)} files failed.")
    return f"s3://{bucket}/{staging_prefix.rstrip('/')}/"


_TABLE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
_FLOAT32_BYTES = 4


def estimated_lance_disk_need_bytes(rows: int, dimensions: int) -> int:
    return rows * dimensions * _FLOAT32_BYTES * 2


def ensure_output_dir_ready(output_dir: Path) -> Path:
    out = output_dir.expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def preflight_local_disk_space(rows: int, dimensions: int, output_dir: Path) -> None:
    need_bytes = estimated_lance_disk_need_bytes(rows, dimensions)
    need_gb = need_bytes / (1024**3)
    usage = shutil.disk_usage(output_dir)
    free_gb = usage.free / (1024**3)
    if usage.free < need_bytes:
        print(
            f"Error: Insufficient disk space. Estimated {need_gb:.2f} GB needed, "
            f"but only {free_gb:.2f} GB available.",
            file=sys.stderr,
        )
        sys.exit(1)


def warn_high_volume_rows_if_needed(rows: int, yes: bool, embedding_mode: str) -> None:
    if rows <= 50_000:
        return
    if yes:
        return
    cost_note = "and OpenAI credits " if embedding_mode == "openai" else ""
    prompt = (
        f"Large dataset detected ({rows:,} rows). This may take significant time {cost_note}to generate. "
        "Proceed? (y/N) "
    )
    if sys.stdin.isatty():
        try:
            ans = input(prompt)
        except EOFError:
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        if ans.strip().lower() != "y":
            print("Aborted.", file=sys.stderr)
            sys.exit(1)
        return
    print(
        f"Error: Large dataset ({rows:,} rows) in a non-interactive session requires --yes to confirm.",
        file=sys.stderr,
    )
    sys.exit(1)


def _validate_embedding_model_or_exit(model: str) -> None:
    dim = OPENAI_EMBEDDING_MODELS.get(model)
    if dim is None:
        known = ", ".join(sorted(OPENAI_EMBEDDING_MODELS))
        print(
            f"Error: Unsupported --embedding-model {model!r}. Known models: {known}.",
            file=sys.stderr,
        )
        sys.exit(1)
    if dim != VECTOR_DIM:
        print(
            f"Error: --embedding-model {model!r} resolves to dimension {dim}, but this seed pipeline requires {VECTOR_DIM}.",
            file=sys.stderr,
        )
        sys.exit(1)


def validate_and_normalize_seed_args(args: argparse.Namespace) -> None:
    if not isinstance(args.rows, int) or args.rows < 1:
        print("Error: --rows must be a positive integer.", file=sys.stderr)
        sys.exit(1)

    name = args.table_name.strip()
    if not name or _TABLE_NAME_PATTERN.fullmatch(name) is None:
        print(
            "Error: --table-name must be non-empty and contain only letters, digits, and underscores.",
            file=sys.stderr,
        )
        sys.exit(1)
    args.table_name = name
    args.embedding_model = args.embedding_model.strip()
    if not args.embedding_model:
        print("Error: --embedding-model must not be blank.", file=sys.stderr)
        sys.exit(1)
    _validate_embedding_model_or_exit(args.embedding_model)

    if args.bucket is not None:
        args.bucket = args.bucket.strip()
        if args.bucket == "":
            args.bucket = None

    p = (args.s3_prefix or "").strip().lstrip("/")
    args.s3_prefix = p

    if args.promote_to_live and args.skip_upload:
        print(
            "Error: --promote-to-live requires an upload; use --no-skip-upload with --bucket.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not args.skip_upload:
        if not args.bucket:
            print(
                "Error: No S3 bucket specified. Use --bucket [name] to upload or --skip-upload for local-only runs.",
                file=sys.stderr,
            )
            sys.exit(1)
        if not args.s3_prefix:
            print("Error: --s3-prefix must not be empty when uploading.", file=sys.stderr)
            sys.exit(1)


def resolve_openai_api_key_or_exit(embedding_mode: str) -> str | None:
    if embedding_mode != "openai":
        return None
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if api_key:
        return api_key
    print(
        "Error: OPENAI_API_KEY is required for --embedding-mode openai.",
        file=sys.stderr,
    )
    sys.exit(1)


def resolve_write_mode_or_exit(
    output_dir: Path,
    table_name: str,
    *,
    force: bool,
) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = local_artifact_paths(output_dir, table_name)
    existing_artifacts = [
        f"{label} ({path.name})" for label, path in artifacts.items() if path.exists()
    ]
    if existing_artifacts and not force:
        print(
            "Error: Local seed artifacts already exist for "
            f"'{table_name}' in {output_dir}: {', '.join(existing_artifacts)}. "
            "Use --force to regenerate them.",
            file=sys.stderr,
        )
        sys.exit(1)

    db = lancedb.connect(str(output_dir))
    if hasattr(db, "list_tables"):
        existing_tables = db.list_tables()
    else:  # pragma: no cover - compatibility with older lancedb versions
        existing_tables = db.table_names()
    table_exists = table_name in existing_tables or artifacts["Lance table"].exists()
    if table_exists and force:
        return "overwrite"
    return "create"


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed synthetic Trace Lance data and sync to S3.")
    parser.add_argument(
        "--rows",
        type=int,
        default=DEFAULT_ROWS,
        help=f"Number of records (default: {DEFAULT_ROWS}).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("lance_seed"),
        help="Directory for the Lance DB (default: ./lance_seed).",
    )
    parser.add_argument("--table-name", type=str, default="uber_audit", help="Lance table name.")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for reproducibility.")
    parser.add_argument(
        "--embedding-mode",
        choices=("openai", "random"),
        default="openai",
        help="Vector generation mode. openai is the eval/demo default; random is smoke/infra only.",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default=DEFAULT_EMBEDDING_MODEL,
        help=f"Embedding model for --embedding-mode openai (default: {DEFAULT_EMBEDDING_MODEL}). Must resolve to {VECTOR_DIM} dimensions.",
    )
    parser.add_argument(
        "--bucket",
        type=str,
        default=None,
        help="S3 bucket for upload. Required when using --no-skip-upload. Defaults to no bucket (local-only).",
    )
    parser.add_argument(
        "--s3-prefix",
        type=str,
        default="uber_audit.lance",
        help="Key prefix inside the bucket (default: uber_audit.lance).",
    )
    parser.add_argument(
        "--skip-upload",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Skip S3 upload (default: true). Use --no-skip-upload with --bucket to upload.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the existing local table, source parquet, and manifest if they already exist.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip interactive upload confirmation (requires --allow-account, allowlist env, or "
        "--allow-production-bucket when not using a TTY).",
    )
    parser.add_argument(
        "--allow-account",
        type=str,
        default=None,
        metavar="ID",
        help="With --yes/CI: require this 12-digit AWS account id to match STS (non-interactive safety).",
    )
    parser.add_argument(
        "--allow-production-bucket",
        action="store_true",
        help="With --yes/CI: acknowledge upload to the reported bucket (use only after reviewing identity).",
    )
    parser.add_argument(
        "--promote-to-live",
        action="store_true",
        help="After a successful staging upload, copy objects to the live s3-prefix (manifests last), then remove staging.",
    )
    args = parser.parse_args()
    validate_and_normalize_seed_args(args)
    api_key = resolve_openai_api_key_or_exit(args.embedding_mode)

    args.output_dir = ensure_output_dir_ready(args.output_dir)
    preflight_local_disk_space(args.rows, VECTOR_DIM, args.output_dir)
    warn_high_volume_rows_if_needed(args.rows, args.yes, args.embedding_mode)

    staging_prefix: str | None = None
    candidate_uri: str | None = None
    live_uri: str | None = None
    if not args.skip_upload:
        base = args.s3_prefix
        run_id = _staging_run_id()
        staging_prefix = f"{base}/staging/{run_id}/"
        candidate_uri = f"s3://{args.bucket}/{staging_prefix.rstrip('/')}/"
        live_uri = f"s3://{args.bucket}/{base}/"

    write_mode = resolve_write_mode_or_exit(
        args.output_dir,
        args.table_name,
        force=args.force,
    )

    if not args.skip_upload:
        assert staging_prefix is not None
        preflight_s3_bucket_writable(args.bucket, f"{base}/staging")
        clear_s3_prefix(args.bucket, staging_prefix)

    print(f"Building {args.rows:,} deterministic source records...")
    try:
        _df, source_path, manifest_path = build_seed_artifacts(
            rows=args.rows,
            output_dir=args.output_dir,
            table_name=args.table_name,
            seed=args.seed,
            write_mode=write_mode,
            embedding_mode=args.embedding_mode,
            embedding_model=args.embedding_model,
            api_key=api_key,
            candidate_uri=candidate_uri,
            live_uri=live_uri,
            promote_to_live=args.promote_to_live,
        )
    except EmbeddingGenerationError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    lance_dir = args.output_dir / f"{args.table_name}.lance"
    print(f"Source parquet: {source_path}")
    print(f"Local dataset: {lance_dir}")
    print(f"Seed manifest: {manifest_path}")

    if not args.skip_upload:
        assert staging_prefix is not None
        try:
            account_id, caller_arn, region = get_aws_identity_for_upload()
            print_aws_identity_report(
                account_id=account_id,
                caller_arn=caller_arn,
                region=region,
                target_bucket=args.bucket,
            )
            enforce_noninteractive_upload_allowance(
                account_id,
                args.bucket,
                yes_flag=args.yes,
                allow_account=args.allow_account,
                allow_production_bucket=args.allow_production_bucket,
            )
            confirm_upload_interactive_if_needed(args.yes)
            print(f"CAUTION: Preparing to upload seed data to S3 bucket: {args.bucket}...")
            time.sleep(2)
            print(
                f"Uploading {lance_dir} to staging s3://{args.bucket}/{staging_prefix} "
                f"(atomic promotion via new prefix; manifests last)...",
            )
            lance_s3_uri = upload_lance_directory_to_staging_prefix(
                lance_dir, args.bucket, staging_prefix
            )
            if lance_s3_uri is None:
                cleanup_incomplete_staging(args.bucket, staging_prefix)
                sys.exit(1)
            update_seed_manifest_publication_state(
                manifest_path,
                candidate_uri=candidate_uri,
            )

            if args.promote_to_live:
                enforce_promote_headless_allowance(args)
                confirm_promote_to_live_if_needed(args.yes, live_uri or "")
                try:
                    promote_staging_to_live_prefix(args.bucket, staging_prefix, base)
                except Exception as e:
                    print(f"Error: Promotion failed: {e}", file=sys.stderr)
                    sys.exit(1)
                update_seed_manifest_publication_state(
                    manifest_path,
                    live_uri=live_uri,
                    promote_to_live=True,
                )
                print(
                    f"Cleaning up staging prefix after successful promotion: "
                    f"{candidate_uri}",
                )
                try:
                    clear_s3_prefix(args.bucket, staging_prefix)
                except Exception as e:
                    print(
                        f"Warning: Could not delete staging prefix after promote: {e}",
                        file=sys.stderr,
                    )
                print(f"PROMOTION COMPLETE: Dataset is now live at {live_uri}")
            else:
                print("Staging upload complete.")
                print(
                    f"Candidate dataset created successfully at {candidate_uri}\n"
                    "This dataset is NOT live.\n"
                    f"To make it live, set Lambda env TRACE_LANCE_S3_URI (or equivalent) to:\n"
                    f"  {candidate_uri}\n"
                    "Or re-run with --promote-to-live to copy this candidate into the live prefix.",
                )
        except KeyboardInterrupt:
            print("\nInterrupted during S3 upload.", file=sys.stderr)
            cleanup_incomplete_staging(args.bucket, staging_prefix)
            sys.exit(130)
        except Exception as e:
            print(f"Error: Upload aborted: {e}", file=sys.stderr)
            cleanup_incomplete_staging(args.bucket, staging_prefix)
            sys.exit(1)
    else:
        print("Skipping S3 upload (local-only).")


if __name__ == "__main__":
    main()
