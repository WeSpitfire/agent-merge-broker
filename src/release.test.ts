import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const action = await readFile(new URL("../verify/action.yml", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const releaseGuide = await readFile(new URL("../docs/RELEASING.md", import.meta.url), "utf8");

test("release surfaces run the exact npm package version they advertise", () => {
  const version = packageMetadata.version.replaceAll(".", "\\.");
  assert.match(action, new RegExp(`\\n\\s+default: ${version}\\n`, "u"));
  assert.match(readme, new RegExp(`verify@v${version}`, "u"));
  assert.match(releaseGuide, new RegExp(`verify@v${version}`, "u"));
});
