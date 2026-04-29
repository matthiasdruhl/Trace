from __future__ import annotations

import importlib.util
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".test-tmp"


def _load_benchmark_module():
    path = ROOT / "scripts" / "run_deployed_benchmark.py"
    spec = importlib.util.spec_from_file_location("run_deployed_benchmark", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["run_deployed_benchmark"] = mod
    spec.loader.exec_module(mod)
    return mod


benchmark = _load_benchmark_module()


@contextmanager
def repo_temp_dir():
    TEST_TMP_ROOT.mkdir(exist_ok=True)
    path = TEST_TMP_ROOT / str(uuid.uuid4())
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class TestParseReportLine(unittest.TestCase):
    def test_parses_cold_report_line(self) -> None:
        line = (
            "REPORT RequestId: abc Duration: 123.45 ms Billed Duration: 124 ms "
            "Memory Size: 512 MB Max Memory Used: 188 MB Init Duration: 1672.99 ms"
        )
        metrics = benchmark.parse_report_line(line)

        self.assertEqual(metrics.duration_ms, 123.45)
        self.assertEqual(metrics.billed_duration_ms, 124.0)
        self.assertEqual(metrics.memory_size_mb, 512)
        self.assertEqual(metrics.max_memory_used_mb, 188)
        self.assertEqual(metrics.init_duration_ms, 1672.99)

    def test_rejects_unparseable_report_line(self) -> None:
        with self.assertRaises(benchmark.TraceRuntimeError):
            benchmark.parse_report_line("REPORT RequestId: abc")


class TestSummariesAndCost(unittest.TestCase):
    def _lambda_sample(
        self,
        *,
        sample_index: int,
        billed_duration_ms: float,
        max_memory_used_mb: int,
        init_duration_ms: float | None,
    ) -> benchmark.LambdaBenchmarkSample:
        return benchmark.LambdaBenchmarkSample(
            sample_index=sample_index,
            case_id="unfiltered-demo",
            invoke_round_trip_ms=100.0 + sample_index,
            lambda_version=None,
            response_took_ms=50,
            returned_count=5,
            report=benchmark.LambdaReportMetrics(
                duration_ms=billed_duration_ms - 1.0,
                billed_duration_ms=billed_duration_ms,
                memory_size_mb=512,
                max_memory_used_mb=max_memory_used_mb,
                init_duration_ms=init_duration_ms,
                report_line="REPORT RequestId: abc",
            ),
        )

    def test_summarize_samples_aggregates_and_prices(self) -> None:
        pricing = benchmark.PricingConfig(
            lambda_request_price_per_million=0.20,
            lambda_gb_second_price=0.0000166667,
            api_gateway_http_request_price_per_million=1.0,
            lambda_pricing_architecture="x86_64",
            lambda_request_price_defaulted=True,
            lambda_gb_second_price_defaulted=True,
            api_gateway_http_request_price_defaulted=True,
        )
        cold_samples = [
            self._lambda_sample(
                sample_index=1,
                billed_duration_ms=1700.0,
                max_memory_used_mb=200,
                init_duration_ms=1600.0,
            ),
            self._lambda_sample(
                sample_index=2,
                billed_duration_ms=1800.0,
                max_memory_used_mb=210,
                init_duration_ms=1700.0,
            ),
            self._lambda_sample(
                sample_index=3,
                billed_duration_ms=1750.0,
                max_memory_used_mb=190,
                init_duration_ms=1650.0,
            ),
        ]
        warm_lambda_samples = [
            self._lambda_sample(
                sample_index=1,
                billed_duration_ms=90.0,
                max_memory_used_mb=180,
                init_duration_ms=None,
            ),
            self._lambda_sample(
                sample_index=2,
                billed_duration_ms=100.0,
                max_memory_used_mb=182,
                init_duration_ms=None,
            ),
            self._lambda_sample(
                sample_index=3,
                billed_duration_ms=110.0,
                max_memory_used_mb=181,
                init_duration_ms=None,
            ),
        ]
        warm_http_samples = [
            benchmark.HttpBenchmarkSample(
                sample_index=1,
                case_id="unfiltered-demo",
                client_round_trip_ms=120.0,
                response_took_ms=60,
                returned_count=5,
            ),
            benchmark.HttpBenchmarkSample(
                sample_index=2,
                case_id="filtered-chi-insurance",
                client_round_trip_ms=140.0,
                response_took_ms=70,
                returned_count=4,
            ),
        ]

        summary = benchmark.summarize_samples(
            cold_lambda_samples=cold_samples,
            warm_lambda_samples=warm_lambda_samples,
            warm_http_samples=warm_http_samples,
            configured_memory_mb=512,
            pricing=pricing,
            warm_lambda_discarded_invocations=1,
        )

        self.assertEqual(summary.cold_init_median_ms, 1650.0)
        self.assertEqual(summary.cold_lambda_round_trip_median_ms, 102.0)
        self.assertEqual(summary.cold_response_took_median_ms, 50.0)
        self.assertEqual(summary.warm_http_latency_median_ms, 130.0)
        self.assertEqual(summary.warm_took_median_ms, 65.0)
        self.assertEqual(summary.max_memory_used_mb, 210)
        self.assertEqual(summary.configured_memory_mb, 512)
        self.assertEqual(
            summary.warm_http_workload_mix,
            [
                {"case_id": "unfiltered-demo", "sample_count": 1},
                {"case_id": "filtered-chi-insurance", "sample_count": 1},
            ],
        )
        self.assertIn("Init Duration", summary.cold_start_measurement_note)
        self.assertEqual(summary.warm_lambda_discarded_invocations, 1)
        self.assertIsNotNone(summary.estimated_warm_cost_per_query_usd)
        self.assertIsNotNone(summary.estimated_cold_cost_per_query_usd)
        assert summary.estimated_warm_cost_per_query_usd is not None
        assert summary.estimated_cold_cost_per_query_usd is not None
        self.assertGreater(
            summary.estimated_cold_cost_per_query_usd,
            summary.estimated_warm_cost_per_query_usd,
        )

        artifact = benchmark.BenchmarkArtifact(
            run_id="run-123",
            generated_at="2026-04-28T19:07:04Z",
            runtime_context={
                "stack_name": "trace-eval",
                "region": "us-east-1",
                "search_url": "https://example.com/search",
                "dataset_uri": "s3://bucket/eval.lance",
                "function_arn": "arn:aws:lambda:us-east-1:123:function:trace-eval",
                "function_architectures": ["x86_64"],
            },
            benchmark_cases=[],
            pricing={
                "lambda_request_price_per_million": 0.20,
                "lambda_gb_second_price": 0.0000166667,
                "api_gateway_http_request_price_per_million": 1.0,
                "lambda_pricing_architecture": "x86_64",
                "lambda_request_price_defaulted": True,
                "lambda_gb_second_price_defaulted": True,
                "api_gateway_http_request_price_defaulted": True,
                "pricing_region": "us-east-1",
                "lambda_request_pricing_tier": "on-demand requests",
                "lambda_compute_pricing_tier": "on-demand first-tier GB-second pricing",
                "api_gateway_http_request_pricing_tier": "HTTP API first 300M requests/month pricing example",
                "lambda_pricing_source_url": "https://aws.amazon.com/lambda/pricing/",
                "api_gateway_http_pricing_source_url": "https://aws.amazon.com/api-gateway/pricing/?z=3",
                "notes": "pricing notes",
            },
        )
        markdown = benchmark.build_summary_markdown(artifact=artifact, summary=summary)
        self.assertIn("Cold Lambda init duration median", markdown)
        self.assertIn("Warm HTTP Workload Mix", markdown)
        self.assertIn("Discarded post-mutation warm Lambda invokes", markdown)
        self.assertIn("unfiltered-demo", markdown)
        self.assertIn("filtered-chi-insurance", markdown)
        self.assertIn("Lambda pricing architecture", markdown)
        self.assertIn("https://aws.amazon.com/lambda/pricing/", markdown)


class TestPricingResolution(unittest.TestCase):
    def test_defaults_lambda_compute_price_from_arm_architecture(self) -> None:
        ctx = benchmark.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.com/search",
            dataset_uri="s3://bucket/eval.lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="none",
            local_api_key_supplied=False,
            function_arn="arn:aws:lambda:us-east-1:123:function:trace-eval",
            function_name="trace-eval",
            function_memory_mb=512,
            function_architectures=("arm64",),
        )
        args = SimpleNamespace(
            lambda_request_price_per_million=None,
            lambda_gb_second_price=None,
            api_gateway_http_request_price_per_million=None,
        )

        pricing = benchmark.resolve_pricing_config(args, ctx)

        self.assertEqual(pricing.lambda_pricing_architecture, "arm64")
        self.assertAlmostEqual(pricing.lambda_gb_second_price, 0.0000133334)
        self.assertTrue(pricing.lambda_request_price_defaulted)
        self.assertTrue(pricing.lambda_gb_second_price_defaulted)
        self.assertTrue(pricing.api_gateway_http_request_price_defaulted)
        self.assertEqual(
            pricing.lambda_pricing_source_url,
            "https://aws.amazon.com/lambda/pricing/",
        )
        self.assertEqual(
            pricing.api_gateway_http_pricing_source_url,
            "https://aws.amazon.com/api-gateway/pricing/?z=3",
        )


class TestBenchmarkValidation(unittest.TestCase):
    def _runtime_context(self) -> benchmark.RuntimeContext:
        return benchmark.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.com/search",
            dataset_uri="s3://bucket/eval.lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="none",
            local_api_key_supplied=False,
            function_arn="arn:aws:lambda:us-east-1:123:function:trace-eval",
            function_name="trace-eval",
            function_memory_mb=512,
            function_architectures=("x86_64",),
        )

    def test_warm_http_sampling_ignores_expected_ids(self) -> None:
        original_http = benchmark.call_search_http
        try:
            benchmark.call_search_http = lambda search_url, payload, api_key, timeout_seconds: {
                "ok": True,
                "results": [{"incident_id": "different-id"}],
                "took_ms": 21,
                "query_dim": 1536,
            }
            samples = benchmark.run_warm_http_samples(
                ctx=self._runtime_context(),
                cases=[
                    benchmark.GoldenCase(
                        case_id="proof-coupled-case",
                        query_text="demo",
                        expected_ids=["expected-proof-id"],
                    )
                ],
                case_vectors={"proof-coupled-case": [0.1, 0.2]},
                sample_count=1,
                timeout_seconds=5,
            )
        finally:
            benchmark.call_search_http = original_http

        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].returned_count, 1)


class TestWarmLambdaSampling(unittest.TestCase):
    def _runtime_context(self) -> benchmark.RuntimeContext:
        return benchmark.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.com/search",
            dataset_uri="s3://bucket/eval.lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="none",
            local_api_key_supplied=False,
            function_arn="arn:aws:lambda:us-east-1:123:function:trace-eval",
            function_name="trace-eval",
            function_memory_mb=512,
            function_architectures=("x86_64",),
        )

    def test_discards_initial_warm_lambda_invoke_after_cold_mutation(self) -> None:
        calls: list[int] = []
        original_invoke = benchmark._invoke_direct_lambda
        original_assert = benchmark.assert_benchmark_case_contract

        def fake_invoke(*, lambda_client, ctx, payload, qualifier):
            del lambda_client, ctx, payload, qualifier
            call_number = len(calls) + 1
            calls.append(call_number)
            init_duration_ms = 250.0 if call_number == 2 else None
            return (
                {"ok": True, "results": [{}], "took_ms": 40 + call_number},
                benchmark.LambdaReportMetrics(
                    duration_ms=10.0 + call_number,
                    billed_duration_ms=20.0 + call_number,
                    memory_size_mb=512,
                    max_memory_used_mb=128,
                    init_duration_ms=init_duration_ms,
                    report_line="REPORT RequestId: abc",
                ),
                float(call_number * 100),
            )

        benchmark._invoke_direct_lambda = fake_invoke
        benchmark.assert_benchmark_case_contract = lambda case, response: None
        try:
            samples, discarded = benchmark.run_warm_lambda_samples(
                lambda_client=object(),
                ctx=self._runtime_context(),
                case=benchmark.GoldenCase(case_id="unfiltered-demo", query_text="demo"),
                case_vector=[0.1, 0.2],
                sample_count=2,
                discard_initial_invocation=True,
            )
        finally:
            benchmark._invoke_direct_lambda = original_invoke
            benchmark.assert_benchmark_case_contract = original_assert

        self.assertEqual(discarded, 2)
        self.assertEqual(calls, [1, 2, 3, 4])
        self.assertEqual([sample.sample_index for sample in samples], [1, 2])
        self.assertEqual([sample.invoke_round_trip_ms for sample in samples], [300.0, 400.0])
        self.assertEqual([sample.response_took_ms for sample in samples], [43, 44])
        self.assertEqual([sample.report.init_duration_ms for sample in samples], [None, None])


class TestColdLambdaSampling(unittest.TestCase):
    def _runtime_context(self) -> benchmark.RuntimeContext:
        return benchmark.RuntimeContext(
            stack_name="trace-eval",
            region="us-east-1",
            search_url="https://example.com/search",
            dataset_uri="s3://bucket/eval.lance",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            api_auth_mode="none",
            local_api_key_supplied=False,
            function_arn="arn:aws:lambda:us-east-1:123:function:trace-eval",
            function_name="trace-eval",
            function_memory_mb=512,
            function_architectures=("x86_64",),
        )

    def test_restores_description_and_deletes_versions_on_failure(self) -> None:
        class FakeLambdaClient:
            def __init__(self) -> None:
                self.updated_descriptions: list[str] = []
                self.deleted_versions: list[str] = []

            def get_function_configuration(self, *, FunctionName: str):
                self.requested_function = FunctionName
                return {"Description": "original-description"}

            def update_function_configuration(self, *, FunctionName: str, Description: str):
                self.updated_descriptions.append(Description)

            def delete_function(self, *, FunctionName: str, Qualifier: str):
                self.deleted_versions.append(Qualifier)

        client = FakeLambdaClient()
        original_publish = benchmark._publish_version
        original_invoke = benchmark._invoke_direct_lambda
        original_assert = benchmark.assert_benchmark_case_contract

        benchmark._publish_version = lambda lambda_client, ctx, description: "11"
        benchmark._invoke_direct_lambda = (
            lambda **kwargs: (_ for _ in ()).throw(benchmark.TraceRuntimeError("boom"))
        )
        benchmark.assert_benchmark_case_contract = lambda case, response: None
        try:
            with self.assertRaises(benchmark.TraceRuntimeError) as exc_info:
                benchmark.run_cold_lambda_samples(
                    lambda_client=client,
                    ctx=self._runtime_context(),
                    case=benchmark.GoldenCase(case_id="unfiltered-demo", query_text="demo"),
                    case_vector=[0.1, 0.2],
                    sample_count=1,
                    keep_published_versions=False,
                )
        finally:
            benchmark._publish_version = original_publish
            benchmark._invoke_direct_lambda = original_invoke
            benchmark.assert_benchmark_case_contract = original_assert

        self.assertIn("boom", str(exc_info.exception))
        self.assertEqual(
            client.updated_descriptions,
            [
                "trace-step4-cold-benchmark-sample-1",
                "original-description",
            ],
        )
        self.assertEqual(client.deleted_versions, ["11"])
