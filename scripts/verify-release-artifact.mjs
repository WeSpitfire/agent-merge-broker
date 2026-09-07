import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const [directory, expectedRevision, expectedVersion, ...extra] = process.argv.slice(2);
assert.ok(directory && expectedVersion && extra.length === 0,
  "Usage: node scripts/verify-release-artifact.mjs directory commit-sha version");
assert.match(expectedRevision ?? "", /^[0-9a-f]{40}$/u, "Expected a full immutable commit SHA.");
const filename = `agent-merge-broker-${expectedVersion}.tgz`;
assert.equal(path.basename(filename), filename, "Version must not contain a path.");
const manifest = JSON.parse(await readFile(path.join(directory, "package-integrity.json"), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.name, "agent-merge-broker");
assert.equal(manifest.version, expectedVersion, "Artifact belongs to a different package version.");
assert.equal(manifest.sourceRevision, expectedRevision, "Artifact was verified against a different commit.");
assert.equal(manifest.filename, filename);
assert.deepEqual((await readdir(directory)).sort(), [filename, "package-integrity.json"].sort(),
  "Release artifact must contain exactly one verified package and its integrity manifest.");
const digest = createHash("sha256").update(await readFile(path.join(directory, filename))).digest("hex");
assert.equal(digest, manifest.sha256, "Tarball differs from the bytes that passed installed-package verification.");
console.log(`Verified release artifact ${filename} from ${expectedRevision}.`);
