import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createValidationCacheDirectory,
  removeValidationCacheDirectory,
  runValidators,
} from "./validation.js";

test("validator cache cleanup refuses a different directory moved into its path", async (context) => {
  const cache = await createValidationCacheDirectory();
  const moved = `${cache}-moved`;
  const victim = await mkdtemp(path.join(tmpdir(), "merge-broker-validation-cache-victim-"));
  const victimRestored = `${victim}-restored`;
  context.after(async () => {
    await rm(cache, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
    await rm(victim, { recursive: true, force: true });
    await rm(victimRestored, { recursive: true, force: true });
  });
  await writeFile(path.join(victim, "keep.txt"), "do not delete\n", "utf8");
  await rename(cache, moved);
  await rename(victim, cache);

  await assert.rejects(removeValidationCacheDirectory(cache), /root identity changed/iu);
  assert.equal(await readFile(path.join(cache, "keep.txt"), "utf8"), "do not delete\n");

  await rename(cache, victimRestored);
  await rename(moved, cache);
  await removeValidationCacheDirectory(cache);
});

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

test("passes large validator path sets through a bounded JSON file", async () => {
  const files = Array.from(
    { length: 30_000 },
    (_, index) => `packages/component-${String(index).padStart(5, "0")}/source-file.ts`,
  );
  const [result] = await runValidators({
    validators: [{
      name: "large path input",
      filesInput: "json",
      command: [
        "node --input-type=commonjs -e",
        '"const fs=require(\'node:fs\');',
        "const paths=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'));",
        "process.stdout.write(paths.length+\'|\'+process.env.MERGE_BROKER_FILES.length+\'|\'+process.env.MERGE_BROKER_FILES_FILE_FORMAT+\'|\'+String(process.argv[1]===process.env.MERGE_BROKER_FILES_FILE))\"",
        "{filesFile}",
      ].join(" "),
    }],
    scope: "authoritative",
    cwd: process.cwd(),
    files,
    baseSha: "base",
    headSha: "head",
    batchId: "batch",
  });
  assert.equal(result?.stdout, "30000|0|json|true");
});

test("fails closed when compatibility-inline validator input exceeds portable limits", async () => {
  await assert.rejects(
    runValidators({
      validators: [{ name: "legacy inline", command: "test -e {files}" }],
      scope: "authoritative",
      cwd: process.cwd(),
      files: Array.from({ length: 500 }, (_, index) => `long/path/${index}/candidate-file.ts`),
      baseSha: "base",
      headSha: "head",
      batchId: "batch",
    }),
    /Set filesInput to json/u,
  );
});

test("does not silently empty oversized path input for legacy environment consumers", async () => {
  await assert.rejects(
    runValidators({
      validators: [{
        name: "legacy environment",
        command: 'node -e "process.exit(process.env.MERGE_BROKER_FILES ? 7 : 0)"',
      }],
      scope: "authoritative",
      cwd: process.cwd(),
      files: Array.from({ length: 500 }, (_, index) => `long/path/${index}/candidate-file.ts`),
      baseSha: "base",
      headSha: "head",
      batchId: "batch",
    }),
    /Set filesInput to json/u,
  );
});

test(
  "refuses a validator cache redirected between stages instead of writing outside it",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "merge-broker-validation-cache-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "merge-broker-validation-cache-outside-"));
    context.after(async () => {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
    const redirect = [
      "node --input-type=commonjs -e",
      JSON.stringify(
        "const fs=require('node:fs');const path=require('node:path');" +
        `const target=${JSON.stringify(outside)};` +
        "const directory=path.dirname(process.env.MERGE_BROKER_FILES_FILE);" +
        "fs.rmSync(directory,{recursive:true,force:true});fs.symlinkSync(target,directory,'dir')",
      ),
    ].join(" ");

    await assert.rejects(
      runValidators({
        validators: [
          { name: "shared cache", command: redirect },
          { name: "shared cache", command: "node --input-type=commonjs -e \"process.exit(0)\"" },
        ],
        scope: "authoritative",
        cwd,
        files: ["candidate.txt"],
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        batchId: "cache-redirect",
      }),
      /redirected the isolated validation cache/iu,
    );
    assert.deepEqual(await readdir(outside), []);
  },
);

test("Gate validators cannot inherit or configure Git repository-selection overrides", async () => {
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = "/tmp/ambient-alternate-index";
  try {
    const [result] = await runValidators({
      validators: [{
        name: "clean Gate environment",
        command: "node --input-type=commonjs -e \"process.stdout.write(process.env.GIT_INDEX_FILE ?? '')\"",
      }],
      scope: "authoritative",
      cwd: process.cwd(),
      files: [],
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      batchId: "submission:environment",
      submissionId: "environment",
    });
    assert.equal(result?.stdout, "");
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }

  await assert.rejects(
    runValidators({
      validators: [{
        name: "configured transport override",
        command: "node --input-type=commonjs -e \"process.exit(0)\"",
        env: { Git_Ssh_Command: "attacker-ssh" },
      }],
      scope: "authoritative",
      cwd: process.cwd(),
      files: [],
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      batchId: "submission:environment",
      submissionId: "environment",
    }),
    /Git execution, repository, and transport selection are broker authority/iu,
  );
});

test("validator environments cannot restore broker credentials with alternate casing", async () => {
  const script = [
    "const denied=new Set(['MERGE_BROKER_TOKEN','MERGE_BROKER_SIGNING_KEY','MERGE_BROKER_SIGNING_KEY_FILE']);",
    "process.stdout.write(Object.keys(process.env).filter((key)=>denied.has(key.toUpperCase())).join(','))",
  ].join("");
  const [result] = await runValidators({
    validators: [{
      name: "credential boundary",
      command: `node --input-type=commonjs -e ${JSON.stringify(script)}`,
      env: {
        merge_broker_token: "not-a-real-token",
        Merge_Broker_Signing_Key: "not-a-real-key",
        MERGE_BROKER_SIGNING_KEY_FILE: "/not/a/real/key",
      },
    }],
    scope: "authoritative",
    cwd: process.cwd(),
    files: [],
    baseSha: "base",
    headSha: "head",
    batchId: "batch",
  });
  assert.equal(result?.stdout, "");
});
