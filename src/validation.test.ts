import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runValidators } from "./validation.js";

test("gives every validator an isolated cache directory and removes it afterward", async () => {
  const [result] = await runValidators({
    validators: [{
      name: "cache",
      command: `node -p "process.env.MERGE_BROKER_CACHE_DIR + '|' + process.argv[1]" {validatorCacheDir}`,
    }],
    scope: "authoritative",
    cwd: process.cwd(),
    files: [],
    baseSha: "base",
    headSha: "head",
    batchId: "batch",
  });
  const [cacheDirectory = "", validatorCacheDirectory = ""] = (result?.stdout.trim() ?? "").split("|");
  assert.ok(cacheDirectory.includes("agent-merge-broker-validator-"));
  assert.ok(validatorCacheDirectory.startsWith(cacheDirectory));
  await assert.rejects(access(cacheDirectory));
});

test("runs validators from a repository-relative working directory", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-validation-"));
  const nested = path.join(root, "apps", "api");
  await mkdir(nested, { recursive: true });
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const [result] = await runValidators({
    validators: [{
      name: "nested",
      command: "node -p \"process.cwd() + '|' + process.env.MERGE_BROKER_FILES\"",
      workingDirectory: "apps/api",
    }],
    scope: "authoritative",
    cwd: root,
    files: ["apps/api/index.ts"],
    baseSha: "base",
    headSha: "head",
    batchId: "batch",
  });
  assert.match(result?.stdout.trim() ?? "", /[/\\]apps[/\\]api\|index\.ts$/u);
});
