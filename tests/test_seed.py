"""Focused tests for the embedding-backed seed pipeline."""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import shutil
import sys
import unittest
import urllib.error
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_seed_module():
    path = ROOT / "scripts" / "seed.py"
    spec = importlib.util.spec_from_file_location("seed_script", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["seed_script"] = mod
    spec.loader.exec_module(mod)
    return mod


seed = _load_seed_module()


@contextmanager
def repo_temp_dir():
    TEST_TMP_ROOT.mkdir(exist_ok=True)
    path = TEST_TMP_ROOT / str(uuid.uuid4())
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class FakeHttpResponse:
    def __init__(self, payload: object):
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return self._payload


def _http_error(status: int, body: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url=seed.OPENAI_EMBEDDINGS_URL,
        code=status,
        msg="boom",
        hdrs=None,
        fp=io.BytesIO(body.encode("utf-8")),
    )


class TestSourceGeneration(unittest.TestCase):
    def test_same_seed_is_deterministic(self) -> None:
        left = seed.build_source_dataframe(8, 42)
        right = seed.build_source_dataframe(8, 42)
        self.assertEqual(left.to_dict("records"), right.to_dict("records"))

    def test_different_seed_changes_records(self) -> None:
        left = seed.build_source_dataframe(6, 42)
        right = seed.build_source_dataframe(6, 43)
        self.assertNotEqual(left.to_dict("records"), right.to_dict("records"))


class TestCliValidation(unittest.TestCase):
    def test_random_mode_does_not_require_api_key(self) -> None:
        vectors = seed.generate_vectors(
            ["hello world"],
            embedding_mode="random",
            seed=42,
            model=seed.DEFAULT_EMBEDDING_MODEL,
            api_key=None,
        )
        self.assertEqual(len(vectors), 1)
        self.assertEqual(len(vectors[0]), seed.VECTOR_DIM)

    def test_openai_mode_requires_api_key(self) -> None:
        with patch.dict(seed.os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as ctx:
                seed.resolve_openai_api_key_or_exit("openai")
        self.assertEqual(ctx.exception.code, 1)

    def test_unknown_embedding_model_fails_fast(self) -> None:
        with self.assertRaises(SystemExit):
            seed._validate_embedding_model_or_exit("not-a-model")

    def test_wrong_dimension_embedding_model_fails_fast(self) -> None:
        with self.assertRaises(SystemExit):
            seed._validate_embedding_model_or_exit("text-embedding-3-large")

    def test_validate_and_normalize_seed_args_strips_and_keeps_defaults(self) -> None:
        args = argparse.Namespace(
            rows=10,
            table_name=" trace_table ",
            embedding_model=" text-embedding-3-small ",
            bucket=" trace-vault ",
            s3_prefix="/trace/eval/lance/",
            promote_to_live=False,
            skip_upload=False,
        )
        seed.validate_and_normalize_seed_args(args)
        self.assertEqual(args.table_name, "trace_table")
        self.assertEqual(args.embedding_model, "text-embedding-3-small")
        self.assertEqual(args.bucket, "trace-vault")
        self.assertEqual(args.s3_prefix, "trace/eval/lance/")


class TestOpenAiEmbeddingGeneration(unittest.TestCase):
    def test_successful_batch_uses_response_index_to_restore_order(self) -> None:
        payload = {
            "data": [
                {"index": 1, "embedding": [0.2] * seed.VECTOR_DIM},
                {"index": 0, "embedding": [0.1] * seed.VECTOR_DIM},
            ]
        }
        with patch.object(seed, "_openai_urlopen", return_value=FakeHttpResponse(payload)):
            vectors = seed.generate_openai_embeddings(
                ["first", "second"],
                api_key="sk-test",
                model=seed.DEFAULT_EMBEDDING_MODEL,
                expected_dim=seed.VECTOR_DIM,
            )
        self.assertEqual(len(vectors), 2)
        self.assertEqual(vectors[0].dtype, np.float32)
        self.assertAlmostEqual(float(vectors[0][0]), 0.1, places=5)
        self.assertAlmostEqual(float(vectors[1][0]), 0.2, places=5)

    def test_batched_response_without_index_fails_cleanly(self) -> None:
        payload = {
            "data": [
                {"embedding": [0.1] * seed.VECTOR_DIM},
                {"embedding": [0.2] * seed.VECTOR_DIM},
            ]
        }
        with patch.object(seed, "_openai_urlopen", return_value=FakeHttpResponse(payload)):
            with self.assertRaises(seed.EmbeddingGenerationError) as ctx:
                seed.generate_openai_embeddings(
                    ["first", "second"],
                    api_key="sk-test",
                    model=seed.DEFAULT_EMBEDDING_MODEL,
                    expected_dim=seed.VECTOR_DIM,
                )
        self.assertIn("omitted index", str(ctx.exception))

    def test_malformed_json_fails_cleanly(self) -> None:
        class BadResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self) -> bytes:
                return b"{bad json"

        with patch.object(seed, "_openai_urlopen", return_value=BadResponse()):
            with self.assertRaises(seed.EmbeddingGenerationError) as ctx:
                seed.generate_openai_embeddings(
                    ["first"],
                    api_key="sk-test",
                    model=seed.DEFAULT_EMBEDDING_MODEL,
                    expected_dim=seed.VECTOR_DIM,
                )
        self.assertIn("invalid JSON", str(ctx.exception))

    def test_wrong_vector_length_fails_cleanly(self) -> None:
        payload = {"data": [{"embedding": [0.1, 0.2]}]}
        with patch.object(seed, "_openai_urlopen", return_value=FakeHttpResponse(payload)):
            with self.assertRaises(seed.EmbeddingGenerationError) as ctx:
                seed.generate_openai_embeddings(
                    ["first"],
                    api_key="sk-test",
                    model=seed.DEFAULT_EMBEDDING_MODEL,
                    expected_dim=seed.VECTOR_DIM,
                )
        self.assertIn("expected", str(ctx.exception))

    def test_transient_failure_retries_then_succeeds(self) -> None:
        payload = {"data": [{"embedding": [0.3] * seed.VECTOR_DIM}]}
        with patch.object(
            seed,
            "_openai_urlopen",
            side_effect=[_http_error(429, "rate limited"), FakeHttpResponse(payload)],
        ), patch.object(seed.time, "sleep") as sleep_mock:
            vectors = seed.generate_openai_embeddings(
                ["first"],
                api_key="sk-test",
                model=seed.DEFAULT_EMBEDDING_MODEL,
                expected_dim=seed.VECTOR_DIM,
            )
        self.assertEqual(len(vectors), 1)
        sleep_mock.assert_called_once()

    def test_non_retriable_failure_stops_immediately(self) -> None:
        with patch.object(
            seed,
            "_openai_urlopen",
            side_effect=_http_error(400, "bad request"),
        ), patch.object(seed.time, "sleep") as sleep_mock:
            with self.assertRaises(seed.EmbeddingGenerationError) as ctx:
                seed.generate_openai_embeddings(
                    ["first"],
                    api_key="sk-test",
                    model=seed.DEFAULT_EMBEDDING_MODEL,
                    expected_dim=seed.VECTOR_DIM,
                )
        self.assertIn("HTTP 400", str(ctx.exception))
        sleep_mock.assert_not_called()


class TestManifestAndArtifacts(unittest.TestCase):
    def test_random_manifest_records_mode_and_null_model(self) -> None:
        manifest = seed.build_seed_manifest(
            table_name="demo",
            rows=10,
            seed=42,
            embedding_mode="random",
            embedding_model=None,
            vector_dimension=seed.VECTOR_DIM,
            source_parquet_path=Path("source.parquet"),
            lance_dataset_path=Path("demo.lance"),
            candidate_uri=None,
            live_uri=None,
            promote_to_live=False,
        )
        self.assertEqual(manifest["embedding_mode"], "random")
        self.assertIsNone(manifest["embedding_model"])

    def test_openai_manifest_records_upload_fields(self) -> None:
        manifest = seed.build_seed_manifest(
            table_name="demo",
            rows=10,
            seed=42,
            embedding_mode="openai",
            embedding_model=seed.DEFAULT_EMBEDDING_MODEL,
            vector_dimension=seed.VECTOR_DIM,
            source_parquet_path=Path("source.parquet"),
            lance_dataset_path=Path("demo.lance"),
            candidate_uri="s3://trace-vault/trace/eval/lance/staging/run/",
            live_uri="s3://trace-vault/trace/eval/lance/",
            promote_to_live=True,
        )
        self.assertEqual(manifest["embedding_model"], seed.DEFAULT_EMBEDDING_MODEL)
        self.assertEqual(
            manifest["requested_upload_live_uri"], "s3://trace-vault/trace/eval/lance/"
        )

    def test_build_seed_artifacts_writes_source_manifest_and_lance(self) -> None:
        rows = 3
        fake_vectors = [np.zeros(seed.VECTOR_DIM, dtype=np.float32) for _ in range(rows)]
        with repo_temp_dir() as td, patch.object(
            seed, "generate_vectors", return_value=fake_vectors
        ):
            output_dir = seed.ensure_output_dir_ready(td / "seed-output")
            _df, source_path, manifest_path = seed.build_seed_artifacts(
                rows=rows,
                output_dir=output_dir,
                table_name="demo",
                seed=42,
                write_mode="create",
                embedding_mode="openai",
                embedding_model=seed.DEFAULT_EMBEDDING_MODEL,
                api_key="sk-test",
                candidate_uri="s3://trace-vault/trace/eval/lance/staging/run/",
                live_uri="s3://trace-vault/trace/eval/lance/",
                promote_to_live=False,
            )

            self.assertTrue(source_path.is_file())
            self.assertTrue(manifest_path.is_file())
            self.assertTrue((output_dir / "demo.lance").is_dir())

            source_df = pd.read_parquet(source_path)
            self.assertEqual(len(source_df), rows)

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["embedding_mode"], "openai")
            self.assertEqual(manifest["row_count"], rows)
            self.assertEqual(manifest["vector_dimension"], seed.VECTOR_DIM)
            self.assertEqual(
                manifest["requested_upload_candidate_uri"],
                "s3://trace-vault/trace/eval/lance/staging/run/",
            )

    def test_stale_source_and_manifest_require_force(self) -> None:
        with repo_temp_dir() as td:
            output_dir = seed.ensure_output_dir_ready(td / "seed-output")
            seed.source_parquet_path(output_dir, "demo").write_bytes(b"stale-source")
            seed.seed_manifest_path(output_dir, "demo").write_text(
                '{"stale": true}', encoding="utf-8"
            )
            with self.assertRaises(SystemExit) as ctx:
                seed.resolve_write_mode_or_exit(output_dir, "demo", force=False)
        self.assertEqual(ctx.exception.code, 1)

    def test_force_allows_regenerating_existing_local_artifacts(self) -> None:
        rows = 2
        fake_vectors = [np.zeros(seed.VECTOR_DIM, dtype=np.float32) for _ in range(rows)]
        with repo_temp_dir() as td, patch.object(
            seed, "generate_vectors", return_value=fake_vectors
        ):
            output_dir = seed.ensure_output_dir_ready(td / "seed-output")
            seed.build_seed_artifacts(
                rows=rows,
                output_dir=output_dir,
                table_name="demo",
                seed=42,
                write_mode="create",
                embedding_mode="openai",
                embedding_model=seed.DEFAULT_EMBEDDING_MODEL,
                api_key="sk-test",
            )

            source_path = seed.source_parquet_path(output_dir, "demo")
            manifest_path = seed.seed_manifest_path(output_dir, "demo")
            source_path.write_bytes(b"stale-source")
            manifest_path.write_text('{"stale": true}', encoding="utf-8")

            write_mode = seed.resolve_write_mode_or_exit(output_dir, "demo", force=True)
            self.assertEqual(write_mode, "overwrite")

            seed.build_seed_artifacts(
                rows=rows,
                output_dir=output_dir,
                table_name="demo",
                seed=42,
                write_mode=write_mode,
                embedding_mode="openai",
                embedding_model=seed.DEFAULT_EMBEDDING_MODEL,
                api_key="sk-test",
            )

            source_df = pd.read_parquet(source_path)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(len(source_df), rows)
            self.assertEqual(manifest["table_name"], "demo")
            self.assertEqual(manifest["row_count"], rows)


if __name__ == "__main__":
    unittest.main()
