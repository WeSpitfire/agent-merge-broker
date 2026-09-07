import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("A schema identity requires JSON data.");
}

/**
 * Exclude only the root $id to avoid a self-referential hash. Local fragment $refs remain intact.
 * Every other keyword, including descriptions and nested $ids, is part of the frozen identity.
 */
export function schemaFingerprint(schema: Record<string, unknown>): string {
  const { $id: _identity, ...content } = schema;
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

export function schemaSnapshotIdentity(name: string, schema: Record<string, unknown>): {
  id: string;
  fingerprint: string;
  path: string;
} {
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new TypeError("Invalid schema name.");
  const fingerprint = schemaFingerprint(schema);
  return {
    id: `urn:agent-merge-broker:schema:${name}:sha256:${fingerprint}`,
    fingerprint,
    path: `schemas/immutable/${name}.${fingerprint}.schema.json`,
  };
}
