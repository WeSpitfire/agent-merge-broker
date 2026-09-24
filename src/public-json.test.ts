import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MergeBroker } from "./broker.js";
import { runCommand } from "./process.js";
import { canonicalJson, cliJsonContract } from "./test-support/public-contracts.js";

test("representative CLI JSON results and errors match the reviewed baseline", async (context) => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "merge-broker-json-contract-")));
  context.after(async () => await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = async (...args: string[]) => await runCommand("git", args, { cwd: repo });
  await git("init", "-b", "main");
  await git("config", "user.name", "Contract fixture");
  await git("config", "user.email", "contract@example.invalid");
  await writeFile(path.join(repo, "README.md"), "# Public contract fixture\n", "utf8");
  await git("add", "README.md");
  await git("-c", "commit.gpgSign=false", "commit", "-m", "initial");
  await MergeBroker.initialize(repo, { detect: false });
  const expected = await readFile(new URL("../src/test-support/contracts/cli-json.json", import.meta.url), "utf8");
  assert.equal(canonicalJson(await cliJsonContract(repo)), expected,
    "CLI JSON changed. Review compatibility and deliberately update the baseline with the documented change.");
});
