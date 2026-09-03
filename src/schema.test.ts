import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { defaultConfig } from "./config.js";

const schema = JSON.parse(
  await readFile(new URL("../schemas/config.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

test("the generated default configuration satisfies the published JSON schema", () => {
  const config = defaultConfig();
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("the JSON schema supports process-relative and native validator execution", () => {
  const config = defaultConfig();
  config.validation.authoritative = [{ name: "Swift", command: "swift test", executionArchitecture: "native" }];
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  const validator = config.validation.authoritative[0] as { executionArchitecture: string };
  validator.executionArchitecture = "arm64";
  assert.equal(validate(config), false);
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
