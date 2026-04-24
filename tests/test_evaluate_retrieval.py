from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_eval_module():
    path = ROOT / "scripts" / "evaluate_retrieval.py"
    spec = importlib.util.spec_from_file_location("evaluate_retrieval", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["evaluate_retrieval"] = mod
    spec.loader.exec_module(mod)
    return mod


evaluate = _load_eval_module()


@contextmanager
def repo_temp_dir():
    TEST_TMP_ROOT.mkdir(exist_ok=True)
    path = TEST_TMP_ROOT / str(uuid.uuid4())
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class TestLoadCases(unittest.TestCase):
    def test_rejects_duplicate_case_ids(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "dup",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["a"],
                        },
                        {
                            "id": "dup",
                            "query": "inspection",
                            "relevant_incident_ids": ["b"],
                        },
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                evaluate.load_cases(path)

    def test_rejects_invalid_filter(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "bad",
                            "query": "insurance lapse",
                            "sql_filter": "fleet_id = 'abc'",
                            "relevant_incident_ids": ["a"],
                        }
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                evaluate.load_cases(path)

    def test_loads_expected_shape(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "insurance",
                            "query": "insurance lapse",
                            "sql_filter": "city_code = 'CHI-BACP'",
                            "limit": 3,
                            "relevant_incident_ids": ["inc-1", "inc-2"],
                            "category": "semantic",
                            "notes": "demo note",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            cases = evaluate.load_cases(path)
        self.assertEqual(cases[0].case_id, "insurance")
        self.assertEqual(cases[0].relevant_incident_ids, ("inc-1", "inc-2"))
        self.assertEqual(cases[0].category, "semantic")
        self.assertIsNotNone(cases[0].filter_expr)


class TestFilterEvaluation(unittest.TestCase):
    def test_evaluate_filter_boolean_and_timestamp(self) -> None:
        expr = evaluate.parse_sql_filter(
            "city_code = 'MEX-SEMOVI' AND timestamp >= '2025-01-01T00:00:00Z'"
        )
        row = {
            "incident_id": "inc-1",
            "city_code": "MEX-SEMOVI",
            "timestamp": datetime(2025, 1, 2, tzinfo=timezone.utc),
            "doc_type": "City_Permit_Renewal",
        }
        self.assertTrue(evaluate.evaluate_filter(expr, row))
        row["timestamp"] = datetime(2024, 12, 31, tzinfo=timezone.utc)
        self.assertFalse(evaluate.evaluate_filter(expr, row))

    def test_evaluate_filter_handles_in_and_not(self) -> None:
        expr = evaluate.parse_sql_filter(
            "doc_type IN ('Safety_Incident_Log', 'Driver_Background_Flag') AND NOT city_code = 'NYC-TLC'"
        )
        ok_row = {
            "incident_id": "inc-1",
            "city_code": "SF-CPUC",
            "timestamp": "2025-01-01T00:00:00Z",
            "doc_type": "Safety_Incident_Log",
        }
        bad_row = dict(ok_row)
        bad_row["city_code"] = "NYC-TLC"
        self.assertTrue(evaluate.evaluate_filter(expr, ok_row))
        self.assertFalse(evaluate.evaluate_filter(expr, bad_row))


class TestKeywordBaseline(unittest.TestCase):
    def test_keyword_scorer_prefers_positive_text(self) -> None:
        rows = [
            {
                "incident_id": "positive",
                "text_content": "commercial auto coverage lapsed and driver suspended until new certificate upload",
                "doc_type": "Insurance_Lapse_Report",
                "city_code": "CHI-BACP",
                "timestamp": "2025-01-01T00:00:00Z",
            },
            {
                "incident_id": "near-miss",
                "text_content": "permit renewal mentions insurance certificate but there was no lapse or suspension",
                "doc_type": "City_Permit_Renewal",
                "city_code": "CHI-BACP",
                "timestamp": "2025-01-01T00:00:00Z",
            },
        ]
        stats = evaluate.build_keyword_stats(rows)
        case = evaluate.RetrievalCase(
            case_id="insurance",
            query="commercial auto coverage lapse suspension certificate",
            sql_filter=None,
            compiled_sql_filter=None,
            filter_expr=None,
            limit=2,
            relevant_incident_ids=("positive",),
            category=None,
            notes=None,
        )
        results = evaluate.keyword_only_search(stats, case=case)
        self.assertEqual(results[0]["incident_id"], "positive")


class _FakeSearch:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows
        self.limit_value: int | None = None
        self.where_calls: list[tuple[str, bool]] = []
        self.bypass_vector_index_called = False

    def where(self, compiled_filter: str, prefilter: bool = False) -> "_FakeSearch":
        self.where_calls.append((compiled_filter, prefilter))
        return self

    def bypass_vector_index(self) -> "_FakeSearch":
        self.bypass_vector_index_called = True
        return self

    def limit(self, value: int) -> "_FakeSearch":
        self.limit_value = value
        return self

    def to_list(self) -> list[dict[str, object]]:
        if self.limit_value is None:
            return list(self._rows)
        return list(self._rows[: self.limit_value])


class _FakeTable:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows
        self.last_search: _FakeSearch | None = None

    def search(self, query_vector) -> _FakeSearch:
        self.last_search = _FakeSearch(self.rows)
        return self.last_search


class TestVectorPostfilter(unittest.TestCase):
    def test_vector_postfilter_drops_filter_mismatches(self) -> None:
        rows = [
            {
                "incident_id": "wrong-city",
                "doc_type": "Safety_Incident_Log",
                "city_code": "NYC-TLC",
                "timestamp": "2025-01-02T00:00:00Z",
            },
            {
                "incident_id": "correct-city",
                "doc_type": "Safety_Incident_Log",
                "city_code": "SF-CPUC",
                "timestamp": "2025-01-02T00:00:00Z",
            },
        ]
        case = evaluate.RetrievalCase(
            case_id="safety",
            query="route deviation",
            sql_filter="city_code = 'SF-CPUC'",
            compiled_sql_filter="city_code = 'SF-CPUC'",
            filter_expr=evaluate.parse_sql_filter("city_code = 'SF-CPUC'"),
            limit=2,
            relevant_incident_ids=("correct-city",),
            category="filtered",
            notes=None,
        )
        results = evaluate.vector_postfilter_search(
            _FakeTable(rows),
            query_vector=evaluate.np.asarray([0.0], dtype=evaluate.np.float32),
            case=case,
        )
        self.assertEqual([row["incident_id"] for row in results], ["correct-city"])

    def test_trace_filtered_search_does_not_bypass_vector_index(self) -> None:
        case = evaluate.RetrievalCase(
            case_id="safety",
            query="route deviation",
            sql_filter="city_code = 'SF-CPUC'",
            compiled_sql_filter="city_code = 'SF-CPUC'",
            filter_expr=evaluate.parse_sql_filter("city_code = 'SF-CPUC'"),
            limit=2,
            relevant_incident_ids=("correct-city",),
            category="filtered",
            notes=None,
        )
        table = _FakeTable(
            [
                {
                    "incident_id": "correct-city",
                    "doc_type": "Safety_Incident_Log",
                    "city_code": "SF-CPUC",
                    "timestamp": "2025-01-02T00:00:00Z",
                }
            ]
        )

        evaluate.trace_prefilter_vector_search(
            table,
            query_vector=evaluate.np.asarray([0.0], dtype=evaluate.np.float32),
            case=case,
        )

        assert table.last_search is not None
        self.assertEqual(
            table.last_search.where_calls,
            [("city_code = 'SF-CPUC'", True)],
        )
        self.assertFalse(table.last_search.bypass_vector_index_called)


class TestMetricsAndReports(unittest.TestCase):
    def _write_manifest(self, td: Path, source_rows: list[dict[str, object]]) -> Path:
        manifest_path = td / "demo.seed-manifest.json"
        source_path = td / "demo.parquet"
        lance_path = td / "demo.lance"
        lance_path.mkdir()

        pd_module = sys.modules.get("pandas")
        if pd_module is None:
            import pandas as pd  # type: ignore
        else:
            pd = pd_module
        pd.DataFrame(source_rows).to_parquet(source_path)

        manifest_path.write_text(
            json.dumps(
                {
                    "embedding_mode": "openai",
                    "embedding_model": "text-embedding-3-small",
                    "vector_dimension": 1536,
                    "lance_dataset_path": str(lance_path),
                    "source_parquet_path": str(source_path),
                }
            ),
            encoding="utf-8",
        )
        return manifest_path

    def _run_evaluation_for_preflight(
        self,
        *,
        td: Path,
        source_rows: list[dict[str, object]],
        cases_payload: list[dict[str, object]],
    ) -> int:
        manifest_path = self._write_manifest(td, source_rows)
        cases_path = td / "cases.json"
        report_path = td / "artifacts" / "report.json"
        summary_path = td / "artifacts" / "summary.md"
        cases_path.write_text(json.dumps(cases_payload), encoding="utf-8")

        with (
            mock.patch.object(
                evaluate.seed,
                "resolve_openai_api_key_or_exit",
                return_value="test-api-key",
            ),
            mock.patch.object(
                evaluate.seed,
                "generate_openai_embeddings",
                return_value=[evaluate.np.asarray([0.0], dtype=evaluate.np.float32)],
            ),
            mock.patch.object(
                evaluate,
                "load_table",
                return_value=_FakeTable([]),
            ),
        ):
            return evaluate.run_evaluation(
                manifest_path=manifest_path,
                cases_path=cases_path,
                report_path=report_path,
                summary_path=summary_path,
                embedding_model="text-embedding-3-small",
                preview_limit=2,
            )

    def _extract_postfilter_candidate_window(self, report: dict[str, object]) -> int | None:
        method_payload = report["cases"][0]["methods"][evaluate.METHOD_VECTOR_POSTFILTER]
        candidate_keys = (
            "candidate_pool_limit",
            "postfilter_candidate_limit",
            "candidate_limit",
            "postfilter_candidate_window",
        )
        containers = [report, method_payload]
        for key in ("config", "evaluation_config"):
            value = report.get(key)
            if isinstance(value, dict):
                containers.append(value)
        method_config = method_payload.get("config")
        if isinstance(method_config, dict):
            containers.append(method_config)
        for container in containers:
            for key in candidate_keys:
                value = container.get(key)
                if isinstance(value, int):
                    return value
        return None

    def test_case_metrics(self) -> None:
        case = evaluate.RetrievalCase(
            case_id="privacy",
            query="privacy deletion request",
            sql_filter="city_code = 'MEX-SEMOVI'",
            compiled_sql_filter="city_code = 'MEX-SEMOVI'",
            filter_expr=evaluate.parse_sql_filter("city_code = 'MEX-SEMOVI'"),
            limit=2,
            relevant_incident_ids=("inc-1", "inc-3"),
            category="filtered",
            notes=None,
        )
        rows = [
            {"incident_id": "inc-1", "city_code": "MEX-SEMOVI", "doc_type": "Data_Privacy_Request"},
            {"incident_id": "inc-2", "city_code": "MEX-SEMOVI", "doc_type": "Data_Privacy_Request"},
        ]
        result = evaluate.evaluate_case_metrics(
            case,
            evaluate.METHOD_TRACE_PREFILTER,
            rows,
            preview_limit=2,
        )
        self.assertEqual(result.relevant_hit_count, 1)
        self.assertAlmostEqual(result.recall_at_k, 0.5)
        self.assertAlmostEqual(result.precision_at_k, 0.5)
        self.assertTrue(result.filter_all_results_match)

    def test_case_metrics_precision_uses_k_not_returned_count(self) -> None:
        case = evaluate.RetrievalCase(
            case_id="precision-k",
            query="insurance lapse",
            sql_filter=None,
            compiled_sql_filter=None,
            filter_expr=None,
            limit=5,
            relevant_incident_ids=("inc-1",),
            category="semantic",
            notes=None,
        )

        result = evaluate.evaluate_case_metrics(
            case,
            evaluate.METHOD_TRACE_PREFILTER,
            [{"incident_id": "inc-1", "city_code": "CHI-BACP", "doc_type": "Insurance_Lapse_Report"}],
            preview_limit=1,
        )

        self.assertAlmostEqual(result.precision_at_k, 0.2)

    def test_filtered_aggregate_accuracy_requires_all_labeled_hits(self) -> None:
        case_payloads = [
            {
                "case_id": "filtered-subset",
                "query": "privacy deletion request",
                "sql_filter": "city_code = 'MEX-SEMOVI'",
                "limit": 2,
                "category": "filtered",
                "notes": None,
                "relevant_incident_ids": ["inc-1", "inc-3"],
                "methods": {
                    evaluate.METHOD_TRACE_PREFILTER: {
                        "method": evaluate.METHOD_TRACE_PREFILTER,
                        "returned_ids": ["inc-1"],
                        "relevant_hits": ["inc-1"],
                        "returned_count": 1,
                        "relevant_hit_count": 1,
                        "recall_at_k": 0.5,
                        "precision_at_k": 0.5,
                        "filter_all_results_match": True,
                        "filtered_strict_success": False,
                        "preview": [],
                        "sql_filter": "city_code = 'MEX-SEMOVI'",
                    }
                },
            }
        ]

        metrics = evaluate.aggregate_method_metrics(case_payloads, evaluate.METHOD_TRACE_PREFILTER)

        self.assertEqual(metrics["filtered_case_count"], 1)
        self.assertEqual(metrics["filtered_query_strict_accuracy"], 0.0)

    def test_build_report_includes_audit_metadata(self) -> None:
        case_payloads = [
            {
                "case_id": "insurance",
                "query": "insurance lapse",
                "sql_filter": None,
                "limit": 3,
                "category": "semantic",
                "notes": None,
                "relevant_incident_ids": ["inc-1"],
                "methods": {
                    evaluate.METHOD_TRACE_PREFILTER: {
                        "method": evaluate.METHOD_TRACE_PREFILTER,
                        "returned_ids": ["inc-1"],
                        "relevant_hits": ["inc-1"],
                        "returned_count": 1,
                        "relevant_hit_count": 1,
                        "recall_at_k": 1.0,
                        "precision_at_k": 1.0,
                        "filter_all_results_match": True,
                        "preview": [],
                        "sql_filter": None,
                    },
                    evaluate.METHOD_KEYWORD_ONLY: {
                        "method": evaluate.METHOD_KEYWORD_ONLY,
                        "returned_ids": ["inc-1"],
                        "relevant_hits": ["inc-1"],
                        "returned_count": 1,
                        "relevant_hit_count": 1,
                        "recall_at_k": 1.0,
                        "precision_at_k": 1.0,
                        "filter_all_results_match": True,
                        "preview": [],
                        "sql_filter": None,
                    },
                    evaluate.METHOD_VECTOR_POSTFILTER: {
                        "method": evaluate.METHOD_VECTOR_POSTFILTER,
                        "returned_ids": ["inc-1"],
                        "relevant_hits": ["inc-1"],
                        "returned_count": 1,
                        "relevant_hit_count": 1,
                        "recall_at_k": 1.0,
                        "precision_at_k": 1.0,
                        "filter_all_results_match": True,
                        "preview": [],
                        "sql_filter": None,
                    },
                },
            }
        ]
        report = evaluate.build_report(
            generated_at=datetime(2026, 4, 24, tzinfo=timezone.utc),
            manifest_path=ROOT / "demo.seed-manifest.json",
            cases_path=ROOT / "cases.json",
            report_path=ROOT / "report.json",
            summary_path=ROOT / "summary.md",
            manifest={
                "lance_dataset_path": str(ROOT / "demo.lance"),
                "source_parquet_path": str(ROOT / "demo.parquet"),
                "embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
            },
            embedding_model="text-embedding-3-small",
            case_payloads=case_payloads,
        )
        self.assertEqual(report["manifest_path"], str(ROOT / "demo.seed-manifest.json"))
        self.assertIn("aggregate_metrics", report)
        self.assertEqual(report["case_count"], 1)
        self.assertEqual(report["methods"], list(evaluate.METHOD_ORDER))

    def test_dataset_preflight_rejects_missing_labeled_incident_id(self) -> None:
        with repo_temp_dir() as td:
            with self.assertRaises(SystemExit):
                self._run_evaluation_for_preflight(
                    td=td,
                    source_rows=[
                        {
                            "incident_id": "inc-1",
                            "text_content": "insurance lapse suspension certificate",
                            "doc_type": "Insurance_Lapse_Report",
                            "city_code": "CHI-BACP",
                            "timestamp": "2025-01-01T00:00:00Z",
                        }
                    ],
                    cases_payload=[
                        {
                            "id": "missing-label",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["inc-404"],
                        }
                    ],
                )

    def test_dataset_preflight_rejects_duplicate_source_incident_ids(self) -> None:
        with repo_temp_dir() as td:
            with self.assertRaises(SystemExit):
                self._run_evaluation_for_preflight(
                    td=td,
                    source_rows=[
                        {
                            "incident_id": "dup-1",
                            "text_content": "first row",
                            "doc_type": "Insurance_Lapse_Report",
                            "city_code": "CHI-BACP",
                            "timestamp": "2025-01-01T00:00:00Z",
                        },
                        {
                            "incident_id": "dup-1",
                            "text_content": "duplicate row",
                            "doc_type": "Insurance_Lapse_Report",
                            "city_code": "CHI-BACP",
                            "timestamp": "2025-01-02T00:00:00Z",
                        },
                    ],
                    cases_payload=[
                        {
                            "id": "duplicate-source",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["dup-1"],
                        }
                    ],
                )

    def test_dataset_preflight_rejects_filtered_label_outside_filter(self) -> None:
        with repo_temp_dir() as td:
            with self.assertRaises(SystemExit):
                self._run_evaluation_for_preflight(
                    td=td,
                    source_rows=[
                        {
                            "incident_id": "inc-1",
                            "text_content": "privacy deletion request",
                            "doc_type": "Data_Privacy_Request",
                            "city_code": "CHI-BACP",
                            "timestamp": "2025-01-01T00:00:00Z",
                        }
                    ],
                    cases_payload=[
                        {
                            "id": "filter-mismatch",
                            "query": "privacy deletion request",
                            "sql_filter": "city_code = 'MEX-SEMOVI'",
                            "relevant_incident_ids": ["inc-1"],
                        }
                    ],
                )

    def test_run_evaluation_reports_explicit_postfilter_candidate_window(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = self._write_manifest(
                td,
                [
                    {
                        "incident_id": "inc-1",
                        "text_content": "insurance lapse suspension certificate",
                        "doc_type": "Insurance_Lapse_Report",
                        "city_code": "CHI-BACP",
                        "timestamp": "2025-01-01T00:00:00Z",
                    }
                ],
            )
            cases_path = td / "cases.json"
            report_path = td / "artifacts" / "report.json"
            summary_path = td / "artifacts" / "summary.md"
            cases_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "postfilter-window",
                            "query": "insurance lapse",
                            "limit": 3,
                            "relevant_incident_ids": ["inc-1"],
                        }
                    ]
                ),
                encoding="utf-8",
            )

            fake_table = _FakeTable(
                [
                    {
                        "incident_id": "inc-1",
                        "doc_type": "Insurance_Lapse_Report",
                        "city_code": "CHI-BACP",
                        "timestamp": "2025-01-01T00:00:00Z",
                        "_distance": 0.01,
                    }
                ]
            )

            with (
                mock.patch.object(
                    evaluate.seed,
                    "resolve_openai_api_key_or_exit",
                    return_value="test-api-key",
                ),
                mock.patch.object(
                    evaluate.seed,
                    "generate_openai_embeddings",
                    return_value=[evaluate.np.asarray([0.0], dtype=evaluate.np.float32)],
                ),
                mock.patch.object(
                    evaluate,
                    "load_table",
                    return_value=fake_table,
                ),
            ):
                exit_code = evaluate.run_evaluation(
                    manifest_path=manifest_path,
                    cases_path=cases_path,
                    report_path=report_path,
                    summary_path=summary_path,
                    embedding_model="text-embedding-3-small",
                    preview_limit=2,
                )

            self.assertEqual(exit_code, 0)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            reported_candidate_window = self._extract_postfilter_candidate_window(report)
            self.assertIsNotNone(
                reported_candidate_window,
                "Expected report or method payload to expose the postfilter candidate window.",
            )
            assert fake_table.last_search is not None
            self.assertEqual(reported_candidate_window, fake_table.last_search.limit_value)

    def test_run_evaluation_writes_report_and_summary(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "demo.seed-manifest.json"
            cases_path = td / "cases.json"
            report_path = td / "artifacts" / "report.json"
            summary_path = td / "artifacts" / "summary.md"

            manifest = {
                "embedding_mode": "openai",
                "embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
                "lance_dataset_path": str(td / "demo.lance"),
                "source_parquet_path": str(td / "demo.parquet"),
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            cases_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "insurance",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["inc-1"],
                        }
                    ]
                ),
                encoding="utf-8",
            )
            pd_module = sys.modules.get("pandas")
            if pd_module is None:
                import pandas as pd  # type: ignore
            else:
                pd = pd_module
            pd.DataFrame(
                [
                    {
                        "incident_id": "inc-1",
                        "text_content": "insurance lapse suspension certificate",
                        "doc_type": "Insurance_Lapse_Report",
                        "city_code": "CHI-BACP",
                        "timestamp": "2025-01-01T00:00:00Z",
                    }
                ]
            ).to_parquet(td / "demo.parquet")
            (td / "demo.lance").mkdir()

            fake_rows = [
                {
                    "incident_id": "inc-1",
                    "doc_type": "Insurance_Lapse_Report",
                    "city_code": "CHI-BACP",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "_distance": 0.01,
                }
            ]

            with (
                mock.patch.object(
                    evaluate.seed,
                    "resolve_openai_api_key_or_exit",
                    return_value="test-api-key",
                ),
                mock.patch.object(
                    evaluate.seed,
                    "generate_openai_embeddings",
                    return_value=[evaluate.np.asarray([0.0], dtype=evaluate.np.float32)],
                ),
                mock.patch.object(
                    evaluate,
                    "load_table",
                    return_value=_FakeTable(fake_rows),
                ),
            ):
                exit_code = evaluate.run_evaluation(
                    manifest_path=manifest_path,
                    cases_path=cases_path,
                    report_path=report_path,
                    summary_path=summary_path,
                    embedding_model="text-embedding-3-small",
                    preview_limit=2,
                )

            self.assertEqual(exit_code, 0)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            summary = summary_path.read_text(encoding="utf-8")
            self.assertEqual(report["case_count"], 1)
            self.assertIn("Avg Recall@k", summary)


if __name__ == "__main__":
    unittest.main()
