import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function createRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-test-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  assert.match(
    await readFile(path.join(repo, ".merge-broker", "agent-instructions.md"), "utf8"),
    /Agents do not merge, rebase, push/u,
  );
  return repo;
}

async function commitFile(repo: string, branch: string, file: string, contents: string): Promise<string> {
  await git(repo, "switch", "-c", branch, "main");
  const target = path.join(repo, file);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
  await writeFile(target, contents, "utf8");
  await git(repo, "add", file);
  await git(repo, "commit", "-m", `change ${file}`);
  const sha = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return sha;
}

test("claims, submits, verifies, and transactionally batches independent commits", async (context) => {
  const repo = await createRepository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const broker = await MergeBroker.open(repo);

  const claimA = await broker.claimTask({ id: "TASK-A", holder: "agent-a", expectedPaths: ["src/a/**"] });
  const commitA = await commitFile(repo, "agent-a", "src/a/feature.ts", "export const a = 1;\n");
  await broker.submitTask("TASK-A", [commitA], claimA.token);

  const claimB = await broker.claimTask({ id: "TASK-B", holder: "agent-b", expectedPaths: ["src/b/**"] });
  const commitB = await commitFile(repo, "agent-b", "src/b/feature.ts", "export const b = 2;\n");
  await broker.submitTask("TASK-B", [commitB], claimB.token);

  const plan = await broker.plan();
  assert.deepEqual(
    plan.selected.map((item) => item.id),
    ["TASK-A", "TASK-B"],
  );

  const verified = await broker.integrate({ dryRun: true });
  assert.equal(verified.batch.status, "verified");
  assert.equal((await broker.task("TASK-A")).status, "submitted");

  const integrated = await broker.integrate();
  assert.equal(integrated.batch.status, "prepared");
  assert.ok(integrated.batch.branchName);
  assert.ok(integrated.batch.provenancePath);
  assert.ok(integrated.batch.integratedHeadSha);
  assert.equal((await broker.task("TASK-A")).status, "batched");
  assert.equal(await git(repo, "show", `${integrated.batch.branchName}:src/a/feature.ts`), "export const a = 1;");
  assert.equal(await git(repo, "show", `${integrated.batch.branchName}:src/b/feature.ts`), "export const b = 2;");
  const provenance = JSON.parse(
    await git(repo, "show", `${integrated.batch.branchName}:${integrated.batch.provenancePath}`),
  ) as {
    batchId: string;
    integratedHeadSha: string;
    taskIds: string[];
  };
  assert.equal(provenance.batchId, integrated.batch.id);
  assert.equal(provenance.integratedHeadSha, await git(repo, "rev-parse", `${integrated.batch.branchName}^`));
  assert.deepEqual(provenance.taskIds, ["TASK-A", "TASK-B"]);

  await broker.markBatchMerged(integrated.batch.id);
  assert.equal((await broker.task("TASK-A")).status, "merged");
  assert.equal((await broker.task("TASK-B")).status, "merged");
  const audit = await broker.store.readAudit();
  assert.ok(audit.some((event) => event.event === "batch.prepared"));
  assert.ok(audit.some((event) => event.event === "batch.merged"));
});

test("attests the final net diff when a corrective commit cancels an earlier path", async (context) => {
  const repo = await createRepository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({
    id: "CORRECTED",
    holder: "agent",
    expectedPaths: ["src/corrected/**"],
  });

  await git(repo, "switch", "-c", "corrected", "main");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.join(repo, "src/corrected"), { recursive: true }),
  );
  await writeFile(path.join(repo, "src/corrected/retained.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repo, "src/corrected/transient.ts"), "remove me\n", "utf8");
  await git(repo, "add", "src/corrected");
  await git(repo, "commit", "-m", "initial implementation");
  const initial = await git(repo, "rev-parse", "HEAD");

  await rm(path.join(repo, "src/corrected/transient.ts"));
  await writeFile(path.join(repo, "src/corrected/retained.ts"), "export const value = 2;\n", "utf8");
  await git(repo, "add", "src/corrected");
  await git(repo, "commit", "-m", "correct implementation");
  const correction = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");

  await broker.submitTask("CORRECTED", [initial, correction], claim.token);
  const integrated = await broker.integrate();
  const provenance = JSON.parse(
    await git(repo, "show", `${integrated.batch.branchName}:${integrated.batch.provenancePath}`),
  ) as { tasks: Array<{ actualPaths: string[] }> };

  assert.deepEqual(provenance.tasks[0]?.actualPaths, ["src/corrected/retained.ts"]);
});

test("rejects overlapping active leases and out-of-scope receipts", async (context) => {
  const repo = await createRepository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const broker = await MergeBroker.open(repo);
  await assert.rejects(
    broker.claimTask({ id: "__proto__", holder: "unsafe", expectedPaths: ["src/**"] }),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_TASK",
  );
  const claim = await broker.claimTask({ id: "ONE", holder: "agent-one", expectedPaths: ["src/shared/**"] });
  const extended = await broker.extendTask("ONE", ["src/owned/**"], claim.token);
  assert.deepEqual(extended.expectedPaths, ["src/shared/**", "src/owned/**"]);
  await assert.rejects(
    broker.claimTask({ id: "TWO", holder: "agent-two", expectedPaths: ["src/shared/file.ts"] }),
    (error: unknown) => error instanceof BrokerError && error.code === "LEASE_CONFLICT",
  );
  await assert.rejects(
    broker.extendTask("ONE", ["src/shared/file.ts"], "wrong-token"),
    (error: unknown) => error instanceof BrokerError && error.code === "LEASE_TOKEN",
  );
  const commit = await commitFile(repo, "outside", "docs/outside.md", "outside\n");
  await assert.rejects(
    broker.submitTask("ONE", [commit, commit], claim.token),
    (error: unknown) => error instanceof BrokerError && error.code === "DUPLICATE_COMMIT",
  );
  await assert.rejects(
    broker.submitTask("ONE", [commit], claim.token),
    (error: unknown) => error instanceof BrokerError && error.code === "UNEXPECTED_PATHS",
  );
});

test("returns tasks to the queue when authoritative validation fails", async (context) => {
  const repo = await createRepository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const config = await loadConfig(repo);
  config.validation.authoritative.push({
    name: "reject marker",
    command: "test ! -f fail.txt",
    timeoutSeconds: 5,
  });
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({ id: "FAIL", holder: "agent", expectedPaths: ["fail.txt"] });
  const commit = await commitFile(repo, "failure", "fail.txt", "fail\n");
  await broker.submitTask("FAIL", [commit], claim.token);

  await assert.rejects(broker.integrate(), (error: unknown) => error instanceof BrokerError);
  assert.equal((await broker.task("FAIL")).status, "failed");
  const batches = Object.values((await broker.state()).batches);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.status, "failed");
  assert.match(batches[0]?.error ?? "", /reject marker/u);
  assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# Fixture\n");

  await broker.retryTask("FAIL", claim.token);
  assert.equal((await broker.task("FAIL")).status, "submitted");
});

test("publishes one integration branch and reconciles it after merge", async (context) => {
  const repo = await createRepository();
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-remote-"));
  const remote = path.join(remoteParent, "origin.git");
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(remoteParent, { recursive: true, force: true });
  });
  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");

  const config = await loadConfig(repo);
  config.publish.mode = "branch";
  config.baseRef = "origin/main";
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({ id: "PUBLISH", holder: "agent", expectedPaths: ["src/publish.ts"] });
  const commit = await commitFile(repo, "publish-task", "src/publish.ts", "export const published = true;\n");
  await broker.submitTask("PUBLISH", [commit], claim.token);
  const integrated = await broker.integrate();
  const published = await broker.publishBatch(integrated.batch.id);
  assert.equal(published.status, "published");
  assert.ok(published.branchName);
  assert.equal(
    await git(repo, "--git-dir", remote, "rev-parse", `refs/heads/${published.branchName}`),
    published.headSha,
  );

  await git(repo, "merge", "--ff-only", published.branchName ?? "");
  await git(repo, "push", "origin", "main");
  const reconciled = await broker.syncBatch(published.id);
  assert.equal(reconciled.status, "merged");
  assert.equal((await broker.task("PUBLISH")).status, "merged");
});

test("requeues tasks when a published batch closes without merging", async (context) => {
  const repo = await createRepository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({
    id: "CLOSED-PR",
    holder: "agent",
    expectedPaths: ["src/closed.ts"],
  });
  const commit = await commitFile(repo, "closed-pr", "src/closed.ts", "export const closed = true;\n");
  await broker.submitTask("CLOSED-PR", [commit], claim.token);
  const integrated = await broker.integrate();

  await broker.store.transaction((state) => {
    const batch = state.batches[integrated.batch.id];
    const task = state.tasks["CLOSED-PR"];
    assert.ok(batch);
    assert.ok(task);
    batch.status = "published";
    task.status = "published";
  });
  const closed = await broker.markBatchClosed(integrated.batch.id);

  assert.equal(closed.status, "failed");
  assert.match(closed.error ?? "", /closed without merge/u);
  assert.equal((await broker.task("CLOSED-PR")).status, "submitted");
});
