from __future__ import annotations

import importlib.util
import io
import json
import shutil
import sys
import uuid
import unittest
from contextlib import contextmanager, redirect_stderr
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_validator_module():
    path = ROOT / "scripts" / "validate_eval_dataset.py"
    spec = importlib.util.spec_from_file_location("validate_eval_dataset", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_eval_dataset"] = mod
    spec.loader.exec_module(mod)
    return mod


validator = _load_validator_module()


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
    def test_load_cases_reads_expected_shape(self) -> None:
        cases = validator.load_cases(ROOT / "fixtures" / "eval" / "local_validation_cases.json")
        self.assertGreaterEqual(len(cases), 7)
        self.assertEqual(cases[0].case_id, "insurance-lapse-semantic")
        self.assertEqual(cases[0].expected_doc_types, ("Insurance_Lapse_Report",))

    def test_curated_cases_cover_key_scenario_families(self) -> None:
        cases = validator.load_cases(ROOT / "fixtures" / "eval" / "local_validation_cases.json")
        cases_by_id = {case.case_id: case for case in cases}

        self.assertIn("background-flag-semantic", cases_by_id)
        self.assertEqual(
            cases_by_id["background-flag-semantic"].expected_doc_types,
            ("Driver_Background_Flag",),
        )

        self.assertIn("permit-renewal-semantic", cases_by_id)
        self.assertEqual(
            cases_by_id["permit-renewal-semantic"].expected_doc_types,
            ("City_Permit_Renewal",),
        )

    def test_curated_timestamp_filtered_case_is_compiled_and_conservative(self) -> None:
        cases = validator.load_cases(ROOT / "fixtures" / "eval" / "local_validation_cases.json")
        cases_by_id = {case.case_id: case for case in cases}

        filtered_case = cases_by_id["recent-mex-permit-filtered"]
        self.assertEqual(filtered_case.expected_doc_types, ("City_Permit_Renewal",))
        self.assertEqual(filtered_case.expected_city_codes, ("MEX-SEMOVI",))
        self.assertEqual(filtered_case.limit, 5)
        self.assertEqual(filtered_case.min_expected_matches, 2)
        self.assertTrue(filtered_case.require_all_results_match)
        self.assertEqual(
            filtered_case.sql_filter,
            (
                "((city_code = 'MEX-SEMOVI') AND "
                "(doc_type = 'City_Permit_Renewal')) AND "
                "(timestamp >= CAST('2025-01-01T00:00:00Z' AS TIMESTAMP))"
            ),
        )

    def test_duplicate_case_ids_fail(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {"id": "dup", "query": "one"},
                        {"id": "dup", "query": "two"},
                    ]
                ),
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_bool_numeric_field_is_rejected(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "bad-limit",
                            "query": "find incidents",
                            "limit": True,
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_non_integer_numeric_field_is_rejected(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "bad-min",
                            "query": "find incidents",
                            "limit": 5,
                            "min_expected_matches": "2.5",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_min_expected_matches_must_not_exceed_limit(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "too-many",
                            "query": "find incidents",
                            "limit": 2,
                            "min_expected_matches": 3,
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_unsupported_sql_filter_field_is_rejected(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "bad-filter",
                            "query": "find incidents",
                            "sql_filter": "fleet_id = 'abc'",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_invalid_timestamp_sql_filter_is_rejected(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "bad-timestamp",
                            "query": "find incidents",
                            "sql_filter": "timestamp >= '2026-04-23'",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit):
                validator.load_cases(path)

    def test_valid_sql_filter_is_compiled_during_case_load(self) -> None:
        with repo_temp_dir() as td:
            path = td / "cases.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "id": "ok-filter",
                            "query": "find incidents",
                            "sql_filter": (
                                "city_code = 'SF-CPUC' "
                                "AND timestamp >= '2026-04-23T12:00:00Z'"
                            ),
                        }
                    ]
                ),
                encoding="utf-8",
            )

            cases = validator.load_cases(path)

        self.assertEqual(
            cases[0].sql_filter,
            "(city_code = 'SF-CPUC') AND (timestamp >= CAST('2026-04-23T12:00:00Z' AS TIMESTAMP))",
        )


class TestEvaluateCase(unittest.TestCase):
    def test_case_passes_when_top_and_match_count_are_good(self) -> None:
        case = validator.ValidationCase(
            case_id="ok",
            query="query",
            sql_filter=None,
            limit=3,
            min_expected_matches=2,
            expected_doc_types=("Insurance_Lapse_Report",),
            expected_city_codes=(),
            require_all_results_match=False,
        )
        rows = [
            {"incident_id": "1", "doc_type": "Insurance_Lapse_Report", "city_code": "NYC-TLC"},
            {"incident_id": "2", "doc_type": "Insurance_Lapse_Report", "city_code": "SF-CPUC"},
            {"incident_id": "3", "doc_type": "City_Permit_Renewal", "city_code": "NYC-TLC"},
        ]
        result = validator.evaluate_case(case, rows, preview_limit=2)
        self.assertTrue(result.passed)
        self.assertEqual(result.matched_result_count, 2)
        self.assertTrue(result.top_result_matches_expectations)
        self.assertEqual(len(result.result_preview), 2)

    def test_case_fails_when_top_result_is_wrong(self) -> None:
        case = validator.ValidationCase(
            case_id="bad-top",
            query="query",
            sql_filter=None,
            limit=3,
            min_expected_matches=2,
            expected_doc_types=("Safety_Incident_Log",),
            expected_city_codes=("SF-CPUC",),
            require_all_results_match=True,
        )
        rows = [
            {"incident_id": "1", "doc_type": "Vehicle_Inspection_Audit", "city_code": "SF-CPUC"},
            {"incident_id": "2", "doc_type": "Safety_Incident_Log", "city_code": "SF-CPUC"},
            {"incident_id": "3", "doc_type": "Safety_Incident_Log", "city_code": "CHI-BACP"},
        ]
        result = validator.evaluate_case(case, rows, preview_limit=3)
        self.assertFalse(result.passed)
        self.assertIn("top result did not match expected metadata", result.failure_reasons)
        self.assertIn("not every returned row matched the required metadata", result.failure_reasons)


class TestManifestUpdate(unittest.TestCase):
    def test_validate_manifest_rejects_blank_embedding_model(self) -> None:
        with repo_temp_dir() as temp_root:
            lance_path = temp_root / "demo.lance"
            lance_path.mkdir()
            manifest = {
                "embedding_mode": "openai",
                "embedding_model": "",
                "vector_dimension": validator.seed.VECTOR_DIM,
                "lance_dataset_path": str(lance_path),
            }

            stderr = io.StringIO()
            with self.assertRaises(SystemExit), redirect_stderr(stderr):
                validator.validate_manifest_or_exit(manifest, temp_root / "demo.seed-manifest.json")

        self.assertIn("must set a non-empty embedding_model", stderr.getvalue())

    def test_validate_manifest_rejects_whitespace_embedding_model(self) -> None:
        with repo_temp_dir() as temp_root:
            lance_path = temp_root / "demo.lance"
            lance_path.mkdir()
            manifest = {
                "embedding_mode": "openai",
                "embedding_model": "   ",
                "vector_dimension": validator.seed.VECTOR_DIM,
                "lance_dataset_path": str(lance_path),
            }

            stderr = io.StringIO()
            with self.assertRaises(SystemExit), redirect_stderr(stderr):
                validator.validate_manifest_or_exit(manifest, temp_root / "demo.seed-manifest.json")

        self.assertIn("must set a non-empty embedding_model", stderr.getvalue())

    def test_validate_manifest_rejects_unsupported_embedding_model(self) -> None:
        with repo_temp_dir() as temp_root:
            lance_path = temp_root / "demo.lance"
            lance_path.mkdir()
            manifest = {
                "embedding_mode": "openai",
                "embedding_model": "not-a-real-model",
                "vector_dimension": validator.seed.VECTOR_DIM,
                "lance_dataset_path": str(lance_path),
            }

            stderr = io.StringIO()
            with self.assertRaises(SystemExit), redirect_stderr(stderr):
                validator.validate_manifest_or_exit(manifest, temp_root / "demo.seed-manifest.json")

        self.assertIn("Unsupported --embedding-model", stderr.getvalue())

    def test_resolve_embedding_model_accepts_matching_override(self) -> None:
        manifest = {"embedding_model": "text-embedding-3-small"}
        self.assertEqual(
            validator.resolve_embedding_model(
                manifest,
                "text-embedding-3-small",
                manifest_path=ROOT / "demo.seed-manifest.json",
            ),
            "text-embedding-3-small",
        )

    def test_resolve_embedding_model_rejects_mismatched_override(self) -> None:
        manifest = {"embedding_model": "text-embedding-3-small"}
        with self.assertRaises(SystemExit):
            validator.resolve_embedding_model(
                manifest,
                "text-embedding-3-large",
                manifest_path=ROOT / "demo.seed-manifest.json",
            )

    def test_update_manifest_with_report_records_summary(self) -> None:
        with repo_temp_dir() as temp_root:
            manifest_path = temp_root / "demo.seed-manifest.json"
            manifest = {
                "table_name": "demo",
                "embedding_mode": "openai",
                "embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
                "lance_dataset_path": str(temp_root / "demo.lance"),
            }
            validator.seed.write_seed_manifest(manifest_path, manifest)

            report = {
                "generated_at": "2026-04-23T12:00:00+00:00",
                "report_path": str(temp_root / "demo.eval-validation.json"),
                "cases_path": str(temp_root / "cases.json"),
                "passed": True,
                "case_count": 4,
                "passed_case_count": 4,
                "failed_case_count": 0,
                "embedding_model": "text-embedding-3-small",
                "dataset_embedding_model": "text-embedding-3-small",
                "query_embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
            }

            validator.update_manifest_with_report(manifest_path, manifest, report=report)
            updated = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertIn("latest_local_validation", updated)
            self.assertTrue(updated["latest_local_validation"]["passed"])
            self.assertEqual(updated["latest_local_validation"]["case_count"], 4)
            self.assertEqual(
                updated["latest_local_validation"]["dataset_embedding_model"],
                "text-embedding-3-small",
            )
            self.assertEqual(
                updated["latest_local_validation"]["query_embedding_model"],
                "text-embedding-3-small",
            )

    def test_update_manifest_with_report_preserves_unrelated_manifest_fields(self) -> None:
        with repo_temp_dir() as temp_root:
            manifest_path = temp_root / "demo.seed-manifest.json"
            manifest = {
                "table_name": "demo",
                "embedding_mode": "openai",
                "embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
                "lance_dataset_path": str(temp_root / "demo.lance"),
                "upload_live_uri": "s3://bucket/demo/",
                "latest_local_validation": {"passed": False, "case_count": 99},
            }
            validator.seed.write_seed_manifest(manifest_path, manifest)

            report = {
                "generated_at": "2026-04-23T12:00:00+00:00",
                "report_path": str(temp_root / "demo.eval-validation.json"),
                "cases_path": str(temp_root / "cases.json"),
                "passed": True,
                "case_count": 1,
                "passed_case_count": 1,
                "failed_case_count": 0,
                "embedding_model": "text-embedding-3-small",
                "dataset_embedding_model": "text-embedding-3-small",
                "query_embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
            }

            validator.update_manifest_with_report(manifest_path, manifest, report=report)
            updated = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(updated["upload_live_uri"], "s3://bucket/demo/")
        self.assertEqual(updated["latest_local_validation"]["case_count"], 1)
        self.assertTrue(updated["latest_local_validation"]["passed"])

    def test_build_report_records_dataset_and_query_embedding_models(self) -> None:
        manifest = {
            "embedding_model": "text-embedding-3-small",
            "vector_dimension": 1536,
            "lance_dataset_path": str(ROOT / "lance_seed" / "demo.lance"),
        }
        report = validator.build_report(
            manifest_path=ROOT / "demo.seed-manifest.json",
            cases_path=ROOT / "cases.json",
            report_path=ROOT / "demo.eval-validation.json",
            manifest=manifest,
            embedding_model="text-embedding-3-small",
            results=[],
        )
        self.assertEqual(report["embedding_model"], "text-embedding-3-small")
        self.assertEqual(report["dataset_embedding_model"], "text-embedding-3-small")
        self.assertEqual(report["query_embedding_model"], "text-embedding-3-small")


class _FakeSearch:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows
        self.applied_filter: str | None = None
        self.prefilter: bool | None = None
        self.bypassed_vector_index = False
        self.limit_value: int | None = None

    def where(self, sql_filter: str, *, prefilter: bool) -> "_FakeSearch":
        self.applied_filter = sql_filter
        self.prefilter = prefilter
        return self

    def bypass_vector_index(self) -> "_FakeSearch":
        self.bypassed_vector_index = True
        return self

    def limit(self, value: int) -> "_FakeSearch":
        self.limit_value = value
        return self

    def to_list(self) -> list[dict[str, object]]:
        if self.limit_value is None:
            return list(self._rows)
        return list(self._rows[: self.limit_value])


class _FakeTable:
    def __init__(self, rows_by_query_index: dict[int, list[dict[str, object]]]) -> None:
        self.rows_by_query_index = rows_by_query_index
        self.searches: list[_FakeSearch] = []

    def search(self, query_vector) -> _FakeSearch:
        query_index = int(query_vector[0])
        search = _FakeSearch(self.rows_by_query_index[query_index])
        self.searches.append(search)
        return search


class TestRunValidation(unittest.TestCase):
    def test_run_validation_writes_report_and_manifest_stamp(self) -> None:
        with repo_temp_dir() as temp_root:
            lance_path = temp_root / "demo.lance"
            lance_path.mkdir()
            manifest_path = temp_root / "demo.seed-manifest.json"
            cases_path = temp_root / "cases.json"
            report_path = temp_root / "demo.eval-validation.json"

            manifest = {
                "table_name": "demo",
                "embedding_mode": "openai",
                "embedding_model": "text-embedding-3-small",
                "vector_dimension": 1536,
                "lance_dataset_path": str(lance_path),
                "upload_candidate_uri": "s3://bucket/staging/demo/",
            }
            validator.seed.write_seed_manifest(manifest_path, manifest)
            cases_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "insurance",
                            "query": "insurance lapse report",
                            "expected_doc_types": ["Insurance_Lapse_Report"],
                            "limit": 2,
                            "min_expected_matches": 1,
                        },
                        {
                            "id": "sf-safety",
                            "query": "san francisco safety log",
                            "sql_filter": "city_code = 'SF-CPUC' AND doc_type = 'Safety_Incident_Log'",
                            "expected_doc_types": ["Safety_Incident_Log"],
                            "expected_city_codes": ["SF-CPUC"],
                            "limit": 2,
                            "min_expected_matches": 1,
                            "require_all_results_match": True,
                        },
                    ]
                ),
                encoding="utf-8",
            )

            fake_table = _FakeTable(
                {
                    0: [
                        {
                            "incident_id": "1",
                            "doc_type": "Insurance_Lapse_Report",
                            "city_code": "NYC-TLC",
                            "text_content": "Coverage lapsed until a new certificate was filed.",
                            "_distance": 0.01,
                        },
                        {
                            "incident_id": "2",
                            "doc_type": "Insurance_Lapse_Report",
                            "city_code": "SF-CPUC",
                            "text_content": "Commercial auto policy expired for a fleet vehicle.",
                            "_distance": 0.02,
                        },
                    ],
                    1: [
                        {
                            "incident_id": "3",
                            "doc_type": "Safety_Incident_Log",
                            "city_code": "SF-CPUC",
                            "text_content": "Route deviation alert escalated through in-app safety tools.",
                            "_distance": 0.03,
                        }
                    ],
                }
            )

            with (
                mock.patch.object(
                    validator.seed,
                    "resolve_openai_api_key_or_exit",
                    return_value="test-api-key",
                ),
                mock.patch.object(
                    validator.seed,
                    "generate_openai_embeddings",
                    return_value=[
                        validator.np.asarray([0.0], dtype=validator.np.float32),
                        validator.np.asarray([1.0], dtype=validator.np.float32),
                    ],
                ) as generate_embeddings,
                mock.patch.object(validator, "load_table", return_value=fake_table),
            ):
                exit_code = validator.run_validation(
                    manifest_path=manifest_path,
                    cases_path=cases_path,
                    report_path=report_path,
                    embedding_model="text-embedding-3-small",
                    preview_limit=2,
                )

            self.assertEqual(exit_code, 0)
            generate_embeddings.assert_called_once_with(
                ["insurance lapse report", "san francisco safety log"],
                api_key="test-api-key",
                model="text-embedding-3-small",
                expected_dim=1536,
            )

            report = json.loads(report_path.read_text(encoding="utf-8"))
            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertTrue(report["passed"])
        self.assertEqual(report["passed_case_count"], 2)
        self.assertEqual(report["dataset_embedding_model"], "text-embedding-3-small")
        self.assertEqual(report["query_embedding_model"], "text-embedding-3-small")
        self.assertEqual(report["manifest_path"], str(manifest_path))
        self.assertEqual(
            report["cases"][1]["sql_filter"],
            "(city_code = 'SF-CPUC') AND (doc_type = 'Safety_Incident_Log')",
        )
        self.assertEqual(
            updated_manifest["latest_local_validation"]["report_path"],
            str(report_path),
        )
        self.assertEqual(
            updated_manifest["latest_local_validation"]["cases_path"],
            str(cases_path),
        )
        self.assertEqual(
            updated_manifest["latest_local_validation"]["embedding_model"],
            "text-embedding-3-small",
        )
        self.assertEqual(
            updated_manifest["upload_candidate_uri"],
            "s3://bucket/staging/demo/",
        )
        self.assertEqual(len(fake_table.searches), 2)
        self.assertIsNone(fake_table.searches[0].applied_filter)
        self.assertEqual(
            fake_table.searches[1].applied_filter,
            "(city_code = 'SF-CPUC') AND (doc_type = 'Safety_Incident_Log')",
        )
        self.assertTrue(fake_table.searches[1].prefilter)
        self.assertTrue(fake_table.searches[1].bypassed_vector_index)


if __name__ == "__main__":
    unittest.main()
