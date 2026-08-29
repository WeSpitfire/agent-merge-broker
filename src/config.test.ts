import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, validateConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { generateProvenanceSigningIdentity } from "./provenance.js";

function requiredCiConfig() {
  const config = defaultConfig();
  const identity = generateProvenanceSigningIdentity();
  config.validation.authority = "required-ci";
  config.publish.mode = "pull-request";
  if (!config.integration.provenance) throw new Error("default provenance missing");
  config.integration.provenance.requireSignature = true;
  config.integration.provenance.publicKey = identity.publicKey;
  return config;
}

test("accepts the generated default configuration", () => {
  assert.deepEqual(validateConfig(defaultConfig()), defaultConfig());
});

test("rejects state directories that escape Git's common directory", () => {
  const config = defaultConfig();
  config.stateDirectory = "../outside";
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_CONFIG",
  );
});

test("rejects a state directory that collides with Git internals", () => {
  const config = defaultConfig();
  config.stateDirectory = "worktrees";
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_CONFIG",
  );
});

test("rejects auto-merge on draft pull requests, which GitHub can never merge", () => {
  const config = defaultConfig();
  config.publish.mode = "pull-request";
  config.publish.autoMerge = true;
  config.publish.draft = true;
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /draft/u.test(error.message),
  );
});

test("rejects auto-merge in branch mode, where there is no pull request to merge", () => {
  const config = defaultConfig();
  config.publish.mode = "branch";
  config.publish.autoMerge = true;
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_CONFIG",
  );
});

test("defaults auto-merge off for configurations written before it existed", () => {
  const config = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, Record<string, unknown>>;
  delete config.publish?.autoMerge;
  delete config.publish?.mergeMethod;
  delete config.integration?.refreshBase;
  delete config.integration?.maxAttempts;
  delete config.validation?.authority;
  delete config.approval;
  const validated = validateConfig(config);
  assert.equal(validated.publish.autoMerge, false);
  assert.equal(validated.publish.mergeMethod, "squash");
  assert.equal(validated.integration.refreshBase, true);
  assert.equal(validated.integration.maxAttempts, 3);
  assert.equal(validated.validation.authority, "broker");
  assert.deepEqual(validated.approval, {
    required: false,
    policyRevision: "default",
    requiredVerifications: [],
    requiredChecks: [],
    authorizedActors: [],
  });
});

test("requires pull-request publication when exact candidate approval is mandatory", () => {
  const config = defaultConfig();
  if (!config.approval) throw new Error("default approval policy missing");
  config.approval.required = true;
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /publish\.mode pull-request/u.test(error.message),
  );
  config.publish.mode = "pull-request";
  assert.deepEqual(validateConfig(config), config);
});

test("rejects ambiguous duplicate approval evidence names", () => {
  const config = defaultConfig();
  if (!config.approval) throw new Error("default approval policy missing");
  config.approval.requiredVerifications = ["browser", "browser"];
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /evidence names must be unique/u.test(error.message),
  );
});

test("accepts required CI as the explicit authority for signed pull-request batches", () => {
  const config = requiredCiConfig();
  assert.deepEqual(validateConfig(config), config);
});

test("required CI authority fails closed without a pull request and signed provenance", () => {
  const unpublished = requiredCiConfig();
  unpublished.publish.mode = "none";
  assert.throws(
    () => validateConfig(unpublished),
    (error: unknown) => error instanceof BrokerError && /publish\.mode pull-request/u.test(error.message),
  );

  const unsigned = requiredCiConfig();
  if (!unsigned.integration.provenance) throw new Error("default provenance missing");
  unsigned.integration.provenance.requireSignature = false;
  assert.throws(
    () => validateConfig(unsigned),
    (error: unknown) => error instanceof BrokerError && /signed provenance/u.test(error.message),
  );
});

test("required CI authority keeps full-suite commands out of the local integration transaction", () => {
  const config = requiredCiConfig();
  config.validation.authoritative.push({ name: "full suite", command: "npm test" });
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /authoritative must be empty/u.test(error.message),
  );
});

test("rejects unknown fields instead of silently ignoring policy typos", () => {
  const config = { ...defaultConfig(), schedulling: {} };
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /schedulling/u.test(error.message),
  );
});

test("accepts legacy version-one configuration without provenance settings", () => {
  const config = defaultConfig();
  delete config.integration.provenance;
  assert.deepEqual(validateConfig(config), config);
});

test("rejects provenance directories that escape the repository", () => {
  const config = defaultConfig();
  if (!config.integration.provenance) throw new Error("default provenance missing");
  config.integration.provenance.directory = "../attestations";
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_CONFIG",
  );
});

test("requires an Ed25519 public key when signed provenance is mandatory", () => {
  const config = defaultConfig();
  if (!config.integration.provenance) throw new Error("default provenance missing");
  config.integration.provenance.requireSignature = true;
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /publicKey/u.test(error.message),
  );

  config.integration.provenance.publicKey = "not a public key";
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /Ed25519/u.test(error.message),
  );
});
