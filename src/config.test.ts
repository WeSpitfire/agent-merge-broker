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
