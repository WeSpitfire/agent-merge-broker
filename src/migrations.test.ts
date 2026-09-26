import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MergeBroker } from "./broker.js";
import { configPath } from "./config.js";
import { BrokerError } from "./errors.js";
import { applySavedFormatMigrations, inspectSavedFormats, MIGRATIONS } from "./migrations.js";
import { runCommand } from "./process.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function repository(context: TestContext): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-migrate-"));
  context.after(async () => await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  return repo;
}

/** Integrate, merge, and prune one task so the repository has an archived state slice. */
async function withArchivedSlice(repo: string): Promise<{ broker: MergeBroker; slicePath: string }> {
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({ id: "LEGACY", holder: "agent", expectedPaths: ["src/legacy.ts"] });
  await git(repo, "switch", "-c", "agent/legacy", "main");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "legacy.ts"), "export const legacy = true;\n", "utf8");
  await git(repo, "add", "src/legacy.ts");
  await git(repo, "commit", "-m", "legacy");
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  await broker.submitTask("LEGACY", [commit], claim.token);
  const integrated = await broker.integrate();
  await broker.markBatchMerged(integrated.batch.id);
  const pruned = await broker.prune({ olderThanDays: 0 });
  assert.ok(pruned.archivePath);
  return { broker, slicePath: pruned.archivePath };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("migration identifiers are unique and name a saved format", () => {
  assert.equal(new Set(MIGRATIONS.map((migration) => migration.id)).size, MIGRATIONS.length);
});

test("a repository written by this release needs no migration", async (context) => {
  const repo = await repository(context);
  await (await MergeBroker.open(repo)).claimTask({ id: "CURRENT", holder: "agent", expectedPaths: ["src/**"] });
  const report = await MergeBroker.migrate(repo);
  assert.equal(report.applied, false);
  assert.equal(report.pending, 0);
  assert.equal(report.blocked, 0);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.findings.map((finding) => [finding.format, finding.status]),
    [["config", "current"], ["state", "current"]],
  );
});

test("preview does not create runtime state", async (context) => {
  const repo = await repository(context);
  const stateDirectory = path.join(await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "merge-broker");
  await rm(stateDirectory, { recursive: true, force: true });
  const report = await MergeBroker.migrate(repo);
  assert.deepEqual(report.findings.map((finding) => finding.format), ["config"]);
  await assert.rejects(access(stateDirectory));
});

test("apply upgrades legacy state and archive slices after backing up their original bytes", async (context) => {
  const repo = await repository(context);
  const { broker, slicePath } = await withArchivedSlice(repo);
  const statePath = path.join(broker.store.directory, "state.json");

  const legacyState = await readJson(statePath);
  delete legacyState.submissions;
  await writeJson(statePath, legacyState);
  const legacySlice = await readJson(slicePath);
  delete legacySlice.version;
  await writeJson(slicePath, legacySlice);
  const originalState = await readFile(statePath, "utf8");
  const originalSlice = await readFile(slicePath, "utf8");

  const preview = await MergeBroker.migrate(repo);
  assert.equal(preview.pending, 2);
  assert.equal(preview.blocked, 0);
  assert.deepEqual(
    preview.findings.filter((finding) => finding.status === "upgradable").map((finding) => finding.migration).sort(),
    ["archived-state-record-version-1", "state-v1-add-submissions"],
  );
  assert.equal(await readFile(statePath, "utf8"), originalState, "preview must not write");

  const applied = await MergeBroker.migrate(repo, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.migrated, 2);
  assert.ok(applied.backupDirectory);
  const commonGitDirectory = broker.store.commonGitDirectory;
  assert.equal(
    await readFile(path.join(applied.backupDirectory, path.relative(commonGitDirectory, statePath)), "utf8"),
    originalState,
  );
  assert.equal(
    await readFile(path.join(applied.backupDirectory, path.relative(commonGitDirectory, slicePath)), "utf8"),
    originalSlice,
  );
  assert.deepEqual((await readJson(statePath)).submissions, {});
  assert.equal((await readJson(slicePath)).version, 1);

  const after = await MergeBroker.migrate(repo);
  assert.equal(after.pending, 0);
  assert.equal(after.blocked, 0);
  const events = await (await MergeBroker.open(repo)).store.readAudit(1_000);
  const migrated = events.find((event) => event.event === "formats.migrated");
  assert.equal(migrated?.details?.migrated, 2);
});

test("the frozen v0.12.1 release-source fixture upgrades with original bytes and task history preserved", async (context) => {
  // This path works from source tests and compiled tests; fixtures are not part of published packages.
  const fixture = new URL("../src/test-support/fixtures/migrations/v0.12.1/", import.meta.url);
  const origin = JSON.parse(await readFile(new URL("origin.json", fixture), "utf8")) as {
    version: string; commit: string; filesSha256: Record<string, string>;
  };
  assert.equal(origin.version, "0.12.1");
  assert.equal(origin.commit, "3b51f22b844fab42ba8190768fac4cdeede162bb");
  const originals: Record<string, string> = {};
  for (const [name, digest] of Object.entries(origin.filesSha256)) {
    const bytes = await readFile(new URL(name, fixture), "utf8");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
    originals[name] = bytes;
  }
  const repo = await repository(context);
  const broker = await MergeBroker.open(repo);
  const statePath = path.join(broker.store.directory, "state.json");
  const archivePath = path.join(broker.store.archiveDirectory, "state-v0.12.1.json");
  await writeFile(configPath(repo), originals["config.json"]!);
  await writeFile(statePath, originals["state.json"]!);
  await writeFile(archivePath, originals["archived-state.json"]!);
  const preview = await MergeBroker.migrate(repo);
  assert.equal(preview.complete, true);
  assert.equal(preview.blocked, 0);
  assert.equal(preview.pending, 2);

  const applied = await MergeBroker.migrate(repo, { apply: true });
  assert.equal(applied.migrated, 2);
  assert.ok(applied.backupDirectory);
  for (const [target, name] of [[statePath, "state.json"], [archivePath, "archived-state.json"]] as const) {
    const backup = path.join(applied.backupDirectory, path.relative(broker.store.commonGitDirectory, target));
    assert.equal(await readFile(backup, "utf8"), originals[name]);
  }
  assert.equal(await readFile(configPath(repo), "utf8"), originals["config.json"]);
  const reopened = await MergeBroker.open(repo);
  const activeBefore = (JSON.parse(originals["state.json"]!) as { tasks: Record<string, unknown> }).tasks;
  assert.deepEqual((await reopened.state()).tasks, activeBefore);
  const archivedBefore = JSON.parse(originals["archived-state.json"]!) as Record<string, unknown>;
  assert.deepEqual(await reopened.store.readArchivedState(), [{ version: 1, ...archivedBefore }]);
  await reopened.registerTask({ id: "AFTER-UPGRADE", expectedPaths: ["src/after.ts"] });
  assert.equal((await reopened.task("AFTER-UPGRADE")).status, "registered");
  assert.deepEqual((await reopened.state()).tasks["HISTORICAL-ACTIVE"], activeBefore["HISTORICAL-ACTIVE"]);
  assert.equal((await MergeBroker.migrate(repo)).pending, 0);
});

test("apply refuses, and writes nothing, when a file comes from a newer release or is unreadable", async (context) => {
  const repo = await repository(context);
  const { broker, slicePath } = await withArchivedSlice(repo);
  const statePath = path.join(broker.store.directory, "state.json");
  const legacySlice = await readJson(slicePath);
  delete legacySlice.version;
  await writeJson(slicePath, legacySlice);
  const futureState = { ...(await readJson(statePath)), version: 2 };
  await writeJson(statePath, futureState);

  const preview = await MergeBroker.migrate(repo);
  assert.equal(preview.pending, 1);
  assert.equal(preview.blocked, 1);
  const state = preview.findings.find((finding) => finding.format === "state");
  assert.equal(state?.status, "unsupported");
  assert.equal(state?.version, 2);

  const sliceBefore = await readFile(slicePath, "utf8");
  await assert.rejects(
    MergeBroker.migrate(repo, { apply: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "MIGRATION_BLOCKED",
  );
  assert.equal(await readFile(slicePath, "utf8"), sliceBefore);
  await assert.rejects(access(path.join(broker.store.archiveDirectory, "migrations")));

  await writeJson(statePath, { ...futureState, version: 1 });
  const submissions = broker.store.submissionsDirectory;
  await mkdir(submissions, { recursive: true });
  await writeFile(path.join(submissions, "broken.json"), "{ not json\n", "utf8");
  const corrupt = await MergeBroker.migrate(repo);
  const broken = corrupt.findings.find((finding) => finding.path.endsWith("broken.json"));
  assert.equal(broken?.status, "unreadable");
  await assert.rejects(
    MergeBroker.migrate(repo, { apply: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "MIGRATION_BLOCKED",
  );
});

test("configuration from a newer release is reported and blocks apply", async (context) => {
  const repo = await repository(context);
  const config = await readJson(configPath(repo));
  await writeJson(configPath(repo), { ...config, version: 2 });
  const report = await MergeBroker.migrate(repo);
  assert.deepEqual(report.findings.map((finding) => [finding.format, finding.status, finding.version]), [["config", "unsupported", 2]]);
  assert.equal(report.blocked, 1);
  await assert.rejects(
    MergeBroker.migrate(repo, { apply: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "MIGRATION_BLOCKED",
  );
});

test("an incomplete preflight blocks apply even when the inspected prefix has no pending migrations", async (context) => {
  const repo = await repository(context);
  const broker = await MergeBroker.open(repo);
  const statePath = path.join(broker.store.directory, "state.json");
  const unseen = path.join(broker.store.receiptsDirectory, "future.json");
  await writeJson(unseen, { version: 2, taskId: "FUTURE" });
  const unseenBytes = await readFile(unseen, "utf8");
  const lock = context.mock.method(broker.store, "withStorageLock");
  // State and the optional authority path exhaust this budget before receipts are inspected.
  const locations = { repositoryRoot: repo, store: broker.store, maxScannedFiles: 2 };
  for (const pending of [false, true]) {
    if (pending) {
      const legacy = await readJson(statePath);
      delete legacy.submissions;
      await writeJson(statePath, legacy);
    }
    const stateBytes = await readFile(statePath, "utf8");
    const preview = await inspectSavedFormats(locations);
    assert.equal(preview.complete, false);
    assert.equal(preview.blocked, 0, "the incompatible receipt lies beyond the scan budget");
    assert.equal(preview.pending, pending ? 1 : 0);
    await assert.rejects(
      applySavedFormatMigrations(locations),
      (error: unknown) => error instanceof BrokerError && error.code === "MIGRATION_BLOCKED" && /scan limit/u.test(error.message),
    );
    assert.equal(await readFile(statePath, "utf8"), stateBytes);
    assert.equal(await readFile(unseen, "utf8"), unseenBytes);
    await assert.rejects(access(path.join(broker.store.archiveDirectory, "migrations")));
  }
  assert.equal(lock.mock.callCount(), 0, "an incomplete initial scan must not enter the write phase");
});

test("an incomplete locked rescan blocks migration when files appear after preflight", async (context) => {
  const repo = await repository(context);
  const broker = await MergeBroker.open(repo);
  const statePath = path.join(broker.store.directory, "state.json");
  const legacy = await readJson(statePath);
  delete legacy.submissions;
  await writeJson(statePath, legacy);
  const stateBytes = await readFile(statePath, "utf8");
  const locations = { repositoryRoot: repo, store: broker.store, maxScannedFiles: 2 };
  const preview = await inspectSavedFormats(locations);
  assert.equal(preview.complete, true);
  assert.equal(preview.pending, 1);

  const unseen = path.join(broker.store.receiptsDirectory, "future.json");
  const withStorageLock = broker.store.withStorageLock.bind(broker.store);
  const lock = context.mock.method(broker.store, "withStorageLock", async <T>(operation: (ownerNonce: string) => Promise<T> | T): Promise<T> => {
    return await withStorageLock(async (ownerNonce) => {
      await writeJson(unseen, { version: 2, taskId: "FUTURE" });
      return await operation(ownerNonce);
    });
  });
  await assert.rejects(
    applySavedFormatMigrations(locations),
    (error: unknown) => error instanceof BrokerError && error.code === "MIGRATION_BLOCKED" && /scan limit/u.test(error.message),
  );
  assert.equal(lock.mock.callCount(), 1);
  assert.equal(await readFile(statePath, "utf8"), stateBytes);
  assert.deepEqual(await readJson(unseen), { version: 2, taskId: "FUTURE" });
  await assert.rejects(access(path.join(broker.store.archiveDirectory, "migrations")));
});

test("an incomplete clean migrate preview exits 1 in JSON and human modes without claiming compatibility", async (context) => {
  const sourceTest = fileURLToPath(import.meta.url).endsWith(".ts");
  const extension = sourceTest ? "ts" : "js";
  const cli = new URL(`./cli.${extension}`, import.meta.url);
  const broker = new URL(`./broker.${extension}`, import.meta.url);
  const report = { applied: false, findings: [], pending: 0, blocked: 0, migrated: 0, complete: false };
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-migrate-cli-"));
  context.after(async () => await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const preload = path.join(directory, "incomplete-report.mjs");
  await writeFile(preload, [
    `import { MergeBroker } from ${JSON.stringify(broker.href)};`,
    `MergeBroker.migrate = async () => (${JSON.stringify(report)});`,
  ].join("\n"));
  for (const json of [false, true]) {
    const result = await runCommand(process.execPath, [
      ...(sourceTest ? ["--import", "tsx"] : []), "--import", pathToFileURL(preload).href,
      fileURLToPath(cli), ...(json ? ["--json"] : []), "migrate",
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), allowFailure: true });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stderr, "");
    if (json) assert.deepEqual(JSON.parse(result.stdout), report);
    else {
      assert.match(result.stdout, /inspection is incomplete/u);
      assert.doesNotMatch(result.stdout, /All saved formats are current|Run migrate --apply/u);
    }
  }
});

test("the migrate command exits 1 while migrations are pending and 3 when apply is blocked", async (context) => {
  const repo = await repository(context);
  const { broker, slicePath } = await withArchivedSlice(repo);
  const legacySlice = await readJson(slicePath);
  delete legacySlice.version;
  await writeJson(slicePath, legacySlice);
  const sourceTest = fileURLToPath(import.meta.url).endsWith(".ts");
  const cli = fileURLToPath(new URL(sourceTest ? "./cli.ts" : "./cli.js", import.meta.url));
  const run = async (...args: string[]) => await runCommand(
    process.execPath,
    [...(sourceTest ? ["--import", "tsx"] : []), cli, "--cwd", repo, "--json", "migrate", ...args],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), allowFailure: true },
  );

  const pending = await run();
  assert.equal(pending.exitCode, 1, pending.stderr);
  assert.equal((JSON.parse(pending.stdout) as { pending: number }).pending, 1);
  const applied = await run("--apply");
  assert.equal(applied.exitCode, 0, applied.stderr);
  const current = await run();
  assert.equal(current.exitCode, 0, current.stderr);

  const statePath = path.join(broker.store.directory, "state.json");
  await writeJson(statePath, { ...(await readJson(statePath)), version: 2 });
  const blocked = await run("--apply");
  assert.equal(blocked.exitCode, 3, blocked.stderr);
  assert.equal((JSON.parse(blocked.stderr) as { error: { code: string } }).error.code, "MIGRATION_BLOCKED");
  assert.ok((await readdir(broker.store.archiveDirectory)).includes("migrations"));
});
