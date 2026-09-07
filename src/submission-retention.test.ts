import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { adoptedRef } from "./git.js";
import { runCommand } from "./process.js";
import type { SubmissionRecord } from "./types.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

/** Real local Git identities and retention refs with a completed, benign validation receipt. */
async function fixture(context: TestContext): Promise<{ broker: MergeBroker; record: SubmissionRecord; repo: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-retention-"));
  context.after(async () => { await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Retention Test");
  await git(repo, "config", "user.email", "retention@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Retention fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.validation.authoritative = [{ name: "check", command: "node --input-type=commonjs -e \"console.log('passed')\"" }];
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "protected policy");
  const base = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-c", "producer/candidate");
  await writeFile(path.join(repo, "candidate.txt"), "candidate preserved\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate change");
  const sha = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  const broker = await MergeBroker.open(repo);
  const id = "retention-one";
  await broker.repo.pinLocalRef(sha, id);
  const at = "2026-01-01T00:00:00.000Z";
  const record: SubmissionRecord = {
    version: 1, id, status: "validated", authorityDigest: "a".repeat(64),
    source: { kind: "local-ref", ref: "producer/candidate" },
    artifact: { kind: "git-commit", sha, treeSha: await git(repo, "rev-parse", `${sha}^{tree}`), retainedRef: adoptedRef(id) },
    base: { ref: "main", baseBranch: "main", remote: "origin", sha: base },
    policy: {
      baseSha: base, configPath: ".merge-broker/config.json",
      configBlobSha: await git(repo, "rev-parse", `${base}:.merge-broker/config.json`),
      digest: "b".repeat(64), revision: "default", evaluatorVersion: "agent-merge-broker/0.13.0", configVersion: 1,
    },
    commits: [sha], paths: ["candidate.txt"], retentionEstablishedAt: at,
    validations: [{ name: "check", command: "node --test", scope: "authoritative", startedAt: at,
      finishedAt: at, durationMs: 12, exitCode: 0, stdout: "passed\n", stderr: "" }],
    createdAt: at, updatedAt: at, validationStartedAt: at, finishedAt: at,
  };
  await broker.store.transaction((state) => { state.submissions[id] = structuredClone(record); });
  await broker.store.writeSubmissionManifest(record);
  return { broker, record, repo };
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof BrokerError && error.code === expected;
}

async function missingRef(repo: string, ref: string): Promise<void> {
  const result = await runCommand("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo, allowFailure: true });
  assert.equal(result.exitCode, 1);
}

function submissionMetrics(value: Record<string, unknown>): Record<string, unknown> {
  return value.submissions as Record<string, unknown>;
}

test("archive preview leaves state, receipts, Git refs, and archives unchanged while retaining pending work", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const pending = { ...structuredClone(record), id: "pending", status: "received" as const };
  pending.artifact.retainedRef = adoptedRef(pending.id);
  await broker.store.transaction((state) => { state.submissions[pending.id] = pending; });
  const stateBefore = await readFile(path.join(broker.store.directory, "state.json"), "utf8");
  const auditBefore = await broker.store.readAudit();
  const preview = await broker.archiveSubmissions();
  assert.equal(preview.dryRun, true);
  assert.equal(preview.releaseArtifacts, false);
  assert.deepEqual(preview.submissions, [record.id]);
  assert.deepEqual(preview.retainedPending, [pending.id]);
  assert.deepEqual(preview.archivePaths, []);
  assert.equal(await readFile(path.join(broker.store.directory, "state.json"), "utf8"), stateBefore);
  assert.deepEqual(await broker.store.readAudit(), auditBefore);
  assert.deepEqual(await readdir(broker.store.archivedSubmissionsDirectory), []);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
  await assert.rejects(broker.archiveSubmissions({ ids: [pending.id], dryRun: false }), errorCode("SUBMISSION_NOT_TERMINAL"));
});

test("default archival retains the exact ref and exposes archived show, list, and metrics", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const result = await broker.archiveSubmissions({ ids: [record.id], dryRun: false });
  assert.equal(result.archivePaths.length, 1);
  assert.equal((await broker.state()).submissions[record.id], undefined);
  const archived = await broker.submission(record.id);
  assert.ok(archived.archivedAt);
  assert.equal(archived.archiveIntent, undefined);
  assert.equal(archived.artifactReleasedAt, undefined);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
  assert.deepEqual(await broker.submissions(), []);
  assert.deepEqual(await broker.submissions({ includeArchived: true }), [archived]);
  const metrics = submissionMetrics(await broker.metrics());
  assert.equal(metrics.total, 1);
  assert.equal(metrics.active, 0);
  assert.equal(metrics.archived, 1);
  assert.equal(metrics.retainedArtifacts, 1);
  assert.equal(metrics.validationRuns, 1);
  assert.equal(metrics.validationDurationMs, 12);
});

test("explicit release removes only the requested exact ref and missing-ref retries never repin archives", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const another = await broker.repo.pinLocalRef(record.artifact.sha, "retention-other");
  await broker.archiveSubmissions({ ids: [record.id], dryRun: false, releaseArtifacts: true });
  await missingRef(repo, record.artifact.retainedRef);
  await broker.repo.releasePinnedLocalRef(record.id, record.artifact.sha);
  assert.equal(await git(repo, "rev-parse", another.ref), record.artifact.sha);
  assert.equal(await git(repo, "rev-parse", "producer/candidate"), record.artifact.sha);
  assert.equal(await git(repo, "rev-parse", "main"), record.base.sha);
  const fresh = await MergeBroker.open(repo);
  fresh.repo.pinLocalRef = async () => { throw new Error("Archived submissions must never be repinned"); };
  const recovery = await fresh.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionWarnings, []);
  assert.deepEqual(recovery.submissionsRecovered, []);
  await missingRef(repo, record.artifact.retainedRef);
  assert.ok((await fresh.submission(record.id)).artifactReleasedAt);
  assert.equal(submissionMetrics(await fresh.metrics()).retainedArtifacts, 0);
});

test("retirement refuses a retention ref changed by a local operation and preserves its journal", async (context) => {
  const { broker, record, repo } = await fixture(context);
  await git(repo, "update-ref", record.artifact.retainedRef, record.base.sha, record.artifact.sha);
  await assert.rejects(broker.archiveSubmissions({ ids: [record.id], dryRun: false, releaseArtifacts: true }),
    errorCode("SUBMISSION_REF_CHANGED"));
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.base.sha);
  assert.equal((await broker.submission(record.id)).archiveIntent?.releaseArtifact, true);
  assert.deepEqual(await readdir(broker.store.archivedSubmissionsDirectory), []);
  const recovery = await (await MergeBroker.open(repo)).recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsArchived, []);
  assert.equal(recovery.submissionWarnings?.length, 1);
  assert.equal((await broker.submission(record.id)).artifactReleasedAt, undefined);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.base.sha);
});

test("a fresh recovery completes the captured archive decision after release succeeds but its response is lost", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const release = broker.repo.releasePinnedLocalRef.bind(broker.repo);
  broker.repo.releasePinnedLocalRef = async (...args) => {
    await release(...args);
    throw new Error("simulated process stop after release");
  };
  await assert.rejects(broker.archiveSubmissions({ ids: [record.id], dryRun: false, releaseArtifacts: true }),
    /simulated process stop after release/u);
  await missingRef(repo, record.artifact.retainedRef);
  assert.equal((await broker.submission(record.id)).archiveIntent?.releaseArtifact, true);
  const fresh = await MergeBroker.open(repo);
  fresh.repo.pinLocalRef = async () => { throw new Error("Archive replay must not repin a released ref"); };
  const recovered = await fresh.recoverAbandonedIntegrations();
  assert.deepEqual(recovered.submissionsArchived, [record.id]);
  assert.deepEqual(recovered.submissionWarnings, []);
  assert.equal((await fresh.state()).submissions[record.id], undefined);
  assert.ok((await fresh.submission(record.id)).artifactReleasedAt);
  await missingRef(repo, record.artifact.retainedRef);
});

test("an archive written before an interrupted state transaction is deduplicated and replayed", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const writeArchive = broker.store.writeArchivedSubmission.bind(broker.store);
  broker.store.writeArchivedSubmission = async (snapshot) => {
    await writeArchive(snapshot);
    throw new Error("simulated process stop after archive write");
  };
  await assert.rejects(broker.archiveSubmissions({ ids: [record.id], dryRun: false }), /simulated process stop after archive write/u);
  assert.equal((await broker.submission(record.id)).archivedAt, undefined);
  assert.equal((await broker.submissions({ includeArchived: true })).length, 1);
  const overlap = submissionMetrics(await broker.metrics());
  assert.equal(overlap.total, 1);
  assert.equal(overlap.validationRuns, 1);
  assert.equal(overlap.active, 1);
  const fresh = await MergeBroker.open(repo);
  assert.deepEqual((await fresh.recoverAbandonedIntegrations()).submissionsArchived, [record.id]);
  assert.equal((await fresh.state()).submissions[record.id], undefined);
  assert.equal((await fresh.submissions({ includeArchived: true })).length, 1);
  assert.equal(submissionMetrics(await fresh.metrics()).total, 1);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
});

test("a failed archived manifest write keeps a replayable intent until fresh recovery repairs it", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const manifest = await broker.store.ensureSubmissionManifest(record);
  broker.store.ensureSubmissionManifest = async () => { throw new Error("simulated manifest write interruption"); };
  await assert.rejects(broker.archiveSubmissions({ ids: [record.id], dryRun: false, releaseArtifacts: true }),
    /simulated manifest write interruption/u);
  assert.ok((await broker.state()).submissions[record.id]?.archiveIntent);
  assert.ok((await broker.store.readArchivedSubmission(record.id))?.artifactReleasedAt);
  assert.equal((JSON.parse(await readFile(manifest, "utf8")) as SubmissionRecord).artifactReleasedAt, undefined);
  const fresh = await MergeBroker.open(repo);
  const recovery = await fresh.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsArchived, [record.id]);
  assert.deepEqual(recovery.submissionWarnings, []);
  assert.equal((await fresh.state()).submissions[record.id], undefined);
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), await fresh.submission(record.id));
  await missingRef(repo, record.artifact.retainedRef);
});

test("failed abandonment cleanup retains ownership while recovery never reruns the validator", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const worktree = path.join(broker.store.worktreesDirectory, `submission-${record.id}`);
  await broker.repo.addRawDetachedWorktree(worktree, record.artifact.sha);
  const identity = await broker.repo.gateWorktreeIdentity(worktree);
  await broker.store.transaction((state) => {
    const pending = state.submissions[record.id]!;
    pending.status = "validating";
    pending.worktree = worktree;
    pending.worktreeIdentity = identity;
    delete pending.finishedAt;
  });
  broker.repo.removeWorktree = async () => {
    assert.equal((await broker.submission(record.id)).status, "abandoned");
    throw new Error("simulated cleanup interruption");
  };
  await assert.rejects(broker.abandonSubmission(record.id, "Operator cancelled this work"), /simulated cleanup interruption/u);
  const abandoned = await broker.submission(record.id);
  assert.equal(abandoned.status, "abandoned");
  assert.equal(abandoned.abandonReason, "Operator cancelled this work");
  assert.deepEqual(abandoned.worktreeIdentity, identity);
  assert.equal(abandoned.worktree, worktree);
  assert.equal(await readFile(path.join(worktree, "candidate.txt"), "utf8"), "candidate preserved\n");
  await assert.rejects(broker.archiveSubmissions({ ids: [record.id], dryRun: false }), errorCode("SUBMISSION_NOT_TERMINAL"));
  const fresh = await MergeBroker.open(repo);
  fresh.repo.addRawDetachedWorktree = async () => { throw new Error("An abandoned validator must not be restarted"); };
  fresh.repo.pinLocalRef = async () => { throw new Error("An abandoned validator must not be repinned"); };
  const recovery = await fresh.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsAbandonedCleaned, [record.id]);
  assert.deepEqual(recovery.submissionsRecovered, []);
  assert.deepEqual(recovery.submissionWarnings, []);
  const cleaned = await fresh.submission(record.id);
  assert.equal(cleaned.status, "abandoned");
  assert.equal(cleaned.worktree, undefined);
  assert.equal(cleaned.worktreeIdentity, undefined);
  await assert.rejects(access(worktree));
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
  await fresh.archiveSubmissions({ ids: [record.id], dryRun: false });
  assert.equal((await fresh.submission(record.id)).status, "abandoned");
});

test("healthy terminal manifests are not rewritten by repeated recovery", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const manifest = await broker.store.ensureSubmissionManifest(record);
  const sentinel = new Date("2026-01-02T00:00:00.000Z");
  await utimes(manifest, sentinel, sentinel);
  const before = await stat(manifest);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual((await (await MergeBroker.open(repo)).recoverAbandonedIntegrations()).submissionWarnings, []);
  }
  assert.equal((await stat(manifest)).mtimeMs, before.mtimeMs);
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), record);
});

test("archive age validation reports invalid limits without changing saved state", async (context) => {
  const { broker } = await fixture(context);
  const before = await broker.state();
  for (const olderThanDays of [-1, NaN, Infinity, Number.MAX_VALUE]) {
    await assert.rejects(broker.archiveSubmissions({ olderThanDays, dryRun: false }), errorCode("INVALID_LIMIT"));
  }
  assert.deepEqual(await broker.state(), before);
});

test("metrics use one active snapshot when a concurrent archival finishes during collection", async (context) => {
  const { broker, record, repo } = await fixture(context);
  const concurrent = await MergeBroker.open(repo);
  const readState = broker.store.read.bind(broker.store);
  const readTaskArchives = broker.store.readArchivedState.bind(broker.store);
  let snapshotCaptured!: () => void;
  const captured = new Promise<void>((resolve) => { snapshotCaptured = resolve; });
  let reads = 0;
  broker.store.read = async () => {
    const snapshot = await readState();
    reads += 1;
    snapshotCaptured();
    return snapshot;
  };
  broker.store.readArchivedState = async () => {
    await captured;
    await concurrent.archiveSubmissions({ ids: [record.id], dryRun: false });
    return await readTaskArchives();
  };
  const metrics = submissionMetrics(await broker.metrics());
  assert.equal(reads, 1);
  assert.equal(metrics.total, 1);
  assert.equal(metrics.active, 1);
  assert.equal(metrics.archived, 0);
  assert.equal(metrics.validationRuns, 1);
  assert.equal((await concurrent.state()).submissions[record.id], undefined);
  assert.ok((await concurrent.submission(record.id)).archivedAt);
});

test("archive readers preserve a malformed field's diagnostic path", async (context) => {
  const { broker, record } = await fixture(context);
  const result = await broker.archiveSubmissions({ ids: [record.id], dryRun: false });
  const file = result.archivePaths[0]!;
  const saved = JSON.parse(await readFile(file, "utf8")) as SubmissionRecord;
  Object.assign(saved.policy, { digest: 42 });
  await writeFile(file, `${JSON.stringify(saved)}\n`, "utf8");
  for (const read of [() => broker.store.readArchivedSubmission(record.id), () => broker.store.readArchivedSubmissions()]) {
    await assert.rejects(read(), (error: unknown) => {
      assert.ok(error instanceof BrokerError);
      assert.equal(error.code, "STATE_CORRUPT");
      assert.match(String(error.details?.path), /\.policy\.digest$/u);
      return true;
    });
  }
});
