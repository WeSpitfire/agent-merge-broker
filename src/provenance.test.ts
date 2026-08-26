import assert from "node:assert/strict";
import test from "node:test";
import {
  generateProvenanceSigningIdentity,
  signBatchProvenance,
  verifyBatchProvenanceSignature,
} from "./provenance.js";
import type { BatchProvenance } from "./types.js";

function manifest(): BatchProvenance {
  return {
    version: 1,
    generator: "agent-merge-broker",
    batchId: "batch-1",
    baseBranch: "main",
    history: "preserve",
    baseSha: "a".repeat(40),
    integratedHeadSha: "b".repeat(40),
    taskIds: ["TASK-1"],
    tasks: [
      {
        id: "TASK-1",
        commits: ["c".repeat(40)],
        actualPaths: ["src/feature.ts"],
        dependsOn: [],
      },
    ],
    validations: [{ name: "test", scope: "authoritative", exitCode: 0, durationMs: 12 }],
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

test("signs a canonical manifest and verifies it with the trusted public key", () => {
  const identity = generateProvenanceSigningIdentity();
  const signed = signBatchProvenance(manifest(), identity.privateKey, identity.publicKey);

  assert.equal(signed.signature?.algorithm, "ed25519");
  assert.equal(signed.signature?.keyId, identity.keyId);
  assert.equal(verifyBatchProvenanceSignature(signed, identity.publicKey), true);
});

test("canonical signing is independent of JSON object key order", () => {
  const identity = generateProvenanceSigningIdentity();
  const signed = signBatchProvenance(manifest(), identity.privateKey, identity.publicKey);
  if (!signed.signature) throw new Error("Expected a signed manifest.");
  const reordered = {
    signature: signed.signature,
    createdAt: signed.createdAt,
    validations: signed.validations,
    tasks: signed.tasks,
    taskIds: signed.taskIds,
    integratedHeadSha: signed.integratedHeadSha,
    baseSha: signed.baseSha,
    history: signed.history ?? "preserve",
    baseBranch: signed.baseBranch,
    batchId: signed.batchId,
    generator: signed.generator,
    version: signed.version,
  } satisfies BatchProvenance;

  assert.equal(verifyBatchProvenanceSignature(reordered, identity.publicKey), true);
});

test("rejects manifest tampering and an untrusted signing identity", () => {
  const trusted = generateProvenanceSigningIdentity();
  const other = generateProvenanceSigningIdentity();
  const signed = signBatchProvenance(manifest(), trusted.privateKey, trusted.publicKey);
  const tampered = { ...signed, baseBranch: "release" };

  assert.equal(verifyBatchProvenanceSignature(tampered, trusted.publicKey), false);
  assert.equal(verifyBatchProvenanceSignature(signed, other.publicKey), false);
});
