import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitRepository } from "./git.js";
import { runCommand } from "./process.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function commit(repo: string, file: string, contents: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), contents, "utf8");
  await git(repo, "add", file);
  await git(repo, "commit", "-m", message);
  return await git(repo, "rev-parse", "HEAD");
}

test("collects commits after a base without resubmitting work already upstream", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-git-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await commit(repo, "README.md", "# Fixture\n", "initial");

  await git(repo, "switch", "-c", "work");
  const first = await commit(repo, "a.ts", "export const a = 1;\n", "add a");
  const second = await commit(repo, "b.ts", "export const b = 2;\n", "add b");

  const repository = await GitRepository.discover(repo);
  assert.deepEqual(await repository.commitsSinceBase(repo, "main"), [first, second]);

  // The same change also lands on main under a different SHA, which is what a rebase leaves behind.
  // Patch identity, not commit identity, decides what is still outstanding.
  await git(repo, "switch", "main");
  await git(repo, "cherry-pick", first);
  await git(repo, "switch", "work");
  assert.deepEqual(await repository.commitsSinceBase(repo, "main"), [second]);
});
