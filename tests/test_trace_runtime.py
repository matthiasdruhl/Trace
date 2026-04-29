from __future__ import annotations

import argparse
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def _load_trace_runtime_module():
    path = ROOT / "scripts" / "trace_runtime.py"
    spec = importlib.util.spec_from_file_location("trace_runtime", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["trace_runtime"] = mod
    spec.loader.exec_module(mod)
    return mod


trace_runtime = _load_trace_runtime_module()


class TestResolveRuntimeContext(unittest.TestCase):
    def _args(
        self,
        *,
        stack_name: str = "trace-eval",
        region: str = "us-east-1",
        search_url: str | None = None,
        function_arn: str | None = None,
    ) -> argparse.Namespace:
        return argparse.Namespace(
            stack_name=stack_name,
            region=region,
            search_url=search_url,
            dataset_uri="s3://trace-vault/trace/eval/lance/",
            api_key=None,
            embedding_model="text-embedding-3-small",
            query_dim=1536,
            function_arn=function_arn,
        )

    def test_rejects_mismatched_explicit_search_url_for_stack(self) -> None:
        stack = {
            "Outputs": [
                {
                    "OutputKey": "SearchUrl",
                    "OutputValue": "https://expected.execute-api.us-east-1.amazonaws.com/search",
                },
                {
                    "OutputKey": "TraceSearchFunctionArn",
                    "OutputValue": "arn:aws:lambda:us-east-1:123:function:trace-eval-trace-search",
                },
            ],
            "Parameters": [],
        }
        with patch.object(trace_runtime, "_describe_stack", return_value=stack):
            with self.assertRaises(trace_runtime.TraceRuntimeError) as ctx:
                trace_runtime.resolve_runtime_context(
                    self._args(
                        search_url="https://different.execute-api.us-east-1.amazonaws.com/search"
                    )
                )
        self.assertIn("does not match stack output SearchUrl", str(ctx.exception))

    def test_rejects_mismatched_explicit_function_arn_for_stack(self) -> None:
        stack = {
            "Outputs": [
                {
                    "OutputKey": "SearchUrl",
                    "OutputValue": "https://expected.execute-api.us-east-1.amazonaws.com/search",
                },
                {
                    "OutputKey": "TraceSearchFunctionArn",
                    "OutputValue": "arn:aws:lambda:us-east-1:123:function:trace-eval-trace-search",
                },
            ],
            "Parameters": [],
        }
        with patch.object(trace_runtime, "_describe_stack", return_value=stack):
            with self.assertRaises(trace_runtime.TraceRuntimeError) as ctx:
                trace_runtime.resolve_runtime_context(
                    self._args(
                        search_url="https://expected.execute-api.us-east-1.amazonaws.com/search",
                        function_arn="arn:aws:lambda:us-east-1:123:function:different-function",
                    )
                )
        self.assertIn("does not match stack output TraceSearchFunctionArn", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
