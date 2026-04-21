"""
Generate synthetic Uber Compliance & Audit records per docs/DATA_SPEC.md:
100k rows in Pandas, write a local Lance table with an IVF-PQ vector index,
then optionally upload to a unique staging prefix under S3 (--no-skip-upload and --bucket).
Uploads are ordered so .manifest/.txn objects are last. Default success path describes a candidate URI;
use --promote-to-live to copy into the live prefix (manifests copied last), then remove staging.

Dependencies: pip install -r scripts/requirements.txt -c scripts/constraints.txt
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

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


def _is_lance_manifest_file(path: Path) -> bool:
    """Manifests must upload last so readers never see a new manifest before data objects exist."""
    n = path.name.lower()
    return n.endswith(".manifest") or n.endswith(".txn")


def _iter_local_files_ordered(local_root: Path) -> list[Path]:
    files = [p for p in local_root.rglob("*") if p.is_file()]
    files.sort(key=lambda p: (_is_lance_manifest_file(p), str(p)))
    return files


def _staging_run_id() -> str:
    return f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"


def get_aws_identity_for_upload() -> tuple[str, str, str | None]:
    """Resolve caller identity via STS (upload path only). Exits on credential/config errors."""
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
    print(f"  Region:          {region or '(not set — check AWS_REGION / config)'}")
    print(f"  Target bucket:   {target_bucket}")
    print("---------------------------")
    print()


def upload_confirmation_bypass(yes_flag: bool) -> bool:
    """Skip interactive prompt when --yes or CI=true (or similar)."""
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
    """
    When upload would proceed without a TTY confirmation (--yes or CI=true), require an explicit
    allowlist match or flag so automation cannot target the wrong account with only --yes.
    Interactive users still confirm via prompt after seeing the identity report.
    """
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
    """Ask before S3 upload when on a TTY; non-TTY requires bypass or exit."""
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
    """Verify bucket exists and we can write/delete an object (before heavy local work)."""
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


# S3 upload_file retries: 5 attempts, exponential backoff between tries (1s, 2s, 4s, 8s).
_MAX_S3_UPLOAD_ATTEMPTS = 5
_S3_UPLOAD_BACKOFF_SEC = (1.0, 2.0, 4.0, 8.0)


def _is_transient_s3_upload_error(exc: BaseException) -> bool:
    """Network / service issues worth retrying; not permission or bad request."""
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
    """
    Wraps upload_file with exponential backoff. Returns True iff upload succeeded.
    """
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
    """
    Best-effort delete of objects under the atomic staging prefix after upload failure or interrupt.
    Only the staging runner prefix (.../staging/<run_id>/) is passed — never the bare dataset prefix.
    """
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
    """
    Copy all objects from staging_prefix to live dataset prefix (live_base/), non-manifest keys first.
    Same-bucket copy_object; does not delete existing live keys first (overwrites on collision).
    """
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
    """Promote requires an explicit y unless --yes (CI/automation with reviewed identity)."""
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
    """
    Headless promote (--yes) requires the same explicit production acknowledgement as upload:
    --allow-production-bucket or --allow-account (env-only upload allowance is not enough to promote).
    """
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
    """Remove all object keys under prefix (idempotent; staging should be empty before a fresh run)."""
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
    """
    Upload the Lance dataset under staging_prefix (must end with '/').
    Data files first with retries; manifest/.txn only if all data uploads succeed.
    Returns the s3:// URI root for opening the dataset, or None if upload failed permanently.
    """
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
            "Skipping manifest upload — staging prefix may be incomplete; do not promote this dataset.",
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

# Bytes per f32 vector column cell; 2× accounts for Lance index build / shuffle overhead (conservative).
_FLOAT32_BYTES = 4


def estimated_lance_disk_need_bytes(rows: int, dimensions: int) -> int:
    """
    (rows * dimensions * 4) bytes for float32 vectors, times 2 for Lance index / shuffle overhead.
    """
    return rows * dimensions * _FLOAT32_BYTES * 2


def ensure_output_dir_ready(output_dir: Path) -> Path:
    """Resolve path and create the directory tree so preflight and Lance use a concrete location."""
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


def warn_high_volume_rows_if_needed(rows: int, yes: bool) -> None:
    if rows <= 50_000:
        return
    if yes:
        return
    prompt = (
        f"Large dataset detected ({rows:,} rows). This may take significant time and API credits. "
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


def validate_and_normalize_seed_args(args: argparse.Namespace) -> None:
    """Fail fast on invalid CLI input; normalize strings before Lance / S3 work."""
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


def resolve_write_mode_or_exit(
    output_dir: Path,
    table_name: str,
    *,
    force: bool,
) -> str:
    """
    Ensure we do not clobber an existing table without --force.
    Call before expensive data generation. Returns 'create' or 'overwrite' for create_table(..., mode=...).
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(output_dir))
    exists = table_name in db.table_names()
    if exists and not force:
        print(
            f"Error: Table '{table_name}' already exists in {output_dir}. Use --force to overwrite.",
            file=sys.stderr,
        )
        sys.exit(1)
    if exists and force:
        return "overwrite"
    return "create"


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
        help="Overwrite existing table if it exists",
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

    args.output_dir = ensure_output_dir_ready(args.output_dir)
    preflight_local_disk_space(args.rows, VECTOR_DIM, args.output_dir)
    warn_high_volume_rows_if_needed(args.rows, args.yes)

    staging_prefix: str | None = None
    if not args.skip_upload:
        base = args.s3_prefix
        run_id = _staging_run_id()
        staging_prefix = f"{base}/staging/{run_id}/"

    write_mode = resolve_write_mode_or_exit(
        args.output_dir,
        args.table_name,
        force=args.force,
    )

    if not args.skip_upload:
        assert staging_prefix is not None
        preflight_s3_bucket_writable(args.bucket, f"{base}/staging")
        clear_s3_prefix(args.bucket, staging_prefix)

    print(f"Building {args.rows:,} rows...")
    df = build_dataframe(args.rows, args.seed)

    if write_mode == "overwrite":
        print(
            f"!!! OVERWRITING existing table: {args.table_name} !!!",
            file=sys.stderr,
        )
    print(f"Writing Lance table {args.table_name!r} under {args.output_dir} and training IVF-PQ index...")
    lance_dir = write_lance_table(df, args.output_dir, args.table_name, mode=write_mode)
    print(f"Local dataset: {lance_dir}")

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

            candidate_uri = f"s3://{args.bucket}/{staging_prefix.rstrip('/')}/"
            live_uri = f"s3://{args.bucket}/{base}/"

            if args.promote_to_live:
                enforce_promote_headless_allowance(args)
                confirm_promote_to_live_if_needed(args.yes, live_uri)
                try:
                    promote_staging_to_live_prefix(args.bucket, staging_prefix, base)
                except Exception as e:
                    print(f"Error: Promotion failed: {e}", file=sys.stderr)
                    sys.exit(1)
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
