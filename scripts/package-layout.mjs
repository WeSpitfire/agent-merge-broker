import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CORE_PACKAGE_NAME = "agent-merge-broker-core";
const CORE_DEPENDENCIES = ["commander", "picomatch", "zod"];

/** Derive the slim distribution from one source/version; do not maintain a fork of the broker. */
export function corePackageMetadata(full) {
  return {
    name: CORE_PACKAGE_NAME,
    version: full.version,
    description: "CLI, Gate, and library for Agent Merge Broker, without the MCP adapter.",
    type: "module",
    bin: { "merge-broker": "dist/cli.js", amb: "dist/cli.js" },
    main: "./dist/core.js",
    types: "./dist/core.d.ts",
    exports: { ".": { types: "./dist/core.d.ts", import: "./dist/core.js" } },
    files: ["dist", "schemas", "templates", "README.md", "LICENSE"],
    engines: full.engines,
    keywords: full.keywords,
    author: full.author,
    license: full.license,
    repository: full.repository,
    bugs: full.bugs,
    homepage: full.homepage,
    dependencies: Object.fromEntries(CORE_DEPENDENCIES.map((name) => {
      assert.ok(full.dependencies[name], `Missing core dependency: ${name}`);
      return [name, full.dependencies[name]];
    })),
  };
}

export async function stageCorePackage(root, destination) {
  await mkdir(destination, { recursive: true });
  assert.deepEqual(await readdir(destination), [], "Core staging directory must be empty.");
  const metadata = corePackageMetadata(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  await mkdir(path.join(destination, "dist"));
  // The compiler emits broker modules directly under dist; neither tests nor MCP enter the core.
  for (const entry of await readdir(path.join(root, "dist"), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|d\.ts)$/u.test(entry.name) ||
        entry.name.includes(".test.") || /^(?:index|mcp|mcp-cli)\./u.test(entry.name)) continue;
    const source = await readFile(path.join(root, "dist", entry.name), "utf8");
    await writeFile(path.join(destination, "dist", entry.name),
      source.replace(/^\/\/# sourceMappingURL=.*\r?\n?/gmu, ""));
  }
  for (const directory of ["schemas", "templates"]) {
    await cp(path.join(root, directory), path.join(destination, directory), { recursive: true });
  }
  await cp(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
  await writeFile(path.join(destination, "README.md"), [
    "# Agent Merge Broker — Core",
    "",
    "The CLI, Gate, and library distribution of Agent Merge Broker, without MCP support.",
    "For the MCP server, choose `agent-merge-broker` instead. Both packages own the `amb` and",
    "`merge-broker` commands; install only one variant in any project or global npm prefix.",
    "",
    `\`npm install --global ${metadata.name}@${metadata.version}\``,
    "",
    "Then run `merge-broker init` in a repository. A local development dependency is also supported",
    "when you need project-specific versions. Runtime state stays in Git's common directory;",
    "repository policy, agent instructions, and Coordinate provenance remain repository files.",
    "",
    "Library imports use `agent-merge-broker-core`. The core exposes the full broker API except",
    "`createMcpServer`, `mcpToolNames`, and `McpProfile`; it does not provide `merge-broker-mcp`.",
    "",
    "[Documentation and examples](https://github.com/WeSpitfire/agent-merge-broker#readme)",
    "",
  ].join("\n"));
  await writeFile(path.join(destination, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

/** Cheap release guard: count the actual tarball inventory, not the development checkout. */
export function assertPackageFootprint(packed) {
  assert.ok(["agent-merge-broker", CORE_PACKAGE_NAME].includes(packed.name));
  assert.ok(packed.unpackedSize <= 1_300_000, `Unpacked package exceeds 1.3 MB: ${packed.unpackedSize}`);
  assert.ok(packed.size <= 300_000, `Download exceeds 300 KB: ${packed.size}`);
  assert.ok(packed.files.length <= 140, `Package has too many files: ${packed.files.length}`);
  for (const { path: filename } of packed.files) {
    assert.ok(!filename.endsWith(".map") && !filename.includes(".test.") &&
      !/^(?:docs|examples|src|dist\/test-support)\//u.test(filename), `Development-only file shipped: ${filename}`);
    if (packed.name === CORE_PACKAGE_NAME) {
      assert.ok(!/^dist\/(?:index|mcp|mcp-cli)\./u.test(filename), `MCP/full entry point shipped in core: ${filename}`);
    }
  }
  return `${packed.name}: ${packed.size} B download, ${packed.unpackedSize} B unpacked, ${packed.files.length} files`;
}
