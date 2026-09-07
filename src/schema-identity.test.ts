import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { schemaFingerprint, schemaSnapshotIdentity } from "./schema-identity.js";
import { submissionAttestationStatementSchema, submissionAttestationEnvelopeSchema } from "./submission-attestation.js";

interface SchemaEntry {
  name: string;
  alias: string;
  aliasId: string;
  id: string;
  fingerprint: string;
  path: string;
}
const manifest = JSON.parse(await readFile(new URL("../schemas/identities.json", import.meta.url), "utf8")) as {
  version: number;
  fingerprintAlgorithm: string;
  schemas: SchemaEntry[];
};
function rootFile(relative: string): URL {
  return new URL(`../${relative}`, import.meta.url);
}
function content(schema: Record<string, unknown>): Record<string, unknown> {
  const { $id: _id, ...rest } = schema;
  return rest;
}

test("every public schema alias maps to the exact packaged content fingerprint without changing legacy IDs", async () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.fingerprintAlgorithm, "sha256-canonical-json-without-root-id");
  const aliases = (await readdir(rootFile("schemas"))).filter((name) => name.endsWith(".schema.json")).sort();
  assert.deepEqual(manifest.schemas.map((entry) => entry.alias), aliases.map((name) => `schemas/${name}`));
  assert.equal(new Set(manifest.schemas.map((entry) => entry.id)).size, aliases.length);
  for (const entry of manifest.schemas) {
    const alias = JSON.parse(await readFile(rootFile(entry.alias), "utf8")) as Record<string, unknown>;
    const snapshot = JSON.parse(await readFile(rootFile(entry.path), "utf8")) as Record<string, unknown>;
    assert.deepEqual(schemaSnapshotIdentity(entry.name, alias), { id: entry.id, fingerprint: entry.fingerprint, path: entry.path });
    assert.equal(snapshot.$id, entry.id);
    assert.equal(alias.$id, entry.aliasId);
    assert.deepEqual(content(snapshot), content(alias));
    if (!["submission-attestation-statement", "submission-attestation-envelope"].includes(entry.name)) {
      assert.equal(alias.$id, `https://github.com/WeSpitfire/agent-merge-broker/raw/main/schemas/${entry.name}.schema.json`);
    }
  }
});

test("all current and historical snapshots verify their own identity and resolve fragment references offline", async () => {
  for (const file of await readdir(rootFile("schemas/immutable"))) {
    const match = /^([a-z][a-z0-9-]*)\.([0-9a-f]{64})\.schema\.json$/u.exec(file);
    assert.ok(match, file);
    const snapshot = JSON.parse(await readFile(rootFile(`schemas/immutable/${file}`), "utf8")) as Record<string, unknown>;
    assert.equal(schemaFingerprint(snapshot), match[2], `Changed immutable content: ${file}`);
    assert.equal(snapshot.$id, schemaSnapshotIdentity(match[1]!, snapshot).id);
    assert.doesNotThrow(() => new Ajv2020({ strict: true, formats: { "date-time": true, uri: true } }).compile(snapshot), file);
  }
});

test("schema fingerprints are independent of formatting and identity but include every other keyword", () => {
  const expected = createHash("sha256").update('{"properties":{"a":{"type":"string"}},"type":"object"}').digest("hex");
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(schemaFingerprint(schema), expected);
  assert.equal(schemaFingerprint({ $id: "urn:old", properties: schema.properties, type: schema.type }), expected);
  assert.notEqual(schemaFingerprint({ ...schema, additionalProperties: false }), expected);
  assert.notEqual(schemaFingerprint({ ...schema, description: "Different specification" }), expected);
});

test("published attestation schemas remain generated from their runtime parsers", async () => {
  for (const [name, runtime] of [
    ["submission-attestation-statement", submissionAttestationStatementSchema],
    ["submission-attestation-envelope", submissionAttestationEnvelopeSchema],
  ] as const) {
    const published = JSON.parse(await readFile(rootFile(`schemas/${name}.schema.json`), "utf8")) as Record<string, unknown>;
    const { $id: _id, title: _title, description: _description, ...structure } = published;
    assert.deepEqual(structure, z.toJSONSchema(runtime, { target: "draft-2020-12", io: "input" }));
  }
});
