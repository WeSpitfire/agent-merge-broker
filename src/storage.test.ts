import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import fsPromises, { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { BrokerError } from "./errors.js";
import { StateStore } from "./store.js";
import { compactAuditStorage, inspectStorage, MAX_COMPACT_AUDIT_BYTES } from "./storage.js";

const OLD_SEGMENT = "audit-2026-01-01T00-00-00-000Z.jsonl";
const SECOND_SEGMENT = "audit-2026-01-02T00-00-00-000Z.jsonl";

async function fixture(context: TestContext, initialize = true): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "amb-storage-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const common = path.join(root, ".git");
  await mkdir(common);
  const store = new StateStore(common, "merge-broker", 2);
  if (initialize) await store.initialize();
  return { root, store };
}

async function closedAudit(store: StateStore, filename = OLD_SEGMENT, sequence = 1): Promise<string> {
  const target = path.join(store.archiveDirectory, filename);
  const contents = `${JSON.stringify({ sequence, at: "2026-01-01T00:00:00.000Z", event: "storage.fixture", details: { text: "evidence ".repeat(400) } })}\n`;
  await writeFile(target, contents, { mode: 0o600 });
  await utimes(target, new Date("2026-01-01"), new Date("2026-01-01"));
  return contents;
}

test("storage inspection reports metadata categories without reading or exposing secret contents", async (context) => {
  const { root, store } = await fixture(context);
  const baseline = await inspectStorage(store, { repositoryRoot: root });
  await writeFile(path.join(store.directory, "audit.jsonl"), "12345");
  await writeFile(path.join(store.directory, "serve.log"), "123456");
  const secret = "NEVER-PRINT-PRIVATE-KEY-CONTENTS";
  await writeFile(store.provenanceSigningKeyFile, secret);
  await writeFile(path.join(store.submissionsDirectory, "one.json"), "1234567");
  await writeFile(path.join(store.worktreesDirectory, "one.txt"), "12345678");
  await writeFile(path.join(store.archiveDirectory, "state-one.json"), "123456789");
  const provenance = path.join(root, ".merge-broker", "attestations");
  await mkdir(provenance, { recursive: true });
  await writeFile(path.join(provenance, "one.json"), "1234567890");
  await writeFile(path.join(root, "application.txt"), "This is not broker storage.");
  const report = await inspectStorage(store, { repositoryRoot: root, provenanceDirectory: ".merge-broker/attestations" });
  assert.equal(report.logicalBytes - baseline.logicalBytes, 5 + 6 + secret.length + 7 + 8 + 9 + 10);
  assert.equal(report.files - baseline.files, 7);
  assert.equal(report.categories.find((item) => item.category === "credentials")?.logicalBytes, secret.length);
  assert.equal(report.categories.find((item) => item.category === "provenance")?.logicalBytes, 10);
  assert.equal(report.complete, true);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("inspection and compaction previews do not initialize an absent store", async (context) => {
  const { root, store } = await fixture(context, false);
  assert.equal((await inspectStorage(store, { repositoryRoot: root })).files, 0);
  assert.equal((await compactAuditStorage(store)).eligibleFiles, 0);
  assert.deepEqual(await readdir(store.commonGitDirectory), []);
});

test("inspection returns partial totals and continues siblings when a directory becomes unreadable or disappears", async (context) => {
  const { root, store } = await fixture(context);
  const restricted = path.join(store.worktreesDirectory, "restricted");
  await mkdir(restricted);
  await writeFile(path.join(restricted, "unreadable"), "not counted");
  await writeFile(path.join(store.worktreesDirectory, "visible"), "12345");
  const originalOpendir = fsPromises.opendir;
  let failureCode = "EACCES";
  const mockedOpendir = context.mock.method(fsPromises, "opendir", async (...args: Parameters<typeof fsPromises.opendir>) => {
    if (String(args[0]) === restricted) {
      throw Object.assign(new Error("Simulated inaccessible directory"), { code: failureCode });
    }
    return await originalOpendir(...args);
  });
  syncBuiltinESMExports();
  try {
    for (failureCode of ["EACCES", "EPERM", "ENOENT", "ENOTDIR"]) {
      const report = await inspectStorage(store, { repositoryRoot: root });
      assert.equal(report.complete, false);
      assert.equal(report.files, 2);
      assert.equal(report.categories.find((item) => item.category === "worktrees")?.logicalBytes, 5);
      assert.equal(report.skipped.length, 1);
      assert.equal(report.skipped[0]?.path, restricted);
      assert.ok(report.skipped[0]?.reason.includes(failureCode));
    }
  } finally {
    mockedOpendir.mock.restore();
    syncBuiltinESMExports();
  }
});

test("inspection skips directory symlinks and junctions, including configured provenance parents", async (context) => {
  const { root, store } = await fixture(context);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret"), "outside storage");
  await symlink(outside, path.join(store.worktreesDirectory, "redirected"), process.platform === "win32" ? "junction" : "dir");
  await symlink(outside, path.join(root, "redirected"), process.platform === "win32" ? "junction" : "dir");
  const report = await inspectStorage(store, { repositoryRoot: root, provenanceDirectory: "redirected/evidence" });
  assert.equal(report.files, 1);
  assert.equal(report.complete, false);
  assert.equal(report.skipped.length, 2);
  assert.equal(report.categories.some((item) => item.category === "worktrees"), false);
  await assert.rejects(inspectStorage(store, { repositoryRoot: root, provenanceDirectory: "../escape" }),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH");
});

test("compaction defaults to preview, filters by age, and does not alter recovery or credential records", async (context) => {
  const { store } = await fixture(context);
  const old = await closedAudit(store);
  await closedAudit(store, SECOND_SEGMENT, 2);
  await utimes(path.join(store.archiveDirectory, SECOND_SEGMENT), new Date(), new Date());
  await writeFile(path.join(store.directory, "audit.jsonl"), "active");
  await writeFile(store.provenanceSigningKeyFile, "private");
  await writeFile(path.join(store.archiveDirectory, "state-old.json"), "recovery");
  const result = await compactAuditStorage(store);
  assert.equal(result.applied, false);
  assert.equal(result.olderThanDays, 30);
  assert.equal(result.eligibleFiles, 1);
  assert.equal(result.eligibleBytes, Buffer.byteLength(old));
  assert.equal(result.savedBytes, 0);
  assert.equal(result.entries[0]?.status, "eligible");
  assert.equal(await readFile(path.join(store.archiveDirectory, OLD_SEGMENT), "utf8"), old);
  assert.equal(await readFile(path.join(store.directory, "audit.jsonl"), "utf8"), "active");
  assert.equal(await readFile(store.provenanceSigningKeyFile, "utf8"), "private");
  assert.equal(await readFile(path.join(store.archiveDirectory, "state-old.json"), "utf8"), "recovery");
  assert.equal((await readdir(store.archiveDirectory)).some((file) => file.endsWith(".gz")), false);
});

test("applied compaction round-trips evidence, preserves audit reads, and is idempotent", async (context) => {
  const { store } = await fixture(context);
  const first = await closedAudit(store);
  await closedAudit(store, SECOND_SEGMENT, 2);
  await store.transaction((_state, audit) => audit("active.fixture"));
  const before = await store.readAudit(10);
  const stateBefore = await readFile(path.join(store.directory, "state.json"));
  const activeBefore = await readFile(path.join(store.directory, "audit.jsonl"));
  const result = await compactAuditStorage(store, { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.compressedFiles, 2);
  assert.ok(result.savedBytes > 0);
  assert.deepEqual(await store.readAudit(10), before);
  assert.equal(gunzipSync(await readFile(path.join(store.archiveDirectory, `${OLD_SEGMENT}.gz`))).toString(), first);
  await assert.rejects(stat(path.join(store.archiveDirectory, OLD_SEGMENT)), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(store.directory, "state.json")), stateBefore);
  assert.deepEqual(await readFile(path.join(store.directory, "audit.jsonl")), activeBefore);
  assert.equal((await compactAuditStorage(store, { apply: true })).compressedFiles, 0);
  if (process.platform !== "win32") assert.equal((await stat(path.join(store.archiveDirectory, `${OLD_SEGMENT}.gz`))).mode & 0o777, 0o600);
});

test("an interrupted compressed copy does not hide or duplicate the original audit segment", async (context) => {
  const { store } = await fixture(context);
  const original = await closedAudit(store);
  await writeFile(path.join(store.archiveDirectory, `${OLD_SEGMENT}.gz`), "partial gzip");
  assert.equal((await store.readAudit(10)).length, 1);
  const result = await compactAuditStorage(store, { apply: true });
  assert.equal(result.compressedFiles, 0);
  assert.match(result.skipped[0]?.reason ?? "", /compressed copy already exists/u);
  assert.equal(await readFile(path.join(store.archiveDirectory, OLD_SEGMENT), "utf8"), original);
});

test("compaction never follows redirected archive directories or removes hard-linked segments", async (context) => {
  const { root, store } = await fixture(context);
  await closedAudit(store);
  await link(path.join(store.archiveDirectory, OLD_SEGMENT), path.join(root, "retained-audit"));
  const result = await compactAuditStorage(store, { apply: true });
  assert.equal(result.compressedFiles, 0);
  assert.match(result.skipped[0]?.reason ?? "", /hard links/u);
  const other = path.join(root, "other-archive");
  await mkdir(other);
  const redirectedStore = new StateStore(store.commonGitDirectory, "redirected-state", 2);
  await redirectedStore.initialize();
  await rm(redirectedStore.archiveDirectory, { recursive: true });
  await symlink(other, redirectedStore.archiveDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(compactAuditStorage(redirectedStore, { apply: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH");
  assert.deepEqual(await readdir(other), []);
});

test("compaction retains files when compression saves no bytes and rejects invalid ages", async (context) => {
  const { store } = await fixture(context);
  await writeFile(path.join(store.archiveDirectory, OLD_SEGMENT), "x");
  await utimes(path.join(store.archiveDirectory, OLD_SEGMENT), new Date("2026-01-01"), new Date("2026-01-01"));
  const result = await compactAuditStorage(store, { apply: true, olderThanDays: 0 });
  assert.equal(result.compressedFiles, 0);
  assert.equal(result.entries[0]?.status, "unchanged");
  assert.equal(await readFile(path.join(store.archiveDirectory, OLD_SEGMENT), "utf8"), "x");
  for (const olderThanDays of [-1, NaN, Infinity]) {
    await assert.rejects(compactAuditStorage(store, { olderThanDays }),
      (error: unknown) => error instanceof BrokerError && error.code === "INVALID_ARGUMENT");
  }
  await assert.rejects(compactAuditStorage(store, { apply: "true" as unknown as boolean }),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_ARGUMENT");
});

test("compressed audit reads bound decompression and surface damaged gzip data", async (context) => {
  const { store } = await fixture(context);
  const target = path.join(store.archiveDirectory, `${OLD_SEGMENT}.gz`);
  await writeFile(target, gzipSync(Buffer.alloc(MAX_COMPACT_AUDIT_BYTES + 1, 32)));
  await assert.rejects(store.readAudit(),
    (error: unknown) => error instanceof BrokerError && error.code === "AUDIT_ARCHIVE_TOO_LARGE");
  await writeFile(target, "broken gzip");
  await assert.rejects(store.readAudit());
});

test("inspection counts unreadable private files using metadata only", { skip: process.platform === "win32" }, async (context) => {
  const { root, store } = await fixture(context);
  await writeFile(store.provenanceSigningKeyFile, "private key");
  await chmod(store.provenanceSigningKeyFile, 0o000);
  try {
    const report = await inspectStorage(store, { repositoryRoot: root });
    assert.equal(report.categories.find((item) => item.category === "credentials")?.logicalBytes, 11);
  } finally {
    await chmod(store.provenanceSigningKeyFile, 0o600);
  }
});
