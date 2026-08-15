import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "./config.js";
import { scheduleTasks } from "./scheduler.js";
import { STATE_VERSION, type BrokerState, type TaskRecord } from "./types.js";

function task(
  id: string,
  paths: string[],
  options: { priority?: number; dependsOn?: string[]; status?: TaskRecord["status"] } = {},
): TaskRecord {
  return {
    id,
    status: options.status ?? "submitted",
    priority: options.priority ?? 0,
    baseSha: "a".repeat(40),
    expectedPaths: paths,
    actualPaths: paths,
    dependsOn: options.dependsOn ?? [],
    commits: [id.repeat(40).slice(0, 40)],
    warnings: [],
    validations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:00.000Z",
  };
}

function state(tasks: TaskRecord[]): BrokerState {
  return {
    version: STATE_VERSION,
    sequence: 0,
    tasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
    batches: {},
  };
}

test("selects a deterministic, non-overlapping batch by priority", () => {
  const plan = scheduleTasks(
    state([
      task("a", ["src/shared.ts"], { priority: 1 }),
      task("b", ["src/shared.ts"], { priority: 10 }),
      task("c", ["src/independent.ts"], { priority: 0 }),
    ]),
    defaultConfig(),
  );
  assert.deepEqual(
    plan.selected.map((item) => item.id),
    ["b", "c"],
  );
  assert.deepEqual(plan.rejected, [{ taskId: "a", reason: "conflicting change set", conflictsWith: "b" }]);
});

test("orders dependencies inside a batch and waits for unmerged dependencies", () => {
  const sameBatch = scheduleTasks(
    state([task("parent", ["src/parent.ts"]), task("child", ["src/child.ts"], { dependsOn: ["parent"] })]),
    defaultConfig(),
  );
  assert.deepEqual(
    sameBatch.selected.map((item) => item.id),
    ["parent", "child"],
  );

  const waiting = scheduleTasks(
    state([
      task("parent", ["src/parent.ts"], { status: "published" }),
      task("child", ["src/child.ts"], { dependsOn: ["parent"] }),
    ]),
    defaultConfig(),
  );
  assert.equal(waiting.selected.length, 0);
  assert.match(waiting.rejected[0]?.reason ?? "", /dependencies not integrated/u);
});

test("distinguishes a task that can never fit from one deferred to a later batch", () => {
  const config = defaultConfig();
  config.scheduling.maxCommits = 1;
  const oversized = task("oversized", ["src/oversized.ts"]);
  oversized.commits = ["a".repeat(40), "b".repeat(40)];

  const plan = scheduleTasks(state([oversized, task("small", ["src/small.ts"])]), config);
  assert.deepEqual(plan.selected.map((item) => item.id), ["small"]);
  assert.match(plan.rejected[0]?.reason ?? "", /can never fit scheduling\.maxCommits/u);
});

test("treats a merged dependency as ready", () => {
  const plan = scheduleTasks(
    state([
      task("parent", ["src/parent.ts"], { status: "merged" }),
      task("child", ["src/child.ts"], { dependsOn: ["parent"] }),
    ]),
    defaultConfig(),
  );
  assert.deepEqual(plan.selected.map((item) => item.id), ["child"]);
});
