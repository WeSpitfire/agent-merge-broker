import { BrokerError } from "./errors.js";
import {
  ARCHIVED_STATE_VERSION,
  STATE_VERSION,
  type ArchivedStateSlice,
  type AuditEvent,
  type CurrentBrokerState,
  type SubmissionRecord,
} from "./types.js";

/** A JSON Schema fragment. Every decoder check carries the schema that describes what it accepts. */
export type JsonSchema = Record<string, unknown>;

interface Check {
  (value: unknown, location: string): void;
  readonly schema: JsonSchema;
}

function check(validate: (value: unknown, location: string) => void, schema: JsonSchema): Check {
  return Object.assign(validate, { schema });
}

/** Named definitions shared by generated document schemas through `$ref`. */
const definitions = new Map<string, JsonSchema>();

function define(name: string, target: Check): Check {
  definitions.set(name, target.schema);
  return check(target, { $ref: `#/$defs/${name}` });
}

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

const string = check((value, location) => {
  if (typeof value !== "string") corrupt(location, "a string");
}, { type: "string" });
// The broker writes RFC 3339 timestamps; saved state is read with Date.parse for older records.
const timestamp = check((value, location) => {
  string(value, location);
  if (!Number.isFinite(Date.parse(value as string))) corrupt(location, "a valid timestamp string");
}, { type: "string", format: "date-time" });
const boolean = check((value, location) => {
  if (typeof value !== "boolean") corrupt(location, "a boolean");
}, { type: "boolean" });
const finiteNumber = check((value, location) => {
  if (typeof value !== "number" || !Number.isFinite(value)) corrupt(location, "a finite number");
}, { type: "number" });
const integer = check((value, location) => {
  if (!Number.isSafeInteger(value)) corrupt(location, "a safe integer");
}, { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const nonnegativeInteger = check((value, location) => {
  integer(value, location);
  if ((value as number) < 0) corrupt(location, "a nonnegative safe integer");
}, { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

function oneOf(...values: (string | number)[]): Check {
  return check((value, location) => {
    if (!values.includes(value as string | number)) corrupt(location, values.map(String).join(" or "));
  }, values.length === 1 ? { const: values[0] } : { enum: values });
}

function array(item: Check): Check {
  return check((value, location) => {
    if (!Array.isArray(value)) corrupt(location, "an array");
    value.forEach((entry, index) => item(entry, `${location}[${index}]`));
  }, { type: "array", items: item.schema });
}

/** Inspect known fields in place so additive fields survive a normal read/write transaction. */
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return check((value, location) => {
    const record = object(value, location);
    for (const [name, field] of Object.entries(required)) field(record[name], `${location}.${name}`);
    for (const [name, field] of Object.entries(optional)) {
      if (Object.hasOwn(record, name) && record[name] !== undefined) field(record[name], `${location}.${name}`);
    }
  }, {
    type: "object",
    required: Object.keys(required),
    properties: Object.fromEntries(
      [...Object.entries(required), ...Object.entries(optional)].map(([name, field]) => [name, field.schema]),
    ),
    // Unknown additive fields are preserved on read and write.
    additionalProperties: true,
  });
}

function keyedRecords(record: Check): Check {
  return check((value, location) => {
    const records = object(value, location);
    for (const [id, entry] of Object.entries(records)) {
      const entryPath = `${location}[${JSON.stringify(id)}]`;
      record(entry, entryPath);
      if ((entry as Record<string, unknown>).id !== id) corrupt(`${entryPath}.id`, "the collection key");
    }
  }, {
    type: "object",
    description: "Records keyed by their id; each record's id must equal its key.",
    additionalProperties: record.schema,
  });
}

const strings = array(string);
const validation = define("validationResult", shape({
  name: string, command: string, scope: oneOf("focused", "authoritative"),
  // Historical validators subtract wall-clock dates; a clock rollback can yield a negative
  // duration. Preserve that finite receipt instead of making otherwise valid saved state unreadable.
  startedAt: timestamp, finishedAt: timestamp, durationMs: finiteNumber, exitCode: integer,
  stdout: string, stderr: string,
}, { taskId: string }));
const validations = array(validation);
const verification = define("verificationEvidence", shape({
  name: string, source: oneOf("manual", "github-check"), status: oneOf("passed", "failed"),
  candidateSha: string, baseSha: string, policyRevision: string, actor: string, recordedAt: timestamp,
}, { evidenceUrl: string, notes: string }));
const approval = define("approval", shape({
  candidateSha: string, baseSha: string, policyRevision: string, actor: string, approvedAt: timestamp,
}, { confirmedAt: timestamp, revocationRequestedAt: timestamp, revocationReason: string }));
const candidate = define("candidate", shape({
  revision: nonnegativeInteger, sha: string, baseSha: string, policyRevision: string,
  state: oneOf("verifying", "ready_for_approval", "approved", "merging", "changes_requested",
    "verification_failed", "superseded", "blocked", "abandoned", "merged"),
  requiredVerifications: strings, verifications: array(verification), createdAt: timestamp,
}, { approval, reason: string }));
const lease = define("lease", shape({
  tokenHash: string, holder: string, acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: timestamp,
}));
const task = define("task", shape({
  id: string, status: oneOf("registered", "claimed", "submitted", "integrating", "batched",
    "published", "merged", "failed", "cancelled"),
  priority: finiteNumber, baseSha: string, expectedPaths: strings, actualPaths: strings,
  dependsOn: strings, commits: strings, warnings: strings, validations, createdAt: timestamp, updatedAt: timestamp,
}, {
  title: string, agent: string, worktree: string, lease, submittedAt: timestamp, batchedAt: timestamp,
  publishedAt: timestamp, mergedAt: timestamp, batchId: string, lastError: string, attempts: nonnegativeInteger,
}));

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
  nextBatch: define("batchSnapshot", shape(batchRequired, batchOptional)),
  revisedTask: shape({ commits: strings, actualPaths: strings, warnings: strings, submittedAt: timestamp }),
});
const batch = define("batch", shape(batchRequired, { ...batchOptional, revisionIntent }));
const submission = define("submission", shape({
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
}));

const brokerState = shape({
  version: oneOf(STATE_VERSION), sequence: nonnegativeInteger, tasks: keyedRecords(task), batches: keyedRecords(batch),
}, { submissions: keyedRecords(submission) });

/** Decode saved v1 state without dropping unknown fields or rewriting supported legacy records. */
export function decodeBrokerState(value: unknown): CurrentBrokerState {
  const state = object(value, "$");
  if (!Object.hasOwn(state, "version")) corrupt("$.version", "a supported state version");
  if (state.version !== STATE_VERSION) {
    throw new BrokerError("STATE_VERSION", `Unsupported broker state version: ${String(state.version)}`);
  }
  brokerState(state, "$");
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

const archivedStateSlice = shape({ tasks: keyedRecords(task), batches: keyedRecords(batch) }, {
  // Slices written before 0.16.0 have no version; they are version 1.
  version: oneOf(ARCHIVED_STATE_VERSION), archivedAt: timestamp, cutoff: timestamp,
});

/** Decode one archived slice of pruned tasks and batches. */
export function decodeArchivedStateSlice(value: unknown, location = "$"): ArchivedStateSlice {
  archivedStateSlice(value, location);
  return value as ArchivedStateSlice;
}

const auditEvent = shape({ sequence: nonnegativeInteger, at: timestamp, event: string }, {
  actor: string, taskId: string, batchId: string, submissionId: string,
  details: check((value, location) => {
    object(value, location);
  }, { type: "object", additionalProperties: true }),
});

/** Validate the stable envelope of one audit record; event names and details are informational. */
export function isAuditEvent(value: unknown): value is AuditEvent {
  try {
    auditEvent(value, "$");
    return true;
  } catch {
    return false;
  }
}

function referencedDefinitions(schema: unknown, found = new Map<string, JsonSchema>()): Map<string, JsonSchema> {
  if (Array.isArray(schema)) {
    for (const item of schema) referencedDefinitions(item, found);
  } else if (schema && typeof schema === "object") {
    const ref = (schema as { $ref?: unknown }).$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
      const name = ref.slice("#/$defs/".length);
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Unknown schema definition: ${name}`);
      if (!found.has(name)) {
        found.set(name, definition);
        referencedDefinitions(definition, found);
      }
    }
    for (const value of Object.values(schema)) referencedDefinitions(value, found);
  }
  return found;
}

function documentSchema(name: string, root: Check, title: string, description: string): JsonSchema {
  const defs = referencedDefinitions(root.schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:agent-merge-broker:schema:${name}:v1`,
    title,
    description,
    ...root.schema,
    ...(defs.size > 0
      ? { $defs: Object.fromEntries([...defs].sort(([left], [right]) => left.localeCompare(right))) }
      : {}),
  };
}

/**
 * JSON Schemas generated from the runtime decoders, so the published schema and the reader cannot
 * drift. Decoders additionally require each keyed record's id to equal its collection key.
 */
export function savedFormatSchemas(): Record<"state" | "archived-state" | "audit-event", JsonSchema> {
  return {
    state: documentSchema(
      "state",
      brokerState,
      "Agent Merge Broker state v1",
      "Broker runtime state (state.json) under Git's common directory. Readers preserve unknown fields. A record in tasks, batches, or submissions must have an id equal to its key.",
    ),
    "archived-state": documentSchema(
      "archived-state",
      archivedStateSlice,
      "Agent Merge Broker archived state slice v1",
      "Tasks and batches retired from state.json by prune. Slices written before 0.16.0 omit version and are version 1.",
    ),
    "audit-event": documentSchema(
      "audit-event",
      auditEvent,
      "Agent Merge Broker audit event v1",
      "One JSON line of the append-only audit stream, including rotated and gzip-compacted segments. The envelope is stable; event names and details are informational and may gain values in minor releases.",
    ),
  };
}
