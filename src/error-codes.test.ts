import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BROKER_ERROR_CATEGORIES,
  BROKER_ERROR_CODES,
  CLI_EXIT_CODES,
  cliExitCodeForError,
  type BrokerErrorCategory,
  type BrokerErrorCode,
} from "./error-codes.js";

const protocol = await readFile(new URL("../docs/PROTOCOL.md", import.meta.url), "utf8");

function errorSection(): string {
  const start = protocol.indexOf("## Stable error categories");
  assert.ok(start >= 0, "PROTOCOL.md must document stable error categories.");
  const end = protocol.indexOf("\n## ", start + 1);
  return protocol.slice(start, end < 0 ? undefined : end);
}

test("PROTOCOL.md documents every registered error code under its category", () => {
  const section = errorSection();
  const bullets = new Map<string, string>();
  for (const bullet of section.split(/\n- /u).slice(1)) {
    const separator = bullet.indexOf(" — ");
    if (separator > 0) bullets.set(bullet.slice(0, separator).trim(), bullet);
  }
  for (const [category, label] of Object.entries(BROKER_ERROR_CATEGORIES) as [BrokerErrorCategory, string][]) {
    const bullet = bullets.get(label);
    assert.ok(bullet, `PROTOCOL.md is missing the "${label}" error category.`);
    for (const [code, codeCategory] of Object.entries(BROKER_ERROR_CODES)) {
      if (codeCategory !== category) continue;
      assert.ok(bullet.includes(`\`${code}\``), `PROTOCOL.md does not list ${code} under "${label}".`);
    }
  }
});

test("PROTOCOL.md mentions only registered error codes", () => {
  const mentioned = new Set([...errorSection().matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/gu)].map((match) => match[1]!));
  const unregistered = [...mentioned].filter((code) => !Object.hasOwn(BROKER_ERROR_CODES, code));
  assert.deepEqual(unregistered, []);
});

test("CLI exit statuses follow error categories and are documented", () => {
  const codes = Object.keys(BROKER_ERROR_CODES) as BrokerErrorCode[];
  for (const code of codes) {
    const category = BROKER_ERROR_CODES[code];
    const status = cliExitCodeForError(code);
    if (category === "input") assert.equal(status, CLI_EXIT_CODES.usage, code);
    else if (category === "internal") assert.equal(status, CLI_EXIT_CODES.internal, code);
    else assert.ok(status === CLI_EXIT_CODES.rejected || status === CLI_EXIT_CODES.failed, code);
  }
  for (const code of ["VALIDATION_FAILED", "PROVENANCE_INVALID", "SUBMISSION_ATTESTATION_SIGNATURE_INVALID"] as const) {
    assert.equal(cliExitCodeForError(code), CLI_EXIT_CODES.rejected, code);
  }
  assert.equal(cliExitCodeForError("LEASE_CONFLICT"), CLI_EXIT_CODES.failed);

  const start = protocol.indexOf("## CLI exit statuses");
  assert.ok(start >= 0, "PROTOCOL.md must document CLI exit statuses.");
  const table = protocol.slice(start, protocol.indexOf("\n## ", start + 1));
  const documented = [...table.matchAll(/^\| `(\d+)` \|/gmu)].map((match) => Number(match[1]));
  assert.deepEqual(documented, Object.values(CLI_EXIT_CODES));
});
