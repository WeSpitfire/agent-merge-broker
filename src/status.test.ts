import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "./config.js";
import { formatBrokerStatus } from "./status.js";
import type { BatchRecord, BrokerState, SubmissionRecord, TaskRecord } from "./types.js";

const at = "2026-09-03T12:00:00.000Z";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "TASK-A",
    status: "submitted",
    priority: 0,
    baseSha: "a".repeat(40),
    expectedPaths: ["src/**"],
    actualPaths: ["src/a.ts"],
    dependsOn: [],
    commits: ["b".repeat(40)],
    warnings: [],
    validations: [],
    createdAt: at,
    updatedAt: at,
    submittedAt: at,
    ...overrides,
  };
}

function batch(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: "BATCH-A",
    status: "prepared",
    taskIds: ["TASK-A"],
    validationAuthority: "broker",
    baseBranch: "main",
    baseSha: "a".repeat(40),
    branchName: "merge-broker/BATCH-A",
    headSha: "b".repeat(40),
    validations: [],
    createdAt: at,
    finishedAt: at,
    ...overrides,
  };
}

function submission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    version: 1,
    id: "submission-1",
    status: "validating",
    authorityDigest: "9".repeat(64),
    source: { kind: "local-ref", ref: "refs/heads/candidate" },
    artifact: {
      kind: "git-commit",
      sha: "b".repeat(40),
      treeSha: "c".repeat(40),
      retainedRef: "refs/merge-broker/adopted/submission-1",
    },
    base: { ref: "main", baseBranch: "main", remote: "origin", sha: "a".repeat(40) },
    policy: {
      baseSha: "a".repeat(40),
      configPath: ".merge-broker/config.json",
      configBlobSha: "d".repeat(40),
      digest: "e".repeat(64),
      revision: "default",
      evaluatorVersion: "agent-merge-broker/submission-policy/v1",
      configVersion: 1,
    },
    commits: ["b".repeat(40)],
    paths: ["candidate.ts"],
    validations: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

test("status includes batches and explains how to land a local prepared batch", () => {
  const state: BrokerState = {
    version: 1,
    sequence: 1,
    tasks: { "TASK-A": task({ status: "batched", batchId: "BATCH-A" }) },
    batches: { "BATCH-A": batch() },
  };

  const output = formatBrokerStatus(state, defaultConfig(), new Date(at));
  assert.match(output, /Batches \(1\)/u);
  assert.match(output, /BATCH-A\s+prepared/u);
  assert.match(output, /batch complete BATCH-A/u);
  assert.doesNotMatch(output, /batch publish BATCH-A/u);
});

test("status shows an actionable publish command and an expired lease", () => {
  const config = defaultConfig();
  config.publish.mode = "branch";
  const state: BrokerState = {
    version: 1,
    sequence: 2,
    tasks: {
      "TASK-A": task({ status: "batched", batchId: "BATCH-A" }),
      "TASK-B": task({
        id: "TASK-B",
        status: "claimed",
        commits: [],
        lease: {
          tokenHash: "hash",
          holder: "worker",
          acquiredAt: "2026-09-03T10:00:00.000Z",
          heartbeatAt: "2026-09-03T10:00:00.000Z",
          expiresAt: "2026-09-03T11:00:00.000Z",
        },
      }),
    },
    batches: { "BATCH-A": batch() },
  };

  const output = formatBrokerStatus(state, config, new Date(at));
  assert.match(output, /batch publish BATCH-A/u);
  assert.match(output, /lease for TASK-B expired/u);
});

test("status exposes validation-only candidate submissions and their recovery action", () => {
  const state: BrokerState = {
    version: 1,
    sequence: 1,
    tasks: {},
    batches: {},
    submissions: { "submission-1": submission() },
  };

  const output = formatBrokerStatus(state, defaultConfig(), new Date(at));
  assert.match(output, /Candidate submissions \(1\)/u);
  assert.match(output, /submission-1\s+validating/u);
  assert.match(output, /merge-broker recover/u);
});
