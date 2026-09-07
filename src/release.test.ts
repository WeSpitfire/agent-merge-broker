import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.js";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; engines: { node: string }; scripts: Record<string, string>; files: string[] };
const action = await readFile(new URL("../verify/action.yml", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const releaseGuide = await readFile(new URL("../docs/RELEASING.md", import.meta.url), "utf8");
const siteWorkflow = await readFile(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");
const siteSync = await readFile(new URL("../site/sync-docs.mjs", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const verificationWorkflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");

function workflowJob(workflow: string, name: string): string {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const start = jobs.indexOf(`  ${name}:\n`);
  assert.ok(start >= 0, `Missing workflow job: ${name}`);
  const block = jobs.slice(start);
  const next = /\n  [a-zA-Z][\w-]*:\n/u.exec(block);
  return next ? block.slice(0, next.index) : block;
}

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

test("site assets follow the configured Pages URL before activating a custom domain", () => {
  assert.match(siteWorkflow, /uses: actions\/configure-pages@v5\r?\n\s+id: pages/u);
  assert.match(siteWorkflow, /SITE_BASE: \$\{\{ steps\.pages\.outputs\.base_path \}\}\//u);
  assert.ok(siteWorkflow.indexOf("uses: actions/configure-pages@v5") < siteWorkflow.indexOf("- name: Build"));
});

test("CI and releases reuse a full OS and maintained-Node verification matrix", () => {
  assert.match(workflowJob(ciWorkflow, "verify"), /uses: \.\/\.github\/workflows\/verify\.yml/u);
  assert.match(workflowJob(ciWorkflow, "verify"), /revision: \$\{\{ github\.sha \}\}/u);
  assert.match(verificationWorkflow, /workflow_call:/u);
  assert.match(verificationWorkflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(verificationWorkflow, /node: \[22, 24, 26\]/u);
  assert.match(verificationWorkflow, /ref: \$\{\{ inputs\.revision \}\}/u);
  assert.match(verificationWorkflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/u);
  assert.match(verificationWorkflow, /npm run verify/u);
  assert.match(verificationWorkflow, /node scripts\/update-schema-snapshots\.mjs --check/u);
  assert.match(verificationWorkflow, /npm run example:gate/u);
  assert.match(verificationWorkflow, /npm run test:package -- --pack-destination release-package/u);
  assert.doesNotMatch(verificationWorkflow, /npm pack --dry-run|npm publish|id-token: write/u);
  assert.equal(packageMetadata.engines.node, ">=22");
});

test("Windows configures LF checkout before materializing generated schema fixtures", () => {
  assert.match(verificationWorkflow, /if: runner\.os == 'Windows'\r?\n\s+run: git config --global core\.autocrlf false/u);
  const configure = verificationWorkflow.indexOf("git config --global core.autocrlf false");
  const checkout = verificationWorkflow.indexOf("uses: actions/checkout@v4");
  assert.ok(configure >= 0 && configure < checkout, "Changing autocrlf after checkout cannot repair existing CRLF bytes.");
});

test("publication requires verification of the release event's immutable commit, not another main run", () => {
  const resolve = workflowJob(releaseWorkflow, "resolve");
  const verify = workflowJob(releaseWorkflow, "verify");
  const npm = workflowJob(releaseWorkflow, "npm");
  assert.match(resolve, /RELEASE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(resolve, /test "\$resolved_sha" = "\$RELEASE_SHA"/u);
  assert.match(resolve, /test "\$RELEASE_TAG" = "v\$package_version"/u);
  assert.match(verify, /needs: resolve/u);
  assert.match(verify, /uses: \.\/\.github\/workflows\/verify\.yml/u);
  assert.match(verify, /revision: \$\{\{ needs\.resolve\.outputs\.sha \}\}/u);
  assert.match(npm, /needs: \[resolve, verify\]/u);
  assert.match(npm, /ref: \$\{\{ needs\.resolve\.outputs\.sha \}\}/u);
  assert.doesNotMatch(npm, /if:.*always\(/u);
  assert.doesNotMatch(releaseWorkflow, /workflow_run:|head_branch: main|gh run list/u);
});

test("npm publishes the tarball exercised by the matrix, with publishing authority confined to its job", () => {
  const npm = workflowJob(releaseWorkflow, "npm");
  assert.match(verificationWorkflow, /uses: actions\/upload-artifact@/u);
  assert.match(verificationWorkflow, /name: npm-package-\$\{\{ inputs\.revision \}\}/u);
  assert.match(npm, /uses: actions\/download-artifact@/u);
  assert.match(npm, /name: npm-package-\$\{\{ needs\.resolve\.outputs\.sha \}\}/u);
  assert.match(npm, /node scripts\/verify-release-artifact\.mjs release-package "\$EXPECTED_SHA" "\$RELEASE_VERSION"/u);
  assert.match(npm, /npm publish "release-package\/agent-merge-broker-\$RELEASE_VERSION\.tgz" --provenance --access public/u);
  assert.match(npm, /id-token: write/u);
  assert.doesNotMatch(releaseWorkflow.slice(0, releaseWorkflow.indexOf("\njobs:\n")), /id-token: write/u);
  assert.ok(packageMetadata.scripts["test:package"]?.includes("scripts/packaged-smoke.mjs"));
  assert.ok(packageMetadata.files.includes("!dist/test-support/**"));
});

test("release artifact verification rejects changed bytes and a different source commit", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-release-artifact-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const filename = `agent-merge-broker-${packageMetadata.version}.tgz`;
  const tarball = path.join(directory, filename);
  const bytes = Buffer.from("fixture package bytes");
  const sha = "a".repeat(40);
  await writeFile(tarball, bytes);
  await writeFile(path.join(directory, "package-integrity.json"), JSON.stringify({
    schemaVersion: 1,
    name: "agent-merge-broker",
    version: packageMetadata.version,
    sourceRevision: sha,
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const verifier = fileURLToPath(new URL("../scripts/verify-release-artifact.mjs", import.meta.url));
  const verify = async (revision = sha) => await runCommand(process.execPath, [verifier, directory, revision, packageMetadata.version], {
    cwd: directory,
    allowFailure: true,
  });
  assert.equal((await verify()).exitCode, 0);
  const wrongSource = await verify("b".repeat(40));
  assert.notEqual(wrongSource.exitCode, 0);
  assert.match(wrongSource.stderr, /different commit/u);
  await writeFile(tarball, "changed package bytes");
  const changed = await verify();
  assert.notEqual(changed.exitCode, 0);
  assert.match(changed.stderr, /differs from the bytes/u);
});
