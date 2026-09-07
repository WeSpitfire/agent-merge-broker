import { createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { BrokerError } from "./errors.js";
import { provenanceKeyId, publicKeyFromPrivate } from "./provenance.js";
import type { SubmissionRecord } from "./types.js";

/** DSSE authenticates this media type together with the exact serialized statement bytes. */
export const SUBMISSION_ATTESTATION_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const SUBMISSION_ATTESTATION_PREDICATE_TYPE = "urn:agent-merge-broker:gate-validation:v1" as const;
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
const MAX_PAYLOAD_BYTES = 1_048_576;
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const at = z.string().datetime({ offset: true });
const label = z.string().min(1).max(4096);
const digest = z.union([
  z.strictObject({ sha1: z.string().regex(/^[0-9a-f]{40}$/u) }),
  z.strictObject({ sha256 }),
]);
const policySchema = z.strictObject({
  baseSha: sha,
  configPath: label,
  configBlobSha: sha,
  digest: sha256,
  revision: label,
  evaluatorVersion: label,
  configVersion: z.number().int().positive(),
});
const validatorSchema = z.strictObject({
  name: label,
  scope: z.enum(["focused", "authoritative"]),
  startedAt: at,
  finishedAt: at,
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int(),
});

/** Structural schema; the verifier additionally enforces relationships and expected identities. */
export const submissionAttestationStatementSchema = z.object({
  _type: z.literal(STATEMENT_TYPE),
  subject: z.tuple([
    z.object({ name: z.literal("git-commit"), digest }),
    z.object({ name: z.literal("git-tree"), digest }),
  ]),
  predicateType: z.literal(SUBMISSION_ATTESTATION_PREDICATE_TYPE),
  predicate: z.strictObject({
    version: z.literal(1),
    purpose: z.literal("validation-evidence"),
    mergeAuthorized: z.literal(false),
    submissionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u),
    authorityDigest: sha256,
    base: z.strictObject({
      sha,
      ref: label,
      baseBranch: label,
      remote: label,
      fetchUrlFingerprint: sha256.optional(),
    }),
    policy: policySchema,
    outcome: z.enum(["validated", "rejected", "failed"]),
    validators: z.array(validatorSchema).max(10_000),
    createdAt: at,
    validationStartedAt: at.optional(),
    finishedAt: at,
    retentionCompromisedAt: at.optional(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).optional(),
  }),
});

/** Envelope extensions and keyid hints are ignored, as specified by DSSE. */
export const submissionAttestationEnvelopeSchema = z.object({
  payloadType: z.literal(SUBMISSION_ATTESTATION_PAYLOAD_TYPE),
  payload: z.string().min(1).max(Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4),
  signatures: z.array(z.object({
    keyid: z.string().max(4096).optional(),
    sig: z.string().min(1).max(128),
  })).min(1).max(64),
});

export type SubmissionAttestationStatement = z.infer<typeof submissionAttestationStatementSchema>;
export type SubmissionAttestationEnvelope = z.infer<typeof submissionAttestationEnvelopeSchema>;
export interface SubmissionAttestationVerificationOptions {
  /** Independently trusted Ed25519 public PEM; never take a key from the envelope. */
  publicKey: string;
  expected: {
    candidateSha: string;
    treeSha: string;
    baseSha: string;
    policyDigest: string;
    authorityDigest: string;
    configBlobSha?: string;
    evaluatorVersion?: string;
  };
}
export interface SubmissionAttestationVerificationResult {
  verified: true;
  validationPassed: boolean;
  outcome: "validated" | "rejected" | "failed";
  keyId: string;
  purpose: "validation-evidence";
  mergeAuthorized: false;
  statement: SubmissionAttestationStatement;
}

/** DSSE v1 PAE uses UTF-8 byte lengths, never JavaScript character counts. */
function pae(payloadType: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, "ascii"),
    typeBytes,
    Buffer.from(` ${payload.length} `, "ascii"),
    payload,
  ]);
}

function invalid(message: string): never {
  throw new BrokerError("SUBMISSION_ATTESTATION_INVALID", message);
}

function decodeBase64(value: string, maximum: number): Buffer {
  // Buffer.from is intentionally permissive; authenticate only unambiguous RFC 4648 encodings.
  if (!/^(?:[A-Za-z0-9+/]*={0,2}|[A-Za-z0-9_-]*={0,2})$/u.test(value)) {
    invalid("Attestation contains malformed base64.");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const unpadded = normalized.replace(/=+$/u, "");
  const bytes = Buffer.from(normalized, "base64");
  if (
    bytes.length > maximum ||
    bytes.toString("base64").replace(/=+$/u, "") !== unpadded ||
    (normalized.includes("=") && normalized !== bytes.toString("base64"))
  ) invalid("Attestation contains malformed or oversized base64.");
  return bytes;
}

function objectDigest(value: string): { sha1: string } | { sha256: string } {
  return value.length === 40 ? { sha1: value } : { sha256: value };
}

function digestValue(value: z.infer<typeof digest>): string {
  return "sha1" in value ? value.sha1 : value.sha256;
}

function parseStatement(value: unknown): SubmissionAttestationStatement {
  const parsed = submissionAttestationStatementSchema.safeParse(value);
  if (!parsed.success) invalid("Attestation does not contain a supported Gate validation statement.");
  const statement = parsed.data;
  const evidence = statement.predicate;
  const candidateSha = digestValue(statement.subject[0].digest);
  const treeSha = digestValue(statement.subject[1].digest);
  if (
    evidence.policy.baseSha !== evidence.base.sha ||
    new Set([candidateSha.length, treeSha.length, evidence.base.sha.length, evidence.policy.configBlobSha.length]).size !== 1
  ) invalid("Attestation contains inconsistent Git or protected-policy identities.");
  if (Date.parse(evidence.finishedAt) < Date.parse(evidence.createdAt)) {
    invalid("Attestation finishes before the submission was created.");
  }
  if (evidence.validationStartedAt && (
    Date.parse(evidence.validationStartedAt) < Date.parse(evidence.createdAt) ||
    Date.parse(evidence.validationStartedAt) > Date.parse(evidence.finishedAt)
  )) invalid("Attestation contains inconsistent validation timestamps.");
  for (const result of evidence.validators) {
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
      invalid("Attestation contains inconsistent validator timestamps.");
    }
  }
  if (evidence.outcome === "validated" && (
    evidence.errorCode || evidence.retentionCompromisedAt || !evidence.validationStartedAt ||
    !evidence.validators.some((result) => result.scope === "authoritative") ||
    evidence.validators.some((result) => result.exitCode !== 0)
  )) invalid("Attestation claims successful validation despite incomplete or failed evidence.");
  return statement;
}

/**
 * Construct and sign validation evidence from a domain record, never from an arbitrary statement.
 * The broker caller must load the saved record, re-prove its Git/policy identity under the Gate
 * lock, and supply its existing local key matching protected-base configuration.
 */
export function signSubmissionAttestation(
  submission: SubmissionRecord,
  privateKey: string,
  trustedPublicKey: string,
): SubmissionAttestationEnvelope {
  if (
    !["validated", "rejected", "failed"].includes(submission.status) ||
    !submission.finishedAt || submission.worktree || submission.worktreeIdentity ||
    submission.archiveIntent || submission.artifactReleasedAt || submission.archivedAt ||
    (submission.status === "validated" && (!submission.retentionEstablishedAt || submission.error))
  ) {
    throw new BrokerError(
      "SUBMISSION_ATTESTATION_INELIGIBLE",
      "Attestation requires an active, completed Gate validation with its retained artifact intact.",
    );
  }
  const keyId = provenanceKeyId(trustedPublicKey);
  if (provenanceKeyId(publicKeyFromPrivate(privateKey)) !== keyId) {
    throw new BrokerError("SIGNING_KEY_MISMATCH", "The local signing key does not match the protected-base public key.");
  }
  const statement = parseStatement({
    _type: STATEMENT_TYPE,
    subject: [
      { name: "git-commit", digest: objectDigest(submission.artifact.sha) },
      { name: "git-tree", digest: objectDigest(submission.artifact.treeSha) },
    ],
    predicateType: SUBMISSION_ATTESTATION_PREDICATE_TYPE,
    predicate: {
      version: 1,
      purpose: "validation-evidence",
      mergeAuthorized: false,
      submissionId: submission.id,
      authorityDigest: submission.authorityDigest,
      base: {
        sha: submission.base.sha,
        ref: submission.base.ref,
        baseBranch: submission.base.baseBranch,
        remote: submission.base.remote,
        ...(submission.base.fetchUrlFingerprint ? { fetchUrlFingerprint: submission.base.fetchUrlFingerprint } : {}),
      },
      policy: {
        baseSha: submission.policy.baseSha,
        configPath: submission.policy.configPath,
        configBlobSha: submission.policy.configBlobSha,
        digest: submission.policy.digest,
        revision: submission.policy.revision,
        evaluatorVersion: submission.policy.evaluatorVersion,
        configVersion: submission.policy.configVersion,
      },
      outcome: submission.status,
      validators: submission.validations.map((result) => ({
        name: result.name,
        scope: result.scope,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      })),
      createdAt: submission.createdAt,
      ...(submission.validationStartedAt ? { validationStartedAt: submission.validationStartedAt } : {}),
      finishedAt: submission.finishedAt,
      ...(submission.retentionCompromisedAt ? { retentionCompromisedAt: submission.retentionCompromisedAt } : {}),
      ...(submission.errorCode ? { errorCode: submission.errorCode } : {}),
    },
  });
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  if (payload.length > MAX_PAYLOAD_BYTES) invalid("Attestation exceeds the 1 MiB payload limit.");
  return {
    payloadType: SUBMISSION_ATTESTATION_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyId, sig: sign(null, pae(SUBMISSION_ATTESTATION_PAYLOAD_TYPE, payload), privateKey).toString("base64") }],
  };
}

/** Offline: no Git, configuration, network, or envelope-supplied trust roots are consulted. */
export function verifySubmissionAttestation(
  envelope: unknown,
  options: SubmissionAttestationVerificationOptions,
): SubmissionAttestationVerificationResult {
  const parsed = submissionAttestationEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) invalid("Attestation is not a supported DSSE envelope.");
  const input = parsed.data;
  const payload = decodeBase64(input.payload, MAX_PAYLOAD_BYTES);
  const keyId = provenanceKeyId(options.publicKey);
  const publicKey = createPublicKey(options.publicKey);
  const signingPayload = pae(input.payloadType, payload);
  let validSignature = false;
  for (const signature of input.signatures) {
    const signatureBytes = decodeBase64(signature.sig, 64);
    if (signatureBytes.length === 64 && verify(null, signingPayload, publicKey, signatureBytes)) validSignature = true;
  }
  if (!validSignature) {
    throw new BrokerError("SUBMISSION_ATTESTATION_SIGNATURE_INVALID", "Attestation signature does not verify with the trusted Ed25519 key.");
  }
  let rawStatement: unknown;
  try {
    // Decode and parse exactly the bytes authenticated above, without re-reading the envelope.
    rawStatement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    invalid("Attestation payload is not valid UTF-8 JSON.");
  }
  const statement = parseStatement(rawStatement);
  const expected = options.expected;
  const evidence = statement.predicate;
  const identities: Array<[string, unknown, string]> = [
    ["candidateSha", expected.candidateSha, digestValue(statement.subject[0].digest)],
    ["treeSha", expected.treeSha, digestValue(statement.subject[1].digest)],
    ["baseSha", expected.baseSha, evidence.base.sha],
    ["policyDigest", expected.policyDigest, evidence.policy.digest],
    ["authorityDigest", expected.authorityDigest, evidence.authorityDigest],
    ...(expected.configBlobSha !== undefined ? [["configBlobSha", expected.configBlobSha, evidence.policy.configBlobSha] as [string, string, string]] : []),
    ...(expected.evaluatorVersion !== undefined ? [["evaluatorVersion", expected.evaluatorVersion, evidence.policy.evaluatorVersion] as [string, string, string]] : []),
  ];
  for (const [field, wanted, actual] of identities) {
    if (typeof wanted !== "string" || wanted !== actual) {
      throw new BrokerError("SUBMISSION_ATTESTATION_IDENTITY_MISMATCH", `Attestation does not match expected ${field}.`, { field });
    }
  }
  return {
    verified: true,
    validationPassed: evidence.outcome === "validated",
    outcome: evidence.outcome,
    keyId,
    purpose: "validation-evidence",
    mergeAuthorized: false,
    statement,
  };
}
