import assert from "node:assert/strict";
import test from "node:test";
import { BrokerError } from "./errors.js";
import { decodeBrokerState, decodeSubmissionRecord } from "./state-codec.js";
import type { CurrentBrokerState } from "./types.js";

function fixture(): CurrentBrokerState {
  const at = "2026-09-06T12:00:00.000Z";
  return {
    version: 1, sequence: 12,
    tasks: {
      task: {
        id: "task", status: "submitted", priority: 0, baseSha: "a".repeat(40),
        expectedPaths: ["src/**"], actualPaths: ["src/change.ts"], dependsOn: [],
        commits: ["b".repeat(40)], warnings: [], validations: [], createdAt: at, updatedAt: at,
      },
    },
    batches: {
      batch: {
        id: "batch", status: "prepared", taskIds: ["task"], baseBranch: "main",
        baseSha: "a".repeat(40), validations: [], createdAt: at,
        candidate: {
          revision: 1, sha: "b".repeat(40), baseSha: "a".repeat(40), policyRevision: "default",
          state: "approved", requiredVerifications: ["review"], createdAt: at,
          verifications: [{
            name: "review", source: "manual", status: "passed", candidateSha: "b".repeat(40),
            baseSha: "a".repeat(40), policyRevision: "default", actor: "reviewer", recordedAt: at,
          }],
          approval: {
            candidateSha: "b".repeat(40), baseSha: "a".repeat(40), policyRevision: "default",
            actor: "reviewer", approvedAt: at,
          },
        },
      },
    },
    submissions: {
      submission: {
        version: 1, id: "submission", status: "validated", authorityDigest: "f".repeat(64),
        source: { kind: "local-ref", ref: "producer/candidate" },
        artifact: {
          kind: "git-commit", sha: "b".repeat(40), treeSha: "c".repeat(40),
          retainedRef: "refs/merge-broker/adopted/submission",
        },
        base: { ref: "main", baseBranch: "main", remote: "origin", sha: "a".repeat(40) },
        policy: {
          baseSha: "a".repeat(40), configPath: ".merge-broker/config.json",
          configBlobSha: "d".repeat(40), digest: "e".repeat(64), revision: "default",
          evaluatorVersion: "agent-merge-broker/0.13.0", configVersion: 1,
        },
        commits: ["b".repeat(40)], paths: ["src/change.ts"], createdAt: at, updatedAt: at,
        validations: [{
          name: "tests", command: "node --test", scope: "authoritative", startedAt: at,
          finishedAt: at, durationMs: 0, exitCode: 0, stdout: "passed", stderr: "",
        }],
      },
    },
  };
}

function corruptAt(value: unknown, expectedPath: string): void {
  assert.throws(() => decodeBrokerState(value), (error: unknown) => {
    assert.ok(error instanceof BrokerError);
    assert.equal(error.code, "STATE_CORRUPT");
    assert.equal(error.details?.path, expectedPath);
    assert.match(error.message, /Broker state/u);
    return true;
  });
}

test("state decoder preserves additive fields and supported legacy omissions", () => {
  const current = fixture();
  Object.assign(current, { futureEnvelope: { enabled: true } });
  Object.assign(current.tasks.task!, { futureTask: [1, 2] });
  Object.assign(current.batches.batch!.candidate!.approval!, { futureApproval: "preserved" });
  const original = structuredClone(current);
  assert.equal(decodeBrokerState(current), current);
  assert.deepEqual(current, original);
  assert.equal(current.batches.batch!.validationAuthority, undefined);
  assert.equal(current.submissions.submission!.worktreeIdentity, undefined);
  const legacy = { version: 1, sequence: 0, tasks: {}, batches: {}, futureEnvelope: true };
  assert.deepEqual(decodeBrokerState(legacy), { ...legacy, submissions: {} });
});

test("state decoder reports envelope and keyed collection corruption before use", () => {
  corruptAt(null, "$");
  corruptAt([], "$");
  corruptAt({}, "$.version");
  for (const sequence of [-1, 0.5, NaN, Infinity, "12", Number.MAX_SAFE_INTEGER + 1]) {
    corruptAt({ ...fixture(), sequence }, "$.sequence");
  }
  corruptAt({ ...fixture(), tasks: [] }, "$.tasks");
  corruptAt({ ...fixture(), batches: null }, "$.batches");
  corruptAt({ ...fixture(), submissions: [] }, "$.submissions");
  const mismatched = fixture();
  mismatched.tasks.task!.id = "different";
  corruptAt(mismatched, '$.tasks["task"].id');
  assert.throws(() => decodeBrokerState({ ...fixture(), version: 2 }),
    (error: unknown) => error instanceof BrokerError && error.code === "STATE_VERSION");
});

test("state decoder reports nested task, approval, evidence, and validation paths", () => {
  const cases: [string, (state: CurrentBrokerState) => void][] = [
    ['$.tasks["task"].commits[0]', (state) => { Object.assign(state.tasks.task!, { commits: [false] }); }],
    ['$.tasks["task"].lease.expiresAt', (state) => {
      Object.assign(state.tasks.task!, { lease: {
        tokenHash: "token", holder: "agent", acquiredAt: state.tasks.task!.createdAt,
        heartbeatAt: state.tasks.task!.createdAt, expiresAt: null,
      } });
    }],
    ['$.batches["batch"].candidate.approval.actor', (state) => {
      Object.assign(state.batches.batch!.candidate!.approval!, { actor: ["reviewer"] });
    }],
    ['$.batches["batch"].candidate.verifications[0].status', (state) => {
      Object.assign(state.batches.batch!.candidate!.verifications[0]!, { status: "unknown" });
    }],
    ['$.submissions["submission"].validations[0].exitCode', (state) => {
      Object.assign(state.submissions.submission!.validations[0]!, { exitCode: "0" });
    }],
    ['$.submissions["submission"].policy.digest', (state) => {
      Object.assign(state.submissions.submission!.policy, { digest: null });
    }],
    ['$.submissions["submission"].createdAt', (state) => {
      state.submissions.submission!.createdAt = "invalid timestamp";
    }],
    ['$.submissions["submission"].validations[0].durationMs', (state) => {
      state.submissions.submission!.validations[0]!.durationMs = Infinity;
    }],
    ['$.submissions["submission"].archiveIntent.releaseArtifact', (state) => {
      Object.assign(state.submissions.submission!, { archiveIntent: {
        requestedAt: state.submissions.submission!.createdAt, releaseArtifact: "yes",
      } });
    }],
  ];
  for (const [location, change] of cases) {
    const state = fixture();
    change(state);
    corruptAt(state, location);
  }
});

test("state decoder preserves finite historical durations from a wall-clock rollback", () => {
  const state = fixture();
  state.submissions.submission!.validations[0]!.durationMs = -1_000;
  const expected = structuredClone(state);
  assert.equal(decodeBrokerState(state), state);
  assert.deepEqual(state, expected);
  for (const durationMs of [NaN, Infinity, -Infinity]) {
    const invalid = fixture();
    invalid.submissions.submission!.validations[0]!.durationMs = durationMs;
    corruptAt(invalid, '$.submissions["submission"].validations[0].durationMs');
  }
});

test("state decoder validates durable revision snapshots and their task receipt", () => {
  const state = fixture();
  const batch = state.batches.batch!;
  batch.revisionIntent = {
    revision: 2, taskId: "task", previousCandidateSha: "b".repeat(40), candidateSha: "c".repeat(40),
    branchName: "candidate", createdAt: batch.createdAt, nextBatch: structuredClone(batch),
    revisedTask: { commits: ["c".repeat(40)], actualPaths: ["src/change.ts"], warnings: [], submittedAt: batch.createdAt },
  };
  assert.equal(decodeBrokerState(state), state);
  Object.assign(batch.revisionIntent.nextBatch, { validations: "passed" });
  corruptAt(state, '$.batches["batch"].revisionIntent.nextBatch.validations');
});

test("individual archived submission decoding preserves lifecycle and additive data", () => {
  const archived = fixture().submissions.submission!;
  Object.assign(archived, {
    status: "abandoned", abandonedAt: archived.updatedAt, abandonReason: "No longer needed",
    archivedAt: archived.updatedAt, artifactReleasedAt: archived.updatedAt, futureManifest: true,
  });
  assert.equal(decodeSubmissionRecord(archived, "archive"), archived);
  Object.assign(archived.artifact, { sha: 42 });
  assert.throws(() => decodeSubmissionRecord(archived, "archive"),
    (error: unknown) => error instanceof BrokerError && error.details?.path === "archive.artifact.sha");
});
