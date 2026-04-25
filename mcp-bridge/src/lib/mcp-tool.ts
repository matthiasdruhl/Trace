import {
  MCP_DEFAULT_LIMIT,
  MCP_LIMIT_MAX,
  MCP_LIMIT_MIN,
  isPlainObject,
} from "./common.js";

export type ValidatedSearchToolArgs = {
  query_text: string;
  sql_filter: string;
  limit: number;
  include_text: boolean;
};

export function toolError(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

export function validateSearchToolArgs(
  raw: unknown
):
  | { ok: true; args: ValidatedSearchToolArgs }
  | { ok: false; message: string } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: "Invalid argument: arguments must be a plain object.",
    };
  }

  if (!("query_text" in raw) || typeof raw.query_text !== "string") {
    return {
      ok: false,
      message: "Invalid argument: query_text must be a string.",
    };
  }
  if (raw.query_text.trim().length === 0) {
    return {
      ok: false,
      message: "Invalid argument: query_text must be a non-empty string.",
    };
  }

  let sql_filter = "";
  if ("sql_filter" in raw && raw.sql_filter !== undefined) {
    if (typeof raw.sql_filter !== "string") {
      return {
        ok: false,
        message: "Invalid argument: sql_filter must be a string.",
      };
    }
    sql_filter = raw.sql_filter;
  }

  let limit = MCP_DEFAULT_LIMIT;
  if ("limit" in raw && raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit)) {
      return {
        ok: false,
        message: "Invalid argument: limit must be an integer.",
      };
    }
    limit = raw.limit;
  }

  if (limit < MCP_LIMIT_MIN || limit > MCP_LIMIT_MAX) {
    return {
      ok: false,
      message: `Invalid argument: limit must be between ${MCP_LIMIT_MIN} and ${MCP_LIMIT_MAX} (inclusive).`,
    };
  }

  let include_text = false;
  if ("include_text" in raw && raw.include_text !== undefined) {
    if (typeof raw.include_text !== "boolean") {
      return {
        ok: false,
        message: "Invalid argument: include_text must be a boolean.",
      };
    }
    include_text = raw.include_text;
  }

  return {
    ok: true,
    args: {
      query_text: raw.query_text,
      sql_filter,
      limit,
      include_text,
    },
  };
}
