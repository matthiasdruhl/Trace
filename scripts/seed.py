"""
Generate synthetic Uber Compliance & Audit records per docs/DATA_SPEC.md:
100k rows in Pandas, write a local Lance table with an IVF-PQ vector index,
then upload the .lance directory to S3.

Dependencies: pip install pandas numpy lancedb boto3 pyarrow
"""

from __future__ import annotations

import argparse
import uuid
from pathlib import Path

import boto3
import lancedb
import numpy as np
import pandas as pd

# --- Constants from DATA_SPEC.md ---

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

INSURANCE_PROVIDERS = [
    "Liberty Mutual Commercial",
    "Progressive Business Auto",
    "Travelers Fleet",
    "Nationwide Commercial",
    "Berkshire Hathaway Guard",
    "Chubb Commercial Auto",
]

# Boilerplate used to expand template snippets to 200–500 words.
FILLER_SENTENCES = [
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


def _random_vin(rng: np.random.Generator) -> str:
    alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"
    return "".join(rng.choice(list(alphabet), size=17))


def _random_driver_id(rng: np.random.Generator) -> str:
    return f"DRV-{rng.integers(0, 10**9):09d}"


def _random_date_str(rng: np.random.Generator) -> str:
    y = rng.integers(2021, 2027)
    m = rng.integers(1, 13)
    d = rng.integers(1, 29)
    return f"{y:04d}-{m:02d}-{d:02d}"


def _template_body(
    kind: int,
    city_code: str,
    doc_type: str,
    rng: np.random.Generator,
) -> str:
    vin = _random_vin(rng)
    driver_id = _random_driver_id(rng)
    provider = rng.choice(INSURANCE_PROVIDERS)
    date = _random_date_str(rng)
    fleet_over = rng.integers(3, 500)

    if kind == 0:
        return (
            f"URGENT NOTIFICATION: Vehicle VIN {vin} operating in {city_code} detected with a "
            f"lapse in commercial liability insurance. Coverage dropped by {provider} on {date}. "
            f"Driver ID {driver_id} has been temporarily waitlisted pending documentation upload. "
            f"Related document category: {doc_type}."
        )
    if kind == 1:
        return (
            f"Quarterly audit for {city_code} mandates a maximum vehicle age of 10 years. "
            f"Audit flagged {fleet_over} vehicles in the active fleet exceeding this limit. "
            f"Corrective action plan required by Q3 to avoid tier-2 fines. "
            f"Cross-reference filing: {doc_type}."
        )
    return (
        f"Rider report filed against Driver ID {driver_id} regarding an unauthorized passenger in "
        f"the vehicle during an active UberX trip in {city_code}. Telematics indicate route deviation. "
        f"Case classification under {doc_type}."
    )


def _generate_text_content(
    city_code: str,
    doc_type: str,
    rng: np.random.Generator,
) -> str:
    """200–500 words: DATA_SPEC templates plus randomized compliance filler."""
    target_words = int(rng.integers(200, 501))
    kind = int(rng.integers(0, 3))
    parts = [_template_body(kind, city_code, doc_type, rng)]
    word_count = len(parts[0].split())
    while word_count < target_words:
        parts.append(rng.choice(FILLER_SENTENCES))
        word_count += len(parts[-1].split())
    full = " ".join(parts)
    words = full.split()
    return " ".join(words[:target_words])


def build_dataframe(n_rows: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2021-01-01")
    end = pd.Timestamp("2026-04-01")
    span_seconds = (end - start).total_seconds()
    random_seconds = rng.uniform(0.0, span_seconds, size=n_rows)
    timestamps = start + pd.to_timedelta(random_seconds, unit="s")

    city_codes = rng.choice(CITY_CODES, size=n_rows)
    doc_types = rng.choice(DOC_TYPES, size=n_rows)

    texts = [
        _generate_text_content(str(city_codes[i]), str(doc_types[i]), rng)
        for i in range(n_rows)
    ]

    incident_ids = [str(uuid.uuid4()) for _ in range(n_rows)]

    vecs = rng.uniform(-1.0, 1.0, size=(n_rows, VECTOR_DIM)).astype(np.float32)
    vector_col = [vecs[i] for i in range(n_rows)]

    return pd.DataFrame(
        {
            "incident_id": incident_ids,
            "timestamp": timestamps,
            "city_code": city_codes,
            "doc_type": doc_types,
            "text_content": texts,
            "vector": vector_col,
        }
    )


def write_lance_table(
    df: pd.DataFrame,
    output_dir: Path,
    table_name: str,
) -> Path:
    """
    Persist `df` to Lance and build an IVF-PQ index on `vector`.
    Returns the path to the `<name>.lance` directory.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(output_dir))
    table = db.create_table(table_name, df, mode="overwrite")

    n = len(df)
    # DATA_SPEC guidance: ~ num_rows / 4096 partitions; sub-vectors ~ dim / 8.
    num_partitions = max(4, min(256, max(1, n // 4096)))
    num_sub_vectors = VECTOR_DIM // 8

    table.create_index(
        vector_column_name="vector",
        index_type="IVF_PQ",
        metric="l2",
        num_partitions=num_partitions,
        num_sub_vectors=num_sub_vectors,
    )
    return output_dir / f"{table_name}.lance"


def upload_lance_directory(
    local_lance_dir: Path,
    bucket: str,
    s3_prefix: str,
) -> None:
    """Upload every file under `local_lance_dir` to s3://bucket/<s3_prefix>/..."""
    client = boto3.client("s3")
    local_lance_dir = local_lance_dir.resolve()
    prefix = s3_prefix.strip("/")
    base = f"{prefix}/" if prefix else ""

    for path in local_lance_dir.rglob("*"):
        if path.is_file():
            rel = path.relative_to(local_lance_dir)
            key = f"{base}{rel.as_posix()}"
            client.upload_file(str(path), bucket, key)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed synthetic Uber Audit Lance data and sync to S3.")
    parser.add_argument("--rows", type=int, default=100_000, help="Number of records (default: 100000).")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("lance_seed"),
        help="Directory for the Lance DB (default: ./lance_seed).",
    )
    parser.add_argument("--table-name", type=str, default="uber_audit", help="Lance table name.")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for reproducibility.")
    parser.add_argument("--bucket", type=str, default="trace-vault", help="S3 bucket name.")
    parser.add_argument(
        "--s3-prefix",
        type=str,
        default="uber_audit.lance",
        help="Key prefix inside the bucket (default: uber_audit.lance).",
    )
    parser.add_argument(
        "--skip-upload",
        action="store_true",
        help="Only build local Lance data; do not call S3.",
    )
    args = parser.parse_args()

    print(f"Building {args.rows:,} rows...")
    df = build_dataframe(args.rows, args.seed)

    print(f"Writing Lance table {args.table_name!r} under {args.output_dir} and training IVF-PQ index...")
    lance_dir = write_lance_table(df, args.output_dir, args.table_name)
    print(f"Local dataset: {lance_dir}")

    if not args.skip_upload:
        print(f"Uploading {lance_dir} to s3://{args.bucket}/{args.s3_prefix.strip('/')}/ ...")
        upload_lance_directory(lance_dir, args.bucket, args.s3_prefix)
        print("Upload complete.")
    else:
        print("Skipping S3 upload (--skip-upload).")


if __name__ == "__main__":
    main()
