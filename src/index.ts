// Preserve the full package's public API; CLI-only consumers use the shared core entry point.
export * from "./core.js";
export { createMcpServer, mcpToolNames, type McpProfile } from "./mcp.js";
