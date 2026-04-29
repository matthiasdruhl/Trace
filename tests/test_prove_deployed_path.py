"""Focused tests for the deployed proof runner (step 1)."""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_prove_module():
    path = ROOT / "scripts" / "prove_deployed_path.py"
    spec = importlib.util.spec_from_file_location("prove_deployed_path", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prove_deployed_path"] = mod
    spec.loader.exec_module(mod)
    return mod


prove = _load_prove_module()


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
    def test_load_valid_fixture(self) -> None:
        cases = prove.load_cases(ROOT / "fixtures" / "deployed" / "golden_cases.json")
        self.assertGreaterEqual(len(cases), 3)
        ids = {c.case_id for c in cases}
        self.assertIn("unfiltered-demo", ids)

    def test_rejects_bad_version(self) -> None:
        with repo_temp_dir() as td:
            p = td / "bad.json"
            p.write_text(json.dumps({"version": 2, "cases": []}), encoding="utf-8")
            with self.assertRaises(prove.ProofPathError):
                prove.load_cases(p)

    def test_rejects_duplicate_ids(self) -> None:
        with repo_temp_dir() as td:
            p = td / "dup.json"
            p.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "cases": [
                            {
                                "case_id": "a",
                                "query_text": "x",
                                "sql_filter": "",
                                "limit": 5,
                                "include_text": True,
                                "expected_ids": [],
                                "assertions": {},
                            },
                            {
                                "case_id": "a",
                                "query_text": "y",
                                "sql_filter": "",
                                "limit": 5,
                                "include_text": True,
                                "expected_ids": [],
                                "assertions": {},
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(prove.ProofPathError):
                prove.load_cases(p)

    def test_rejects_expected_ids_string(self) -> None:
        with repo_temp_dir() as td:
            p = td / "bad.json"
            p.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "cases": [
                            {
                                "case_id": "a",
                                "query_text": "x",
                                "expected_ids": "id-1",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.load_cases(p)
            self.assertIn("expected_ids", str(ctx.exception))

    def test_rejects_expected_ids_non_string_elements(self) -> None:
        with repo_temp_dir() as td:
            p = td / "bad.json"
            p.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "cases": [
                            {
                                "case_id": "a",
                                "query_text": "x",
                                "expected_ids": ["ok", 1],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.load_cases(p)
            self.assertIn("expected_ids[1]", str(ctx.exception))


class TestValidateRunFlags(unittest.TestCase):
    def test_write_stable_with_skip_mcp_fails(self) -> None:
        args = argparse.Namespace(
            write_stable_fixtures=True,
            skip_mcp=True,
            dry_run=False,
            stable_fixture_cases="case-a",
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_flags(args)
        self.assertIn("--skip-mcp", str(ctx.exception))

    def test_write_stable_with_dry_run_fails(self) -> None:
        args = argparse.Namespace(
            write_stable_fixtures=True,
            skip_mcp=False,
            dry_run=True,
            stable_fixture_cases="case-a",
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_flags(args)
        self.assertIn("--dry-run", str(ctx.exception))

    def test_write_stable_requires_explicit_case_ids(self) -> None:
        args = argparse.Namespace(
            write_stable_fixtures=True,
            skip_mcp=False,
            dry_run=False,
            stable_fixture_cases="",
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_flags(args)
        self.assertIn("--stable-fixture-cases", str(ctx.exception))

    def test_write_stable_with_explicit_case_ids_ok(self) -> None:
        prove.validate_run_flags(
            argparse.Namespace(
                write_stable_fixtures=True,
                skip_mcp=False,
                dry_run=False,
                stable_fixture_cases="unfiltered-demo,filtered-nyc-safety",
            )
        )

    def test_skip_mcp_without_write_stable_ok(self) -> None:
        prove.validate_run_flags(
            argparse.Namespace(
                write_stable_fixtures=False,
                skip_mcp=True,
                dry_run=True,
                stable_fixture_cases="",
            )
        )

    def test_replay_mode_rejects_live_execution_flags(self) -> None:
        args = argparse.Namespace(
            replay_fixtures_dir=Path("fixtures/deployed/examples"),
            dry_run=True,
            mock_embeddings=False,
            allow_missing_vectors=False,
            skip_mcp=False,
            write_stable_fixtures=False,
            stable_fixture_cases="",
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_flags(args)
        self.assertIn("--replay-fixtures-dir", str(ctx.exception))
        self.assertIn("--dry-run", str(ctx.exception))

    def test_replay_mode_rejects_stable_fixture_promotion(self) -> None:
        args = argparse.Namespace(
            replay_fixtures_dir=Path("fixtures/deployed/examples"),
            dry_run=False,
            mock_embeddings=False,
            allow_missing_vectors=False,
            skip_mcp=False,
            write_stable_fixtures=True,
            stable_fixture_cases="filtered-nyc-safety",
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_flags(args)
        self.assertIn("--write-stable-fixtures", str(ctx.exception))


class TestCaseSelection(unittest.TestCase):
    def test_parse_case_ids_keeps_order(self) -> None:
        self.assertEqual(
            prove.parse_case_ids("case-b, case-a"),
            ["case-b", "case-a"],
        )

    def test_parse_case_ids_rejects_duplicates(self) -> None:
        with self.assertRaises(prove.ProofPathError):
            prove.parse_case_ids("case-a,case-a")

    def test_select_cases_rejects_unknown_case(self) -> None:
        cases = [
            prove.GoldenCase(case_id="case-a", query_text="a"),
            prove.GoldenCase(case_id="case-b", query_text="b"),
        ]
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.select_cases(cases, ["case-b", "missing"])
        self.assertIn("Unknown case_id", str(ctx.exception))

    def test_select_cases_returns_requested_subset(self) -> None:
        cases = [
            prove.GoldenCase(case_id="case-a", query_text="a"),
            prove.GoldenCase(case_id="case-b", query_text="b"),
        ]
        selected = prove.select_cases(cases, ["case-b"])
        self.assertEqual([case.case_id for case in selected], ["case-b"])


class TestReplayFixtureCoverage(unittest.TestCase):
    def _write_bundle(self, fixtures_dir: Path, *, channel: str, case_id: str) -> None:
        payload = {
            "case_id": case_id,
            "channel": channel,
            "request": {},
            "response": {},
        }
        (fixtures_dir / f"{channel}_{case_id}.json").write_text(
            json.dumps(payload),
            encoding="utf-8",
        )

    def test_inspect_replay_fixture_coverage_reports_drift(self) -> None:
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            self._write_bundle(fixtures_dir, channel="http", case_id="case-a")
            self._write_bundle(fixtures_dir, channel="http", case_id="case-extra")
            self._write_bundle(fixtures_dir, channel="mcp", case_id="case-extra")
            (fixtures_dir / "notes.json").write_text("{}", encoding="utf-8")

            coverage = prove.inspect_replay_fixture_coverage(
                fixtures_dir,
                required_case_ids=["case-a", "case-b"],
                require_exact_case_set=True,
            )

            self.assertEqual(coverage.invalid_fixture_names, ["notes.json"])
            self.assertEqual(coverage.missing_case_ids, ["case-b"])
            self.assertEqual(coverage.extra_case_ids, ["case-extra"])
            self.assertEqual(
                coverage.incomplete_channels_by_case,
                {"case-a": ["mcp"]},
            )

    def test_assert_replay_fixture_coverage_accepts_exact_full_set(self) -> None:
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            for case_id in ("case-a", "case-b"):
                self._write_bundle(fixtures_dir, channel="http", case_id=case_id)
                self._write_bundle(fixtures_dir, channel="mcp", case_id=case_id)

            coverage = prove.assert_replay_fixture_coverage(
                fixtures_dir,
                required_case_ids=["case-a", "case-b"],
                require_exact_case_set=True,
            )

            self.assertEqual(coverage.fixture_case_ids, ["case-a", "case-b"])

    def test_assert_replay_fixture_coverage_allows_extra_cases_for_subset_replay(self) -> None:
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            for case_id in ("case-a", "case-b"):
                self._write_bundle(fixtures_dir, channel="http", case_id=case_id)
                self._write_bundle(fixtures_dir, channel="mcp", case_id=case_id)

            coverage = prove.assert_replay_fixture_coverage(
                fixtures_dir,
                required_case_ids=["case-a"],
                require_exact_case_set=False,
            )

            self.assertEqual(coverage.extra_case_ids, [])

    def test_committed_examples_cover_every_golden_case(self) -> None:
        golden_cases = prove.load_cases(ROOT / "fixtures" / "deployed" / "golden_cases.json")
        coverage = prove.assert_replay_fixture_coverage(
            ROOT / "fixtures" / "deployed" / "examples",
            required_case_ids=[case.case_id for case in golden_cases],
            require_exact_case_set=True,
        )

        self.assertEqual(
            set(coverage.fixture_case_ids),
            {case.case_id for case in golden_cases},
        )


class TestScrubbing(unittest.TestCase):
    def test_scrub_removes_timing_and_urls(self) -> None:
        raw = {
            "ok": True,
            "took_ms": 12,
            "search_url": "https://abc.execute-api.us-east-1.amazonaws.com/search",
            "nested": {"latency_ms": 3},
        }
        out = prove.scrub_value(raw, scrub_urls=True)
        self.assertNotIn("took_ms", out)
        self.assertEqual(out.get("search_url"), prove.SCRUBBED_URL_PLACEHOLDER)

    def test_stable_response_view(self) -> None:
        r = {"ok": True, "took_ms": 9, "stub": "x", "results": []}
        v = prove.stable_response_view(r)
        self.assertNotIn("took_ms", v)
        self.assertNotIn("stub", v)

    def test_redact_http_request_replaces_vector(self) -> None:
        req = {"query_vector": [0.1, 0.2, 0.3], "limit": 5, "sql_filter": ""}
        out = prove.redact_http_request_for_stable_fixture(req)
        self.assertEqual(
            out["query_vector"],
            {"_redacted": True, "dim": 3},
        )
        self.assertEqual(req["query_vector"], [0.1, 0.2, 0.3])

    def test_redact_http_request_non_list_vector(self) -> None:
        req = {"query_vector": "unexpected", "limit": 1}
        out = prove.redact_http_request_for_stable_fixture(req)
        self.assertEqual(
            out["query_vector"],
            {"_redacted": True, "note": "omitted in stable fixtures (non-list value)"},
        )


class TestResolveRuntimeContext(unittest.TestCase):
    def _ns(
        self,
        *,
        stack_name=None,
        region=None,
        search_url="",
        dataset_uri="s3://b/p",
        query_dim=1536,
    ):
        return argparse.Namespace(
            stack_name=stack_name,
            region=region,
            search_url=search_url,
            dataset_uri=dataset_uri,
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=query_dim,
        )

    def test_requires_search_url_without_stack(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.resolve_runtime_context(self._ns())
        self.assertIn("Search URL", str(ctx.exception))

    def test_stack_without_region_fails(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.resolve_runtime_context(
                self._ns(stack_name="trace-prod", region=None, search_url="")
            )
        self.assertIn("region", str(ctx.exception).lower())

    def test_describe_stack_failure_surfaces(self) -> None:
        with patch.object(
            prove,
            "_describe_stack",
            side_effect=prove.ProofPathError("simulated stack API failure"),
        ):
            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.resolve_runtime_context(
                    self._ns(
                        stack_name="trace-prod",
                        region="us-east-1",
                        search_url="",
                    )
                )
        self.assertIn("simulated stack API failure", str(ctx.exception))


class TestStableFixturePromotionContext(unittest.TestCase):
    def _ctx(self, *, stack_name: str | None, dataset_uri: str | None) -> prove.RuntimeContext:
        return prove.RuntimeContext(
            stack_name=stack_name,
            region="us-east-1",
            search_url="https://example.invalid/search",
            dataset_uri=dataset_uri,
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="iam_only_or_public",
            local_api_key_supplied=False,
        )

    def test_rejects_eval_stack_with_non_eval_dataset_uri(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_stable_fixture_promotion_context(
                self._ctx(
                    stack_name="trace-eval",
                    dataset_uri="s3://trace-vault/trace/smoke/lance",
                ),
                allow_non_eval_stable_fixtures=False,
            )
        self.assertIn("dataset_uri must be", str(ctx.exception))
        self.assertIn("trace/smoke/lance", str(ctx.exception))

    def test_rejects_non_eval_stack_with_eval_dataset_uri(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_stable_fixture_promotion_context(
                self._ctx(
                    stack_name="trace-smoke",
                    dataset_uri="s3://trace-vault/trace/eval/lance",
                ),
                allow_non_eval_stable_fixtures=False,
            )
        self.assertIn("stack_name must be", str(ctx.exception))
        self.assertIn("trace-smoke", str(ctx.exception))

    def test_accepts_eval_dataset_without_stack_name(self) -> None:
        prove.assert_stable_fixture_promotion_context(
            self._ctx(
                stack_name=None,
                dataset_uri="s3://trace-vault/trace/eval/lance",
            ),
            allow_non_eval_stable_fixtures=False,
        )


class TestFilterAssertions(unittest.TestCase):
    def test_assert_filter_match_ok(self) -> None:
        case = prove.GoldenCase(
            case_id="t",
            query_text="q",
            sql_filter="city_code = 'NYC-TLC'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        prove.assert_filter_match(
            case,
            [{"incident_id": "1", "city_code": "NYC-TLC"}],
        )

    def test_assert_filter_match_fails(self) -> None:
        case = prove.GoldenCase(
            case_id="t",
            query_text="q",
            sql_filter="city_code = 'NYC-TLC'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with self.assertRaises(prove.ProofPathError):
            prove.assert_filter_match(
                case,
                [{"incident_id": "1", "city_code": "SF-CPUC"}],
            )

    def test_assert_filter_match_in_clause_ok(self) -> None:
        case = prove.GoldenCase(
            case_id="filtered-doc-type-in",
            query_text="q",
            sql_filter="doc_type IN ('Driver_Background_Flag', 'Safety_Incident_Log')",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        prove.assert_filter_match(
            case,
            [{"incident_id": "1", "doc_type": "Safety_Incident_Log"}],
        )

    def test_assert_filter_match_in_clause_fails_for_out_of_set_value(self) -> None:
        case = prove.GoldenCase(
            case_id="filtered-doc-type-in",
            query_text="q",
            sql_filter="doc_type IN ('Driver_Background_Flag', 'Safety_Incident_Log')",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_filter_match(
                case,
                [{"incident_id": "1", "doc_type": "Insurance_Lapse_Report"}],
            )
        self.assertIn("doc_type", str(ctx.exception))

    def test_assert_filter_match_accepts_parenthesized_and_escaped_literals(self) -> None:
        case = prove.GoldenCase(
            case_id="parenthesized-supported-filter",
            query_text="q",
            sql_filter="(city_code = 'NYC-TLC') AND (doc_type IN ('Driver''s Report', 'Safety_Incident_Log'))",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        prove.assert_filter_match(
            case,
            [
                {
                    "incident_id": "1",
                    "city_code": "NYC-TLC",
                    "doc_type": "Driver's Report",
                }
            ],
        )

    def test_assert_filter_match_rejects_or_clause(self) -> None:
        case = prove.GoldenCase(
            case_id="unsupported-or-filter",
            query_text="q",
            sql_filter="city_code = 'NYC-TLC' OR city_code = 'SF-CPUC'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_filter_match(
                case,
                [{"incident_id": "1", "city_code": "NYC-TLC"}],
            )
        self.assertIn("top-level AND", str(ctx.exception))

    def test_assert_filter_match_rejects_not_clause(self) -> None:
        case = prove.GoldenCase(
            case_id="unsupported-not-filter",
            query_text="q",
            sql_filter="NOT doc_type = 'Safety_Incident_Log'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_filter_match(
                case,
                [{"incident_id": "1", "doc_type": "Driver_Background_Flag"}],
            )
        self.assertIn("require_filter_match only supports", str(ctx.exception))

    def test_assert_filter_match_rejects_duplicate_field_clauses(self) -> None:
        case = prove.GoldenCase(
            case_id="unsupported-duplicate-field",
            query_text="q",
            sql_filter="doc_type = 'Driver_Background_Flag' AND doc_type = 'Safety_Incident_Log'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_filter_match(
                case,
                [{"incident_id": "1", "doc_type": "Driver_Background_Flag"}],
            )
        self.assertIn("duplicate field clause", str(ctx.exception))

    def test_assert_filter_match_skips_unsupported_sql_when_assertion_disabled(self) -> None:
        case = prove.GoldenCase(
            case_id="unsupported-filter-skip-safe",
            query_text="q",
            sql_filter="city_code = 'NYC-TLC' OR city_code = 'SF-CPUC'",
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=False,
            ),
        )
        prove.assert_filter_match(
            case,
            [{"incident_id": "1", "city_code": "NYC-TLC"}],
        )


class TestAssertResponseQueryDim(unittest.TestCase):
    def test_ok_missing_query_dim_fails(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.assert_response_query_dim({"ok": True, "results": []}, 1536)
        self.assertIn("query_dim", str(ctx.exception))

    def test_ok_non_int_query_dim_fails(self) -> None:
        for bad in ("1536", 1536.0, 1536.5, [], {}):
            with self.subTest(bad=bad):
                with self.assertRaises(prove.ProofPathError) as ctx:
                    prove.assert_response_query_dim(
                        {"ok": True, "results": [], "query_dim": bad},
                        1536,
                    )
                self.assertIn("query_dim", str(ctx.exception).lower())

    def test_ok_bool_query_dim_fails(self) -> None:
        with self.assertRaises(prove.ProofPathError):
            prove.assert_response_query_dim(
                {"ok": True, "results": [], "query_dim": True},
                1536,
            )

    def test_ok_matching_query_dim_passes(self) -> None:
        prove.assert_response_query_dim(
            {"ok": True, "results": [], "query_dim": 1536},
            1536,
        )

    def test_ok_wrong_query_dim_fails(self) -> None:
        with self.assertRaises(prove.ProofPathError):
            prove.assert_response_query_dim(
                {"ok": True, "results": [], "query_dim": 128},
                1536,
            )

    def test_error_response_skips_query_dim(self) -> None:
        prove.assert_response_query_dim(
            {
                "ok": False,
                "error": {"code": "X", "message": "y"},
            },
            1536,
        )


class TestDeployedApiAuthMode(unittest.TestCase):
    def test_empty_secret_ref_is_iam_only(self) -> None:
        self.assertEqual(
            prove.deployed_api_auth_mode_from_stack_parameters(
                {"TraceApiKeySecretRef": ""}
            ),
            "iam_only_or_public",
        )

    def test_whitespace_secret_ref_is_iam_only(self) -> None:
        self.assertEqual(
            prove.deployed_api_auth_mode_from_stack_parameters(
                {"TraceApiKeySecretRef": "   "}
            ),
            "iam_only_or_public",
        )

    def test_non_empty_secret_ref_is_api_key(self) -> None:
        self.assertEqual(
            prove.deployed_api_auth_mode_from_stack_parameters(
                {"TraceApiKeySecretRef": "trace/prod-key"}
            ),
            "api_key",
        )

    def test_arn_secret_ref_is_api_key(self) -> None:
        self.assertEqual(
            prove.deployed_api_auth_mode_from_stack_parameters(
                {
                    "TraceApiKeySecretRef": (
                        "arn:aws:secretsmanager:us-east-1:123456789012:secret:trace-key"
                    )
                }
            ),
            "api_key",
        )


class TestMockVector(unittest.TestCase):
    def test_deterministic_length(self) -> None:
        v = prove._mock_query_vector("hello", 32)
        self.assertEqual(len(v), 32)
        v2 = prove._mock_query_vector("hello", 32)
        self.assertEqual(v, v2)


class TestPromoteStable(unittest.TestCase):
    def test_writes_scrubbed_files(self) -> None:
        mod = prove
        with repo_temp_dir() as td:
            run_dir = td / "run"
            run_dir.mkdir()
            (run_dir / "http").mkdir()
            (run_dir / "mcp").mkdir()
            cid = "case-a"
            http_resp = {"ok": True, "results": [], "query_dim": 1536, "k": 3, "took_ms": 1}
            mcp_resp = dict(http_resp)
            (run_dir / "http" / f"{cid}.request.json").write_text(
                json.dumps({"query_vector": [0.1], "limit": 3}), encoding="utf-8"
            )
            (run_dir / "http" / f"{cid}.response.json").write_text(
                json.dumps(http_resp), encoding="utf-8"
            )
            (run_dir / "mcp" / f"{cid}.request.json").write_text(
                json.dumps({"query_text": "x"}), encoding="utf-8"
            )
            (run_dir / "mcp" / f"{cid}.response.json").write_text(
                json.dumps(mcp_resp), encoding="utf-8"
            )
            dest = td / "out"
            cases = [
                mod.GoldenCase(case_id=cid, query_text="x"),
            ]
            mod.promote_stable_fixtures(run_dir, cases, [cid], dest)
            self.assertTrue((dest / f"http_{cid}.json").is_file())
            self.assertTrue((dest / f"mcp_{cid}.json").is_file())
            bundle = json.loads((dest / f"http_{cid}.json").read_text(encoding="utf-8"))
            self.assertNotIn("took_ms", bundle["response"])
            self.assertEqual(
                bundle["request"]["query_vector"],
                {"_redacted": True, "dim": 1},
            )

    def test_missing_http_request_artifact_fails(self) -> None:
        mod = prove
        with repo_temp_dir() as td:
            run_dir = td / "run"
            run_dir.mkdir()
            (run_dir / "http").mkdir()
            (run_dir / "mcp").mkdir()
            cid = "case-a"
            (run_dir / "http" / f"{cid}.response.json").write_text(
                json.dumps({"ok": True, "results": [], "query_dim": 1536}),
                encoding="utf-8",
            )
            (run_dir / "mcp" / f"{cid}.request.json").write_text(
                json.dumps({"query_text": "x"}),
                encoding="utf-8",
            )
            (run_dir / "mcp" / f"{cid}.response.json").write_text(
                json.dumps({"ok": True, "results": [], "query_dim": 1536}),
                encoding="utf-8",
            )
            cases = [mod.GoldenCase(case_id=cid, query_text="x")]
            with self.assertRaises(mod.ProofPathError) as ctx:
                mod.promote_stable_fixtures(run_dir, cases, [cid], td / "out")
            self.assertIn("Missing HTTP request artifact", str(ctx.exception))

    def test_missing_mcp_request_artifact_fails(self) -> None:
        mod = prove
        with repo_temp_dir() as td:
            run_dir = td / "run"
            run_dir.mkdir()
            (run_dir / "http").mkdir()
            (run_dir / "mcp").mkdir()
            cid = "case-a"
            (run_dir / "http" / f"{cid}.request.json").write_text(
                json.dumps({"query_vector": [0.1], "limit": 3}),
                encoding="utf-8",
            )
            (run_dir / "http" / f"{cid}.response.json").write_text(
                json.dumps({"ok": True, "results": [], "query_dim": 1536}),
                encoding="utf-8",
            )
            (run_dir / "mcp" / f"{cid}.response.json").write_text(
                json.dumps({"ok": True, "results": [], "query_dim": 1536}),
                encoding="utf-8",
            )
            cases = [mod.GoldenCase(case_id=cid, query_text="x")]
            with self.assertRaises(mod.ProofPathError) as ctx:
                mod.promote_stable_fixtures(run_dir, cases, [cid], td / "out")
            self.assertIn("Missing MCP request artifact", str(ctx.exception))

    def test_unknown_case_id_fails(self) -> None:
        mod = prove
        with repo_temp_dir() as td:
            run_dir = td / "run"
            run_dir.mkdir()
            (run_dir / "http").mkdir()
            (run_dir / "mcp").mkdir()
            cases = [mod.GoldenCase(case_id="case-a", query_text="x")]
            with self.assertRaises(mod.ProofPathError) as ctx:
                mod.promote_stable_fixtures(run_dir, cases, ["case-b"], td / "out")
            self.assertIn("Unknown stable fixture case_id", str(ctx.exception))


class TestReplayFixtures(unittest.TestCase):
    def _write_replay_fixture_bundle(
        self,
        fixtures_dir: Path,
        *,
        case: prove.GoldenCase,
        channel: str,
        response: dict[str, object],
        request_overrides: dict[str, object] | None = None,
    ) -> None:
        request = prove._expected_replay_request(
            channel=channel,
            case=case,
            expected_query_dim=1536,
        )
        if request_overrides:
            request.update(request_overrides)
        payload = {
            "case_id": case.case_id,
            "channel": channel,
            "request": request,
            "response": response,
        }
        (fixtures_dir / f"{channel}_{case.case_id}.json").write_text(
            json.dumps(payload),
            encoding="utf-8",
        )

    def test_replay_case_uses_committed_fixture_bundle(self) -> None:
        cases = prove.load_cases(ROOT / "fixtures" / "deployed" / "golden_cases.json")
        case = next(case for case in cases if case.case_id == "filtered-nyc-safety")
        fixtures_dir = ROOT / "fixtures" / "deployed" / "examples"
        with repo_temp_dir() as td:
            result = prove.replay_case(
                case,
                fixtures_dir=fixtures_dir,
                run_dir=td,
                expected_query_dim=1536,
            )

        self.assertTrue(result.http_ok)
        self.assertTrue(result.mcp_ok)
        self.assertIn("Replay fixture validation passed", result.notes[0])

    def test_replay_case_uses_committed_in_clause_fixture_with_semantic_checks(self) -> None:
        cases = prove.load_cases(ROOT / "fixtures" / "deployed" / "golden_cases.json")
        case = next(case for case in cases if case.case_id == "filtered-doc-type-in")
        self.assertTrue(case.assertions.require_filter_match)
        fixtures_dir = ROOT / "fixtures" / "deployed" / "examples"
        with repo_temp_dir() as td:
            result = prove.replay_case(
                case,
                fixtures_dir=fixtures_dir,
                run_dir=td,
                expected_query_dim=1536,
            )

        self.assertTrue(result.http_ok)
        self.assertTrue(result.mcp_ok)
        self.assertIn("Replay fixture validation passed", result.notes[0])

    def test_replay_case_rejects_unscrubbed_response(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="query")
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            bundle = {
                "case_id": "case-a",
                "request": {
                    "include_text": True,
                    "limit": 5,
                    "query_vector": {"_redacted": True, "dim": 1536},
                    "sql_filter": "",
                },
                "response": {
                    "ok": True,
                    "query_dim": 1536,
                    "results": [{"incident_id": "inc-1"}],
                    "took_ms": 5,
                },
            }
            for channel in ("http", "mcp"):
                payload = dict(bundle)
                payload["channel"] = channel
                if channel == "mcp":
                    payload["request"] = {
                        "include_text": True,
                        "limit": 5,
                        "query_text": "query",
                        "sql_filter": "",
                    }
                (fixtures_dir / f"{channel}_case-a.json").write_text(
                    json.dumps(payload),
                    encoding="utf-8",
                )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=1536,
                )
            self.assertIn("volatile or environment-specific fields", str(ctx.exception))

    def test_replay_case_rejects_http_query_vector_extra_keys(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="query")
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            response = {
                "ok": True,
                "query_dim": 1536,
                "results": [{"incident_id": "inc-1"}],
            }
            http_payload = {
                "case_id": "case-a",
                "channel": "http",
                "request": {
                    "include_text": True,
                    "limit": 5,
                    "query_vector": {
                        "_redacted": True,
                        "dim": 1536,
                        "values": [0.1, 0.2],
                    },
                    "sql_filter": "",
                },
                "response": response,
            }
            mcp_payload = {
                "case_id": "case-a",
                "channel": "mcp",
                "request": {
                    "include_text": True,
                    "limit": 5,
                    "query_text": "query",
                    "sql_filter": "",
                },
                "response": response,
            }
            (fixtures_dir / "http_case-a.json").write_text(
                json.dumps(http_payload),
                encoding="utf-8",
            )
            (fixtures_dir / "mcp_case-a.json").write_text(
                json.dumps(mcp_payload),
                encoding="utf-8",
            )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=1536,
                )
            self.assertIn("unexpected query_vector keys", str(ctx.exception))

    def test_replay_case_rejects_http_query_vector_dim_mismatch(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="query")
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            response = {
                "ok": True,
                "query_dim": 1536,
                "results": [{"incident_id": "inc-1"}],
            }
            http_payload = {
                "case_id": "case-a",
                "channel": "http",
                "request": {
                    "include_text": True,
                    "limit": 5,
                    "query_vector": {"_redacted": True, "dim": 512},
                    "sql_filter": "",
                },
                "response": response,
            }
            mcp_payload = {
                "case_id": "case-a",
                "channel": "mcp",
                "request": {
                    "include_text": True,
                    "limit": 5,
                    "query_text": "query",
                    "sql_filter": "",
                },
                "response": response,
            }
            (fixtures_dir / "http_case-a.json").write_text(
                json.dumps(http_payload),
                encoding="utf-8",
            )
            (fixtures_dir / "mcp_case-a.json").write_text(
                json.dumps(mcp_payload),
                encoding="utf-8",
            )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=1536,
                )
            self.assertIn("query_vector.dim=512", str(ctx.exception))

    def test_replay_case_rejects_stale_http_request_shape(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="query")
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            response = {
                "ok": True,
                "query_dim": 1536,
                "results": [{"incident_id": "inc-1"}],
            }
            self._write_replay_fixture_bundle(
                fixtures_dir,
                case=case,
                channel="http",
                response=response,
                request_overrides={"include_text": False},
            )
            self._write_replay_fixture_bundle(
                fixtures_dir,
                case=case,
                channel="mcp",
                response=response,
            )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=1536,
                )
            self.assertIn("does not match the current request builder output", str(ctx.exception))
            self.assertIn("include_text=False", str(ctx.exception))

    def test_replay_case_rejects_unexpected_mcp_request_key(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="query")
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            response = {
                "ok": True,
                "query_dim": 1536,
                "results": [{"incident_id": "inc-1"}],
            }
            self._write_replay_fixture_bundle(
                fixtures_dir,
                case=case,
                channel="http",
                response=response,
            )
            self._write_replay_fixture_bundle(
                fixtures_dir,
                case=case,
                channel="mcp",
                response=response,
                request_overrides={"trace_id": "stale-field"},
            )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=1536,
                )
            self.assertIn("unexpected keys ['trace_id']", str(ctx.exception))

    def test_replay_case_enforces_in_clause_filter_semantics(self) -> None:
        case = prove.GoldenCase(
            case_id="filtered-doc-type-in",
            query_text="query",
            sql_filter="doc_type IN ('Driver_Background_Flag', 'Safety_Incident_Log')",
            include_text=False,
            limit=6,
            assertions=prove.CaseAssertions(
                require_non_empty_results=True,
                require_filter_match=True,
            ),
        )
        with repo_temp_dir() as td:
            fixtures_dir = td / "fixtures"
            fixtures_dir.mkdir()
            bad_response = {
                "ok": True,
                "query_dim": 32,
                "results": [
                    {
                        "incident_id": "inc-1",
                        "doc_type": "Insurance_Lapse_Report",
                    }
                ],
            }
            for channel in ("http", "mcp"):
                payload = {
                    "case_id": case.case_id,
                    "channel": channel,
                    "request": {
                        "include_text": False,
                        "limit": 6,
                        "sql_filter": case.sql_filter,
                    },
                    "response": bad_response,
                }
                if channel == "http":
                    payload["request"]["query_vector"] = {"_redacted": True, "dim": 32}
                else:
                    payload["request"]["query_text"] = "query"
                (fixtures_dir / f"{channel}_{case.case_id}.json").write_text(
                    json.dumps(payload),
                    encoding="utf-8",
                )

            with self.assertRaises(prove.ProofPathError) as ctx:
                prove.replay_case(
                    case,
                    fixtures_dir=fixtures_dir,
                    run_dir=td / "artifacts",
                    expected_query_dim=32,
                )
            self.assertIn("doc_type", str(ctx.exception))


class TestRunManifest(unittest.TestCase):
    def _ctx(self) -> prove.RuntimeContext:
        return prove.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.invalid/search",
            dataset_uri="s3://trace-vault/trace/eval/lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="iam_only_or_public",
            local_api_key_supplied=False,
        )

    def test_manifest_for_live_run_records_selected_cases(self) -> None:
        manifest = prove.manifest_for_run(
            "run-1",
            prove.utc_now(),
            run_mode="live",
            run_purpose=prove.RUN_PURPOSE_AD_HOC,
            selected_case_ids=["case-a"],
            fixture_source_dir=None,
            ctx=self._ctx(),
            expected_query_dim=1536,
        )
        self.assertEqual(manifest.run_mode, "live")
        self.assertEqual(manifest.run_purpose, prove.RUN_PURPOSE_AD_HOC)
        self.assertEqual(manifest.selected_case_ids, ["case-a"])
        self.assertIsNone(manifest.fixture_source_dir)
        self.assertEqual(manifest.channel_requirements["http_required"], True)
        self.assertEqual(manifest.query_dim, 1536)
        self.assertEqual(manifest.evidence["evidence_class"], "pending")

    def test_manifest_for_replay_run_omits_live_context_and_uses_expected_query_dim(self) -> None:
        fixtures_dir = ROOT / "fixtures" / "deployed" / "examples"
        manifest = prove.manifest_for_run(
            "run-2",
            prove.utc_now(),
            run_mode="replay",
            run_purpose=prove.RUN_PURPOSE_AD_HOC,
            selected_case_ids=["case-a"],
            fixture_source_dir=fixtures_dir,
            ctx=None,
            expected_query_dim=32,
        )
        self.assertEqual(manifest.run_mode, "replay")
        self.assertEqual(manifest.run_purpose, prove.RUN_PURPOSE_AD_HOC)
        self.assertEqual(manifest.api_auth_mode, "replay")
        self.assertEqual(manifest.fixture_source_dir, str(fixtures_dir.resolve()))
        self.assertIsNone(manifest.search_url)
        self.assertEqual(manifest.query_dim, 32)


class TestRunPurposePolicy(unittest.TestCase):
    def _ctx(
        self,
        *,
        stack_name: str = "trace-eval",
        dataset_uri: str = "s3://trace-vault/trace/eval/lance/",
    ) -> prove.RuntimeContext:
        return prove.RuntimeContext(
            stack_name=stack_name,
            region="us-east-1",
            search_url="https://example.invalid/search",
            dataset_uri=dataset_uri,
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="iam_only_or_public",
            local_api_key_supplied=False,
        )

    def test_smoke_rerun_requires_explicit_subset(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_purpose_policy(
                run_purpose=prove.RUN_PURPOSE_SMOKE_RERUN,
                run_mode="live",
                requested_case_ids=[],
                selected_case_ids=["case-a"],
                expected_case_ids=["case-a", "case-b"],
                ctx=self._ctx(),
            )
        self.assertIn("requires explicit --case-ids", str(ctx.exception))

    def test_smoke_rerun_rejects_full_case_set(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_purpose_policy(
                run_purpose=prove.RUN_PURPOSE_SMOKE_RERUN,
                run_mode="live",
                requested_case_ids=["case-b", "case-a"],
                selected_case_ids=["case-b", "case-a"],
                expected_case_ids=["case-a", "case-b"],
                ctx=self._ctx(),
            )
        self.assertIn("cannot cover the full golden-case set", str(ctx.exception))

    def test_release_gate_requires_eval_context(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_run_purpose_policy(
                run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
                run_mode="live",
                requested_case_ids=[],
                selected_case_ids=["case-a", "case-b"],
                expected_case_ids=["case-a", "case-b"],
                ctx=self._ctx(stack_name="trace-smoke"),
            )
        self.assertIn("trace-eval", str(ctx.exception))

    def test_release_gate_accepts_full_eval_live_run(self) -> None:
        prove.validate_run_purpose_policy(
            run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
            run_mode="live",
            requested_case_ids=[],
            selected_case_ids=["case-a", "case-b"],
            expected_case_ids=["case-a", "case-b"],
            ctx=self._ctx(),
        )

    def test_case_set_selection_marks_full_set_independent_of_order(self) -> None:
        selection = prove.evaluate_case_set_selection(
            ["case-b", "case-a"],
            ["case-a", "case-b"],
        )
        self.assertTrue(selection.full_golden_case_set_selected)
        self.assertFalse(selection.reduced_golden_case_subset_selected)

    def test_case_set_selection_marks_reduced_subset(self) -> None:
        selection = prove.evaluate_case_set_selection(
            ["case-a"],
            ["case-a", "case-b"],
        )
        self.assertFalse(selection.full_golden_case_set_selected)
        self.assertTrue(selection.reduced_golden_case_subset_selected)


class TestWorkflowLiveRequestPreflight(unittest.TestCase):
    def test_smoke_rerun_normalizes_case_ids_and_classifies_subset(self) -> None:
        with repo_temp_dir() as td:
            cases_path = td / "cases.json"
            cases_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "cases": [
                            {"case_id": "case-a", "query_text": "a"},
                            {"case_id": "case-b", "query_text": "b"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            preflight = prove.workflow_live_request_preflight(
                run_purpose=prove.RUN_PURPOSE_SMOKE_RERUN,
                stack_name="trace-eval",
                case_ids_raw=" case-b ",
                cases_path=cases_path,
            )

        self.assertEqual(preflight.normalized_case_ids, "case-b")
        self.assertEqual(preflight.selected_case_count, 1)
        self.assertFalse(preflight.full_golden_case_set_selected)
        self.assertEqual(preflight.evidence_class, "smoke-rerun")
        self.assertFalse(preflight.gate_eligible)

    def test_release_gate_preflight_rejects_wrong_stack_name(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.workflow_live_request_preflight(
                run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
                stack_name="trace-smoke",
                case_ids_raw="",
                cases_path=ROOT / "fixtures" / "deployed" / "golden_cases.json",
            )
        self.assertIn("trace-eval", str(ctx.exception))

    def test_release_gate_preflight_rejects_duplicate_case_ids(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.workflow_live_request_preflight(
                run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
                stack_name="trace-eval",
                case_ids_raw="case-a,case-a",
                cases_path=ROOT / "fixtures" / "deployed" / "golden_cases.json",
            )
        self.assertIn("Duplicate case_id", str(ctx.exception))


class TestEvidenceClassification(unittest.TestCase):
    def _ctx(
        self,
        *,
        stack_name: str = "trace-eval",
        dataset_uri: str = "s3://trace-vault/trace/eval/lance/",
    ) -> prove.RuntimeContext:
        return prove.RuntimeContext(
            stack_name=stack_name,
            region="us-east-1",
            search_url="https://example.invalid/search",
            dataset_uri=dataset_uri,
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="iam_only_or_public",
            local_api_key_supplied=False,
        )

    def test_release_gate_manifest_marks_gate_eligible(self) -> None:
        evidence = prove.evidence_for_manifest(
            run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
            run_mode="live",
            selected_case_ids=["case-a", "case-b"],
            expected_case_ids=["case-a", "case-b"],
            completeness={"complete": True},
            ctx=self._ctx(),
        )
        self.assertEqual(evidence["evidence_class"], "release-gate")
        self.assertTrue(evidence["gate_eligible"])
        self.assertEqual(evidence["gate_policy_reasons"], [])

    def test_smoke_rerun_manifest_marks_non_gate_even_when_complete(self) -> None:
        evidence = prove.evidence_for_manifest(
            run_purpose=prove.RUN_PURPOSE_SMOKE_RERUN,
            run_mode="live",
            selected_case_ids=["case-a"],
            expected_case_ids=["case-a", "case-b"],
            completeness={"complete": True},
            ctx=self._ctx(),
        )
        self.assertEqual(evidence["evidence_class"], "smoke-rerun")
        self.assertFalse(evidence["gate_eligible"])
        self.assertIn("run_purpose is smoke_rerun", evidence["gate_policy_reasons"])

    def test_release_gate_policy_reasons_reuse_shared_case_selection(self) -> None:
        selection = prove.evaluate_case_set_selection(
            ["case-a"],
            ["case-a", "case-b"],
        )
        reasons = prove.release_gate_policy_reasons(
            run_purpose=prove.RUN_PURPOSE_RELEASE_GATE,
            run_mode="live",
            case_set_selection=selection,
            completeness={"complete": True},
            ctx=self._ctx(),
        )
        self.assertEqual(
            reasons,
            ["selected_case_ids is not the full golden-case set"],
        )


class TestReleaseGateManifestPolicy(unittest.TestCase):
    def test_accepts_gate_eligible_release_gate_manifest(self) -> None:
        prove.validate_release_gate_manifest_policy(
            {
                "run_mode": "live",
                "run_purpose": prove.RUN_PURPOSE_RELEASE_GATE,
                "evidence": {
                    "evidence_class": "release-gate",
                    "gate_eligible": True,
                    "gate_policy_reasons": [],
                },
            }
        )

    def test_rejects_non_gate_manifest_with_reasons(self) -> None:
        with self.assertRaises(prove.ProofPathError) as ctx:
            prove.validate_release_gate_manifest_policy(
                {
                    "run_mode": "live",
                    "run_purpose": prove.RUN_PURPOSE_RELEASE_GATE,
                    "evidence": {
                        "evidence_class": "live-ad-hoc",
                        "gate_eligible": False,
                        "gate_policy_reasons": ["selected_case_ids is not the full golden-case set"],
                    },
                }
            )
        self.assertIn("evidence.evidence_class must be release-gate", str(ctx.exception))
        self.assertIn("selected_case_ids is not the full golden-case set", str(ctx.exception))


class TestRunCase(unittest.TestCase):
    def _ctx(self) -> prove.RuntimeContext:
        return prove.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.invalid/search",
            dataset_uri="s3://trace-vault/trace/eval/lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="iam_only_or_public",
            local_api_key_supplied=False,
        )

    def test_dry_run_writes_mcp_request_scaffold_and_note(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="audit logs", sql_filter="")
        with repo_temp_dir() as td:
            result = prove.run_case(
                case,
                self._ctx(),
                ROOT,
                td,
                timeout_seconds=1,
                mcp_timeout_seconds=1,
                mock_embeddings=False,
                allow_missing_vectors=False,
                skip_mcp=False,
                dry_run=True,
            )
            self.assertEqual(
                result.notes,
                ["Dry run: skipped HTTP, MCP, and embedding calls."],
            )
            self.assertFalse(result.http_ok)
            self.assertFalse(result.mcp_ok)
            self.assertFalse((td / "http" / "case-a.request.json").exists())
            mcp_request = json.loads(
                (td / "mcp" / "case-a.request.json").read_text(encoding="utf-8")
            )
            self.assertEqual(mcp_request["query_text"], "audit logs")
            self.assertEqual(mcp_request["sql_filter"], "")

    def test_skip_mcp_still_validates_http_and_records_note(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="audit logs", sql_filter="")
        http_response = {"ok": True, "results": [{"incident_id": "inc-1"}], "query_dim": 1536}
        with repo_temp_dir() as td, patch.object(
            prove,
            "resolve_case_vector",
            return_value=[0.0] * 1536,
        ), patch.object(
            prove,
            "call_search_http",
            return_value=http_response,
        ), patch.object(prove, "call_search_mcp_bridge") as mock_mcp:
            result = prove.run_case(
                case,
                self._ctx(),
                ROOT,
                td,
                timeout_seconds=1,
                mcp_timeout_seconds=1,
                mock_embeddings=False,
                allow_missing_vectors=False,
                skip_mcp=True,
                dry_run=False,
            )

            self.assertTrue(result.http_ok)
            self.assertFalse(result.mcp_ok)
            self.assertIn(
                "Skipped MCP validation because --skip-mcp was set.",
                result.notes,
            )
            mock_mcp.assert_not_called()
            http_request = json.loads(
                (td / "http" / "case-a.request.json").read_text(encoding="utf-8")
            )
            self.assertEqual(http_request["limit"], 5)
            self.assertEqual(http_request["include_text"], True)


class TestMainSuccessCriteria(unittest.TestCase):
    def _args(
        self,
        artifacts_root: Path,
        *,
        skip_mcp: bool,
        allow_missing_vectors: bool,
        query_dim: int = 1536,
        replay_fixtures_dir: Path | None = None,
    ):
        return argparse.Namespace(
            cases=ROOT / "fixtures" / "deployed" / "golden_cases.json",
            artifacts_root=artifacts_root,
            case_ids="",
            repo_root=ROOT,
            run_purpose=prove.RUN_PURPOSE_AD_HOC,
            stack_name=None,
            region=None,
            search_url="https://example.invalid/search",
            dataset_uri="s3://trace-vault/trace/eval/lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=query_dim,
            timeout_seconds=1,
            mcp_timeout_seconds=1,
            mock_embeddings=False,
            allow_missing_vectors=allow_missing_vectors,
            skip_mcp=skip_mcp,
            write_stable_fixtures=False,
            replay_fixtures_dir=replay_fixtures_dir,
            stable_fixture_cases="",
            dry_run=False,
        )

    def test_main_fails_when_case_skips_mcp_validation(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="audit logs")
        case_result = prove.CaseResult(
            case_id="case-a",
            http_ok=True,
            mcp_ok=False,
            notes=["Skipped MCP validation because --skip-mcp was set."],
        )
        with repo_temp_dir() as td, patch.object(
            prove,
            "parse_args",
            return_value=self._args(td, skip_mcp=True, allow_missing_vectors=False),
        ), patch.object(
            prove,
            "load_cases",
            return_value=[case],
        ), patch.object(
            prove,
            "resolve_runtime_context",
            return_value=TestRunCase()._ctx(),
        ), patch.object(
            prove,
            "run_case",
            return_value=case_result,
        ):
            stderr = io.StringIO()
            with patch("sys.stderr", stderr):
                exit_code = prove.main()

        self.assertEqual(exit_code, 1)
        self.assertIn("Step 3 requires both HTTP and MCP validation", stderr.getvalue())
        self.assertIn("case-a (MCP missing)", stderr.getvalue())

    def test_main_fails_when_case_skips_http_validation(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="audit logs")
        case_result = prove.CaseResult(
            case_id="case-a",
            http_ok=False,
            mcp_ok=True,
            notes=["Skipped HTTP search (no query vector)."],
        )
        with repo_temp_dir() as td, patch.object(
            prove,
            "parse_args",
            return_value=self._args(td, skip_mcp=False, allow_missing_vectors=True),
        ), patch.object(
            prove,
            "load_cases",
            return_value=[case],
        ), patch.object(
            prove,
            "resolve_runtime_context",
            return_value=TestRunCase()._ctx(),
        ), patch.object(
            prove,
            "run_case",
            return_value=case_result,
        ):
            stderr = io.StringIO()
            with patch("sys.stderr", stderr):
                exit_code = prove.main()

        self.assertEqual(exit_code, 1)
        self.assertIn("Step 3 requires both HTTP and MCP validation", stderr.getvalue())
        self.assertIn("case-a (HTTP missing)", stderr.getvalue())

    def test_main_replay_mode_uses_configured_query_dim(self) -> None:
        case = prove.GoldenCase(case_id="case-a", query_text="audit logs")
        case_result = prove.CaseResult(
            case_id="case-a",
            http_ok=True,
            mcp_ok=True,
            notes=["Replay fixture validation passed."],
        )
        with repo_temp_dir() as td, patch.object(
            prove,
            "parse_args",
            return_value=self._args(
                td,
                skip_mcp=False,
                allow_missing_vectors=False,
                query_dim=32,
                replay_fixtures_dir=ROOT / "fixtures" / "deployed" / "examples",
            ),
        ), patch.object(
            prove,
            "load_cases",
            return_value=[case],
        ), patch.object(
            prove,
            "assert_replay_fixture_coverage",
        ), patch.object(
            prove,
            "replay_case",
            return_value=case_result,
        ) as mock_replay:
            exit_code = prove.main()
            self.assertEqual(exit_code, 0)
            self.assertEqual(mock_replay.call_args.kwargs["expected_query_dim"], 32)
            manifests = sorted(td.glob("*/manifest.json"))
            self.assertEqual(len(manifests), 1)
            manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
            self.assertEqual(manifest["run_mode"], "replay")
            self.assertEqual(manifest["run_purpose"], prove.RUN_PURPOSE_AD_HOC)
            self.assertEqual(manifest["query_dim"], 32)
            self.assertEqual(manifest["evidence"]["evidence_class"], "replay-fixture")


if __name__ == "__main__":
    unittest.main()
