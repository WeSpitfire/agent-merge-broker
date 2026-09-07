import { BrokerError } from "./errors.js";
import { STATE_VERSION, type CurrentBrokerState, type SubmissionRecord } from "./types.js";

type Check = (value: unknown, location: string) => void;

function corrupt(location: string, expected: string): never {
  throw new BrokerError("STATE_CORRUPT", `Broker state ${location} must be ${expected}.`, {
    path: location,
    expected,
  });
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corrupt(location, "an object");
  }
  return value as Record<string, unknown>;
}

const string: Check = (value, location) => {
  if (typeof value !== "string") corrupt(location, "a string");
};
const timestamp: Check = (value, location) => {
  string(value, location);
  if (!Number.isFinite(Date.parse(value as string))) corrupt(location, "a valid timestamp string");
};
const boolean: Check = (value, location) => {
  if (typeof value !== "boolean") corrupt(location, "a boolean");
};
const finiteNumber: Check = (value, location) => {
  if (typeof value !== "number" || !Number.isFinite(value)) corrupt(location, "a finite number");
};
const integer: Check = (value, location) => {
  if (!Number.isSafeInteger(value)) corrupt(location, "a safe integer");
};
const nonnegativeInteger: Check = (value, location) => {
  integer(value, location);
  if ((value as number) < 0) corrupt(location, "a nonnegative safe integer");
};

function oneOf(...values: (string | number)[]): Check {
  return (value, location) => {
    if (!values.includes(value as string | number)) corrupt(location, values.map(String).join(" or "));
  };
}

function array(check: Check): Check {
  return (value, location) => {
    if (!Array.isArray(value)) corrupt(location, "an array");
    value.forEach((item, index) => check(item, `${location}[${index}]`));
  };
}

/** Inspect known fields in place so additive fields survive a normal read/write transaction. */
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value, location) => {
    const record = object(value, location);
    for (const [name, check] of Object.entries(required)) check(record[name], `${location}.${name}`);
    for (const [name, check] of Object.entries(optional)) {
      if (Object.hasOwn(record, name) && record[name] !== undefined) check(record[name], `${location}.${name}`);
    }
  };
}

function keyedRecords(check: Check): Check {
  return (value, location) => {
    const records = object(value, location);
    for (const [id, record] of Object.entries(records)) {
      const entryPath = `${location}[${JSON.stringify(id)}]`;
      check(record, entryPath);
      if ((record as Record<string, unknown>).id !== id) corrupt(`${entryPath}.id`, "the collection key");
    }
  };
}

const strings = array(string);
const validation = shape({
  name: string, command: string, scope: oneOf("focused", "authoritative"),
  // Historical validators subtract wall-clock dates; a clock rollback can yield a negative
  // duration. Preserve that finite receipt instead of making otherwise valid saved state unreadable.
  startedAt: timestamp, finishedAt: timestamp, durationMs: finiteNumber, exitCode: integer,
  stdout: string, stderr: string,
}, { taskId: string });
const validations = array(validation);
const verification = shape({
  name: string, source: oneOf("manual", "github-check"), status: oneOf("passed", "failed"),
  candidateSha: string, baseSha: string, policyRevision: string, actor: string, recordedAt: timestamp,
}, { evidenceUrl: string, notes: string });
const approval = shape({
  candidateSha: string, baseSha: string, policyRevision: string, actor: string, approvedAt: timestamp,
}, { confirmedAt: timestamp, revocationRequestedAt: timestamp, revocationReason: string });
const candidate = shape({
  revision: nonnegativeInteger, sha: string, baseSha: string, policyRevision: string,
  state: oneOf("verifying", "ready_for_approval", "approved", "merging", "changes_requested",
    "verification_failed", "superseded", "blocked", "abandoned", "merged"),
  requiredVerifications: strings, verifications: array(verification), createdAt: timestamp,
}, { approval, reason: string });
const lease = shape({
  tokenHash: string, holder: string, acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: timestamp,
});
const task = shape({
  id: string, status: oneOf("registered", "claimed", "submitted", "integrating", "batched",
    "published", "merged", "failed", "cancelled"),
  priority: finiteNumber, baseSha: string, expectedPaths: strings, actualPaths: strings,
  dependsOn: strings, commits: strings, warnings: strings, validations, createdAt: timestamp, updatedAt: timestamp,
}, {
  title: string, agent: string, worktree: string, lease, submittedAt: timestamp, batchedAt: timestamp,
  publishedAt: timestamp, mergedAt: timestamp, batchId: string, lastError: string, attempts: nonnegativeInteger,
});

const batchRequired = {
  id: string, status: oneOf("running", "verified", "prepared", "published", "merged", "closed", "failed"),
  taskIds: strings, baseBranch: string, baseSha: string, validations, createdAt: timestamp,
};
const batchOptional = {
  validationAuthority: oneOf("broker", "required-ci"), remote: string,
  publicationMode: oneOf("none", "branch", "pull-request"), remoteUrlFingerprint: string,
  forgeRepository: string, branchName: string, headSha: string, candidate,
  candidateHistory: array(candidate), integratedHeadSha: string, provenancePath: string,
  worktree: string, finishedAt: timestamp, publishedAt: timestamp, pullRequestUrl: string,
  autoMergeEnabled: boolean, autoMergePending: boolean,
  changeRequestIntent: shape({
    candidateSha: string, baseSha: string, actor: string, reason: string, requestedAt: timestamp,
  }, { policyRevision: string }),
  publishWarning: string, refreshRequired: boolean,
  refreshCloseIntent: shape({ pullRequestUrl: string, targetBaseSha: string, startedAt: timestamp }, { nonce: string }),
  closedAt: timestamp, error: string,
};
const revisionIntent = shape({
  revision: nonnegativeInteger, taskId: string, previousCandidateSha: string, candidateSha: string,
  branchName: string, createdAt: timestamp,
  // This is the prepared batch snapshot, not another pending transaction. Do not recurse through
  // unknown fields: historical additive data must not create unbounded decoder recursion.
  nextBatch: shape(batchRequired, batchOptional),
  revisedTask: shape({ commits: strings, actualPaths: strings, warnings: strings, submittedAt: timestamp }),
});
const batch = shape(batchRequired, { ...batchOptional, revisionIntent });
const submission = shape({
  version: oneOf(1), id: string,
  status: oneOf("received", "validating", "validated", "rejected", "failed", "abandoned"),
  authorityDigest: string,
  source: shape({ kind: oneOf("local-ref"), ref: string }),
  artifact: shape({ kind: oneOf("git-commit"), sha: string, treeSha: string, retainedRef: string }),
  base: shape({ ref: string, baseBranch: string, remote: string, sha: string }, { fetchUrlFingerprint: string }),
  policy: shape({
    baseSha: string, configPath: string, configBlobSha: string, digest: string,
    revision: string, evaluatorVersion: string, configVersion: nonnegativeInteger,
  }),
  commits: strings, paths: strings, validations, createdAt: timestamp, updatedAt: timestamp,
}, {
  worktree: string, worktreeIdentity: shape({ device: string, inode: string }),
  retentionEstablishedAt: timestamp, retentionCompromisedAt: timestamp,
  validationStartedAt: timestamp, finishedAt: timestamp, errorCode: string, error: string,
  abandonedAt: timestamp, abandonReason: string,
  archiveIntent: shape({ requestedAt: timestamp, releaseArtifact: boolean }),
  archivedAt: timestamp, artifactReleasedAt: timestamp,
});

/** Decode saved v1 state without dropping unknown fields or rewriting supported legacy records. */
export function decodeBrokerState(value: unknown): CurrentBrokerState {
  const state = object(value, "$");
  if (!Object.hasOwn(state, "version")) corrupt("$.version", "a supported state version");
  if (state.version !== STATE_VERSION) {
    throw new BrokerError("STATE_VERSION", `Unsupported broker state version: ${String(state.version)}`);
  }
  shape({ sequence: nonnegativeInteger, tasks: keyedRecords(task), batches: keyedRecords(batch) }, {
    submissions: keyedRecords(submission),
  })(state, "$");
  // The only additive v1 default. Other optional legacy fields stay absent so their compatibility
  // semantics remain in the components that understand them.
  if (state.submissions === undefined) state.submissions = {};
  return state as unknown as CurrentBrokerState;
}

/** Shared decoder for archived submission manifests, with the same additive-field behavior. */
export function decodeSubmissionRecord(value: unknown, location = "$"): SubmissionRecord {
  submission(value, location);
  return value as SubmissionRecord;
}
