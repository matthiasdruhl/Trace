import test from "node:test";
import assert from "node:assert/strict";

import { validateSearchToolArgs } from "./mcp-tool.js";

test("validateSearchToolArgs preserves default MCP behavior", () => {
  const validated = validateSearchToolArgs({
    query_text: "find audits",
  });

  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.deepEqual(validated.args, {
      query_text: "find audits",
      sql_filter: "",
      limit: 10,
      include_text: false,
    });
  }
});

test("validateSearchToolArgs rejects non integer limits", () => {
  const validated = validateSearchToolArgs({
    query_text: "find audits",
    limit: 2.5,
  });

  assert.deepEqual(validated, {
    ok: false,
    message: "Invalid argument: limit must be an integer.",
  });
});
