import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { BrokerError } from "./errors.js";
import type { BatchProvenance, BatchRecord, HistoryMode, TaskRecord } from "./types.js";

export interface ProvenanceSigningIdentity {
  privateKey: string;
  publicKey: string;
  keyId: string;
}

function publicKeyObject(value: string): ReturnType<typeof createPublicKey> {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(value);
  } catch (error) {
    throw new BrokerError("INVALID_SIGNING_KEY", "Provenance public key is not valid PEM.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new BrokerError("INVALID_SIGNING_KEY", "Provenance public key must be an Ed25519 key.");
  }
  return key;
}

function privateKeyObject(value: string): ReturnType<typeof createPrivateKey> {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(value);
  } catch (error) {
    throw new BrokerError("INVALID_SIGNING_KEY", "Provenance private key is not valid PEM.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new BrokerError("INVALID_SIGNING_KEY", "Provenance private key must be an Ed25519 key.");
  }
  return key;
}

function exportPublicKey(value: ReturnType<typeof createPublicKey>): string {
  return value.export({ format: "pem", type: "spki" }).toString();
}

export function provenanceKeyId(publicKey: string): string {
  const der = publicKeyObject(publicKey).export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

export function publicKeyFromPrivate(privateKey: string): string {
  return exportPublicKey(createPublicKey(privateKeyObject(privateKey)));
}

export function validateProvenancePublicKey(publicKey: string): void {
  publicKeyObject(publicKey);
}

export function generateProvenanceSigningIdentity(): ProvenanceSigningIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { privateKey: privatePem, publicKey: publicPem, keyId: provenanceKeyId(publicPem) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BrokerError("PROVENANCE_INVALID", "Manifest contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new BrokerError("PROVENANCE_INVALID", `Manifest contains unsupported ${typeof value} data.`);
}

export function provenanceSigningPayload(manifest: BatchProvenance): Buffer {
  const { signature: _signature, ...unsigned } = manifest;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function signBatchProvenance(
  manifest: BatchProvenance,
  privateKey: string,
  trustedPublicKey: string,
): BatchProvenance {
  const derivedPublicKey = publicKeyFromPrivate(privateKey);
  const derivedKeyId = provenanceKeyId(derivedPublicKey);
  const trustedKeyId = provenanceKeyId(trustedPublicKey);
  if (derivedKeyId !== trustedKeyId) {
    throw new BrokerError(
      "SIGNING_KEY_MISMATCH",
      "The local provenance private key does not match the public key committed in configuration.",
      { expectedKeyId: trustedKeyId, actualKeyId: derivedKeyId },
    );
  }
  const value = signBytes(null, provenanceSigningPayload(manifest), privateKeyObject(privateKey)).toString("base64url");
  return {
    ...manifest,
    signature: { algorithm: "ed25519", keyId: trustedKeyId, value },
  };
}

export function verifyBatchProvenanceSignature(manifest: BatchProvenance, trustedPublicKey: string): boolean {
  const signature = manifest.signature;
  if (
    !signature ||
    signature.algorithm !== "ed25519" ||
    signature.keyId !== provenanceKeyId(trustedPublicKey) ||
    typeof signature.value !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(signature.value)
  ) {
    return false;
  }
  try {
    return verifyBytes(
      null,
      provenanceSigningPayload(manifest),
      publicKeyObject(trustedPublicKey),
      Buffer.from(signature.value, "base64url"),
    );
  } catch {
    return false;
  }
}

export function provenancePath(directory: string, batchId: string): string {
  return path.posix.join(directory.replaceAll("\\", "/"), `${batchId}.json`);
}

export function buildBatchProvenance(options: {
  batch: BatchRecord;
  tasks: TaskRecord[];
  integratedHeadSha: string;
  integratedPaths: string[];
  history?: HistoryMode;
}): BatchProvenance {
  const { batch, tasks, integratedHeadSha, integratedPaths, history } = options;
  const integratedPathSet = new Set(integratedPaths);
  return {
    version: 1,
    generator: "agent-merge-broker",
    batchId: batch.id,
    baseBranch: batch.baseBranch,
    ...(history ? { history } : {}),
    baseSha: batch.baseSha,
    integratedHeadSha,
    taskIds: [...batch.taskIds],
    tasks: tasks.map((task) => ({
      id: task.id,
      commits: [...task.commits],
      // A corrective commit may intentionally cancel an earlier change. The
      // attestation describes the integrated result, while task receipts retain
      // the historical union used for scope checks and validation routing.
      actualPaths: task.actualPaths.filter((file) => integratedPathSet.has(file)),
      dependsOn: [...task.dependsOn],
    })),
    validations: batch.validations.map((result) => ({
      name: result.name,
      scope: result.scope,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })),
    createdAt: new Date().toISOString(),
  };
}
