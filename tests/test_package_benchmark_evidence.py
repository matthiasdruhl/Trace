from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_package_module():
    path = ROOT / "scripts" / "package_benchmark_evidence.py"
    spec = importlib.util.spec_from_file_location("package_benchmark_evidence", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["package_benchmark_evidence"] = mod
    spec.loader.exec_module(mod)
    return mod


package = _load_package_module()


@contextmanager
def repo_temp_dir():
    TEST_TMP_ROOT.mkdir(exist_ok=True)
    path = TEST_TMP_ROOT / str(uuid.uuid4())
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class TestRetrievalValidation(unittest.TestCase):
    def _write_retrieval_provenance(
        self,
        td: Path,
        *,
        validation_passed: bool = True,
    ) -> dict[str, object]:
        lance_dataset_path = td / "uber_audit.lance"
        source_parquet_path = td / "uber_audit.source.parquet"
        lance_dataset_path.mkdir()
        source_parquet_path.write_text("placeholder", encoding="utf-8")
        manifest_path = td / "uber_audit.seed-manifest.json"
        validation_report_path = td / "uber_audit.eval-validation.json"
        validation_cases_path = (ROOT / "fixtures" / "eval" / "local_validation_cases.json").resolve()
        validation_report = {
            "generated_at": "2026-04-27T09:15:00Z",
            "manifest_path": str(manifest_path.resolve()),
            "cases_path": str(validation_cases_path),
            "report_path": str(validation_report_path.resolve()),
            "lance_dataset_path": str(lance_dataset_path.resolve()),
            "embedding_model": "text-embedding-3-small",
            "dataset_embedding_model": "text-embedding-3-small",
            "query_embedding_model": "text-embedding-3-small",
            "vector_dimension": 1536,
            "passed": validation_passed,
            "case_count": 7,
            "passed_case_count": 7 if validation_passed else 6,
            "failed_case_count": 0 if validation_passed else 1,
            "cases": [],
        }
        validation_report_path.write_text(
            json.dumps(validation_report, indent=2),
            encoding="utf-8",
        )
        manifest = {
            "embedding_mode": "openai",
            "embedding_model": "text-embedding-3-small",
            "vector_dimension": 1536,
            "lance_dataset_path": str(lance_dataset_path.resolve()),
            "source_parquet_path": str(source_parquet_path.resolve()),
            "latest_local_validation": {
                "generated_at": validation_report["generated_at"],
                "report_path": validation_report["report_path"],
                "cases_path": validation_report["cases_path"],
                "passed": validation_report["passed"],
                "case_count": validation_report["case_count"],
                "passed_case_count": validation_report["passed_case_count"],
                "failed_case_count": validation_report["failed_case_count"],
                "embedding_model": validation_report["embedding_model"],
                "dataset_embedding_model": validation_report["dataset_embedding_model"],
                "query_embedding_model": validation_report["query_embedding_model"],
                "vector_dimension": validation_report["vector_dimension"],
            },
        }
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return {
            "manifest_path": str(manifest_path.resolve()),
            "lance_dataset_path": str(lance_dataset_path.resolve()),
            "source_parquet_path": str(source_parquet_path.resolve()),
            "vector_dimension": 1536,
            "validation_report_path": validation_report_path,
            "manifest_file_path": manifest_path,
        }

    def _valid_retrieval_report(self, td: Path) -> dict[str, object]:
        case_count = 7
        provenance = self._write_retrieval_provenance(td)
        return {
            "run_id": "eval-run",
            "generated_at": "2026-04-28T16:17:16Z",
            "cases_path": str((ROOT / "fixtures" / "eval" / "retrieval_relevance_cases.json").resolve()),
            "manifest_path": provenance["manifest_path"],
            "source_parquet_path": provenance["source_parquet_path"],
            "vector_dimension": provenance["vector_dimension"],
            "embedding_model": "text-embedding-3-small",
            "dataset_embedding_model": "text-embedding-3-small",
            "query_embedding_model": "text-embedding-3-small",
            "case_count": case_count,
            "lance_dataset_path": provenance["lance_dataset_path"],
            "evaluation_config": {
                "postfilter_candidate_multiplier": 10,
                "postfilter_candidate_limit": None,
            },
            "methods": [
                "trace_prefilter_vector",
                "keyword_only",
                "vector_postfilter",
            ],
            "cases": [
                {"case_id": f"case-{index + 1}"}
                for index in range(case_count)
            ],
            "aggregate_metrics": {
                "trace_prefilter_vector": {
                    "average_recall_at_k": 1.0,
                    "average_precision_at_k": 0.6,
                    "filtered_query_strict_accuracy": 1.0,
                },
                "keyword_only": {
                    "average_recall_at_k": 0.25,
                    "average_precision_at_k": 0.15,
                    "filtered_query_accuracy": 0.0,
                },
                "vector_postfilter": {
                    "average_recall_at_k": 1.0,
                    "average_precision_at_k": 0.6,
                    "filtered_query_strict_accuracy": 1.0,
                },
            },
        }

    def test_normalizes_older_filtered_accuracy_field(self) -> None:
        with repo_temp_dir() as td:
            report = package.validate_retrieval_report(
                self._valid_retrieval_report(td),
                ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
            )
            self.assertEqual(
                report["keyword_only"]["filtered_query_strict_accuracy"],
                0.0,
            )
            self.assertIn("provenance", report)

    def test_rejects_missing_required_metric_before_render(self) -> None:
        with repo_temp_dir() as td:
            payload = self._valid_retrieval_report(td)
            payload["aggregate_metrics"]["trace_prefilter_vector"]["average_precision_at_k"] = None
            with self.assertRaises(package.TraceRuntimeError):
                package.validate_retrieval_report(
                    payload,
                    ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
                )

    def test_rejects_case_count_mismatch(self) -> None:
        with repo_temp_dir() as td:
            payload = self._valid_retrieval_report(td)
            payload["cases"] = payload["cases"][:-1]
            with self.assertRaises(package.TraceRuntimeError):
                package.validate_retrieval_report(
                    payload,
                    ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
                )

    def test_rejects_wrong_cases_path(self) -> None:
        with repo_temp_dir() as td:
            payload = self._valid_retrieval_report(td)
            payload["cases_path"] = str((ROOT / "fixtures" / "eval" / "proof_of_value_cases.json").resolve())
            with self.assertRaises(package.TraceRuntimeError):
                package.validate_retrieval_report(
                    payload,
                    ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
                )

    def test_rejects_missing_passing_local_validation_provenance(self) -> None:
        with repo_temp_dir() as td:
            payload = self._valid_retrieval_report(td)
            manifest_path = Path(str(payload["manifest_path"]))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["latest_local_validation"]["passed"] = False
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            with self.assertRaises(package.TraceRuntimeError):
                package.validate_retrieval_report(
                    payload,
                    ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
                )

    def test_rejects_validation_report_for_different_dataset(self) -> None:
        with repo_temp_dir() as td:
            payload = self._valid_retrieval_report(td)
            manifest_path = Path(str(payload["manifest_path"]))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            validation_report_path = Path(str(manifest["latest_local_validation"]["report_path"]))
            validation_report = json.loads(validation_report_path.read_text(encoding="utf-8"))
            validation_report["lance_dataset_path"] = str((td / "different.lance").resolve())
            validation_report_path.write_text(json.dumps(validation_report, indent=2), encoding="utf-8")
            with self.assertRaises(package.TraceRuntimeError):
                package.validate_retrieval_report(
                    payload,
                    ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
                )


class TestBenchmarkValidation(unittest.TestCase):
    def _valid_benchmark_report(self) -> dict[str, object]:
        return {
            "run_id": "bench-run",
            "generated_at": "2026-04-28T18:00:00Z",
            "runtime_context": {
                "stack_name": "trace-eval",
                "dataset_uri": "s3://trace-vault/trace/eval/lance/",
                "search_url": "https://kqsqrljj11.execute-api.us-east-1.amazonaws.com/search",
                "function_arn": "arn:aws:lambda:us-east-1:123456789012:function:trace-eval-trace-search",
                "function_name": "trace-eval-trace-search",
                "configured_memory_mb": 512,
                "function_architectures": ["arm64"],
                "embedding_model": "text-embedding-3-small",
                "region": "us-east-1",
            },
            "pricing": {
                "lambda_request_price_per_million": 0.2,
                "lambda_gb_second_price": 0.0000166667,
                "api_gateway_http_request_price_per_million": 1.0,
                "embedding_cost_included": False,
                "notes": (
                    "Estimate includes Lambda request cost, Lambda compute cost, and "
                    "API Gateway HTTP API request cost only. It excludes query-embedding cost."
                ),
            },
            "benchmark_cases": [
                {"case_id": "unfiltered-demo"},
                {"case_id": "filtered-chi-insurance"},
            ],
            "summary": {
                "cold_init_median_ms": 100.0,
                "cold_init_p95_ms": 110.0,
                "cold_lambda_billed_median_ms": 1800.0,
                "warm_http_latency_median_ms": 120.0,
                "warm_http_latency_p95_ms": 150.0,
                "warm_took_median_ms": 60.0,
                "warm_took_p95_ms": 75.0,
                "warm_lambda_billed_median_ms": 81.0,
                "configured_memory_mb": 512,
                "max_memory_used_mb": 188,
                "estimated_warm_cost_per_query_usd": 0.00000234,
                "estimated_cold_cost_per_query_usd": 0.00002123,
            },
            "cold_lambda_samples": [
                {
                    "lambda_version": "2",
                    "report": {
                        "init_duration_ms": 80.77,
                        "billed_duration_ms": 1956.0,
                        "report_line": "REPORT ... Init Duration: 80.77 ms",
                    },
                },
                {
                    "lambda_version": "3",
                    "report": {
                        "init_duration_ms": 105.13,
                        "billed_duration_ms": 1846.0,
                        "report_line": "REPORT ... Init Duration: 105.13 ms",
                    },
                },
            ],
            "warm_http_samples": [
                {"case_id": "unfiltered-demo", "client_round_trip_ms": 120.0},
            ],
            "warm_lambda_samples": [
                {"case_id": "unfiltered-demo", "report": {"billed_duration_ms": 81.0}},
            ],
        }

    def test_rejects_smoke_stack(self) -> None:
        payload = self._valid_benchmark_report()
        runtime_context = dict(payload["runtime_context"])
        runtime_context["stack_name"] = "trace-smoke"
        payload["runtime_context"] = runtime_context
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )

    def test_rejects_smoke_dataset(self) -> None:
        payload = self._valid_benchmark_report()
        runtime_context = dict(payload["runtime_context"])
        runtime_context["dataset_uri"] = "s3://trace-vault/uber_audit.lance/"
        payload["runtime_context"] = runtime_context
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )

    def test_rejects_missing_summary_metric_instead_of_allowing_none(self) -> None:
        payload = self._valid_benchmark_report()
        payload["summary"]["warm_took_median_ms"] = None
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )

    def test_rejects_cost_scope_that_includes_embeddings(self) -> None:
        payload = self._valid_benchmark_report()
        payload["pricing"]["embedding_cost_included"] = True
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )

    def test_rejects_cold_samples_without_published_version_proof(self) -> None:
        payload = self._valid_benchmark_report()
        payload["cold_lambda_samples"][0]["lambda_version"] = None
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )

    def test_rejects_runtime_context_that_disagrees_with_stack_outputs(self) -> None:
        payload = self._valid_benchmark_report()
        payload["stack_outputs"] = {
            "SearchUrl": "https://different.execute-api.us-east-1.amazonaws.com/search",
            "TraceSearchFunctionArn": payload["runtime_context"]["function_arn"],
        }
        with self.assertRaises(package.TraceRuntimeError):
            package.validate_benchmark_report(
                payload,
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )


class TestSnapshotAndMarkdown(unittest.TestCase):
    def test_render_markdown_contains_required_sections(self) -> None:
        with repo_temp_dir() as td:
            retrieval = package.validate_retrieval_report(
                TestRetrievalValidation()._valid_retrieval_report(td),
                ROOT / "artifacts" / "evaluations" / "demo" / "report.json",
            )
            benchmark = package.validate_benchmark_report(
                TestBenchmarkValidation()._valid_benchmark_report(),
                ROOT / "artifacts" / "benchmarks" / "demo" / "benchmark.json",
            )
            snapshot = package.build_snapshot(retrieval=retrieval, benchmark=benchmark)
            markdown = package.render_markdown(snapshot)

            self.assertIn("## Headline Claims", markdown)
            self.assertIn("## What We Measured", markdown)
            self.assertIn("## Current Numbers Table", markdown)
            self.assertIn("### Retrieval Evidence", markdown)
            self.assertIn("### Deployed Benchmark Evidence", markdown)
            self.assertIn("Approved corpus validation", markdown)
            self.assertIn("Cold Lambda billed median", markdown)
            self.assertIn("Estimated cold cost/query", markdown)
            self.assertIn("## What The Numbers Mean", markdown)
            self.assertIn("## Boundaries And Methodology", markdown)
            self.assertIn("## Source Artifacts Used", markdown)
            self.assertIn("Retrieval approval validation report", markdown)
