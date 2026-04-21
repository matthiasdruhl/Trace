"""
Minimal MCP stdio client for the Trace proof runner.

The MCP TypeScript SDK uses newline-delimited JSON-RPC on the child process stdout.
This module speaks the same framing so Python can drive `trace-mcp-bridge` without
adding a Node helper script.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


class McpStdioError(RuntimeError):
    """Raised when the MCP stdio session cannot complete a request."""


def _format_subprocess_start_failure(
    *,
    node_executable: str,
    bridge_entry: Path,
    exc: OSError,
) -> str:
    """Human-readable guidance when Popen fails before the MCP session starts."""
    cmd = f"{node_executable} {bridge_entry}"
    detail = f"{type(exc).__name__}: {exc}"
    return (
        "Failed to start MCP bridge subprocess.\n\n"
        "Likely causes:\n"
        "  - Node.js is missing or not on PATH (try `node --version`).\n"
        "  - NODE_BINARY is set to a wrong or non-executable path.\n"
        "  - Bridge entry is missing or not built (expected mcp-bridge/dist/index.js after npm run build).\n"
        "  - The bridge entry exists but cannot be executed (permissions, OS policy).\n"
        "  - OS-level failure spawning the process (antivirus, sandbox, broken install).\n\n"
        f"Command attempted: {cmd}\n"
        f"Underlying error: {detail}"
    )


class McpStdioSession:
    """One-shot session: connect, initialize, call one tool, exit."""

    def __init__(
        self,
        node_executable: str,
        bridge_entry: Path,
        env: dict[str, str],
        timeout_seconds: int = 120,
    ) -> None:
        self._timeout = timeout_seconds
        try:
            self._proc = subprocess.Popen(
                [node_executable, str(bridge_entry)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                bufsize=0,
            )
        except OSError as exc:
            raise McpStdioError(
                _format_subprocess_start_failure(
                    node_executable=node_executable,
                    bridge_entry=bridge_entry,
                    exc=exc,
                )
            ) from exc
        self._stderr_lines: list[str] = []
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True
        )
        self._stderr_thread.start()
        self._line_queue: queue.Queue[str | None] = queue.Queue()
        self._stdout_thread = threading.Thread(target=self._drain_stdout, daemon=True)
        self._stdout_thread.start()
        self._next_id = 0

    def _drain_stderr(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            self._stderr_lines.append(line.rstrip("\n"))

    def _drain_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self._line_queue.put(line)
        self._line_queue.put(None)

    def close(self) -> None:
        if self._proc.stdin:
            try:
                self._proc.stdin.close()
            except OSError:
                pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()

    def _write_line(self, obj: dict[str, Any]) -> None:
        assert self._proc.stdin is not None
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"
        self._proc.stdin.write(line)
        self._proc.stdin.flush()

    def _read_result(self, req_id: int) -> dict[str, Any]:
        deadline = time.monotonic() + self._timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                err = "\n".join(self._stderr_lines[-40:])
                raise McpStdioError(
                    f"MCP request timed out after {self._timeout}s (stderr tail):\n{err}"
                )
            try:
                raw_line = self._line_queue.get(timeout=min(remaining, 5.0))
            except queue.Empty:
                continue
            if raw_line is None:
                err = "\n".join(self._stderr_lines[-40:])
                raise McpStdioError(
                    f"MCP server closed stdout before responding (stderr tail):\n{err}"
                )
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                raise McpStdioError(f"Invalid JSON from MCP stdout: {line[:200]}") from exc

            if msg.get("id") != req_id:
                # Notifications and unrelated responses (e.g. logging) are ignored.
                continue

            if "error" in msg:
                err = msg["error"]
                if isinstance(err, dict):
                    code = err.get("code")
                    message = err.get("message", "")
                    raise McpStdioError(f"MCP JSON-RPC error {code}: {message}")
                raise McpStdioError(f"MCP JSON-RPC error: {err}")

            result = msg.get("result")
            if result is None:
                raise McpStdioError(f"MCP JSON-RPC missing result: {msg!r}")
            return result

    def _request(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        self._next_id += 1
        rid = self._next_id
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": rid,
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        self._write_line(payload)
        return self._read_result(rid)

    def _notification(self, method: str, params: dict[str, Any] | None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._write_line(payload)

    def connect(self, protocol_version: str = "2024-11-05") -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "trace-proof-runner", "version": "1.0.0"},
            },
        )
        self._notification("notifications/initialized", {})

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "tools/call",
            {"name": name, "arguments": arguments},
        )


def default_node_executable() -> str:
    return os.environ.get("NODE_BINARY", "node")


def default_bridge_entry(repo_root: Path) -> Path:
    return repo_root / "mcp-bridge" / "dist" / "index.js"


def parse_call_tool_search_result(result: dict[str, Any]) -> dict[str, Any]:
    """Extract the Trace search JSON object from an MCP tools/call result."""
    if result.get("isError"):
        texts: list[str] = []
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    texts.append(t)
        raise McpStdioError("MCP tool error: " + (" | ".join(texts) or "(no text)"))

    texts = []
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            t = block.get("text")
            if isinstance(t, str):
                texts.append(t)
    if not texts:
        raise McpStdioError("MCP tools/call returned no text content")

    raw = texts[0].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise McpStdioError(
            f"MCP tool returned non-JSON text (prefix): {raw[:200]}"
        ) from exc


def run_search_cold_archive(
    *,
    repo_root: Path,
    env: dict[str, str],
    tool_arguments: dict[str, Any],
    node_executable: str | None = None,
    bridge_entry: Path | None = None,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    """
    Spawn the MCP bridge, run one tools/call for search_cold_archive, parse JSON, exit.
    """
    node = node_executable or default_node_executable()
    entry = bridge_entry or default_bridge_entry(repo_root)
    if not entry.is_file():
        raise McpStdioError(
            f"MCP bridge not built at {entry}. Run: cd mcp-bridge && npm install && npm run build"
        )

    merged = {**os.environ, **env}
    session = McpStdioSession(node, entry, merged, timeout_seconds=timeout_seconds)
    try:
        session.connect()
        result = session.call_tool("search_cold_archive", tool_arguments)
        return parse_call_tool_search_result(result)
    finally:
        session.close()


def main_smoke() -> int:
    """Manual smoke: requires TRACE_SEARCH_URL and embedding config like the bridge."""
    if len(sys.argv) < 2:
        print("usage: proof_mcp_stdio.py <repo_root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    out = run_search_cold_archive(
        repo_root=root,
        env={},
        tool_arguments={
            "query_text": "smoke",
            "sql_filter": "",
            "limit": 3,
            "include_text": False,
        },
    )
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main_smoke())
