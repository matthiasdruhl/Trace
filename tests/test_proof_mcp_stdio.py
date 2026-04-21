"""Focused tests for the MCP stdio helper used by the deployed proof runner."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def _load_mcp_module():
    path = ROOT / "scripts" / "proof_mcp_stdio.py"
    spec = importlib.util.spec_from_file_location("proof_mcp_stdio", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["proof_mcp_stdio"] = mod
    spec.loader.exec_module(mod)
    return mod


mcp = _load_mcp_module()


class TestMcpStartupFailures(unittest.TestCase):
    @patch("subprocess.Popen", side_effect=FileNotFoundError("node not found"))
    def test_popen_failure_becomes_mcp_stdio_error(self, _mock_popen) -> None:
        with self.assertRaises(mcp.McpStdioError) as ctx:
            mcp.McpStdioSession(
                node_executable="node",
                bridge_entry=Path("mcp-bridge/dist/index.js"),
                env={},
            )

        msg = str(ctx.exception)
        self.assertIn("Failed to start MCP bridge subprocess", msg)
        self.assertIn("Node.js", msg)
        self.assertIn("NODE_BINARY", msg)
        self.assertIn("Command attempted", msg)


class TestParseCallToolSearchResult(unittest.TestCase):
    def test_tool_error_surfaces_text_blocks(self) -> None:
        with self.assertRaises(mcp.McpStdioError) as ctx:
            mcp.parse_call_tool_search_result(
                {
                    "isError": True,
                    "content": [
                        {"type": "text", "text": "bridge failed"},
                        {"type": "text", "text": "details"},
                    ],
                }
            )

        self.assertIn("bridge failed", str(ctx.exception))
        self.assertIn("details", str(ctx.exception))

    def test_non_json_tool_text_fails_cleanly(self) -> None:
        with self.assertRaises(mcp.McpStdioError) as ctx:
            mcp.parse_call_tool_search_result(
                {
                    "content": [
                        {"type": "text", "text": "not json"},
                    ]
                }
            )

        self.assertIn("non-JSON text", str(ctx.exception))


class TestRunSearchColdArchive(unittest.TestCase):
    def test_missing_bridge_entry_fails_before_spawn(self) -> None:
        missing_entry = ROOT / "mcp-bridge" / "dist" / "__missing__.js"
        self.assertFalse(missing_entry.exists())

        with self.assertRaises(mcp.McpStdioError) as ctx:
            mcp.run_search_cold_archive(
                repo_root=ROOT,
                env={},
                tool_arguments={
                    "query_text": "smoke",
                    "sql_filter": "",
                    "limit": 3,
                    "include_text": False,
                },
                bridge_entry=missing_entry,
            )

        self.assertIn("not built", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
