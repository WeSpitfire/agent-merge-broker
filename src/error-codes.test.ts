import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BROKER_ERROR_CATEGORIES,
  BROKER_ERROR_CODES,
  type BrokerErrorCategory,
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
