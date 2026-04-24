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
    def _args(self, artifacts_root: Path, *, skip_mcp: bool, allow_missing_vectors: bool):
        return argparse.Namespace(
            cases=ROOT / "fixtures" / "deployed" / "golden_cases.json",
            artifacts_root=artifacts_root,
            repo_root=ROOT,
            stack_name=None,
            region=None,
            search_url="https://example.invalid/search",
            dataset_uri="s3://trace-vault/trace/eval/lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            timeout_seconds=1,
            mcp_timeout_seconds=1,
            mock_embeddings=False,
            allow_missing_vectors=allow_missing_vectors,
            skip_mcp=skip_mcp,
            write_stable_fixtures=False,
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


if __name__ == "__main__":
    unittest.main()
