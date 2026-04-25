import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  FATAL_ERROR_MESSAGE_CHARS,
  MCP_DEFAULT_LIMIT,
  MCP_LIMIT_MAX,
  MCP_LIMIT_MIN,
  envBool,
  normalizeForPreview,
  truncate,
} from "./lib/common.js";
import { embedText, validateEmbeddingConfig } from "./lib/embeddings.js";
import { toolError, validateSearchToolArgs } from "./lib/mcp-tool.js";
import { callSearch } from "./lib/search-client.js";
import { SearchRequest } from "./lib/search-types.js";

async function main(): Promise<void> {
  validateEmbeddingConfig();

  const server = new Server(
    {
      name: "trace-mcp-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_cold_archive",
        description: `Semantic search over the cold Lance archive on S3 (Trace). limit is ${MCP_LIMIT_MIN}-${MCP_LIMIT_MAX} rows.`,
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
              description: "Optional metadata filter expression forwarded to the Lambda.",
            },
            limit: {
              type: "integer",
              minimum: MCP_LIMIT_MIN,
              maximum: MCP_LIMIT_MAX,
              description: `Result count (${MCP_LIMIT_MIN}-${MCP_LIMIT_MAX}); omit to use default ${MCP_DEFAULT_LIMIT}.`,
            },
            include_text: {
              type: "boolean",
              description:
                "When true, include text fields in result rows (forwarded to Lambda).",
            },
          },
          required: ["query_text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "search_cold_archive") {
      return toolError(
        `Invalid argument: tool must be search_cold_archive (got ${request.params.name}).`
      );
    }

    const validated = validateSearchToolArgs(request.params.arguments);
    if (!validated.ok) {
      return toolError(validated.message);
    }

    const { query_text, sql_filter, limit, include_text } = validated.args;

    let vector: number[];
    try {
      vector = await embedText(query_text);
    } catch (err) {
      const message = err instanceof Error ? err.message : `${err}`;
      return toolError(`Embedding generation failed (internal): ${message}`);
    }

    const payload: SearchRequest = {
      query_vector: vector,
      sql_filter,
      limit,
      include_text,
    };

    try {
      const result = await callSearch(payload);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : `${err}`;
      return toolError(`Search request failed: ${message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const payload: Record<string, unknown> = {
    kind: "fatal",
    name: err instanceof Error ? err.name : "non_error_thrown",
    message:
      err instanceof Error
        ? truncate(normalizeForPreview(err.message), FATAL_ERROR_MESSAGE_CHARS)
        : truncate(normalizeForPreview(String(err)), FATAL_ERROR_MESSAGE_CHARS),
  };
  if (envBool("MCP_DEBUG") && err instanceof Error && err.stack) {
    payload.stack = truncate(err.stack, 8000);
  }
  console.error("[Fatal]", JSON.stringify(payload));
  process.exit(1);
});
