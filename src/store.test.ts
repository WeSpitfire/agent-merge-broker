import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { appendFile, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { StateStore } from "./store.js";
import { BrokerError } from "./errors.js";

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
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD",
  );
  assert.equal((await store.releaseLock("integration", { force: true })).held, false);

  // A holder on this machine whose process is gone is provably abandoned.
  await write({ pid: 4_294_967_295, host: hostname(), createdAt: new Date().toISOString() });
  assert.equal((await store.inspectLock("integration")).abandoned, true);
  assert.equal((await store.releaseLock("integration")).held, false);
  assert.equal((await store.inspectLock("integration")).held, false);
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

    const external = path.join(directory, "caller-owned");
    await mkdir(external, { mode: 0o755 });
    await chmod(external, 0o755);
    const token = path.join(external, "worker.token");
    await store.writeToken("worker", "secret", token);
    assert.equal((await stat(external)).mode & 0o777, 0o755);
    assert.equal((await stat(token)).mode & 0o777, 0o600);
  },
);
