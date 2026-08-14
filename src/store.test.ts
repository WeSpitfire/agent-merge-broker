import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StateStore } from "./store.js";

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
