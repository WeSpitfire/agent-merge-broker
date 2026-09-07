#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schemaSnapshotIdentity } from "../dist/schema-identity.js";
import { z } from "zod";
import { submissionAttestationStatementSchema, submissionAttestationEnvelopeSchema } from "../dist/submission-attestation.js";

// Run npm run build first. --check is read-only; --write creates immutable snapshots and updates
// the alias manifest. Existing snapshots are never overwritten, even by --write.
const mode = process.argv[2];
if (!["--check", "--write"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/update-schema-snapshots.mjs --check|--write (after npm run build)");
}
const root = fileURLToPath(new URL("..", import.meta.url));
const schemaDirectory = path.join(root, "schemas");
const manifestPath = path.join(schemaDirectory, "identities.json");
for (const [name, runtimeSchema, title, description] of [
  ["submission-attestation-statement", submissionAttestationStatementSchema,
    "Agent Merge Broker Gate validation in-toto statement v1",
    "Structural schema for Gate validation evidence. Verification additionally checks signatures, expected commit/tree/base/policy/authority, and consistency of outcomes and timestamps. Evidence never grants merge authorization."],
  ["submission-attestation-envelope", submissionAttestationEnvelopeSchema,
    "Agent Merge Broker Gate validation DSSE envelope v1",
    "DSSE envelope carrying an in-toto Statement/v1 with the Gate validation v1 predicate and Ed25519 signatures. The keyid is an unauthenticated hint; consumers supply a trusted key independently."],
]) {
  const generated = {
    ...z.toJSONSchema(runtimeSchema, { target: "draft-2020-12", io: "input" }),
    $id: `urn:agent-merge-broker:schema:${name}:v1`,
    title,
    description,
  };
  const destination = path.join(schemaDirectory, `${name}.schema.json`);
  const encoded = `${JSON.stringify(generated, null, 2)}\n`;
  if (mode === "--write") await writeFile(destination, encoded, "utf8");
  else if (await readFile(destination, "utf8") !== encoded) throw new Error(`Generated ${name} schema is stale; regenerate with --write.`);
}
const aliases = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".schema.json")).sort();
const entries = [];
for (const file of aliases) {
  const schema = JSON.parse(await readFile(path.join(schemaDirectory, file), "utf8"));
  const name = file.slice(0, -".schema.json".length);
  const identity = schemaSnapshotIdentity(name, schema);
  const snapshot = { ...schema, $id: identity.id };
  const destination = path.join(root, identity.path);
  let existing;
  try { existing = JSON.parse(await readFile(destination, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (schemaSnapshotIdentity(name, existing).id !== identity.id || existing.$id !== identity.id) {
      throw new Error(`Immutable schema was changed: ${identity.path}`);
    }
  } else if (mode === "--write") {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  } else throw new Error(`Missing schema snapshot: ${identity.path}; regenerate with --write.`);
  entries.push({ name, alias: `schemas/${file}`, aliasId: schema.$id, ...identity });
}
// Validate historical snapshots too. New versions add files; old consumer identities stay valid.
for (const file of await readdir(path.join(schemaDirectory, "immutable"))) {
  const match = /^([a-z][a-z0-9-]*)\.([0-9a-f]{64})\.schema\.json$/u.exec(file);
  if (!match) throw new Error(`Unexpected immutable schema filename: ${file}`);
  const schema = JSON.parse(await readFile(path.join(schemaDirectory, "immutable", file), "utf8"));
  const identity = schemaSnapshotIdentity(match[1], schema);
  if (identity.fingerprint !== match[2] || schema.$id !== identity.id) {
    throw new Error(`Immutable schema content no longer matches its fingerprint: ${file}`);
  }
}
const manifest = {
  version: 1,
  fingerprintAlgorithm: "sha256-canonical-json-without-root-id",
  description: "Local packaged snapshots have immutable content identities. Alias URLs may change; URNs identify content and are not network locations.",
  schemas: entries,
};
const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
if (mode === "--write") await writeFile(manifestPath, encoded, "utf8");
else if (await readFile(manifestPath, "utf8") !== encoded) throw new Error("Schema identity manifest is stale; regenerate with --write.");
console.log(`Verified ${entries.length} schema aliases and their immutable snapshots.`);
