import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const distDir = currentDir;
const packageRoot = path.dirname(distDir);
const serverEntry = path.join(distDir, "index.js");

function requiredTextResult(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(typeof result.content[0]?.text, "string");
  return result.content[0]!.text!;
}

function stringEnv(
  overrides: Record<string, string | undefined>
): Record<string, string> {
  const merged = {
    ...process.env,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    })
  );
}

async function withMcpClient<T>(
  envOverrides: Record<string, string | undefined>,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: packageRoot,
    env: stringEnv(envOverrides),
    stderr: "pipe",
  });

  let stderrOutput = "";
  transport.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  const client = new Client({
    name: "trace-mcp-bridge-test-client",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    if (stderrOutput.trim().length > 0) {
      throw new Error(
        `MCP stdio test failed with server stderr:\n${stderrOutput}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    await transport.close();
  }
}

test("stdio MCP server lists search_cold_archive and serves successful calls", async () => {
  await withMcpClient(
    {
      USE_MOCK_EMBEDDINGS: "true",
      TRACE_MCP_MOCK: "true",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    },
    async (client) => {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 1);
      assert.deepEqual(tools.tools[0], {
        name: "search_cold_archive",
        description:
          "Semantic search over the cold Lance archive on S3 (Trace). limit is 1-50 rows.",
        inputSchema: {
          type: "object",
          properties: {
            query_text: {
              type: "string",
              description:
                "Natural language query (embedded via OpenAI unless USE_MOCK_EMBEDDINGS=true).",
            },
            sql_filter: {
              type: "string",
              description:
                "Optional metadata filter expression forwarded to the Lambda.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description: "Result count (1-50); omit to use default 10.",
            },
            include_text: {
              type: "boolean",
              description:
                "When true, include text fields in result rows (forwarded to Lambda).",
            },
          },
          required: ["query_text"],
        },
      });

      const result = await client.callTool({
        name: "search_cold_archive",
        arguments: {
          query_text: "find archived reports",
          sql_filter: "city_code = 'SF'",
          limit: 3,
          include_text: true,
        },
      });

      assert.equal(result.isError, undefined);
      const payload = JSON.parse(requiredTextResult(result as { content: Array<{ type: string; text?: string }> }));
      assert.deepEqual(payload, {
        ok: true,
        results: [],
        query_dim: 1536,
        k: 3,
        took_ms: 0,
        stub: "mock response for query with limit=3 (no Lambda call)",
      });
    }
  );
});

test("stdio MCP server returns tool errors when shared search path fails", async () => {
  await withMcpClient(
    {
      USE_MOCK_EMBEDDINGS: "true",
      TRACE_MCP_MOCK: undefined,
      TRACE_SEARCH_URL: undefined,
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    },
    async (client) => {
      const result = await client.callTool({
        name: "search_cold_archive",
        arguments: {
          query_text: "find archived reports",
        },
      });

      assert.equal(result.isError, true);
      assert.equal(
        requiredTextResult(result as { content: Array<{ type: string; text?: string }> }),
        "Search request failed: TRACE_SEARCH_URL is required unless TRACE_MCP_MOCK=1"
      );
    }
  );
});
