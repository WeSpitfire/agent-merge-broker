import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as core from "./core.js";
import * as full from "./index.js";

// The root exports are the supported Node API. Adding a name is a minor change that needs docs;
// removing or renaming one is a breaking change. Update this list only deliberately.
const CORE_EXPORTS = [
  "BrokerError",
  "MergeBroker",
  "SUBMISSION_ATTESTATION_PAYLOAD_TYPE",
  "SUBMISSION_ATTESTATION_PREDICATE_TYPE",
  "batchIdFromBranch",
  "defaultConfig",
  "githubCliPublisher",
  "loadConfig",
  "policyFromBase",
  "provenanceKeyId",
  "provenancePath",
  "schemaFingerprint",
  "schemaSnapshotIdentity",
  "validateConfig",
  "verifyBatchProvenanceSignature",
  "verifyProvenance",
  "verifySubmissionAttestation",
];

test("the core package exports exactly the supported runtime API", () => {
  assert.deepEqual(Object.keys(core).sort(), [...CORE_EXPORTS].sort());
});

test("the full package adds only the MCP adapter to the core API", () => {
  assert.deepEqual(Object.keys(full).sort(), [...CORE_EXPORTS, "createMcpServer", "mcpToolNames"].sort());
});

test("published declarations hide MergeBroker implementation fields", async (context) => {
  const declarations = await readFile(new URL("./broker.d.ts", import.meta.url), "utf8").catch(() => undefined);
  if (declarations === undefined) {
    context.skip("declarations are emitted only by the TypeScript build");
    return;
  }
  const broker = declarations.slice(declarations.indexOf("export declare class MergeBroker"));
  assert.match(broker, /readonly config: BrokerConfig;/u);
  for (const member of ["repo", "store", "publisher"]) {
    assert.doesNotMatch(broker, new RegExp(`readonly ${member}:`, "u"), `MergeBroker.${member} is internal`);
  }
});
