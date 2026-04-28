from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_proof_module():
    path = ROOT / "scripts" / "build_proof_of_value.py"
    spec = importlib.util.spec_from_file_location("build_proof_of_value", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_proof_of_value"] = mod
    spec.loader.exec_module(mod)
    return mod


proof = _load_proof_module()


@contextmanager
def repo_temp_dir():
    TEST_TMP_ROOT.mkdir(exist_ok=True)
    path = TEST_TMP_ROOT / str(uuid.uuid4())
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def write_json(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


class TestLoadProofConfig(unittest.TestCase):
    def test_loads_valid_config(self) -> None:
        with repo_temp_dir() as td:
            path = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            config = proof.load_proof_config(path)

        self.assertEqual(len(config), 1)
        self.assertEqual(config[0].artifact_id, "insurance-keyword-gap")

    def test_rejects_duplicate_artifact_id(self) -> None:
        with repo_temp_dir() as td:
            path = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "dup",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "case-a",
                            "title": "First",
                        },
                        {
                            "artifact_id": "dup",
                            "comparison_type": "semantic_scope",
                            "retrieval_case_id": "case-b",
                            "title": "Second",
                        },
                    ],
                },
            )

            with self.assertRaises(SystemExit):
                proof.load_proof_config(path)

    def test_rejects_missing_artifact_id(self) -> None:
        with repo_temp_dir() as td:
            path = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "case-a",
                            "title": "Missing id",
                        }
                    ],
                },
            )

            with self.assertRaises(SystemExit):
                proof.load_proof_config(path)


class TestBuildSnapshot(unittest.TestCase):
    def _manifest(self) -> dict[str, object]:
        return {
            "embedding_mode": "openai",
            "embedding_model": "text-embedding-3-small",
            "vector_dimension": 1536,
            "lance_dataset_path": str(ROOT / ".test-tmp" / "demo.lance"),
            "source_parquet_path": str(ROOT / ".test-tmp" / "demo.parquet"),
        }

    def _report_metadata(self, *, manifest_path: Path, cases_path: Path) -> dict[str, object]:
        manifest = self._manifest()
        return {
            "manifest_path": str(manifest_path.resolve()),
            "cases_path": str(cases_path.resolve()),
            "lance_dataset_path": str(Path(str(manifest["lance_dataset_path"])).resolve()),
            "source_parquet_path": str(Path(str(manifest["source_parquet_path"])).resolve()),
            "dataset_embedding_model": str(manifest["embedding_model"]),
            "query_embedding_model": str(manifest["embedding_model"]),
            "vector_dimension": int(manifest["vector_dimension"]),
        }

    def test_rejects_missing_referenced_retrieval_case(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "missing-case",
                            "title": "Missing",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "different-case",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [],
                },
            )

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=[]),
            ):
                with self.assertRaises(SystemExit):
                    proof.build_snapshot(
                        manifest_path=manifest_path,
                        retrieval_report_path=report_path,
                        cases_path=cases_path,
                        proof_config_path=proof_config,
                    )

    def test_builds_keyword_vs_trace_artifact_from_report(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "insurance-lapse-relevance",
                        "query": "Which fleet vehicles had commercial auto coverage lapse and were suspended until a new insurance certificate was uploaded?",
                        "limit": 5,
                        "relevant_incident_ids": ["inc-1", "inc-2", "inc-3"],
                        "category": "adversarial_keyword_overlap",
                        "notes": "demo",
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [
                        {
                            "case_id": "insurance-lapse-relevance",
                            "query": "Which fleet vehicles had commercial auto coverage lapse and were suspended until a new insurance certificate was uploaded?",
                            "sql_filter": None,
                            "relevant_incident_ids": ["inc-1", "inc-2", "inc-3"],
                            "methods": {
                                "keyword_only": {
                                    "returned_ids": ["near-1", "near-2", "inc-3", "near-3", "near-4"],
                                },
                                "trace_prefilter_vector": {
                                    "returned_ids": ["inc-1", "inc-2", "inc-3", "trace-4", "trace-5"],
                                },
                            },
                        }
                    ]
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed and driver was suspended pending a new certificate",
                },
                {
                    "incident_id": "inc-2",
                    "city_code": "MEX-SEMOVI",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-02T00:00:00Z",
                    "text_content": "coverage gap triggered a hold until a new certificate arrived",
                },
                {
                    "incident_id": "inc-3",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-03T00:00:00Z",
                    "text_content": "commercial auto coverage lapsed and operations were suspended",
                },
                {
                    "incident_id": "near-1",
                    "city_code": "NYC-TLC",
                    "doc_type": "City_Permit_Renewal",
                    "timestamp": "2025-01-04T00:00:00Z",
                    "text_content": "permit renewal mentions insurance certificates without a real lapse",
                },
                {
                    "incident_id": "near-2",
                    "city_code": "SF-CPUC",
                    "doc_type": "City_Permit_Renewal",
                    "timestamp": "2025-01-05T00:00:00Z",
                    "text_content": "near miss with certificate vocabulary only",
                },
                {
                    "incident_id": "near-3",
                    "city_code": "LON-TfL",
                    "doc_type": "Vehicle_Inspection_Audit",
                    "timestamp": "2025-01-06T00:00:00Z",
                    "text_content": "inspection near miss",
                },
                {
                    "incident_id": "near-4",
                    "city_code": "PAR-VTC",
                    "doc_type": "Vehicle_Inspection_Audit",
                    "timestamp": "2025-01-07T00:00:00Z",
                    "text_content": "another near miss",
                },
                {
                    "incident_id": "trace-4",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-08T00:00:00Z",
                    "text_content": "supporting insurance row",
                },
                {
                    "incident_id": "trace-5",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-09T00:00:00Z",
                    "text_content": "supporting insurance row",
                },
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                snapshot = proof.build_snapshot(
                    manifest_path=manifest_path,
                    retrieval_report_path=report_path,
                    cases_path=cases_path,
                    proof_config_path=proof_config,
                )

            artifact = snapshot["artifacts"][0]
            self.assertEqual(artifact["artifact_id"], "insurance-keyword-gap")
            self.assertEqual(
                artifact["modes"]["weaker"]["missed_labeled_ids"],
                ["inc-1", "inc-2"],
            )
            self.assertEqual(
                artifact["modes"]["trace"]["labeled_hit_ids"],
                ["inc-1", "inc-2", "inc-3"],
            )
            self.assertIn(
                "Keyword search missed the right incidents",
                proof.render_markdown(snapshot),
            )
            self.assertIn("insurance-keyword-gap", proof.render_markdown(snapshot))

    def test_builds_semantic_scope_artifact_and_scope_annotations(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-scope-gap",
                            "comparison_type": "semantic_scope",
                            "retrieval_case_id": "chi-insurance-filtered-relevance",
                            "title": "Semantic retrieval needed city and document scope",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "chi-insurance-filtered-relevance",
                        "query": "insurance lapse or coverage gap for fleet vehicles",
                        "sql_filter": "city_code = 'CHI-BACP' AND doc_type = 'Insurance_Lapse_Report'",
                        "limit": 5,
                        "relevant_incident_ids": ["chi-1", "chi-2", "chi-3"],
                        "category": "filtered",
                        "notes": "demo",
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [
                        {
                            "case_id": "chi-insurance-filtered-relevance",
                            "query": "insurance lapse or coverage gap for fleet vehicles",
                            "sql_filter": "city_code = 'CHI-BACP' AND doc_type = 'Insurance_Lapse_Report'",
                            "relevant_incident_ids": ["chi-1", "chi-2", "chi-3"],
                            "methods": {
                                "trace_prefilter_vector": {
                                    "returned_ids": ["chi-1", "chi-2", "chi-3", "chi-4", "chi-5"],
                                },
                                "semantic_only_vector": {
                                    "returned_ids": ["nyc-1", "chi-1", "chi-2", "chi-3", "mex-1"],
                                }
                            },
                        }
                    ]
                },
            )
            source_rows = [
                {
                    "incident_id": "chi-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "filtered row one",
                },
                {
                    "incident_id": "chi-2",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-02T00:00:00Z",
                    "text_content": "filtered row two",
                },
                {
                    "incident_id": "chi-3",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-03T00:00:00Z",
                    "text_content": "filtered row three",
                },
                {
                    "incident_id": "chi-4",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-04T00:00:00Z",
                    "text_content": "filtered row four",
                },
                {
                    "incident_id": "chi-5",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-05T00:00:00Z",
                    "text_content": "filtered row five",
                },
                {
                    "incident_id": "nyc-1",
                    "city_code": "NYC-TLC",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-06T00:00:00Z",
                    "text_content": "out of scope nyc row",
                },
                {
                    "incident_id": "mex-1",
                    "city_code": "MEX-SEMOVI",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-07T00:00:00Z",
                    "text_content": "out of scope mex row",
                },
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
                mock.patch.object(
                    proof.retrieval,
                    "load_table",
                    side_effect=AssertionError("semantic proof build should stay offline"),
                ),
                mock.patch.object(
                    proof.retrieval.seed,
                    "generate_openai_embeddings",
                    side_effect=AssertionError("semantic proof build should not re-embed queries"),
                ),
            ):
                snapshot = proof.build_snapshot(
                    manifest_path=manifest_path,
                    retrieval_report_path=report_path,
                    cases_path=cases_path,
                    proof_config_path=proof_config,
                )

            artifact = snapshot["artifacts"][0]
            weaker = artifact["modes"]["weaker"]
            self.assertEqual(weaker["scope_match_count"], 3)
            self.assertEqual(weaker["scope_miss_ids"], ["nyc-1", "mex-1"])
            self.assertFalse(weaker["top_results"][0]["matches_scope"])
            self.assertTrue(weaker["top_results"][1]["matches_scope"])
            self.assertIn("semantic-only vector retrieval", weaker["summary"].lower())
            self.assertNotIn("generated_at", snapshot)
            self.assertNotIn("retrieval_report_path", snapshot)

    def test_snapshot_omits_timestamped_report_metadata(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "insurance-lapse-relevance",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "generated_at": "2026-04-28T15:08:48.279685+00:00",
                    "report_path": str((td / "report.json").resolve()),
                    "summary_path": str((td / "summary.md").resolve()),
                    "run_id": "20260428T150848Z",
                    "cases": [
                        {
                            "case_id": "insurance-lapse-relevance",
                            "query": "insurance lapse",
                            "sql_filter": None,
                            "relevant_incident_ids": ["inc-1"],
                            "methods": {
                                "keyword_only": {"returned_ids": []},
                                "trace_prefilter_vector": {"returned_ids": ["inc-1"]},
                            },
                        }
                    ],
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed",
                }
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                snapshot = proof.build_snapshot(
                    manifest_path=manifest_path,
                    retrieval_report_path=report_path,
                    cases_path=cases_path,
                    proof_config_path=proof_config,
                )

            self.assertEqual(snapshot["version"], proof.SNAPSHOT_VERSION)
            self.assertNotIn("generated_at", snapshot)
            self.assertNotIn("retrieval_report_run_id", snapshot)
            self.assertNotIn("retrieval_report_artifact_dir", snapshot)
            self.assertEqual(
                snapshot["cases_path"],
                proof.repo_relative_string(cases_path),
            )

    def test_rejects_duplicate_report_case_ids(self) -> None:
        report = {
            "cases": [
                {"case_id": "dup", "methods": {}},
                {"case_id": "dup", "methods": {}},
            ]
        }

        with self.assertRaises(SystemExit):
            proof.ensure_report_cases(report)

    def test_rejects_semantic_scope_without_filter(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-scope-gap",
                            "comparison_type": "semantic_scope",
                            "retrieval_case_id": "chi-insurance-filtered-relevance",
                            "title": "Semantic retrieval needed city and document scope",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "chi-insurance-filtered-relevance",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [
                        {
                            "case_id": "chi-insurance-filtered-relevance",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["inc-1"],
                            "methods": {
                                "trace_prefilter_vector": {"returned_ids": ["inc-1"]},
                                "semantic_only_vector": {"returned_ids": ["inc-1"]},
                            },
                        }
                    ],
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed",
                }
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                with self.assertRaises(SystemExit):
                    proof.build_snapshot(
                        manifest_path=manifest_path,
                        retrieval_report_path=report_path,
                        cases_path=cases_path,
                        proof_config_path=proof_config,
                    )

    def test_rejects_malformed_method_returned_ids(self) -> None:
        with self.assertRaises(SystemExit):
            proof.require_returned_ids(
                {"returned_ids": "not-a-list"},
                case_id="case-a",
                method="trace_prefilter_vector",
            )

    def test_rejects_duplicate_returned_ids_in_report_method(self) -> None:
        with self.assertRaises(SystemExit):
            proof.require_returned_ids(
                {"returned_ids": ["inc-1", "inc-1"]},
                case_id="case-a",
                method="trace_prefilter_vector",
            )

    def test_rejects_report_case_shape_mismatch(self) -> None:
        case = proof.retrieval.RetrievalCase(
            case_id="case-a",
            query="insurance lapse",
            sql_filter="city_code = 'CHI-BACP'",
            compiled_sql_filter="city_code = 'CHI-BACP'",
            filter_expr=proof.retrieval.parse_sql_filter("city_code = 'CHI-BACP'"),
            limit=5,
            relevant_incident_ids=("inc-1",),
            category=None,
            notes=None,
        )

        with self.assertRaises(SystemExit):
            proof.ensure_report_case_matches_case(
                {
                    "case_id": "case-a",
                    "query": "different query",
                    "sql_filter": "city_code = 'CHI-BACP'",
                    "relevant_incident_ids": ["inc-1"],
                },
                case=case,
            )

    def test_rejects_report_case_missing_integrity_fields(self) -> None:
        case = proof.retrieval.RetrievalCase(
            case_id="case-a",
            query="insurance lapse",
            sql_filter=None,
            compiled_sql_filter=None,
            filter_expr=None,
            limit=5,
            relevant_incident_ids=("inc-1",),
            category=None,
            notes=None,
        )

        with self.assertRaises(SystemExit):
            proof.ensure_report_case_matches_case(
                {
                    "case_id": "case-a",
                    "methods": {},
                },
                case=case,
            )

    def test_rejects_empty_trace_results_before_handoff(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "insurance-lapse-relevance",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [
                        {
                            "case_id": "insurance-lapse-relevance",
                            "methods": {
                                "keyword_only": {"returned_ids": ["inc-1"]},
                                "trace_prefilter_vector": {"returned_ids": []},
                            },
                        }
                    ],
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed",
                }
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                with self.assertRaises(SystemExit):
                    proof.build_snapshot(
                        manifest_path=manifest_path,
                        retrieval_report_path=report_path,
                        cases_path=cases_path,
                        proof_config_path=proof_config,
                    )

    def test_rejects_keyword_vs_trace_claim_when_trace_does_not_beat_keyword(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "insurance-lapse-relevance",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "cases": [
                        {
                            "case_id": "insurance-lapse-relevance",
                            "query": "insurance lapse",
                            "relevant_incident_ids": ["inc-1"],
                            "methods": {
                                "keyword_only": {"returned_ids": ["inc-1"]},
                                "trace_prefilter_vector": {"returned_ids": ["inc-1"]},
                            },
                        }
                    ],
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed",
                }
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                with self.assertRaises(SystemExit):
                    proof.build_snapshot(
                        manifest_path=manifest_path,
                        retrieval_report_path=report_path,
                        cases_path=cases_path,
                        proof_config_path=proof_config,
                    )

    def test_rejects_semantic_scope_claim_without_scope_gap(self) -> None:
        case = proof.retrieval.RetrievalCase(
            case_id="case-a",
            query="insurance lapse",
            sql_filter="city_code = 'CHI-BACP'",
            compiled_sql_filter="city_code = 'CHI-BACP'",
            filter_expr=proof.retrieval.parse_sql_filter("city_code = 'CHI-BACP'"),
            limit=5,
            relevant_incident_ids=("inc-1",),
            category=None,
            notes=None,
        )

        with self.assertRaises(SystemExit):
            proof.validate_semantic_scope_claim(
                spec=proof.ProofArtifactSpec(
                    artifact_id="scope-gap",
                    comparison_type="semantic_scope",
                    retrieval_case_id="case-a",
                    title="Scope gap",
                ),
                case=case,
                weaker_summary={
                    "scope_miss_ids": [],
                    "scope_match_count": 1,
                },
                trace_summary={
                    "scope_miss_ids": [],
                    "scope_match_count": 1,
                },
            )

    def test_rejects_report_metadata_mismatch(self) -> None:
        with repo_temp_dir() as td:
            manifest_path = td / "manifest.json"
            cases_path = write_json(
                td / "cases.json",
                [
                    {
                        "id": "insurance-lapse-relevance",
                        "query": "insurance lapse",
                        "relevant_incident_ids": ["inc-1"],
                    }
                ],
            )
            proof_config = write_json(
                td / "proof.json",
                {
                    "version": 1,
                    "artifacts": [
                        {
                            "artifact_id": "insurance-keyword-gap",
                            "comparison_type": "keyword_vs_trace",
                            "retrieval_case_id": "insurance-lapse-relevance",
                            "title": "Keyword overlap missed the insurance lapse cases",
                        }
                    ],
                },
            )
            report_path = write_json(
                td / "report.json",
                {
                    **self._report_metadata(
                        manifest_path=manifest_path,
                        cases_path=cases_path,
                    ),
                    "lance_dataset_path": str((td / "wrong.lance").resolve()),
                    "cases": [
                        {
                            "case_id": "insurance-lapse-relevance",
                            "query": "insurance lapse",
                            "sql_filter": None,
                            "relevant_incident_ids": ["inc-1"],
                            "methods": {
                                "keyword_only": {"returned_ids": []},
                                "trace_prefilter_vector": {"returned_ids": ["inc-1"]},
                            },
                        }
                    ],
                },
            )
            source_rows = [
                {
                    "incident_id": "inc-1",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-01T00:00:00Z",
                    "text_content": "coverage lapsed",
                }
            ]

            with (
                mock.patch.object(proof.retrieval, "load_manifest", return_value=self._manifest()),
                mock.patch.object(proof.retrieval, "validate_manifest_or_exit"),
                mock.patch.object(
                    proof.retrieval,
                    "validate_cases_against_source_rows_or_exit",
                ),
                mock.patch.object(proof.retrieval, "load_source_rows", return_value=source_rows),
            ):
                with self.assertRaises(SystemExit):
                    proof.build_snapshot(
                        manifest_path=manifest_path,
                        retrieval_report_path=report_path,
                        cases_path=cases_path,
                        proof_config_path=proof_config,
                    )

    def test_rejects_duplicate_source_incident_ids(self) -> None:
        rows = [
            {
                "incident_id": "dup-1",
                "city_code": "CHI-BACP",
                "doc_type": "Insurance_Lapse_Report",
                "timestamp": "2025-01-01T00:00:00Z",
            },
            {
                "incident_id": "dup-1",
                "city_code": "CHI-BACP",
                "doc_type": "Insurance_Lapse_Report",
                "timestamp": "2025-01-02T00:00:00Z",
            },
        ]

        with self.assertRaises(SystemExit):
            proof.row_lookup_by_incident_id(rows)

    def test_scope_annotation_handles_date_and_metadata_filter(self) -> None:
        filter_expr = proof.retrieval.parse_sql_filter(
            "city_code = 'CHI-BACP' AND timestamp >= '2025-01-01T00:00:00Z'"
        )
        execution = proof.retrieval.SearchExecution(
            rows=[
                {
                    "incident_id": "ok-row",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-02T00:00:00Z",
                    "text_content": "ok",
                },
                {
                    "incident_id": "bad-city",
                    "city_code": "NYC-TLC",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2025-01-02T00:00:00Z",
                    "text_content": "bad city",
                },
                {
                    "incident_id": "bad-date",
                    "city_code": "CHI-BACP",
                    "doc_type": "Insurance_Lapse_Report",
                    "timestamp": "2024-12-31T00:00:00Z",
                    "text_content": "bad date",
                },
            ]
        )

        rows = proof.build_rows_from_search_execution(
            execution,
            filter_expr=filter_expr,
            relevant_ids={"ok-row"},
        )

        self.assertTrue(rows[0]["matches_scope"])
        self.assertFalse(rows[1]["matches_scope"])
        self.assertFalse(rows[2]["matches_scope"])


if __name__ == "__main__":
    unittest.main()
