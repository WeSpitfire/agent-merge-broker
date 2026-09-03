import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { runValidators } from "./validation.js";

test("gives every validator an isolated cache directory and removes it afterward", async () => {
  const [result] = await runValidators({
    validators: [{
      name: "cache",
      command: `node -e "process.stdout.write(process.env.MERGE_BROKER_CACHE_DIR || '')"`,
    }],
    scope: "authoritative",
    cwd: process.cwd(),
    files: [],
    baseSha: "base",
    headSha: "head",
    batchId: "batch",
  });
  assert.ok(result?.stdout.includes("agent-merge-broker-validator-"));
  await assert.rejects(access(result?.stdout ?? ""));
});
