import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import test from "node:test";
import { BrokerError } from "./errors.js";
import { generateProvenanceSigningIdentity } from "./provenance.js";
import {
  SUBMISSION_ATTESTATION_PAYLOAD_TYPE,
  signSubmissionAttestation,
  verifySubmissionAttestation,
  type SubmissionAttestationEnvelope,
  type SubmissionAttestationVerificationOptions,
} from "./submission-attestation.js";
import type { SubmissionRecord } from "./types.js";

const identity = generateProvenanceSigningIdentity();
function submission(status: "validated" | "rejected" | "failed" = "validated"): SubmissionRecord {
  const startedAt = "2026-09-06T12:00:00.000Z";
  const finishedAt = "2026-09-06T12:00:01.000Z";
  return {
    version: 1,
    id: "candidate-1",
    status,
    authorityDigest: "9".repeat(64),
    source: { kind: "local-ref", ref: "refs/heads/producer" },
    artifact: { kind: "git-commit", sha: "a".repeat(40), treeSha: "b".repeat(40), retainedRef: "refs/merge-broker/submissions/candidate-1" },
    base: { sha: "c".repeat(40), ref: "refs/heads/main", baseBranch: "main", remote: "origin" },
    policy: {
      baseSha: "c".repeat(40), configPath: ".merge-broker/config.json", configBlobSha: "d".repeat(40),
      digest: "e".repeat(64), revision: "protected-v1", evaluatorVersion: "agent-merge-broker/0.13.0", configVersion: 1,
    },
    commits: ["a".repeat(40)],
    paths: ["file.txt"],
    validations: [{
      name: "tests ünicode", command: "SECRET_COMMAND", scope: "authoritative", startedAt, finishedAt,
      durationMs: 1000, exitCode: status === "rejected" ? 7 : 0, stdout: "SECRET_STDOUT", stderr: "SECRET_STDERR",
    }],
    createdAt: startedAt,
    updatedAt: finishedAt,
    retentionEstablishedAt: startedAt,
    validationStartedAt: startedAt,
    finishedAt,
    ...(status !== "validated" ? { error: "SECRET_ERROR", errorCode: status === "rejected" ? "VALIDATION_FAILED" : "SUBMISSION_FAILED" } : {}),
  };
}

function expected(record = submission()): SubmissionAttestationVerificationOptions {
  return {
    publicKey: identity.publicKey,
    expected: {
      candidateSha: record.artifact.sha, treeSha: record.artifact.treeSha, baseSha: record.base.sha,
      policyDigest: record.policy.digest, authorityDigest: record.authorityDigest,
      configBlobSha: record.policy.configBlobSha, evaluatorVersion: record.policy.evaluatorVersion,
    },
  };
}

function envelope(record = submission()): SubmissionAttestationEnvelope {
  return signSubmissionAttestation(record, identity.privateKey, identity.publicKey);
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof BrokerError && error.code === code;
}

// Independent DSSE PAE construction ensures this test does not share the implementation helper.
function externalPae(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), payload]);
}

function externallySigned(statement: unknown): SubmissionAttestationEnvelope {
  const bytes = Buffer.from(JSON.stringify(statement, null, 2));
  return {
    payloadType: SUBMISSION_ATTESTATION_PAYLOAD_TYPE,
    payload: bytes.toString("base64"),
    signatures: [{ sig: sign(null, externalPae(SUBMISSION_ATTESTATION_PAYLOAD_TYPE, bytes), identity.privateKey).toString("base64") }],
  };
}

test("detached Gate evidence authenticates the exact commit/tree and protected policy with DSSE PAE", () => {
  const record = submission();
  const before = structuredClone(record);
  const signed = envelope(record);
  const verified = verifySubmissionAttestation(signed, expected(record));
  assert.equal(verified.validationPassed, true);
  assert.equal(verified.mergeAuthorized, false);
  assert.equal(verified.purpose, "validation-evidence");
  assert.equal(verified.statement._type, "https://in-toto.io/Statement/v1");
  const bytes = Buffer.from(signed.payload, "base64");
  assert.equal(verify(null, externalPae(signed.payloadType, bytes), identity.publicKey, Buffer.from(signed.signatures[0]!.sig, "base64")), true);
  assert.deepEqual(record, before, "detached signing must not mutate the record or commit identity");
  assert.doesNotMatch(bytes.toString(), /SECRET_|stdout|stderr|command|retainedRef/);
});

test("a valid failure signature is validation evidence, never a success or merge authorization", () => {
  for (const outcome of ["rejected", "failed"] as const) {
    const verified = verifySubmissionAttestation(envelope(submission(outcome)), expected());
    assert.equal(verified.verified, true);
    assert.equal(verified.outcome, outcome);
    assert.equal(verified.validationPassed, false);
    assert.equal(verified.mergeAuthorized, false);
    assert.doesNotMatch(JSON.stringify(verified), /SECRET_/);
  }
});

test("offline verification rejects every unexpected artifact, base, authority, and policy binding", () => {
  const signed = envelope();
  for (const field of Object.keys(expected().expected) as Array<keyof SubmissionAttestationVerificationOptions["expected"]>) {
    const options = expected();
    options.expected[field] = "unexpected";
    assert.throws(() => verifySubmissionAttestation(signed, options), hasCode("SUBMISSION_ATTESTATION_IDENTITY_MISMATCH"), field);
  }
  const missing = expected();
  delete (missing.expected as Partial<typeof missing.expected>).policyDigest;
  assert.throws(() => verifySubmissionAttestation(signed, missing), hasCode("SUBMISSION_ATTESTATION_IDENTITY_MISMATCH"));
});

test("untrusted keys, altered payloads, signatures, and media types fail closed", () => {
  const signed = envelope();
  assert.throws(
    () => verifySubmissionAttestation(signed, { ...expected(), publicKey: generateProvenanceSigningIdentity().publicKey }),
    hasCode("SUBMISSION_ATTESTATION_SIGNATURE_INVALID"),
  );
  const changed = structuredClone(signed);
  changed.payload = Buffer.from(Buffer.from(signed.payload, "base64").toString().replace("candidate-1", "candidate-2")).toString("base64");
  assert.throws(() => verifySubmissionAttestation(changed, expected()), hasCode("SUBMISSION_ATTESTATION_SIGNATURE_INVALID"));
  const invalidSignature = structuredClone(signed);
  invalidSignature.signatures[0]!.sig = Buffer.alloc(64).toString("base64");
  assert.throws(() => verifySubmissionAttestation(invalidSignature, expected()), hasCode("SUBMISSION_ATTESTATION_SIGNATURE_INVALID"));
  assert.throws(() => verifySubmissionAttestation({ ...signed, payloadType: "application/json" }, expected()), hasCode("SUBMISSION_ATTESTATION_INVALID"));
});

test("DSSE keyid is only a hint, extensions are ignored, and both base64 alphabets are supported", () => {
  const signed = envelope();
  signed.signatures[0]!.keyid = "an-untrusted-hint";
  signed.payload = Buffer.from(signed.payload, "base64").toString("base64url");
  signed.signatures[0]!.sig = Buffer.from(signed.signatures[0]!.sig, "base64").toString("base64url");
  const result = verifySubmissionAttestation({ ...signed, futureEnvelopeField: true }, expected());
  assert.equal(result.validationPassed, true);
  assert.notEqual(result.keyId, "an-untrusted-hint");
  delete signed.signatures[0]!.keyid;
  assert.equal(verifySubmissionAttestation(signed, expected()).verified, true);
});

test("malformed or oversized base64 and envelopes are refused", () => {
  for (const payload of ["###", "A", "e30===", "e30=\n", "A".repeat(1_500_000)]) {
    assert.throws(() => verifySubmissionAttestation({ ...envelope(), payload }, expected()), hasCode("SUBMISSION_ATTESTATION_INVALID"));
  }
  assert.throws(() => verifySubmissionAttestation({ ...envelope(), signatures: [] }, expected()), hasCode("SUBMISSION_ATTESTATION_INVALID"));
});

test("signed foreign JSON is verified as serialized but unsupported or contradictory predicates are rejected", () => {
  const statement = verifySubmissionAttestation(envelope(), expected()).statement;
  assert.equal(verifySubmissionAttestation(externallySigned(statement), expected()).verified, true);
  for (const change of [
    (value: typeof statement) => { value.predicate.mergeAuthorized = true as false; },
    (value: typeof statement) => { value.predicate.version = 2 as 1; },
    (value: typeof statement) => { value.predicate.policy.baseSha = "1".repeat(40); },
    (value: typeof statement) => { value.predicate.validators[0]!.exitCode = 7; },
    (value: typeof statement) => { value.predicate.retentionCompromisedAt = value.predicate.finishedAt; },
    (value: typeof statement) => { value.predicate.finishedAt = "2020-01-01T00:00:00Z"; },
    (value: typeof statement) => { Object.assign(value.predicate, { stdout: "sensitive" }); },
  ]) {
    const changed = structuredClone(statement);
    change(changed);
    assert.throws(() => verifySubmissionAttestation(externallySigned(changed), expected()), hasCode("SUBMISSION_ATTESTATION_INVALID"));
  }
});

test("only eligible saved terminal validation records can produce an attestation", () => {
  for (const changes of [
    { status: "received" as const }, { status: "validating" as const }, { status: "abandoned" as const },
    { worktree: "/still/active" }, { worktreeIdentity: { device: "1", inode: "2" } },
    { archiveIntent: { requestedAt: "2026-09-06T13:00:00Z", releaseArtifact: true } },
    { archivedAt: "2026-09-06T13:00:00Z" }, { artifactReleasedAt: "2026-09-06T13:00:00Z" },
    { error: "not successful" },
  ]) {
    assert.throws(() => envelope({ ...submission(), ...changes }), hasCode("SUBMISSION_ATTESTATION_INELIGIBLE"));
  }
  const missingRetention = submission();
  delete missingRetention.retentionEstablishedAt;
  assert.throws(() => envelope(missingRetention), hasCode("SUBMISSION_ATTESTATION_INELIGIBLE"));
  const missingFinish = submission();
  delete missingFinish.finishedAt;
  assert.throws(() => envelope(missingFinish), hasCode("SUBMISSION_ATTESTATION_INELIGIBLE"));
  assert.throws(() => envelope({ ...submission(), retentionCompromisedAt: submission().finishedAt! }), hasCode("SUBMISSION_ATTESTATION_INVALID"));
  const other = generateProvenanceSigningIdentity();
  assert.throws(() => signSubmissionAttestation(submission(), identity.privateKey, other.publicKey), hasCode("SIGNING_KEY_MISMATCH"));
});

test("placeholder success with no authoritative validation cannot be signed or accepted offline", () => {
  for (const validators of [[], [{ ...submission().validations[0]!, scope: "focused" as const }]]) {
    const record = { ...submission(), validations: validators };
    assert.throws(() => envelope(record), hasCode("SUBMISSION_ATTESTATION_INVALID"));
    const statement = verifySubmissionAttestation(envelope(), expected()).statement;
    statement.predicate.validators = validators.map(({ command: _command, stdout: _stdout, stderr: _stderr, ...result }) => result);
    assert.throws(() => verifySubmissionAttestation(externallySigned(statement), expected()), hasCode("SUBMISSION_ATTESTATION_INVALID"));
  }
});

test("Git SHA-256 repositories retain SHA-256 commit and tree subjects", () => {
  const record = submission();
  record.artifact.sha = "a".repeat(64);
  record.artifact.treeSha = "b".repeat(64);
  record.base.sha = record.policy.baseSha = "c".repeat(64);
  record.policy.configBlobSha = "d".repeat(64);
  const result = verifySubmissionAttestation(envelope(record), expected(record));
  assert.deepEqual(result.statement.subject[0].digest, { sha256: record.artifact.sha });
  assert.deepEqual(result.statement.subject[1].digest, { sha256: record.artifact.treeSha });
});
