import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { defaultConfig } from "./config.js";
import {
  GATE_AUTHORITY_VERSION,
  SUBMISSION_VERSION,
  type GateAuthorityRegistration,
  type SubmissionRecord,
} from "./types.js";

const schema = JSON.parse(
  await readFile(new URL("../schemas/config.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const candidateSchema = JSON.parse(
  await readFile(new URL("../schemas/candidate.schema.json", import.meta.url), "utf8"),
) as object;
const validateCandidate = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": true, uri: true },
}).compile(candidateSchema);
const submissionSchema = JSON.parse(
  await readFile(new URL("../schemas/submission.schema.json", import.meta.url), "utf8"),
) as object;
const validateSubmission = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": true },
}).compile(submissionSchema);
const gateAuthoritySchema = JSON.parse(
  await readFile(new URL("../schemas/gate-authority.schema.json", import.meta.url), "utf8"),
) as object;
const validateGateAuthority = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": true },
}).compile(gateAuthoritySchema);

function submission(): SubmissionRecord {
  const at = "2026-09-04T12:00:00.000Z";
  return {
    version: SUBMISSION_VERSION,
    id: "gate-candidate-1",
    status: "validating",
    authorityDigest: "9".repeat(64),
    source: { kind: "local-ref", ref: "refs/heads/agent/candidate" },
    artifact: {
      kind: "git-commit",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
      retainedRef: "refs/merge-broker/submissions/gate-candidate-1",
    },
    base: {
      ref: "refs/remotes/origin/main",
      baseBranch: "main",
      remote: "origin",
      fetchUrlFingerprint: "c".repeat(64),
      sha: "d".repeat(40),
    },
    policy: {
      baseSha: "d".repeat(40),
      configPath: ".merge-broker.json",
      configBlobSha: "e".repeat(40),
      digest: "f".repeat(64),
      revision: "protected-base-v1",
      evaluatorVersion: "agent-merge-broker/0.12.1",
      configVersion: 1,
    },
    commits: ["a".repeat(40)],
    paths: ["src/candidate.ts"],
    validations: [],
    worktree: "/broker-state/worktrees/gate-candidate-1",
    createdAt: at,
    updatedAt: at,
    validationStartedAt: at,
  };
}

function gateAuthority(): GateAuthorityRegistration {
  return {
    version: GATE_AUTHORITY_VERSION,
    kind: "trusted-local-ref",
    digest: "9".repeat(64),
    target: {
      baseRef: "refs/remotes/origin/main",
      baseBranch: "main",
      remote: "origin",
      refreshBase: true,
      fetchUrlFingerprint: "a".repeat(64),
    },
    stateDirectory: "merge-broker",
    registeredAt: "2026-09-04T12:00:00.000Z",
  };
}

test("the generated default configuration satisfies the published JSON schema", () => {
  const config = defaultConfig();
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("the JSON schema supports process-relative and native validator execution", () => {
  const config = defaultConfig();
  config.validation.authoritative = [{
    name: "Swift",
    command: "swift test",
    workingDirectory: "Desktop",
    executionArchitecture: "native",
  }];
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  const validator = config.validation.authoritative[0] as { executionArchitecture: string };
  validator.executionArchitecture = "arm64";
  assert.equal(validate(config), false);
});

test("the JSON schema supports only declared validator path-input modes", () => {
  const config = defaultConfig();
  config.validation.authoritative = [{ name: "large repository", command: "npm test", filesInput: "json" }];
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  const validator = config.validation.authoritative[0] as { filesInput: string };
  validator.filesInput = "truncate";
  assert.equal(validate(config), false);
});

test("the JSON schema rejects validator working directories outside the repository", () => {
  for (const workingDirectory of ["../outside", "/absolute", "C:\\absolute", "C:drive-relative", "\\\\server\\share"]) {
    const config = defaultConfig();
    config.validation.authoritative = [{ name: "invalid", command: "test", workingDirectory }];
    assert.equal(validate(config), false, `${workingDirectory} should not satisfy the schema`);
  }
});

test("the JSON schema permits disabled auto-merge intent but rejects branch or draft publication", () => {
  const disabled = defaultConfig();
  disabled.publish.autoMerge = true;
  disabled.publish.mode = "none";
  assert.equal(validate(disabled), true, JSON.stringify(validate.errors));

  const config = defaultConfig();
  config.publish.autoMerge = true;
  config.publish.mode = "branch";
  assert.equal(validate(config), false);
  config.publish.mode = "pull-request";
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  config.publish.draft = true;
  assert.equal(validate(config), false);
});

test("the JSON schema accepts only explicit forge repository selectors", () => {
  const config = defaultConfig();
  config.publish.mode = "pull-request";
  config.publish.repository = "github.corp.example/owner/repository";
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  for (const repository of ["owner", "https://github.com/owner/repository", "owner/repository.git"]) {
    config.publish.repository = repository;
    assert.equal(validate(config), false, `${repository} should not satisfy the schema`);
  }
});

test("the candidate schema accepts a causally confirmed exact approval", () => {
  const sha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const candidate = {
    revision: 1,
    sha,
    baseSha,
    policyRevision: "release-v1",
    state: "approved",
    requiredVerifications: [],
    verifications: [],
    createdAt: "2026-09-03T12:00:00.000Z",
    approval: {
      candidateSha: sha,
      baseSha,
      policyRevision: "release-v1",
      actor: "release-manager",
      approvedAt: "2026-09-03T12:01:00.000Z",
      confirmedAt: "2026-09-03T12:01:01.000Z",
    },
  };
  assert.equal(validateCandidate(candidate), true, JSON.stringify(validateCandidate.errors));

  const revokingCandidate = {
    ...candidate,
    approval: {
      ...candidate.approval,
      revocationRequestedAt: "2026-09-03T12:02:00.000Z",
      revocationReason: "Required check changed after approval.",
    },
  };
  assert.equal(validateCandidate(revokingCandidate), true, JSON.stringify(validateCandidate.errors));
});

test("the submission schema requires immutable artifact, target, and protected-base policy identities", () => {
  const value = submission();
  assert.equal(validateSubmission(value), true, JSON.stringify(validateSubmission.errors));

  const invalidDigest = structuredClone(value) as SubmissionRecord;
  invalidDigest.policy.digest = "not-a-digest";
  assert.equal(validateSubmission(invalidDigest), false);

  const invalidTree = structuredClone(value) as SubmissionRecord;
  invalidTree.artifact.treeSha = "a".repeat(39);
  assert.equal(validateSubmission(invalidTree), false);

  const missingRemote = structuredClone(value) as unknown as {
    base: { remote?: string };
  };
  delete missingRemote.base.remote;
  assert.equal(validateSubmission(missingRemote), false);
});

test("the submission schema exposes validation-only lifecycle and stable failure codes", () => {
  const value = submission();
  const unsupported = structuredClone(value) as unknown as { status: string };
  unsupported.status = "approved";
  assert.equal(validateSubmission(unsupported), false);

  const rejected = structuredClone(value);
  rejected.status = "rejected";
  rejected.errorCode = "VALIDATION_FAILED";
  rejected.error = "Authoritative validation failed.";
  rejected.finishedAt = "2026-09-04T12:01:00.000Z";
  assert.equal(validateSubmission(rejected), true, JSON.stringify(validateSubmission.errors));

  rejected.errorCode = "";
  assert.equal(validateSubmission(rejected), false);
});

test("the Gate authority schema exposes only a fingerprinted protected-target locator", () => {
  const value = gateAuthority();
  assert.equal(validateGateAuthority(value), true, JSON.stringify(validateGateAuthority.errors));

  const rawRemote = structuredClone(value) as unknown as {
    target: { remoteUrl?: string };
  };
  rawRemote.target.remoteUrl = "https://credentials@example.invalid/owner/repo.git";
  assert.equal(validateGateAuthority(rawRemote), false);

  const outsideState = structuredClone(value);
  outsideState.stateDirectory = "../alternate-state";
  assert.equal(validateGateAuthority(outsideState), false);
});
