import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function repository(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-hooks-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  return repo;
}

test(
  "installs a guard that blocks implementation pushes and allows integration branches",
  { skip: process.platform === "win32" ? "POSIX hook fixture" : false },
  async (context) => {
    const repo = await repository();
    const remote = await mkdtemp(path.join(tmpdir(), "merge-broker-remote-"));
    context.after(async () => {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(remote, "init", "--bare", "-b", "main");
    await git(repo, "remote", "add", "origin", remote);

    const broker = await MergeBroker.open(repo);
    const installed = await broker.installHooks();
    assert.equal(installed.installed, true);
    assert.equal(await git(repo, "config", "--get", "core.hooksPath"), ".githooks");

    await git(repo, "switch", "-c", "agent/feature");
    await writeFile(path.join(repo, "feature.txt"), "work\n", "utf8");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "agent work");

    const blocked = await runCommand("git", ["push", "origin", "agent/feature"], { cwd: repo, allowFailure: true });
    assert.notEqual(blocked.exitCode, 0);
    assert.match(blocked.stderr, /Direct implementation pushes are disabled/u);

    // An operator can still get work out in an emergency, deliberately.
    const bypassed = await runCommand("git", ["push", "origin", "agent/feature"], {
      cwd: repo,
      allowFailure: true,
      env: { ...process.env, MERGE_BROKER_ALLOW_DIRECT_PUSH: "1" },
    });
    assert.equal(bypassed.exitCode, 0);

    // Integration branches are exactly what the guard exists to let through.
    await git(repo, "switch", "-c", "merge-broker/20260101T000000Z-abcdef");
    const allowed = await runCommand("git", ["push", "origin", "merge-broker/20260101T000000Z-abcdef"], {
      cwd: repo,
      allowFailure: true,
    });
    assert.equal(allowed.exitCode, 0);

    await broker.installHooks({ uninstall: true });
    assert.equal((await runCommand("git", ["config", "--get", "core.hooksPath"], { cwd: repo, allowFailure: true })).exitCode, 1);
  },
);

test("composes with repository-local hook directories without disabling existing hooks", async (context) => {
  const repo = await repository();
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const hookFile = path.join(repo, ".git", "hooks", "pre-commit");
  await mkdir(path.dirname(hookFile), { recursive: true });
  await writeFile(hookFile, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  await chmod(hookFile, 0o755);

  const broker = await MergeBroker.open(repo);
  const defaultComposed = await broker.installHooks();
  assert.match(defaultComposed.hooksPath, /[/\\]\.git[/\\]hooks$/u);
  assert.match(await readFile(hookFile, "utf8"), /exit 0/u);
  assert.match(await readFile(defaultComposed.hookFile, "utf8"), /Installed by Agent Merge Broker/u);
  await broker.installHooks({ uninstall: true });

  // A repository-local configured directory such as Husky is used in place without changing it.
  await runCommand("git", ["config", "core.hooksPath", ".husky"], { cwd: repo });
  const husky = await broker.installHooks();
  assert.match(husky.hooksPath, /[/\\]\.husky$/u);
  assert.equal(await git(repo, "config", "--get", "core.hooksPath"), ".husky");
  await broker.installHooks({ uninstall: true });

  // An existing hook at the same entry point is never overwritten implicitly.
  await mkdir(path.join(repo, ".husky"), { recursive: true });
  await writeFile(path.join(repo, ".husky", "pre-push"), "#!/bin/sh\necho owner\n", "utf8");
  await assert.rejects(
    broker.installHooks(),
    (error: unknown) => error instanceof BrokerError && error.code === "HOOKS_PATH_CONFLICT",
  );
});
