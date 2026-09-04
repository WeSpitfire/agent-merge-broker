import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BrokerError } from "./errors.js";
import { GateAuthorityStore, gateAuthorityDigest, validateGateAuthority } from "./gate-authority.js";
import { StateStore } from "./store.js";
import {
  GATE_AUTHORITY_VERSION,
  type GateAuthorityRegistration,
} from "./types.js";

async function commonDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-gate-authority-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return directory;
}

function registration(
  overrides: Partial<Pick<GateAuthorityRegistration, "target" | "stateDirectory" | "registeredAt">> = {},
): GateAuthorityRegistration {
  const value: GateAuthorityRegistration = {
    version: GATE_AUTHORITY_VERSION,
    kind: "trusted-local-ref",
    digest: "0".repeat(64),
    target: overrides.target ?? {
      baseRef: "main",
      baseBranch: "main",
      remote: "origin",
      refreshBase: false,
    },
    stateDirectory: overrides.stateDirectory ?? "merge-broker",
    registeredAt: overrides.registeredAt ?? "2026-09-04T12:00:00.000Z",
  };
  value.digest = gateAuthorityDigest(value);
  return value;
}

test("creates one config-independent Gate authority and repeats identical setup idempotently", async (context) => {
  const common = await commonDirectory(context);
  const store = new GateAuthorityStore(common);
  const first = registration();
  const repeated = registration({ registeredAt: "2026-09-04T13:00:00.000Z" });

  const written = await store.register(first);
  const again = await store.register(repeated);

  assert.deepEqual(written, first);
  assert.deepEqual(again, first);
  assert.deepEqual(await store.read(), first);
  assert.equal(path.dirname(store.file), common);
  assert.equal((await stat(store.file)).mode & 0o777, process.platform === "win32" ? (await stat(store.file)).mode & 0o777 : 0o600);
});

test("requires explicit replacement and never stores a raw remote URL", async (context) => {
  const common = await commonDirectory(context);
  const store = new GateAuthorityStore(common);
  const original = registration();
  const replacement = registration({
    target: {
      ...original.target,
      baseRef: "refs/remotes/origin/release",
      baseBranch: "release",
      refreshBase: true,
      fetchUrlFingerprint: "a".repeat(64),
    },
  });
  await store.register(original);

  await assert.rejects(
    store.register(replacement),
    (error: unknown) => error instanceof BrokerError && error.code === "GATE_AUTHORITY_EXISTS",
  );
  assert.deepEqual(await store.read(), original);

  assert.deepEqual(await store.register(replacement, { replace: true }), replacement);
  assert.deepEqual(await store.read(), replacement);
  assert.doesNotMatch(await readFile(store.file, "utf8"), /https?:\/\//iu);
});

test("fails closed on a changed digest or unsupported authority version", () => {
  const changed = registration();
  changed.target.baseBranch = "changed";
  assert.throws(
    () => validateGateAuthority(changed),
    (error: unknown) => error instanceof BrokerError && error.code === "GATE_AUTHORITY_CORRUPT",
  );

  const future = { ...registration(), version: 2 };
  assert.throws(
    () => validateGateAuthority(future),
    (error: unknown) => error instanceof BrokerError && error.code === "GATE_AUTHORITY_VERSION",
  );
});

test("fails closed when persisted authority names an unsafe state directory", () => {
  for (const stateDirectory of ["Objects/gate-state", "worktrees", "OBJECT~1/state", "nested\\state"]) {
    const unsafe = registration({ stateDirectory });
    assert.throws(
      () => validateGateAuthority(unsafe),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "GATE_AUTHORITY_CORRUPT",
      stateDirectory,
    );
  }
});

test("uses one common-directory authority lock across different configured state directories", async (context) => {
  const common = await commonDirectory(context);
  const left = new StateStore(common, "left-state", 5);
  const right = new StateStore(common, "right-state", 5);
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered: (() => void) | undefined;
  const firstDidEnter = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const first = left.withGateAuthorityLock(async () => {
    order.push("first-enter");
    firstEntered?.();
    await firstMayFinish;
    order.push("first-leave");
  });
  await firstDidEnter;
  const second = right.withGateAuthorityLock(async () => {
    order.push("second-enter");
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(order, ["first-enter"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-leave", "second-enter"]);
});
