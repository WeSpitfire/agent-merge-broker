import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerError } from "./errors.js";
import { waitForExecutions } from "./execution-guard.js";
import { canProbeProcessIdentity, linuxProcessIdentity } from "./process-identity.js";
import { StateStore } from "./store.js";

const THIS_IDENTITY = "linux:11111111-1111-4111-8111-111111111111:pid:[4026531836]";
const FOREIGN_NAMESPACE = "linux:11111111-1111-4111-8111-111111111111:pid:[4026531999]";
const FOREIGN_BOOT = "linux:22222222-2222-4222-8222-222222222222:pid:[4026531836]";

test("Linux liveness probes require readable, matching boot and PID namespace identity", () => {
  assert.equal(canProbeProcessIdentity(THIS_IDENTITY, "linux", THIS_IDENTITY), true);
  for (const recorded of [undefined, null, 7, {}, FOREIGN_NAMESPACE, FOREIGN_BOOT]) {
    assert.equal(canProbeProcessIdentity(recorded, "linux", THIS_IDENTITY), false);
  }
  assert.equal(canProbeProcessIdentity(THIS_IDENTITY, "linux", undefined), false);
  assert.equal(canProbeProcessIdentity(undefined, "linux", undefined), false);
  assert.equal(canProbeProcessIdentity(undefined, "darwin", undefined), true);
  assert.equal(canProbeProcessIdentity(undefined, "win32", undefined), true);
  assert.equal(canProbeProcessIdentity(THIS_IDENTITY, "darwin", undefined), false);
});

test("Linux captures a bounded boot and PID namespace token from procfs", {
  skip: process.platform !== "linux" ? "Linux procfs identity" : false,
}, () => {
  assert.match(linuxProcessIdentity() ?? "", /^linux:[0-9a-f-]{36}:pid:\[\d+\]$/u);
});

test("a foreign namespace cannot release or automatically reclaim a nonexistent lock PID", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-namespace-lock-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 0.01);
  await store.initialize();
  const lock = path.join(store.directory, "integration.lock");
  await mkdir(lock);
  const owner = {
    pid: 2_147_483_647, host: hostname(), platform: `${process.platform}-${process.arch}`,
    processIdentity: FOREIGN_NAMESPACE, nonce: randomUUID(), createdAt: "2020-01-01T00:00:00.000Z",
  };
  const source = JSON.stringify(owner);
  await writeFile(path.join(lock, "owner.json"), source);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await store.inspectLock("integration")).abandoned, false);
  await assert.rejects(store.releaseLock("integration"),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
  await assert.rejects(store.withIntegrationLock(async () => assert.fail("foreign owner must not be reclaimed")),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_TIMEOUT");
  assert.equal(await readFile(path.join(lock, "owner.json"), "utf8"), source);
});

test("a PID probe error other than ESRCH never proves abandonment", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-invalid-pid-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 0.01);
  await store.initialize();
  const lock = path.join(store.directory, "integration.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({
    pid: 4_294_967_295, host: hostname(), platform: `${process.platform}-${process.arch}`,
    processIdentity: linuxProcessIdentity(), nonce: randomUUID(),
  }));
  assert.equal((await store.inspectLock("integration")).abandoned, false);
  await assert.rejects(store.releaseLock("integration"),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
});

test("a foreign namespace cannot retire a nonexistent validator process group", {
  skip: process.platform === "win32" ? "POSIX process-group observation" : false,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-namespace-execution-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, "validator-executions");
  await mkdir(root);
  const nonce = randomUUID();
  const file = path.join(root, `${nonce}.json`);
  const source = JSON.stringify({
    version: 1, nonce, pid: 2_147_483_647, host: hostname(), platform: `${process.platform}-${process.arch}`,
    processIdentity: FOREIGN_NAMESPACE, kind: "process-group", cwd: directory,
  });
  await writeFile(file, source);
  await assert.rejects(waitForExecutions(directory, 0),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
  assert.equal(await readFile(file, "utf8"), source);
});

test("Linux legacy owners need inspected force unlock rather than an unsafe PID fallback", {
  skip: process.platform !== "linux" ? "Linux legacy namespace ambiguity" : false,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-namespace-legacy-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 0.01);
  await store.initialize();
  const lock = path.join(store.directory, "integration.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, host: hostname(), nonce: randomUUID() }));
  assert.equal((await store.inspectLock("integration")).abandoned, false);
  await assert.rejects(store.releaseLock("integration"),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
  assert.equal((await store.releaseLock("integration", { force: true })).held, false);
});
