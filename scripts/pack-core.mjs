import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertPackageFootprint, stageCorePackage } from "./package-layout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--pack-destination"),
  "Usage: npm run pack:core -- [--pack-destination empty-directory]");
const npm = process.env.npm_execpath;
assert.ok(npm && path.isAbsolute(npm), "Run this command through npm run pack:core.");
const destination = path.resolve(args[1] ?? path.join(root, "release-core-package"));
await mkdir(destination, { recursive: true });
assert.deepEqual(await readdir(destination), [], "Pack destination must be empty; existing artifacts are never overwritten.");
const scratch = await mkdtemp(path.join(tmpdir(), "merge-broker-core-"));
try {
  await stageCorePackage(root, scratch);
  const { stdout } = await promisify(execFile)(process.execPath,
    [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: scratch, timeout: 120_000, maxBuffer: 4 * 1_024 * 1_024, windowsHide: true });
  const [packed] = JSON.parse(stdout);
  console.log(assertPackageFootprint(packed));
  console.log(path.join(destination, packed.filename));
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
