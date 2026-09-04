import assert from "node:assert/strict";
import test from "node:test";
import {
  describeServeEvent,
  formatServeEvent,
  isErrorEvent,
  serveEventJson,
  shouldReportIdle,
  HEARTBEAT_INTERVAL_MS,
} from "./serve-log.js";

const NOW = new Date("2026-08-18T04:30:00.000Z");

test("announces that a batch is starting, not only that one finished", () => {
  // The regression: validators run for minutes, and with no line at the start
  // the log stayed empty while the loop was working hardest. A service that
  // looks dead gets restarted, and restarting mid-integration abandons a batch.
  const line = describeServeEvent({ kind: "integrating", tasks: ["agent/a", "agent/b"] });
  assert.match(line, /integrating 2 task\(s\)/);
  assert.match(line, /agent\/a, agent\/b/);
});

test("reports abandoned integration recovery", () => {
  assert.equal(
    describeServeEvent({
      kind: "recovered",
      batches: ["old-batch"],
      tasks: ["TASK-1", "TASK-2"],
      submissions: ["submission-1"],
    }),
    "recovered 1 abandoned batch(es); requeued 2 task(s); recovered 1 candidate submission(s)",
  );
});

test("makes publication recovery and its failures visible", () => {
  assert.equal(
    describeServeEvent({
      kind: "publication-retrying",
      batchId: "batch-1",
      reason: "pending auto-merge",
    }),
    "retrying pending auto-merge for batch batch-1",
  );
  assert.match(
    describeServeEvent({
      kind: "publication-retried",
      batchId: "batch-1",
      state: "published",
      autoMergeEnabled: true,
    }),
    /publication retry completed \(published, auto-merge enabled\)/u,
  );
  assert.equal(
    isErrorEvent({ kind: "publication-failed", batchId: "batch-1", message: "forge unavailable" }),
    true,
  );
  assert.equal(
    describeServeEvent({
      kind: "batch-refreshed",
      batchId: "batch-1",
      replacementBatchId: "batch-2",
      state: "published",
    }),
    "batch batch-1 was stale; replacement batch-2 is published",
  );
});

test("every line carries a timestamp", () => {
  const line = formatServeEvent({ kind: "merged", batchId: "20260818T040141471Z-ff92fd" }, NOW);
  assert.ok(line.startsWith("2026-08-18T04:30:00.000Z "));
  assert.match(line, /merged/);
});

test("says what it started with, so a service that came up wrong is visible", () => {
  const line = describeServeEvent({
    kind: "started",
    version: "0.6.0",
    repository: "/Users/dev/PowerHouse-CRM",
    intervalSeconds: 15,
    publish: true,
    eager: true,
  });
  assert.match(line, /serve 0\.6\.0 watching \/Users\/dev\/PowerHouse-CRM every 15s/);
  assert.match(line, /publish=true, eager=true/);
});

test("routes failures to stderr and progress to stdout", () => {
  assert.equal(isErrorEvent({ kind: "failed", message: "boom" }), true);
  assert.equal(isErrorEvent({ kind: "sync-failed", batchId: "b", message: "boom" }), true);
  // A batch closed without merging needs a human or worker to revise it.
  assert.equal(isErrorEvent({ kind: "closed", batchId: "b" }), true);
  assert.equal(isErrorEvent({ kind: "integrating", tasks: [] }), false);
  assert.equal(isErrorEvent({ kind: "merged", batchId: "b" }), false);
});

test("says that a closed batch is paused instead of implying an automatic retry", () => {
  assert.equal(
    describeServeEvent({ kind: "closed", batchId: "b-1" }),
    "batch b-1 closed without merging; its tasks are paused for revision",
  );
});

test("reports idleness on a slower clock than the poll", () => {
  // At a 15s poll, a line per cycle would be 5,760 a day and nobody reads that.
  const start = Date.parse("2026-08-18T04:00:00.000Z");
  assert.equal(shouldReportIdle(start, start + 15_000), false);
  assert.equal(shouldReportIdle(start, start + HEARTBEAT_INTERVAL_MS - 1), false);
  assert.equal(shouldReportIdle(start, start + HEARTBEAT_INTERVAL_MS), true);
});

test("distinguishes idle-with-work-waiting from idle-with-nothing", () => {
  assert.match(
    describeServeEvent({ kind: "idle", waiting: 2, quietSeconds: 600 }),
    /2 task\(s\) waiting to fill a batch/,
  );
  assert.match(
    describeServeEvent({ kind: "idle", waiting: 0, quietSeconds: 600 }),
    /nothing submitted/,
  );
});

test("emits one JSON object per line when asked", () => {
  const parsed = JSON.parse(serveEventJson({ kind: "merged", batchId: "b-1" }, NOW));
  assert.deepEqual(parsed, { at: "2026-08-18T04:30:00.000Z", kind: "merged", batchId: "b-1" });
});

test("says it is stopping rather than vanishing", () => {
  assert.match(describeServeEvent({ kind: "stopped", signal: "SIGTERM" }), /stopping on SIGTERM/);
});
