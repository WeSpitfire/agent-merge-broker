import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  applyBootstrapPlan,
  detectBootstrapPlan,
  hasAgentContract,
  installAgentContract,
} from "./bootstrap.js";
import { defaultConfig } from "./config.js";

async function fixture(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-bootstrap-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("detects a declared package manager and repository verify script deterministically", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.1.0",
    scripts: { lint: "eslint .", test: "node --test", verify: "pnpm lint && pnpm test" },
  }), "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const first = await detectBootstrapPlan(root);
  const second = await detectBootstrapPlan(root);
  assert.deepEqual(second, first);
  assert.deepEqual(first.ecosystems, ["pnpm:workspace"]);
  assert.deepEqual(first.authoritative.map((item) => item.command), ["pnpm run verify"]);
  assert.deepEqual(first.focused.map((item) => item.command), ["pnpm run lint"]);
  assert.deepEqual(first.serializedPatterns, ["pnpm-lock.yaml"]);
  assert.deepEqual(first.unresolved, []);
});

test("treats a root verify script as the complete monorepo gate without duplicating package suites", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.1.0",
    scripts: { verify: "pnpm -r verify" },
  }), "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "web", "package.json"), JSON.stringify({
    scripts: { lint: "eslint .", test: "node --test" },
  }), "utf8");

  const plan = await detectBootstrapPlan(root);
  assert.deepEqual(plan.authoritative.map((item) => item.command), ["pnpm run verify"]);
  assert.deepEqual(plan.focused.map((item) => item.command), ["pnpm run lint"]);
  assert.equal(plan.focused[0]?.workingDirectory, "apps/web");
  assert.deepEqual(plan.focused[0]?.paths, ["apps/web/**"]);
});

test("detects declared Go, Rust, and Python validation without inventing project policy", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, "services", "api"), { recursive: true });
  await mkdir(path.join(root, "crates", "worker"), { recursive: true });
  await mkdir(path.join(root, "python"), { recursive: true });
  await writeFile(path.join(root, "services", "api", "go.mod"), "module example.invalid/api\n", "utf8");
  await writeFile(path.join(root, "services", "api", "go.sum"), "", "utf8");
  await writeFile(path.join(root, "crates", "worker", "Cargo.toml"), "[package]\nname='worker'\nversion='0.1.0'\n", "utf8");
  await writeFile(path.join(root, "crates", "worker", "Cargo.lock"), "", "utf8");
  await writeFile(path.join(root, "python", "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.ruff]\n", "utf8");
  await writeFile(path.join(root, "python", "uv.lock"), "", "utf8");

  const plan = await detectBootstrapPlan(root);
  assert.deepEqual(plan.ecosystems, ["go:services/api", "python:python", "rust:crates/worker"]);
  assert.deepEqual(
    plan.authoritative.map((item) => [item.command, item.workingDirectory]),
    [
      ["go test ./...", "services/api"],
      ["cargo test --workspace", "crates/worker"],
      ["uv run pytest", "python"],
      ["uv run ruff check .", "python"],
    ],
  );
  assert.deepEqual(plan.serializedPatterns, [
    "crates/worker/Cargo.lock",
    "python/uv.lock",
    "services/api/go.sum",
  ]);
  assert.deepEqual(plan.unresolved, []);
});

test("isolates Swift builds and reports Xcode details it cannot safely infer", async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, "Desktop", "Example.xcodeproj"), { recursive: true });
  await writeFile(path.join(root, "Desktop", "Package.swift"), "// swift-tools-version: 6.0\n", "utf8");
  await writeFile(path.join(root, "Desktop", "Package.resolved"), "{}\n", "utf8");
  await writeFile(path.join(root, "Desktop", "Example.xcodeproj", "project.pbxproj"), "// fixture\n", "utf8");

  const plan = await detectBootstrapPlan(root);
  assert.deepEqual(plan.ecosystems, ["swift:Desktop"]);
  assert.equal(plan.focused[0]?.executionArchitecture, "native");
  assert.equal(plan.authoritative[0]?.executionArchitecture, "native");
  assert.equal(plan.authoritative[0]?.command, "swift test --scratch-path {validatorCacheDir}");
  assert.deepEqual(plan.serializedPatterns, ["Desktop/Package.resolved"]);
  assert.equal(plan.unresolved.length, 1);
  assert.match(plan.unresolved[0] ?? "", /no destination or scheme was inferred/u);
});

test("applies a detected plan only to an empty broker-owned policy", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  const plan = await detectBootstrapPlan(root);
  const config = defaultConfig();

  assert.equal(applyBootstrapPlan(config, plan), true);
  const snapshot = JSON.stringify(config);
  assert.equal(applyBootstrapPlan(config, plan), false);
  assert.equal(JSON.stringify(config), snapshot);

  config.validation.authoritative = [{ name: "owner policy", command: "./validate" }];
  assert.equal(applyBootstrapPlan(config, { ...plan, authoritative: [{ name: "replacement", command: "false" }] }), false);
  assert.equal(config.validation.authoritative[0]?.name, "owner policy");
});

test("installs an idempotent managed agent contract without replacing owner instructions", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "AGENTS.md"), "# Owner instructions\n\nKeep this text.\n", "utf8");

  assert.equal((await installAgentContract(root)).changed, true);
  const first = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(first, /# Owner instructions/u);
  assert.match(first, /\.merge-broker\/agent-instructions\.md/u);
  assert.equal(await hasAgentContract(root), true);
  assert.equal((await installAgentContract(root)).changed, false);
  assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), first);
});

test("refuses to guess how to repair a partially edited managed contract", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, "AGENTS.md"), "<!-- agent-merge-broker:start -->\nowner edit\n", "utf8");
  await assert.rejects(installAgentContract(root), /managed Merge Broker block.*incomplete/u);
});
