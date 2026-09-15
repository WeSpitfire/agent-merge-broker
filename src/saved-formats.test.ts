import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MergeBroker } from "./broker.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import {
  decodeArchivedStateSlice,
  decodeBrokerState,
  isAuditEvent,
  savedFormatSchemas,
} from "./state-codec.js";

const schemas = savedFormatSchemas();

function validator(schema: object) {
  return new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } }).compile(schema);
}
const validateState = validator(schemas.state);
const validateArchivedState = validator(schemas["archived-state"]);
const validateAuditEvent = validator(schemas["audit-event"]);

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

/** A repository whose broker has integrated, merged, and pruned one batch. */
async function exercisedRepository(context: TestContext): Promise<MergeBroker> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-formats-"));
  context.after(async () => await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  const broker = await MergeBroker.open(repo);
  for (const id of ["FORMAT-A", "FORMAT-B"]) {
    const claim = await broker.claimTask({ id, holder: "agent", expectedPaths: [`src/${id}.ts`] });
    await git(repo, "switch", "-c", `agent/${id}`, "main");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", `${id}.ts`), `export const id = "${id}";\n`, "utf8");
    await git(repo, "add", `src/${id}.ts`);
    await git(repo, "commit", "-m", id);
    const commit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "switch", "main");
    await broker.submitTask(id, [commit], claim.token);
  }
  const integrated = await broker.integrate();
  await broker.markBatchMerged(integrated.batch.id);
  await broker.prune({ olderThanDays: 0 });
  return broker;
}

test("committed saved-format schemas are generated from the runtime decoders", async () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const committed = await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8");
    assert.equal(committed, `${JSON.stringify(schema, null, 2)}\n`, `${name}.schema.json is stale`);
  }
});

test("state, archive slices, and audit events written by the broker match their schemas", async (context) => {
  const broker = await exercisedRepository(context);
  await broker.claimTask({ id: "FORMAT-ACTIVE", holder: "agent", expectedPaths: ["docs/**"] });

  const state = JSON.parse(await readFile(path.join(broker.store.directory, "state.json"), "utf8")) as unknown;
  decodeBrokerState(structuredClone(state));
  assert.ok(validateState(state), JSON.stringify(validateState.errors));

  const archives = (await readdir(broker.store.archiveDirectory)).filter((file) => file.startsWith("state-"));
  assert.equal(archives.length, 1);
  const slice = JSON.parse(await readFile(path.join(broker.store.archiveDirectory, archives[0]!), "utf8")) as {
    version?: number;
    tasks: Record<string, unknown>;
  };
  assert.equal(slice.version, 1);
  assert.deepEqual(Object.keys(slice.tasks).sort(), ["FORMAT-A", "FORMAT-B"]);
  decodeArchivedStateSlice(slice);
  assert.ok(validateArchivedState(slice), JSON.stringify(validateArchivedState.errors));

  const events = await broker.store.readAudit(1_000);
  assert.ok(events.some((event) => event.event === "state.pruned"));
  for (const event of events) {
    assert.ok(isAuditEvent(event));
    assert.ok(validateAuditEvent(event), JSON.stringify(validateAuditEvent.errors));
  }
});

test("decoders and schemas agree on accepted and rejected state", () => {
  const at = "2026-09-15T12:00:00.000Z";
  const valid = {
    version: 1,
    sequence: 3,
    futureField: { kept: true },
    tasks: {
      T1: {
        id: "T1", status: "claimed", priority: 0, baseSha: "a".repeat(40), expectedPaths: ["src/**"],
        actualPaths: [], dependsOn: [], commits: [], warnings: [], validations: [], createdAt: at, updatedAt: at,
        lease: { tokenHash: "h", holder: "agent", acquiredAt: at, heartbeatAt: at, expiresAt: at },
      },
    },
    batches: {},
  };
  const cases: Array<[string, (state: Record<string, any>) => void]> = [
    ["missing tasks", (state) => { delete state.tasks; }],
    ["negative sequence", (state) => { state.sequence = -1; }],
    ["unknown task status", (state) => { state.tasks.T1.status = "lost"; }],
    ["non-array paths", (state) => { state.tasks.T1.expectedPaths = "src/**"; }],
    ["lease without holder", (state) => { delete state.tasks.T1.lease.holder; }],
    ["non-integer sequence", (state) => { state.sequence = 1.5; }],
  ];
  decodeBrokerState(structuredClone(valid));
  assert.ok(validateState(valid), JSON.stringify(validateState.errors));
  for (const [name, mutate] of cases) {
    const state = structuredClone(valid) as Record<string, any>;
    mutate(state);
    assert.equal(validateState(state), false, `schema accepted ${name}`);
    assert.throws(
      () => decodeBrokerState(structuredClone(state)),
      (error: unknown) => error instanceof BrokerError && error.code === "STATE_CORRUPT",
      `decoder accepted ${name}`,
    );
  }
  const unsupported = { ...structuredClone(valid), version: 2 };
  assert.equal(validateState(unsupported), false);
  assert.throws(() => decodeBrokerState(unsupported), (error: unknown) => error instanceof BrokerError && error.code === "STATE_VERSION");
});

test("archive slices written before versioning remain readable", async (context) => {
  const broker = await exercisedRepository(context);
  const [file] = (await readdir(broker.store.archiveDirectory)).filter((name) => name.startsWith("state-"));
  const target = path.join(broker.store.archiveDirectory, file!);
  const slice = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  delete slice.version;
  await writeFile(target, `${JSON.stringify(slice, null, 2)}\n`, "utf8");
  assert.ok(validateArchivedState(slice), JSON.stringify(validateArchivedState.errors));
  const [legacy] = await broker.store.readArchivedState();
  assert.equal(legacy?.version, undefined);
  assert.deepEqual(Object.keys(legacy?.tasks ?? {}).sort(), ["FORMAT-A", "FORMAT-B"]);

  // An unknown future version is not reinterpreted as version 1.
  await writeFile(target, `${JSON.stringify({ ...slice, version: 2 }, null, 2)}\n`, "utf8");
  assert.deepEqual(await broker.store.readArchivedState(), []);
});
