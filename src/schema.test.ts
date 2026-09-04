import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { defaultConfig } from "./config.js";

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

test("the JSON schema rejects validator working directories outside the repository", () => {
  for (const workingDirectory of ["../outside", "/absolute", "C:\\absolute", "C:drive-relative", "\\\\server\\share"]) {
    const config = defaultConfig();
    config.validation.authoritative = [{ name: "invalid", command: "test", workingDirectory }];
    assert.equal(validate(config), false, `${workingDirectory} should not satisfy the schema`);
  }
});

test("the JSON schema rejects auto-merge unless publication creates a non-draft pull request", () => {
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
