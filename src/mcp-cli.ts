#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, type McpProfile } from "./mcp.js";

const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const program = new Command()
  .name("merge-broker-mcp")
  .description("Serve Agent Merge Broker tools over MCP stdio")
  .version(version)
  .option("-C, --cwd <directory>", "repository or worktree directory", process.cwd())
  .addOption(new Option("--profile <profile>", "worker or operator capabilities").choices(["worker", "operator"]).default("worker"));

program.parse();
const options = program.opts<{ cwd: string; profile: McpProfile }>();
const handle = serveStdio(
  () => createMcpServer({ cwd: options.cwd, profile: options.profile, version }),
  { onerror: (error) => console.error(error instanceof Error ? error.message : String(error)) },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
