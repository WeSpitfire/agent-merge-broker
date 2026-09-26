import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as core from "./core.js";
import * as full from "./index.js";
import { publicDeclarationsSnapshot } from "./test-support/public-contracts.js";

// The root exports are the supported Node API. Adding a name is a minor change that needs docs;
// removing or renaming one is a breaking change. Update this list only deliberately.
const CORE_EXPORTS = [
  "BROKER_ERROR_CATEGORIES",
  "BROKER_ERROR_CODES",
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

test("PROTOCOL.md lists every supported runtime export", async () => {
  const protocol = await readFile(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8");
  const start = protocol.indexOf("## Programmatic use");
  assert.ok(start >= 0);
  const section = protocol.slice(start, protocol.indexOf("\n## ", start + 1));
  for (const name of [...CORE_EXPORTS, "createMcpServer", "mcpToolNames"]) {
    assert.ok(section.includes(`\`${name}\``), `PROTOCOL.md programmatic use does not list ${name}`);
  }
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

test("root public declarations match the reviewed compatibility baseline", async () => {
  const expected = await readFile(new URL("../src/test-support/contracts/public-api.txt", import.meta.url), "utf8");
  assert.equal(await publicDeclarationsSnapshot(), expected,
    "Public declarations changed. Review compatibility and deliberately update the baseline with the documented change.");
});
