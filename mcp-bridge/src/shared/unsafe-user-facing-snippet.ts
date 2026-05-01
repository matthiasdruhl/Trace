/**
 * SQL-ish / procedural disclosure probes for user-facing explanatory strings.
 * Shared by mcp-bridge scope interpreter and demo-ui sanitization.
 */
export const UNSAFE_USER_FACING_SNIPPET =
  /(`|\$\{|;\s*$|\bdrop\b|\bdelete\s+from\b|\binsert\s+into\b|\bunion\s+select\b|\bEXEC\s*\(|\bsql\b|\bsql\b\s*-?\s*filter\b)/i;
