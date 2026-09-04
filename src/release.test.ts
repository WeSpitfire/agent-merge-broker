import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const action = await readFile(new URL("../verify/action.yml", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const releaseGuide = await readFile(new URL("../docs/RELEASING.md", import.meta.url), "utf8");
const siteWorkflow = await readFile(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");
const siteSync = await readFile(new URL("../site/sync-docs.mjs", import.meta.url), "utf8");

test("release surfaces run the exact npm package version they advertise", () => {
  const version = packageMetadata.version.replaceAll(".", "\\.");
  assert.match(action, new RegExp(`\\r?\\n\\s+default: ${version}\\r?\\n`, "u"));
  assert.match(readme, new RegExp(`verify@v${version}`, "u"));
  assert.match(releaseGuide, new RegExp(`verify@v${version}`, "u"));
});

test("the site redeploys when any canonical content source changes", () => {
  for (const source of ["site/**", "docs/**", "VISION.md", "ROADMAP.md", "SUPPORT.md", "package.json"]) {
    assert.match(siteWorkflow, new RegExp(`- ["']${source.replaceAll("*", "\\*")}["']`, "u"));
  }
  for (const source of ["VISION.md", "ROADMAP.md", "SUPPORT.md"]) {
    assert.match(siteSync, new RegExp(`from: ["']${source}["']`, "u"));
  }
});
