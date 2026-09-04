import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { StateStore } from "./store.js";
import { BrokerError } from "./errors.js";
import { STATE_VERSION, SUBMISSION_VERSION, type SubmissionRecord } from "./types.js";

function submissionRecord(id = "submission-one"): SubmissionRecord {
  const at = "2026-09-04T12:00:00.000Z";
  return {
    version: SUBMISSION_VERSION,
    id,
    status: "received",
    authorityDigest: "9".repeat(64),
    source: { kind: "local-ref", ref: "refs/heads/agent/candidate" },
    artifact: {
      kind: "git-commit",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
      retainedRef: `refs/merge-broker/submissions/${id}`,
    },
    base: {
      ref: "refs/remotes/origin/main",
      baseBranch: "main",
      remote: "origin",
      fetchUrlFingerprint: "c".repeat(64),
      sha: "d".repeat(40),
    },
    policy: {
      baseSha: "d".repeat(40),
      configPath: ".merge-broker.json",
      configBlobSha: "e".repeat(40),
      digest: "f".repeat(64),
      revision: "protected-base-v1",
      evaluatorVersion: "agent-merge-broker/0.12.1",
      configVersion: 1,
    },
    commits: ["a".repeat(40)],
    paths: ["src/candidate.ts"],
    validations: [],
    createdAt: at,
    updatedAt: at,
  };
}

function batchLockPath(store: StateStore, batchId: string): string {
  const readable = batchId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
  const digest = createHash("sha256").update(batchId).digest("hex").slice(0, 12);
  return path.join(store.directory, `batch-${readable || "record"}-${digest}.lock`);
}

test("refuses state paths outside or redirected from Git's physical common directory", {
  skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false,
}, async (context) => {
  const common = await mkdtemp(path.join(tmpdir(), "merge-broker-store-containment-"));
  const outside = await mkdtemp(path.join(tmpdir(), "merge-broker-store-outside-"));
  context.after(async () => {
    await rm(common, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  assert.throws(
    () => new StateStore(common, "../outside", 1),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH",
  );
  await symlink(outside, path.join(common, "redirected"));
  const redirected = new StateStore(common, "redirected/state", 1);
  await assert.rejects(
    redirected.initialize(),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH",
  );
  await assert.rejects(stat(path.join(outside, "state")));
});

test("serializes concurrent first-use state transactions without losing events", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const stores = Array.from({ length: 20 }, () => new StateStore(directory, "state", 10));
  await Promise.all(
    stores.map(async (store, index) => {
      await store.transaction((_state, audit) => {
        audit("concurrent.test", { details: { index } });
      });
    }),
  );
  const first = stores[0];
  if (!first) throw new Error("Expected a store fixture.");
  const state = await first.read();
  const audit = await first.readAudit(100);
  assert.equal(state.sequence, 20);
  assert.equal(audit.length, 20);
  assert.deepEqual(
    audit.map((event) => event.sequence),
    Array.from({ length: 20 }, (_value, index) => index + 1),
  );
});

test("normalizes legacy v1 state with no submissions and persists the additive collection", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 10);
  await store.initialize();
  const stateFile = path.join(store.directory, "state.json");
  await writeFile(stateFile, `${JSON.stringify({
    version: STATE_VERSION,
    sequence: 7,
    tasks: {},
    batches: {},
  }, null, 2)}\n`, "utf8");

  const legacy = await store.read();
  assert.equal(legacy.sequence, 7);
  assert.deepEqual(legacy.submissions, {});

  const submission = submissionRecord();
  await store.transaction((state, audit) => {
    state.submissions[submission.id] = submission;
    audit("submission.received", { submissionId: submission.id });
  });

  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
    sequence: number;
    submissions?: Record<string, SubmissionRecord>;
  };
  assert.equal(persisted.sequence, 8);
  assert.deepEqual(persisted.submissions?.[submission.id], submission);
  assert.equal((await store.readAudit(1))[0]?.submissionId, submission.id);
});

test("rejects a malformed submissions collection instead of silently dropping it", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 10);
  await store.initialize();
  await writeFile(path.join(store.directory, "state.json"), `${JSON.stringify({
    version: STATE_VERSION,
    sequence: 0,
    tasks: {},
    batches: {},
    submissions: [],
  })}\n`, "utf8");

  await assert.rejects(
    store.read(),
    (error: unknown) => error instanceof BrokerError && error.code === "STATE_CORRUPT",
  );
});

test("reads the audit trail past a line truncated by a crash", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 10);
  await store.transaction((_state, audit) => {
    audit("first.event");
  });
  await store.transaction((_state, audit) => {
    audit("second.event");
  });
  // A crash between writing and flushing leaves a partial record. The audit trail is most needed
  // exactly then, so one bad line must not make every read throw.
  await appendFile(path.join(directory, "state", "audit.jsonl"), '{"sequence":3,"at":"2026-08', "utf8");

  assert.deepEqual(
    (await store.readAudit(100)).map((event) => event.event),
    ["first.event", "second.event"],
  );
});

test("reads recent audit events across rotated segments", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 10);
  await store.transaction((_state, audit) => {
    audit("before.rotation.one");
    audit("before.rotation.two");
  });
  await rename(
    path.join(store.directory, "audit.jsonl"),
    path.join(store.archiveDirectory, "audit-2026-09-03T12-00-00-000Z.jsonl"),
  );
  await store.transaction((_state, audit) => audit("after.rotation"));

  assert.deepEqual(
    (await store.readAudit(3)).map((event) => event.event),
    ["before.rotation.one", "before.rotation.two", "after.rotation"],
  );
});

test("releases an abandoned lock but refuses one that may still be live", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 10);
  await store.initialize();
  const lockDirectory = path.join(directory, "state", "integration.lock");

  const write = async (owner: Record<string, unknown>): Promise<void> => {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  };

  // A holder on another machine cannot be probed, so it is never assumed dead.
  await write({ pid: 1, host: "another-machine", createdAt: new Date().toISOString() });
  const foreign = await store.inspectLock("integration");
  assert.equal(foreign.held, true);
  assert.equal(foreign.abandoned, false);
  await assert.rejects(
    store.releaseLock("integration"),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "LOCK_HELD" &&
      /no operation using this lock can still progress/iu.test(error.message),
  );
  assert.equal((await store.releaseLock("integration", { force: true })).held, false);

  // A holder on this machine whose process is gone is provably abandoned.
  await write({ pid: 4_294_967_295, host: hostname(), createdAt: new Date().toISOString() });
  assert.equal((await store.inspectLock("integration")).abandoned, true);
  assert.equal((await store.releaseLock("integration")).held, false);
  assert.equal((await store.inspectLock("integration")).held, false);
});

test("serializes operations for the same batch and gives each holder a new fencing nonce", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const firstStore = new StateStore(directory, "state", 2);
  const secondStore = new StateStore(directory, "state", 2);
  let releaseFirst: (() => void) | undefined;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const events: string[] = [];
  const nonces: string[] = [];

  const first = firstStore.withBatchLock("batch/one", async (nonce) => {
    nonces.push(nonce);
    events.push("first-entered");
    firstEntered?.();
    await firstRelease;
    events.push("first-leaving");
  });
  await entered;
  const second = secondStore.withBatchLock("batch/one", (nonce) => {
    nonces.push(nonce);
    events.push("second-entered");
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(events, ["first-entered"]);
  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first-entered", "first-leaving", "second-entered"]);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
});

test("an old batch-lock holder cannot release a replacement owner's lock", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const oldStore = new StateStore(directory, "state", 2);
  const replacementStore = new StateStore(directory, "state", 2);
  const lockDirectory = batchLockPath(oldStore, "replacement-race");
  let releaseReplacement: (() => void) | undefined;
  const replacementRelease = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let replacementEntered: (() => void) | undefined;
  const replacementReady = new Promise<void>((resolve) => {
    replacementEntered = resolve;
  });
  let replacement: Promise<void> | undefined;

  await oldStore.withBatchLock("replacement-race", async () => {
    // Simulate an operator replacing a lock while its former process is suspended. The old holder's
    // finally block must compare nonces and leave the replacement alone.
    await rm(lockDirectory, { recursive: true, force: true });
    replacement = replacementStore.withBatchLock("replacement-race", async () => {
      replacementEntered?.();
      await replacementRelease;
    });
    await replacementReady;
  });

  const owner = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as { nonce?: string };
  assert.equal(typeof owner.nonce, "string");
  releaseReplacement?.();
  await replacement;
  assert.equal(await stat(lockDirectory).then(() => true, () => false), false);
});

test("reclaims a provably crashed batch lock without exposing its successor", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const store = new StateStore(directory, "state", 2);
  await store.initialize();
  const lockDirectory = batchLockPath(store, "stale-batch");
  const staleNonce = "stale-owner-nonce";
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify({
    pid: 4_294_967_295,
    host: hostname(),
    createdAt: "2026-01-01T00:00:00.000Z",
    nonce: staleNonce,
  })}\n`, "utf8");
  const old = new Date(Date.now() - 5_000);
  await utimes(lockDirectory, old, old);

  let acquiredNonce: string | undefined;
  await store.withBatchLock("stale-batch", (nonce) => {
    acquiredNonce = nonce;
  });

  assert.notEqual(acquiredNonce, staleNonce);
  const tombstones = (await readdir(store.directory)).filter((entry) =>
    entry.startsWith(`${path.basename(lockDirectory)}.reclaimed-${staleNonce}`));
  assert.equal(tombstones.length, 1);
  assert.equal(await stat(lockDirectory).then(() => true, () => false), false);
});

test("never age-steals an ancient same-host batch lock held by the current process", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const ownerStore = new StateStore(directory, "state", 2);
  const contender = new StateStore(directory, "state", 0.1);
  await ownerStore.initialize();
  const lockDirectory = batchLockPath(ownerStore, "ancient-live-batch");
  const ownerContents = `${JSON.stringify({
    pid: process.pid,
    host: hostname(),
    createdAt: "2000-01-01T00:00:00.000Z",
    nonce: "ancient-live-owner",
  })}\n`;
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(path.join(lockDirectory, "owner.json"), ownerContents, "utf8");
  const ancient = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockDirectory, ancient, ancient);

  let entered = false;
  await assert.rejects(
    contender.withBatchLock("ancient-live-batch", () => {
      entered = true;
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_TIMEOUT",
  );

  assert.equal(entered, false);
  assert.equal(await readFile(path.join(lockDirectory, "owner.json"), "utf8"), ownerContents);
  assert.equal(await stat(lockDirectory).then(() => true, () => false), true);
  const tombstones = (await readdir(ownerStore.directory)).filter((entry) =>
    entry.startsWith(`${path.basename(lockDirectory)}.reclaimed-`));
  assert.deepEqual(tombstones, []);
});

test(
  "keeps runtime state private without changing a caller-owned token directory",
  { skip: process.platform === "win32" ? "POSIX permission modes" : false },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-store-"));
    context.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const store = new StateStore(directory, "state", 10);
    await store.initialize();
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(store.directory, "state.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(store.tokensDirectory)).mode & 0o777, 0o700);

    await store.transaction((_state, audit) => audit("permissions.test"));
    assert.equal((await stat(path.join(store.directory, "audit.jsonl"))).mode & 0o777, 0o600);
    const manifest = await store.writeBatchManifest("permissions", { private: true });
    assert.equal((await stat(manifest)).mode & 0o777, 0o600);
    const submissionManifest = await store.writeSubmissionManifest(submissionRecord("permissions"));
    assert.equal((await stat(store.submissionsDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(submissionManifest)).mode & 0o777, 0o600);

    const external = path.join(directory, "caller-owned");
    await mkdir(external, { mode: 0o755 });
    await chmod(external, 0o755);
    const token = path.join(external, "worker.token");
    await store.writeToken("worker", "secret", token);
    assert.equal((await stat(external)).mode & 0o777, 0o755);
    assert.equal((await stat(token)).mode & 0o777, 0o600);
  },
);
