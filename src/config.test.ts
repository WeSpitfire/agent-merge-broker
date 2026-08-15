import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, validateConfig } from "./config.js";
import { BrokerError } from "./errors.js";

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
  const validated = validateConfig(config);
  assert.equal(validated.publish.autoMerge, false);
  assert.equal(validated.publish.mergeMethod, "squash");
  assert.equal(validated.integration.refreshBase, true);
  assert.equal(validated.integration.maxAttempts, 3);
});

test("rejects unknown fields instead of silently ignoring policy typos", () => {
  const config = { ...defaultConfig(), schedulling: {} };
  assert.throws(
    () => validateConfig(config),
    (error: unknown) => error instanceof BrokerError && /schedulling/u.test(error.message),
  );
});
