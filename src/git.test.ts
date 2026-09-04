import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BrokerError } from "./errors.js";
import { GitRepository, remoteUrlFingerprint } from "./git.js";
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
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

test(
  "broker-generated commits ignore ambient identity, signing, and repository hooks",
  { skip: process.platform === "win32" ? "POSIX executable hook fixture" : false },
  async (context) => {
    const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-generated-commit-"));
    context.after(async () => {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(repo, "init", "-b", "main");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
    await git(repo, "add", "README.md");
    await git(
      repo,
      "-c", "user.name=Fixture Author",
      "-c", "user.email=fixture@merge-broker.invalid",
      "-c", "commit.gpgSign=false",
      "commit", "-m", "initial",
    );

    await git(repo, "config", "user.useConfigOnly", "true");
    await git(repo, "config", "commit.gpgSign", "true");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'injected by hook\\n' > hook-injected.txt\ngit add -- hook-injected.txt\n",
      "utf8",
    );
    await chmod(hook, 0o755);

    const isolatedGlobalConfig = path.join(repo, ".git", "isolated-global.config");
    await writeFile(isolatedGlobalConfig, "", "utf8");
    const isolatedEnvironment = [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ] as const;
    const previousEnvironment = new Map(
      isolatedEnvironment.map((name) => [name, process.env[name]] as const),
    );
    process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    for (const name of isolatedEnvironment.slice(2)) delete process.env[name];

    try {
      const ambientIdentity = await runCommand("git", ["var", "GIT_AUTHOR_IDENT"], {
        cwd: repo,
        allowFailure: true,
      });
      assert.notEqual(ambientIdentity.exitCode, 0);

      const repository = await GitRepository.discover(repo);
      const head = await repository.commitGeneratedFile(
        repo,
        ".merge-broker/attestations/generated.json",
        "{\"generated\":true}\n",
        "Record generated attestation",
      );

      assert.deepEqual(
        (await git(repo, "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", head)).split("\0"),
        [
          "Agent Merge Broker",
          "merge-broker@localhost",
          "Agent Merge Broker",
          "merge-broker@localhost",
        ],
      );
      assert.match(
        await git(repo, "ls-tree", "-r", "--name-only", head),
        /^\.merge-broker\/attestations\/generated\.json$/m,
      );
      assert.doesNotMatch(await git(repo, "ls-tree", "-r", "--name-only", head), /^hook-injected\.txt$/m);
      await assert.rejects(readFile(path.join(repo, "hook-injected.txt"), "utf8"));
      assert.doesNotMatch(await git(repo, "cat-file", "-p", head), /^gpgsig /m);
      assert.equal(await git(repo, "config", "--get", "commit.gpgSign"), "true");
    } finally {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

async function publicationRepository(context: TestContext): Promise<{
  repo: string;
  remote: string;
  repository: GitRepository;
  first: string;
  second: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-push-"));
  const repo = path.join(root, "local");
  const remote = path.join(root, "remote.git");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "--bare", remote);
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await git(repo, "remote", "add", "origin", remote);
  const first = await commit(repo, "first.txt", "first\n", "first");
  const second = await commit(repo, "second.txt", "second\n", "second");
  await git(repo, "branch", "merge-broker/batch-1", first);
  return { repo, remote, repository: await GitRepository.discover(repo), first, second };
}

test("publishes the recorded commit and permits an idempotent same-SHA retry", async (context) => {
  const { repo, remote, repository, first, second } = await publicationRepository(context);
  const branch = "merge-broker/batch-1";

  // Assembly recorded `first`, but the local branch moved before publication.
  await git(repo, "branch", "-f", branch, second);
  await repository.push("origin", branch, first);
  await repository.push("origin", branch, first);

  assert.equal(await git(remote, "rev-parse", `refs/heads/${branch}`), first);
  assert.equal(await git(repo, "rev-parse", `refs/heads/${branch}`), second);
});

test("initial publication never overwrites a different remote branch value", async (context) => {
  const { repo, remote, repository, first, second } = await publicationRepository(context);
  const branch = "merge-broker/batch-1";
  await git(repo, "push", "--", "origin", `${first}:refs/heads/${branch}`);

  // This would be a valid fast-forward without the create-only lease, but initial publication must
  // not adopt or replace a branch that somebody else already created.
  await assert.rejects(repository.push("origin", branch, second));

  assert.equal(await git(remote, "rev-parse", `refs/heads/${branch}`), first);
});

test("derives the forge repository from the selected Git remote instead of gh defaults", async (context) => {
  const { repo, repository } = await publicationRepository(context);
  await git(repo, "remote", "add", "github", "git@github.com:octo-org/octo-repo.git");
  await git(repo, "remote", "add", "enterprise", "ssh://git@github.corp.example/octo-org/octo-repo.git");
  await git(repo, "remote", "add", "custom-port", "ssh://git@github.corp.example:8443/octo-org/octo-repo.git");

  assert.equal(await repository.forgeRepository("github"), "github.com/octo-org/octo-repo");
  assert.equal(
    await repository.forgeRepository("enterprise"),
    "github.corp.example/octo-org/octo-repo",
  );
  await assert.rejects(
    repository.forgeRepository("origin"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_REPOSITORY_UNKNOWN",
  );
  await assert.rejects(
    repository.forgeRepository("custom-port"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_REPOSITORY_UNKNOWN",
  );
});

test("refuses a remote URL changed after a batch binds its publication target", async (context) => {
  const { repo, repository } = await publicationRepository(context);
  const original = await repository.remotePushUrl("origin");
  const fingerprint = remoteUrlFingerprint(original);
  assert.equal(await repository.boundRemoteUrl("origin", fingerprint), original);

  const redirected = path.join(repo, "redirected.git");
  await git(repo, "init", "--bare", redirected);
  await git(repo, "remote", "set-url", "origin", redirected);
  await assert.rejects(
    repository.boundRemoteUrl("origin", fingerprint),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
  );
});

test("canonicalizes a relative filesystem remote before Git can reinterpret it as another remote name", async (context) => {
  const { repo, remote, repository, first } = await publicationRepository(context);
  const localSink = path.join(repo, "sink");
  await runCommand("git", ["init", "--bare", localSink], { cwd: repo });
  await git(repo, "remote", "set-url", "origin", "sink");
  await git(repo, "remote", "add", "sink", remote);

  const bound = await repository.remotePushUrl("origin");
  assert.equal(bound, await realpath(localSink));
  await repository.push(bound, "merge-broker/relative-target", first);

  assert.equal(await git(localSink, "rev-parse", "refs/heads/merge-broker/relative-target"), first);
  const wrongTarget = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", "refs/heads/merge-broker/relative-target"],
    { cwd: remote, allowFailure: true },
  );
  assert.notEqual(wrongTarget.exitCode, 0);
});

test(
  "binds a local remote to its physical target instead of a retargetable symlink",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const { repo, remote, repository } = await publicationRepository(context);
    const alternate = path.join(path.dirname(remote), "alternate.git");
    const locator = path.join(path.dirname(remote), "current.git");
    await git(path.dirname(remote), "init", "--bare", alternate);
    await symlink(remote, locator);
    await git(repo, "remote", "set-url", "origin", locator);

    const original = await repository.remotePushUrl("origin");
    assert.equal(original, await realpath(remote));
    const fingerprint = remoteUrlFingerprint(original);

    await unlink(locator);
    await symlink(alternate, locator);
    await assert.rejects(
      repository.boundRemoteUrl("origin", fingerprint),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
    );
  },
);
