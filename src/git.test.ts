import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { BrokerError } from "./errors.js";
import {
  adoptedRef,
  gatePortablePathKey,
  GitRepository,
  remoteUrlFingerprint,
  supportsGateGitVersion,
} from "./git.js";
import { runCommand } from "./process.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function gitInput(repo: string, args: string[], input: string): Promise<string> {
  return (await runCommand("git", args, { cwd: repo, input })).stdout.trim();
}

async function writeLooseObject(repo: string, type: "tree", body: Buffer): Promise<string> {
  const object = Buffer.concat([Buffer.from(`${type} ${body.byteLength}\0`), body]);
  const oid = createHash("sha1").update(object).digest("hex");
  const objectPath = path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, deflateSync(object));
  return oid;
}

async function commit(repo: string, file: string, contents: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), contents, "utf8");
  await git(repo, "add", file);
  await git(repo, "commit", "-m", message);
  return await git(repo, "rev-parse", "HEAD");
}

test("recognizes the Git floor that can enforce Gate no-lazy-fetch", () => {
  assert.equal(supportsGateGitVersion("git version 2.45.4"), false);
  assert.equal(supportsGateGitVersion("git version 2.46.0"), true);
  assert.equal(supportsGateGitVersion("git version 2.50.1.windows.1"), true);
  assert.equal(supportsGateGitVersion("git version 2.50.1 (Apple Git-155)"), true);
  assert.equal(supportsGateGitVersion("git version 3.0.0"), true);
  assert.equal(supportsGateGitVersion("unknown"), false);
});

test("rejects portable path hazards and canonicalizes cross-platform collision keys", () => {
  assert.equal(gatePortablePathKey("src/O'Brien file.ts"), "src/o'brien file.ts");
  assert.equal(gatePortablePathKey("Case/Foo.ts"), gatePortablePathKey("case/foo.TS"));
  for (const unsafe of [
    "CON.txt",
    "src/aux",
    "src/trailing.",
    "src/trailing ",
    "src/colon:name",
    "src/control\u0001name",
    "Caf\u00e9/Foo.ts",
    "\u00df/payload",
    "\u03c2/payload",
    "\ufb01/payload",
    "COM\u00b9.log",
    "lpt\u00b2",
    "COM0.log",
    "LPT0",
    "CONIN$",
    "conout$.txt",
    ".git/config",
    ".g\u200cit/config",
    "GIT~1/config",
    "FOOBAR~1/payload",
    "source~12.txt",
    "src\\windows.txt",
  ]) {
    assert.throws(
      () => gatePortablePathKey(unsafe),
      (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH",
      unsafe,
    );
  }
});

test("rejects a deep-tree prefix bomb within bounded work", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-git-prefix-depth-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");

  // Git can represent paths far deeper than every supported worktree filesystem should safely
  // materialize. Construct the tree through objects so the fixture itself needs no deep host path.
  const deepPath = `${"a/".repeat(257)}leaf.txt`;
  await gitInput(repo, ["fast-import", "--quiet"], [
    "blob",
    "mark :1",
    "data 1",
    "x",
    "commit refs/heads/deep-tree",
    "committer Merge Broker Test <test@merge-broker.invalid> 0 +0000",
    "data 9",
    "deep tree",
    `M 100644 :1 ${deepPath}`,
    "",
    "done",
    "",
  ].join("\n"));
  const candidate = await git(repo, "rev-parse", "refs/heads/deep-tree");
  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.assertLocalObjectClosure([candidate]),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "SUBMISSION_TOO_LARGE" &&
      error.details?.maximumDepth === 256,
  );
});

test("rejects a deep chain of empty trees that flattened inspection cannot see", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-git-empty-depth-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");

  let tree = await writeLooseObject(repo, "tree", Buffer.alloc(0));
  for (let depth = 0; depth < 257; depth += 1) {
    tree = await writeLooseObject(
      repo,
      "tree",
      Buffer.concat([Buffer.from("40000 a\0"), Buffer.from(tree, "hex")]),
    );
  }
  const candidate = await git(repo, "commit-tree", tree, "-m", "deep empty tree");
  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.assertLocalObjectClosure([candidate]),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "SUBMISSION_TOO_LARGE" &&
      error.details?.maximumDepth === 256,
  );
});

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

test("pins one exact local-ref commit and ignores later source-ref movement", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-ref-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "README.md", "# Fixture\n", "initial");

  await git(repo, "switch", "-c", "producer");
  const candidate = await commit(repo, "candidate.txt", "candidate\n", "candidate");
  const repository = await GitRepository.discover(repo);
  assert.equal(adoptedRef("candidate-1"), "refs/merge-broker/adopted/candidate-1");
  assert.throws(
    () => adoptedRef("../heads/main"),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_ARGUMENTS",
  );
  assert.throws(
    () => adoptedRef("candidate.lock"),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_ARGUMENTS",
  );
  const pinned = await repository.pinLocalRef("producer", "candidate-1");
  assert.equal(pinned.oid, candidate);
  assert.equal(pinned.ref, "refs/merge-broker/adopted/candidate-1");
  assert.deepEqual(await repository.pinLocalRef("producer", "candidate-1"), pinned);

  const moved = await commit(repo, "later.txt", "later\n", "move producer ref");
  assert.notEqual(moved, candidate);
  assert.equal(await repository.resolveCommit(pinned.ref), candidate);
  assert.equal(await repository.currentHead(), moved);

  assert.deepEqual(await repository.requireLinearHistory(base, pinned.ref), {
    baseOid: base,
    headOid: candidate,
    commits: [candidate],
  });
  assert.deepEqual(await repository.changedFilesBetween(base, pinned.ref), ["candidate.txt"]);
  assert.equal(await repository.currentHead(), moved);

  await assert.rejects(
    repository.pinLocalRef("producer", "candidate-1"),
    (error: unknown) => error instanceof BrokerError && error.code === "PINNED_REF_EXISTS",
  );
  assert.equal(await repository.resolveCommit(pinned.ref), candidate);
});

test(
  "pins without running repository reference-transaction hooks",
  { skip: process.platform === "win32" ? "POSIX executable hook fixture" : false },
  async (context) => {
    const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-hooks-"));
    context.after(async () => {
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Merge Broker Test");
    await git(repo, "config", "user.email", "test@merge-broker.invalid");
    const head = await commit(repo, "README.md", "# Fixture\n", "initial");
    const hook = path.join(repo, ".git", "hooks", "reference-transaction");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    const legacyDisabledHooks = path.join(repo, ".git", "merge-broker-disabled-hooks");
    await mkdir(legacyDisabledHooks);
    const poisoned = path.join(legacyDisabledHooks, "reference-transaction");
    await writeFile(poisoned, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(poisoned, 0o755);

    const ambient = await runCommand(
      "git",
      ["update-ref", "--no-deref", "refs/ambient-hook-check", head, ""],
      { cwd: repo, allowFailure: true },
    );
    assert.notEqual(ambient.exitCode, 0);

    const repository = await GitRepository.discover(repo);
    assert.deepEqual(await repository.pinLocalRef("main", "hook-free"), {
      ref: "refs/merge-broker/adopted/hook-free",
      oid: head,
    });
  },
);

test(
  "Gate worktree checks disable hooks and ambient filesystem monitors",
  { skip: process.platform === "win32" ? "POSIX executable hook fixture" : false },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-monitors-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const marker = path.join(root, "executed.txt");
    context.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "Merge Broker Test");
    await git(repo, "config", "user.email", "test@merge-broker.invalid");
    const head = await commit(repo, "candidate.txt", "candidate\n", "candidate");

    const monitor = path.join(root, "fsmonitor.sh");
    await writeFile(monitor, `#!/bin/sh\nprintf invoked >> ${JSON.stringify(marker)}\nprintf '\\n'\n`, "utf8");
    await chmod(monitor, 0o755);
    await git(repo, "config", "core.fsmonitor", monitor);

    for (const hooksDirectory of [
      path.join(repo, ".git", "hooks"),
      path.join(repo, ".git", "merge-broker-disabled-hooks"),
    ]) {
      await mkdir(hooksDirectory, { recursive: true });
      const hook = path.join(hooksDirectory, "post-checkout");
      await writeFile(hook, `#!/bin/sh\nprintf invoked >> ${JSON.stringify(marker)}\nexit 1\n`, "utf8");
      await chmod(hook, 0o755);
    }

    const repository = await GitRepository.discover(repo);
    await repository.pinLocalRef(head, "isolated-git");
    await repository.addRawDetachedWorktree(worktree, head);
    await repository.assertRawWorktree(worktree, head);
    await assert.rejects(access(marker));
    await repository.removeWorktree(worktree, { strictGateCleanup: true });
  },
);

test(
  "Gate worktree checks require the tracked owner executable bit",
  { skip: process.platform === "win32" ? "POSIX executable-mode fixture" : false },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-executable-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    context.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "Merge Broker Test");
    await git(repo, "config", "user.email", "test@merge-broker.invalid");
    const script = path.join(repo, "script.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(script, 0o755);
    await git(repo, "add", "script.sh");
    await git(repo, "commit", "-m", "add executable");
    const head = await git(repo, "rev-parse", "HEAD");

    const repository = await GitRepository.discover(repo);
    await repository.addRawDetachedWorktree(worktree, head);
    await chmod(path.join(worktree, "script.sh"), 0o641);
    await assert.rejects(
      repository.assertRawWorktree(worktree, head),
      (error: unknown) => error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
    );
    await repository.removeWorktree(worktree, { strictGateCleanup: true });
  },
);

test("Gate rejects case-aliased untracked paths even when repository config ignores case", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-untracked-case-"));
  const probeLower = path.join(root, "probe");
  const probeUpper = path.join(root, "PROBE");
  await writeFile(probeLower, "lower", "utf8");
  await writeFile(probeUpper, "upper", "utf8");
  if (await readFile(probeLower, "utf8") === "upper") {
    await rm(root, { recursive: true, force: true });
    context.skip("fixture requires a case-sensitive filesystem");
    return;
  }

  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const head = await commit(repo, "foo.txt", "tracked\n", "tracked lower-case path");
  await git(repo, "config", "core.ignoreCase", "true");

  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(worktree, head);
  await writeFile(path.join(worktree, "FOO.txt"), "untracked\n", "utf8");
  await assert.rejects(
    repository.assertRawWorktree(worktree, head),
    (error: unknown) => error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
  );
  await repository.removeWorktree(worktree, { strictGateCleanup: true });
});

test("memoizes repeated tree-pair path inspection across retained history", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-path-cache-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "state.txt", "a\n", "state a");
  const commits = [
    await commit(repo, "state.txt", "b\n", "state b 1"),
    await commit(repo, "state.txt", "a\n", "state a 2"),
    await commit(repo, "state.txt", "b\n", "state b 3"),
    await commit(repo, "state.txt", "a\n", "state a 4"),
  ];

  const repository = await GitRepository.discover(repo);
  const internals = repository as unknown as {
    localObjectGitBuffer: (
      args: string[],
      cwd: string,
      input: string | undefined,
      maxOutputBytes: number,
    ) => Promise<Buffer>;
  };
  const original = internals.localObjectGitBuffer.bind(repository);
  let diffInspections = 0;
  internals.localObjectGitBuffer = async (args, cwd, input, maxOutputBytes) => {
    if (args.includes("diff-tree")) diffInspections += 1;
    return await original(args, cwd, input, maxOutputBytes);
  };

  assert.deepEqual(await repository.changedFilesForLinearHistory(base, commits), ["state.txt"]);
  assert.equal(diffInspections, 2);
});

test("derives a conservative changed-path set for a renamed file", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-paths-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "old-name.txt", "content\n", "initial");
  await git(repo, "config", "diff.renames", "true");
  await git(repo, "mv", "old-name.txt", "new-name.txt");
  await git(repo, "commit", "-m", "rename file");
  const head = await git(repo, "rev-parse", "HEAD");

  const repository = await GitRepository.discover(repo);
  assert.deepEqual(await repository.changedFilesBetween(base, head), [
    "new-name.txt",
    "old-name.txt",
  ]);
});

test("rejects a non-descendant or merge history for a pinned local ref", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-history-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "README.md", "# Fixture\n", "initial");

  await git(repo, "switch", "-c", "producer");
  const candidate = await commit(repo, "candidate.txt", "candidate\n", "candidate");
  await git(repo, "switch", "-c", "side", base);
  const sibling = await commit(repo, "side.txt", "side\n", "side");
  const repository = await GitRepository.discover(repo);

  await assert.rejects(
    repository.requireLinearHistory(sibling, candidate),
    (error: unknown) => error instanceof BrokerError && error.code === "BASE_NOT_ANCESTOR",
  );

  await git(repo, "switch", "producer");
  await git(repo, "merge", "--no-ff", "side", "-m", "merge side");
  const mergeHead = await git(repo, "rev-parse", "HEAD");
  const pinned = await repository.pinLocalRef("producer", "merge-candidate");
  assert.equal(pinned.oid, mergeHead);
  await assert.rejects(
    repository.requireLinearHistory(base, pinned.ref),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "NON_LINEAR_HISTORY" &&
      Array.isArray(error.details?.mergeCommits) &&
      error.details.mergeCommits.includes(mergeHead),
  );
});

test("rejects retained history whose loose blob bytes do not match their object ID", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-corrupt-object-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "README.md", "# Fixture\n", "base");
  await git(repo, "switch", "-c", "producer");
  const first = await commit(repo, "transient.bin", "abc", "add transient blob");
  const blob = await git(repo, "rev-parse", `${first}:transient.bin`);
  await rm(path.join(repo, "transient.bin"));
  await git(repo, "add", "-u");
  await git(repo, "commit", "-m", "remove transient blob");
  const head = await git(repo, "rev-parse", "HEAD");

  // Keep the loose-object path/OID but replace its zlib payload with a different valid blob. Git's
  // ordinary cat-file command returns these bytes; Gate must independently reject the mismatch.
  const objectPath = path.join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, deflateSync(Buffer.from("blob 3\0xyz")));
  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.assertLocalObjectClosure([base, first, head]),
    (error: unknown) => error instanceof BrokerError && error.code === "GIT_OBJECT_READ_FAILED",
  );
});

test("does not scan unrelated corrupt unreachable objects outside the retained closure", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-unrelated-object-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const head = await commit(repo, "README.md", "# Fixture\n", "candidate");
  const unrelated = await gitInput(repo, ["hash-object", "-w", "--stdin"], "unreachable");
  const objectPath = path.join(repo, ".git", "objects", unrelated.slice(0, 2), unrelated.slice(2));
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, deflateSync(Buffer.from("blob 7\0changed")));

  const repository = await GitRepository.discover(repo);
  await repository.assertLocalObjectClosure([head]);
});

test("reads raw commit parents instead of accepting ancestry forged by info/grafts", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-graft-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "base.txt", "base\n", "base");
  await git(repo, "switch", "--orphan", "producer/unrelated");
  const unrelated = await commit(repo, "candidate.txt", "candidate\n", "unrelated root");
  const raw = await git(repo, "cat-file", "-p", unrelated);
  assert.doesNotMatch(raw, /^parent /mu);

  await writeFile(path.join(repo, ".git", "info", "grafts"), `${unrelated} ${base}\n`, "utf8");
  assert.equal(
    (await runCommand("git", ["--no-replace-objects", "merge-base", "--is-ancestor", base, unrelated], {
      cwd: repo,
      allowFailure: true,
    })).exitCode,
    0,
    "Git's --no-replace-objects still accepts info/grafts",
  );

  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.assertGateObjectStoreSupported(),
    (error: unknown) =>
      error instanceof BrokerError && error.code === "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
  );
  await assert.rejects(
    repository.requireLinearHistory(base, unrelated),
    (error: unknown) => error instanceof BrokerError && error.code === "BASE_NOT_ANCESTOR",
  );
});

test("rejects parent-looking commit headers that Git does not recognize as ancestry", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-malformed-parent-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "base.txt", "base\n", "base");
  const tree = await git(repo, "rev-parse", `${base}^{tree}`);
  const malformed = [
    `tree ${tree}`,
    "author Merge Broker Test <test@merge-broker.invalid> 0 +0000",
    `parent ${base}`,
    "committer Merge Broker Test <test@merge-broker.invalid> 0 +0000",
    "",
    "parent-looking extension",
    "",
  ].join("\n");
  const candidate = await gitInput(
    repo,
    ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
    malformed,
  );
  assert.doesNotMatch(await git(repo, "rev-list", "--parents", "-n", "1", candidate), new RegExp(base, "u"));
  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.requireLinearHistory(base, candidate),
    (error: unknown) => error instanceof BrokerError && error.code === "HISTORY_INSPECTION_FAILED",
  );
});

test("Gate raw worktrees bypass filters and detect mutations that clean filters conceal", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-raw-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, ".gitattributes"), "payload.txt filter=gate-review\n", "utf8");
  await writeFile(path.join(repo, ".gitignore"), "dist/\n", "utf8");
  await writeFile(path.join(repo, "payload.txt"), "safe\n", "utf8");
  await git(repo, "add", ".gitattributes", ".gitignore", "payload.txt");
  await git(repo, "commit", "-m", "candidate bytes");
  const head = await git(repo, "rev-parse", "HEAD");

  const filter = path.join(root, "filter.cjs");
  await writeFile(
    filter,
    "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(process.argv[2] === 'smudge' ? value.replaceAll('safe', 'pwned') : value.replaceAll('pwned', 'safe')));\n",
    "utf8",
  );
  await git(repo, "config", "filter.gate-review.smudge", `node ${JSON.stringify(filter)} smudge`);
  await git(repo, "config", "filter.gate-review.clean", `node ${JSON.stringify(filter)} clean`);
  await git(repo, "config", "filter.gate-review.required", "true");

  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(worktree, head);
  assert.equal(await readFile(path.join(worktree, "payload.txt"), "utf8"), "safe\n");
  await repository.assertRawWorktree(worktree, head);

  await mkdir(path.join(worktree, "dist"));
  await writeFile(path.join(worktree, "dist", "validator-output.txt"), "ignored\n", "utf8");
  await repository.assertRawWorktree(worktree, head);

  await git(worktree, "update-index", "--assume-unchanged", "--skip-worktree", "payload.txt");
  await writeFile(path.join(worktree, "payload.txt"), "pwned\n", "utf8");
  assert.equal(
    await repository.isClean(worktree),
    true,
    "ambient clean filter and index flags hide the mutation",
  );
  await assert.rejects(
    repository.assertRawWorktree(worktree, head),
    (error: unknown) => error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
  );
});

test("Gate rejects a validator changing detached HEAD to a same-commit branch", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-symbolic-head-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const head = await commit(repo, "candidate.txt", "candidate\n", "candidate");
  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(worktree, head);
  await git(worktree, "switch", "-c", "validator-spoof");
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
  await assert.rejects(
    repository.assertRawWorktree(worktree, head),
    (error: unknown) => error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
  );
  await repository.removeWorktree(worktree, { strictGateCleanup: true });
});

test(
  "rejects a validator-replaced tracked parent even when outside bytes are identical",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-parent-link-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    context.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "Merge Broker Test");
    await git(repo, "config", "user.email", "test@merge-broker.invalid");
    await mkdir(path.join(repo, "tracked"));
    await writeFile(path.join(repo, "tracked", "payload.txt"), "exact bytes\n", "utf8");
    await git(repo, "add", "tracked/payload.txt");
    await writeFile(path.join(repo, ".gitignore"), "/tracked\n", "utf8");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "tracked directory");
    const head = await git(repo, "rev-parse", "HEAD");

    const repository = await GitRepository.discover(repo);
    await repository.addRawDetachedWorktree(worktree, head);
    await mkdir(outside);
    await writeFile(path.join(outside, "payload.txt"), "exact bytes\n", "utf8");
    await rm(path.join(worktree, "tracked"), { recursive: true });
    await symlink(outside, path.join(worktree, "tracked"));
    assert.equal(
      (await repository.localObjectGit(
        ["--no-replace-objects", "ls-files", "--others", "--exclude-standard", "-z"],
        worktree,
      )).stdout,
      "",
      "candidate ignore rules conceal the substituted parent from an untracked-only check",
    );

    await assert.rejects(
      repository.assertRawWorktree(worktree, head),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
    );
  },
);

test("rejects a Gate worktree marker swapped to a byte-identical sibling", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-gitfile-swap-"));
  const repo = path.join(root, "repo");
  const first = path.join(root, "first");
  const sibling = path.join(root, "sibling");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  // Newer Git versions can emit relative gitfiles/backlinks; older versions safely ignore this
  // unknown configuration while exercising the same absolute-path invariant.
  await git(repo, "config", "worktree.useRelativePaths", "true");
  const head = await commit(repo, "payload.txt", "identical bytes\n", "candidate");

  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(first, head);
  await repository.addRawDetachedWorktree(sibling, head);
  await writeFile(path.join(first, ".git"), await readFile(path.join(sibling, ".git")));

  assert.equal(await git(first, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(path.join(first, "payload.txt"), "utf8"), "identical bytes\n");
  assert.equal(
    await realpath(await git(first, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    await realpath(await git(sibling, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    "the swapped marker stays inside the same common repository",
  );
  await assert.rejects(
    repository.assertRawWorktree(first, head),
    (error: unknown) =>
      error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE",
  );

  // Cleanup repairs only `first` from its captured registry backlink; the sibling remains intact.
  await repository.removeWorktree(first);
  assert.equal(await git(sibling, "rev-parse", "HEAD"), head);
  const physicalSibling = await realpath(sibling);
  const registeredPaths = await Promise.all(
    (await repository.listWorktrees()).map(async (item) => await realpath(item.path)),
  );
  assert.equal(registeredPaths.includes(physicalSibling), true);
});

test("Gate cleanup refuses a different physical directory moved into its worktree path", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-root-swap-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const moved = path.join(root, "moved-worktree");
  const victim = path.join(root, "victim");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const head = await commit(repo, "candidate.txt", "candidate\n", "candidate");
  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(worktree, head);
  const identity = await repository.gateWorktreeIdentity(worktree);
  await mkdir(victim);
  await writeFile(path.join(victim, "keep.txt"), "do not delete\n", "utf8");
  await rename(worktree, moved);
  await rename(victim, worktree);

  await assert.rejects(
    repository.removeWorktree(worktree, {
      strictGateCleanup: true,
      expectedRootIdentity: identity,
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "WORKTREE_REMOVE_FAILED",
  );
  assert.equal(await readFile(path.join(worktree, "keep.txt"), "utf8"), "do not delete\n");
  assert.equal(await readFile(path.join(moved, "candidate.txt"), "utf8"), "candidate\n");

  // Restore the exact captured root so cleanup can remove only the registered Gate worktree.
  await rename(worktree, victim);
  await rename(moved, worktree);
  await repository.removeWorktree(worktree, {
    strictGateCleanup: true,
    expectedRootIdentity: identity,
  });
});

test("Gate cleanup never unlinks an unrelated file moved into its worktree path", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-root-file-swap-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const moved = path.join(root, "moved-worktree");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const head = await commit(repo, "candidate.txt", "candidate\n", "candidate");
  const repository = await GitRepository.discover(repo);
  await repository.addRawDetachedWorktree(worktree, head);
  const identity = await repository.gateWorktreeIdentity(worktree);
  await rename(worktree, moved);
  await writeFile(worktree, "unrelated\n", "utf8");

  await assert.rejects(
    repository.removeWorktree(worktree, {
      strictGateCleanup: true,
      expectedRootIdentity: identity,
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "WORKTREE_REMOVE_FAILED",
  );
  assert.equal(await readFile(worktree, "utf8"), "unrelated\n");

  await unlink(worktree);
  await rename(moved, worktree);
  await repository.removeWorktree(worktree, {
    strictGateCleanup: true,
    expectedRootIdentity: identity,
  });
});

test("rejects case-folded prefix collisions before creating a raw worktree", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-collision-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  const base = await commit(repo, "README.md", "base\n", "base");
  const linkBlob = (await runCommand("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: "outside",
  })).stdout.trim();
  const payloadBlob = (await runCommand("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: "payload\n",
  })).stdout.trim();
  const nestedTree = (await runCommand("git", ["mktree"], {
    cwd: repo,
    input: `100644 blob ${payloadBlob}\tpayload\n`,
  })).stdout.trim();
  const rootTree = (await runCommand("git", ["mktree"], {
    cwd: repo,
    input: `120000 blob ${linkBlob}\tFoo\n040000 tree ${nestedTree}\tfoo\n`,
  })).stdout.trim();
  const candidate = await git(repo, "commit-tree", rootTree, "-p", base, "-m", "collision");

  const repository = await GitRepository.discover(repo);
  await assert.rejects(
    repository.addRawDetachedWorktree(worktree, candidate),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH",
  );
  await assert.rejects(access(worktree));
});

test("Gate refuses a shared clone whose retained refs borrow another object store", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-shared-"));
  const source = path.join(root, "source");
  const shared = path.join(root, "shared");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(root, "init", "-b", "main", source);
  await git(source, "config", "user.name", "Merge Broker Test");
  await git(source, "config", "user.email", "test@merge-broker.invalid");
  await commit(source, "README.md", "source\n", "source");
  await git(root, "clone", "--shared", source, shared);

  const repository = await GitRepository.discover(shared);
  await assert.rejects(
    repository.assertGateObjectStoreSupported(),
    (error: unknown) =>
      error instanceof BrokerError && error.code === "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
  );
});

test(
  "Gate rejects a loose-object fanout redirected outside its object store",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-fanout-link-"));
    const source = path.join(root, "source");
    const borrower = path.join(root, "borrower");
    context.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(root, "init", "-b", "main", source);
    await git(source, "config", "user.name", "Merge Broker Test");
    await git(source, "config", "user.email", "test@merge-broker.invalid");
    const blob = (await runCommand("git", ["hash-object", "-w", "--stdin"], {
      cwd: source,
      input: "borrowed loose object\n",
    })).stdout.trim();
    await git(root, "init", "-b", "main", borrower);
    const fanout = blob.slice(0, 2);
    await symlink(
      path.join(source, ".git", "objects", fanout),
      path.join(borrower, ".git", "objects", fanout),
    );
    assert.equal(await git(borrower, "cat-file", "-e", blob), "");

    const repository = await GitRepository.discover(borrower);
    await assert.rejects(
      repository.assertGateObjectStoreSupported(),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
    );
  },
);

test(
  "Gate rejects a whitespace alternate that resolves through a filesystem alias",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-space-alternate-"));
    const source = path.join(root, "source");
    const borrower = path.join(root, "borrower");
    context.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await git(root, "init", "-b", "main", source);
    await git(source, "config", "user.name", "Merge Broker Test");
    await git(source, "config", "user.email", "test@merge-broker.invalid");
    const borrowed = await commit(source, "README.md", "borrowed\n", "borrowed");
    await git(root, "init", "-b", "main", borrower);
    const borrowerObjects = path.join(borrower, ".git", "objects");
    await symlink(path.join(source, ".git", "objects"), path.join(borrowerObjects, "   "));
    await writeFile(path.join(borrowerObjects, "info", "alternates"), "   \n", "utf8");
    assert.equal((await git(borrower, "cat-file", "-e", borrowed)), "");

    const repository = await GitRepository.discover(borrower);
    await assert.rejects(
      repository.assertGateObjectStoreSupported(),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
    );
  },
);

test("Gate does not lazy-fetch a missing blob from a partial-clone promisor", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-adopt-promisor-"));
  const source = path.join(root, "source");
  const partial = path.join(root, "partial");
  context.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const version = await git(root, "--version");
  if (!supportsGateGitVersion(version)) {
    context.skip("Git older than the Gate 2.46 floor");
    return;
  }
  await git(root, "init", "-b", "main", source);
  await git(source, "config", "user.name", "Merge Broker Test");
  await git(source, "config", "user.email", "test@merge-broker.invalid");
  await git(source, "config", "uploadpack.allowFilter", "true");
  const head = await commit(source, "payload.txt", "promised bytes\n", "promised blob");
  const blob = await git(source, "rev-parse", `${head}:payload.txt`);
  await git(
    root,
    "clone",
    "--no-local",
    "--filter=blob:none",
    "--no-checkout",
    `file://${source}`,
    partial,
  );

  const repository = await GitRepository.discover(partial);
  assert.notEqual(
    (await repository.localObjectGit(["cat-file", "-e", blob], partial, true)).exitCode,
    0,
  );
  await assert.rejects(
    repository.assertLocalObjectClosure([head]),
    (error: unknown) => error instanceof BrokerError && error.code === "GIT_OBJECT_READ_FAILED",
  );
  assert.notEqual(
    (await repository.localObjectGit(["cat-file", "-e", blob], partial, true)).exitCode,
    0,
  );
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

test(
  "fetches an exact branch head without repository hooks or durable temporary refs",
  { skip: process.platform === "win32" ? "POSIX executable hook fixture" : false },
  async (context) => {
    const { repo, remote, repository, first } = await publicationRepository(context);
    await git(repo, "push", "--", "origin", `${first}:refs/heads/main`);
    const hook = path.join(repo, ".git", "hooks", "reference-transaction");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    const legacy = path.join(repo, ".git", "merge-broker-disabled-hooks");
    await mkdir(legacy);
    await writeFile(path.join(legacy, "reference-transaction"), "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(path.join(legacy, "reference-transaction"), 0o755);

    const remoteUrl = await realpath(remote);
    assert.equal(await repository.fetchBranchHead(remoteUrl, "main"), first);
    assert.equal(await git(repo, "for-each-ref", "--format=%(refname)", "refs/merge-broker/fetch"), "");
    await assert.rejects(readFile(path.join(repo, ".git", "FETCH_HEAD"), "utf8"));
  },
);

test("refuses Git URL rewrites before an exact remote fetch", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);
  await git(repo, "config", `url.${await realpath(remote)}.insteadOf`, "gate-protected://repository");
  await assert.rejects(
    repository.fetchBranchHead("gate-protected://repository", "main"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
  );
});

test("refuses configured Git transport commands before an exact remote fetch", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);
  for (const [key, value] of [
    ["core.sshCommand", "attacker-ssh"],
    ["core.gitProxy", "attacker-proxy"],
    ["http.proxy", "http://127.0.0.1:9"],
    ["http.sslVerify", "false"],
    ["http.https://honest.invalid/.curloptResolve", "honest.invalid:443:127.0.0.1"],
    ["http.extraHeader", "Host: evil.invalid"],
    ["http.https://honest.invalid/.extraHeader", "Host;"],
  ] as const) {
    await git(repo, "config", key, value);
    await assert.rejects(
      repository.fetchBranchHead(await realpath(remote), "main"),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
    );
    await git(repo, "config", "--unset", key);
  }
});

test("allows non-routing HTTP authorization headers during exact target checks", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);
  await git(
    repo,
    "config",
    "http.https://github.com/.extraHeader",
    "AUTHORIZATION: basic placeholder",
  );

  assert.equal(await repository.remotePushUrl("origin"), await realpath(remote));
});

test("refuses an exact locator that Git would reinterpret as a remote subsection", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);
  const exact = "ssh://honest.invalid/path";
  await git(repo, "config", `remote.${exact}.url`, remote);

  await assert.rejects(
    repository.fetchBranchHead(exact, "main"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
  );
});

test("refuses an exact locator matching an effective global remote subsection", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);
  const exact = "ssh://global.invalid/good.git";
  const home = path.join(repo, "isolated-home");
  await mkdir(home);
  await writeFile(
    path.join(home, ".gitconfig"),
    `[remote "${exact}"]\n\turl = ${remote}\n`,
    "utf8",
  );
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
  try {
    await assert.rejects(
      repository.fetchBranchHead(exact, "main"),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test(
  "refuses exact locators that Git would reinterpret through legacy remote shorthands",
  { skip: process.platform === "win32" ? "legacy colon-named remote fixture is POSIX-only" : false },
  async (context) => {
    const { repo, remote, repository, first } = await publicationRepository(context);
    await mkdir(path.join(repo, ".git", "remotes"));
    await writeFile(path.join(repo, ".git", "remotes", "foo:bar"), `URL: ${remote}\n`, "utf8");

    await assert.rejects(
      repository.fetchBranchHead("foo:bar", "main"),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
    );
    await assert.rejects(
      repository.push("foo:bar", "merge-broker/legacy-refused", first, { exactRemote: true }),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
    );
  },
);

test("refuses URL rewrites and scrubs ambient Git executable overrides for exact pushes", async (context) => {
  const { repo, remote, repository, first } = await publicationRepository(context);
  const exact = await realpath(remote);
  const malicious = path.join(path.dirname(remote), "push-redirect.git");
  await git(path.dirname(remote), "init", "--bare", malicious);
  await git(repo, "config", `url.${await realpath(malicious)}.insteadOf`, exact);
  await assert.rejects(
    repository.push(exact, "merge-broker/rewrite-refused", first, { exactRemote: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_TARGET_CHANGED",
  );
  await git(repo, "config", "--unset", `url.${await realpath(malicious)}.insteadOf`);

  const previous = process.env.GIT_EXEC_PATH;
  process.env.GIT_EXEC_PATH = path.join(repo, "missing-git-exec-path");
  try {
    await repository.push(exact, "merge-broker/scrubbed-exec-path", first, { exactRemote: true });
  } finally {
    if (previous === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = previous;
  }
  assert.equal(await git(remote, "rev-parse", "refs/heads/merge-broker/scrubbed-exec-path"), first);
});

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

test("binds distinct canonical fetch and push URLs for one remote", async (context) => {
  const { repo, repository } = await publicationRepository(context);
  const fetchTarget = path.join(repo, "fetch-target.git");
  const pushTarget = path.join(repo, "push-target.git");
  await git(repo, "init", "--bare", fetchTarget);
  await git(repo, "init", "--bare", pushTarget);
  await git(repo, "remote", "set-url", "origin", fetchTarget);
  await git(repo, "remote", "set-url", "--push", "origin", pushTarget);

  assert.equal(await repository.remoteFetchUrl("origin"), await realpath(fetchTarget));
  assert.equal(await repository.remotePushUrl("origin"), await realpath(pushTarget));
});

test("canonicalizes a relative filesystem remote before Git can reinterpret it as another remote name", async (context) => {
  const { repo, remote, repository, first } = await publicationRepository(context);
  const localSink = path.join(repo, "sink");
  await runCommand("git", ["init", "--bare", localSink], { cwd: repo });
  await git(repo, "remote", "set-url", "origin", "sink");
  await git(repo, "remote", "add", "sink", remote);

  const bound = await repository.remotePushUrl("origin");
  assert.equal(bound, await realpath(localSink));
  await repository.push(bound, "merge-broker/relative-target", first, { exactRemote: true });

  assert.equal(await git(localSink, "rev-parse", "refs/heads/merge-broker/relative-target"), first);
  const wrongTarget = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", "refs/heads/merge-broker/relative-target"],
    { cwd: remote, allowFailure: true },
  );
  assert.notEqual(wrongTarget.exitCode, 0);
});

test("preserves legal trailing spaces in a local remote pathname", async (context) => {
  const { repo, remote, repository, first } = await publicationRepository(context);
  const spaced = `${remote} `;
  await git(path.dirname(remote), "init", "--bare", spaced);
  await git(repo, "remote", "set-url", "origin", spaced);

  const bound = await repository.remotePushUrl("origin");
  assert.equal(bound, await realpath(spaced));
  await repository.push(bound, "merge-broker/spaced-target", first, { exactRemote: true });
  assert.equal(await git(spaced, "rev-parse", "refs/heads/merge-broker/spaced-target"), first);
  const wrongTarget = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", "refs/heads/merge-broker/spaced-target"],
    { cwd: remote, allowFailure: true },
  );
  assert.notEqual(wrongTarget.exitCode, 0);

  await git(repo, "remote", "set-url", "origin", `${remote}\r`);
  await assert.rejects(
    repository.remotePushUrl("origin"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
  );
});

test("rejects a remote URL whose non-UTF-8 bytes would decode ambiguously", async (context) => {
  const { repo, repository } = await publicationRepository(context);
  const configPath = path.join(repo, ".git", "config");
  const config = await readFile(configPath);
  await writeFile(
    configPath,
    Buffer.concat([
      config,
      Buffer.from('\n[remote "binary"]\n\turl = ', "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\n", "utf8"),
    ]),
  );

  await assert.rejects(
    repository.remotePushUrl("binary"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
  );
});

test("rejects file URL syntax whose web normalization differs from Git", async (context) => {
  const { repo, remote, repository } = await publicationRepository(context);

  for (const locator of [
    `file://${remote}#fragment`,
    `file://${remote}?query`,
    `file://${remote} `,
    `file://${remote}\t`,
    `file://${path.dirname(remote)}/directory/../${path.basename(remote)}`,
    `file://${path.dirname(remote)}/literal\\name.git`,
    `file://${path.dirname(remote)}/C|/legacy-drive.git`,
    `file://localhost${remote}`,
  ]) {
    await git(repo, "remote", "set-url", "origin", locator);
    await assert.rejects(
      repository.remoteFetchUrl("origin"),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
    );
    await assert.rejects(
      repository.remotePushUrl("origin"),
      (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
    );
  }
});

test(
  "resolves symlinks before parent components in local remote paths",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const { repo, repository } = await publicationRepository(context);
    const locators = path.join(repo, "locators");
    const nested = path.join(locators, "inside", "deep");
    const intended = path.join(locators, "inside", "target.git");
    const lexicalSibling = path.join(locators, "target.git");
    await mkdir(nested, { recursive: true });
    await git(repo, "init", "--bare", intended);
    await git(repo, "init", "--bare", lexicalSibling);
    await symlink(path.join("inside", "deep"), path.join(locators, "link"));
    const configured = `${path.join(locators, "link")}${path.sep}..${path.sep}target.git`;
    await git(repo, "remote", "set-url", "origin", configured);

    assert.equal(await repository.remoteFetchUrl("origin"), await realpath(intended));
    assert.equal(await repository.remotePushUrl("origin"), await realpath(intended));
  },
);

test(
  "treats Windows UNC-looking remote text as a relative local pathname on POSIX",
  { skip: process.platform === "win32" ? "UNC syntax is absolute on Windows" : false },
  async (context) => {
    const { repo, remote, repository } = await publicationRepository(context);
    const locator = "\\\\server\\share.git";
    await symlink(remote, path.join(repo, locator));
    await git(repo, "remote", "set-url", "origin", locator);

    assert.equal(await repository.remoteFetchUrl("origin"), await realpath(remote));
    assert.equal(await repository.remotePushUrl("origin"), await realpath(remote));
  },
);

test("preserves Git scp-style file host locators instead of parsing them as file URLs", async (context) => {
  const { repo, repository } = await publicationRepository(context);

  for (const locator of [
    "file:/private/example.git",
    "file:relative.git",
    "FILE:///private/example.git",
  ]) {
    await git(repo, "remote", "set-url", "origin", locator);
    assert.equal(await repository.remoteFetchUrl("origin"), locator);
    assert.equal(await repository.remotePushUrl("origin"), locator);
  }
});

test("rejects Windows drive-relative remote locators on every platform", async (context) => {
  const { repo, repository } = await publicationRepository(context);
  await git(repo, "remote", "set-url", "origin", "C:repo.git");

  await assert.rejects(
    repository.remoteFetchUrl("origin"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
  );
  await assert.rejects(
    repository.remotePushUrl("origin"),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
  );
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
