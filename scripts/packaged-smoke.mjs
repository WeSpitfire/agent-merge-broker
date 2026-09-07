import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const npm = process.env.npm_execpath;
assert.ok(npm && path.isAbsolute(npm), "Run this smoke test with npm run test:package.");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--pack-destination"),
  "Usage: npm run test:package -- [--pack-destination directory]");
const scratch = await mkdtemp(path.join(tmpdir(), "merge-broker-package-"));
const consumer = path.join(scratch, "consumer with spaces");
const packDestination = args[1] ? path.resolve(args[1]) : path.join(scratch, "package");

async function run(executable, commandArgs, cwd = consumer) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_PATH: "" },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(executable)} ${commandArgs.join(" ")} failed (${code ?? signal})\n${stdout}\n${stderr}`));
    });
  });
}

async function runNpm(commandArgs, cwd = consumer) {
  // npm.cmd cannot be spawned directly on Windows without a shell. Use npm's actual JS entrypoint.
  return await run(process.execPath, [npm, ...commandArgs], cwd);
}

async function mcpSmoke(installedRoot, fixture) {
  const child = spawn(process.execPath, [path.join(installedRoot, "dist/mcp-cli.js"), "-C", fixture], {
    cwd: consumer,
    stdio: "pipe",
    windowsHide: true,
    env: { ...process.env, NODE_PATH: "" },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let processError;
  let closed = false;
  const exited = new Promise((resolve) => child.once("close", () => { closed = true; resolve(); }));
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    processError = error;
    for (const handler of pending.values()) handler.reject(error);
  });
  child.stdin.on("error", (error) => {
    for (const handler of pending.values()) handler.reject(error);
  });
  child.on("close", () => {
    for (const handler of pending.values()) handler.reject(new Error(`MCP exited before replying: ${stderr}`));
  });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const handler = pending.get(message.id);
      if (handler) handler.resolve(message);
    } catch (error) {
      for (const handler of pending.values()) handler.reject(error);
    }
  });
  const request = async (id, method, params = {}) => {
    if (processError) throw processError;
    if (closed) throw new Error(`MCP exited: ${stderr}`);
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 15_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    } finally {
      pending.delete(id);
    }
  };
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "installed-package-smoke", version: "1" },
    });
    assert.equal(initialized.result?.serverInfo?.version, metadata.version);
    assert.ok(initialized.result?.capabilities?.tools, "Installed MCP server must advertise tools.");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request(2, "tools/list");
    assert.ok(listed.result?.tools.some((tool) => tool.name === "broker_status"));
  } finally {
    lines.close();
    child.stdin.end();
    if (!closed) child.kill("SIGTERM");
    const killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 5_000);
    await exited;
    clearTimeout(killTimer);
  }
}

try {
  await mkdir(consumer);
  await mkdir(packDestination, { recursive: true });
  assert.deepEqual(await readdir(packDestination), [], "Pack destination must be empty; existing artifacts are never overwritten.");
  const [packed] = JSON.parse(await runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDestination], root));
  assert.equal(packed.name, metadata.name);
  assert.equal(packed.version, metadata.version);
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/index.js", "dist/index.d.ts", "dist/cli.js", "dist/mcp-cli.js",
    "schemas/config.schema.json", "schemas/submission.schema.json", "schemas/identities.json",
    "schemas/submission-attestation-envelope.schema.json", "schemas/submission-attestation-statement.schema.json",
    "templates/AGENTS.snippet.md", "examples/local-gate/run.mjs", "examples/local-gate/README.md",
  ]) {
    assert.ok(files.has(required), `Missing packaged asset: ${required}`);
  }
  for (const file of files) {
    assert.ok(!file.includes(".test.") && !file.startsWith("dist/test-support/"), `Test code must not ship: ${file}`);
  }
  const tarball = path.join(packDestination, packed.filename);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    name: "merge-broker-installed-consumer",
    private: true,
    type: "module",
    scripts: {
      "smoke:amb": "amb --version",
      "smoke:merge-broker": "merge-broker --version",
      "smoke:merge-broker-mcp": "merge-broker-mcp --version",
      "smoke:init": "amb -C fixture init --no-detect",
      "smoke:types": "tsc --noEmit -p tsconfig.json",
    },
    devDependencies: {
      typescript: lock.packages["node_modules/typescript"].version,
      "@types/node": lock.packages["node_modules/@types/node"].version,
    },
  }, null, 2));
  // First install only the public package and runtime dependencies: source/dev modules must not
  // accidentally satisfy its imports. A second install adds only the consumer's compiler/types.
  await runNpm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball]);
  const installedRoot = path.join(consumer, "node_modules", metadata.name);
  const installed = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installed.version, metadata.version);
  for (const alias of ["amb", "merge-broker", "merge-broker-mcp"]) {
    await access(path.join(consumer, "node_modules/.bin", `${alias}${process.platform === "win32" ? ".cmd" : ""}`));
    assert.equal((await runNpm(["run", "--silent", `smoke:${alias}`])).trim(), metadata.version);
  }
  await writeFile(path.join(consumer, "consumer.mjs"), [
    'import assert from "node:assert/strict";',
    'import { MergeBroker, defaultConfig, createMcpServer, verifySubmissionAttestation, schemaFingerprint } from "agent-merge-broker";',
    'assert.equal(typeof MergeBroker.open, "function");',
    'assert.equal(defaultConfig().baseBranch, "main");',
    'assert.equal(typeof createMcpServer, "function");',
    'assert.equal(typeof verifySubmissionAttestation, "function");',
    'assert.equal(typeof schemaFingerprint, "function");',
    "",
  ].join("\n"));
  await run(process.execPath, ["consumer.mjs"]);

  const fixture = path.join(consumer, "fixture");
  await mkdir(fixture);
  await run("git", ["init", "-b", "main"], fixture);
  await run("git", ["config", "user.name", "Package smoke"], fixture);
  await run("git", ["config", "user.email", "package-smoke@example.invalid"], fixture);
  await writeFile(path.join(fixture, "README.md"), "# Installed package consumer\n");
  await run("git", ["add", "README.md"], fixture);
  await run("git", ["-c", "commit.gpgSign=false", "commit", "-m", "initial"], fixture);
  await runNpm(["run", "--silent", "smoke:init"]);
  const config = JSON.parse(await readFile(path.join(fixture, ".merge-broker/config.json"), "utf8"));
  assert.equal(config.baseBranch, "main");
  assert.match(await readFile(path.join(fixture, ".merge-broker/agent-instructions.md"), "utf8"), /Merge Broker/u);
  assert.match(await readFile(path.join(fixture, "AGENTS.md"), "utf8"), /agent-merge-broker:start/u);
  await mcpSmoke(installedRoot, fixture);

  await runNpm(["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await writeFile(path.join(consumer, "consumer.ts"), [
    'import { MergeBroker, defaultConfig, createMcpServer, verifySubmissionAttestation, schemaFingerprint, type BrokerConfig, type SubmissionRecord } from "agent-merge-broker";',
    "const config: BrokerConfig = defaultConfig();",
    "const submission: SubmissionRecord | undefined = undefined;",
    "void [config, submission, MergeBroker.open, createMcpServer, verifySubmissionAttestation, schemaFingerprint];",
    "",
  ].join("\n"));
  await writeFile(path.join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: ["node"] },
    files: ["consumer.ts"],
  }));
  await runNpm(["run", "--silent", "smoke:types"]);
  const sourceRevision = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  await writeFile(path.join(packDestination, "package-integrity.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: metadata.name,
    version: metadata.version,
    sourceRevision,
    filename: packed.filename,
    sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
  }, null, 2)}\n`);
  await run(process.execPath, [path.join(root, "scripts/verify-release-artifact.mjs"), packDestination, sourceRevision, metadata.version], root);
  console.log(`Installed package smoke passed: ${metadata.name}@${metadata.version} (${process.platform}, Node ${process.versions.node}).`);
  if (args[1]) console.log(`Verified tarball: ${tarball}`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
