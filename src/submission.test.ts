import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { remoteUrlFingerprint } from "./git.js";
import { runCommand } from "./process.js";
import type { BrokerConfig } from "./types.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function repository(
  context: TestContext,
  configure: (config: BrokerConfig) => void = () => undefined,
): Promise<{ repo: string; baseSha: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  configure(config);
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "protect broker policy");
  await (await MergeBroker.open(repo)).registerCandidateAuthority();
  return { repo, baseSha: await git(repo, "rev-parse", "HEAD") };
}

async function candidateCommit(
  repo: string,
  branch = "producer/candidate",
  contents = "candidate\n",
): Promise<string> {
  await git(repo, "switch", "-c", branch, "main");
  await writeFile(path.join(repo, "candidate.txt"), contents, "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate change");
  const candidate = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return candidate;
}

test("adopts an immutable local ref under protected-base policy without inventing tasks", async (context) => {
  const { repo, baseSha } = await repository(context, (config) => {
    config.approval!.policyRevision = "protected-v2";
    config.validation.focused = [{
      name: "candidate exists",
      command: "node --input-type=commonjs -e \"process.exit(require('node:fs').existsSync('candidate.txt') ? 0 : 1)\"",
      paths: ["candidate.txt"],
    }];
    config.validation.authoritative = [{
      name: "submission context",
      command: "node --input-type=commonjs -e \"process.exit(process.env.MERGE_BROKER_SUBMISSION_ID ? 0 : 1)\"",
    }];
  });
  const candidate = await candidateCommit(repo);

  // Neither the mutable checkout nor the candidate's own config is policy authority. If adoption
  // accidentally uses this file instead of the protected-base blob, validation fails.
  const checkoutConfig = await loadConfig(repo);
  checkoutConfig.validation.focused = [];
  checkoutConfig.validation.authoritative = [{
    name: "untrusted checkout policy",
    command: "node --input-type=commonjs -e \"process.exit(91)\"",
  }];
  await writeFile(configPath(repo), `${JSON.stringify(checkoutConfig, null, 2)}\n`, "utf8");

  const broker = await MergeBroker.open(repo);
  const submission = await broker.adoptCandidate({ ref: "producer/candidate" });

  assert.equal(submission.status, "validated");
  assert.equal(submission.artifact.sha, candidate);
  assert.equal(submission.base.sha, baseSha);
  assert.equal(submission.policy.baseSha, baseSha);
  assert.equal(submission.policy.revision, "protected-v2");
  assert.match(submission.policy.digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(submission.commits, [candidate]);
  assert.deepEqual(submission.paths, ["candidate.txt"]);
  assert.deepEqual(
    submission.validations.map((validation) => [validation.name, validation.exitCode]),
    [["candidate exists", 0], ["submission context", 0]],
  );
  assert.equal(submission.worktree, undefined);

  const state = await broker.state();
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.batches, {});
  assert.deepEqual(state.submissions?.[submission.id], submission);
  assert.equal(await broker.repo.resolveCommit(submission.artifact.retainedRef), candidate);

  // Moving the friendly source ref after validation cannot change the retained authority.
  await git(repo, "switch", "producer/candidate");
  await writeFile(path.join(repo, "later.txt"), "later\n", "utf8");
  await git(repo, "add", "later.txt");
  await git(repo, "commit", "-m", "move producer ref");
  assert.notEqual(await git(repo, "rev-parse", "HEAD"), candidate);
  assert.equal(await broker.repo.resolveCommit(submission.artifact.retainedRef), candidate);

  const manifests = await readdir(broker.store.submissionsDirectory);
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(
    await readFile(path.join(broker.store.submissionsDirectory, manifests[0] ?? "missing"), "utf8"),
  ) as { id?: string; artifact?: { sha?: string } };
  assert.equal(manifest.id, submission.id);
  assert.equal(manifest.artifact?.sha, candidate);
  assert.deepEqual(
    (await broker.store.readAudit()).filter((event) => event.submissionId === submission.id).map((event) => event.event),
    [
      "submission.received",
      "submission.validation_started",
      "submission.retention_established",
      "submission.validated",
    ],
  );
});

test("rejects a malicious checkout config that redirects Gate authority to the producer", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo);
  const malicious = await loadConfig(repo);
  malicious.baseRef = "producer/candidate";
  malicious.baseBranch = "producer/candidate";
  malicious.integration.refreshBase = false;
  await writeFile(configPath(repo), `${JSON.stringify(malicious, null, 2)}\n`, "utf8");

  const broker = await MergeBroker.open(repo);
  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "GATE_AUTHORITY_MISMATCH",
  );
  assert.deepEqual((await broker.state()).submissions, {});
});

test("refuses ambient Git repository and index selection before Gate setup or adoption", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo);
  const broker = await MergeBroker.open(repo);
  for (const [name, value] of [
    ["GIT_INDEX_FILE", path.join(repo, ".git", "attacker-index")],
    ["GIT_EXEC_PATH", path.join(repo, "attacker-git-exec")],
    ["GIT_SSH_COMMAND", "attacker-ssh"],
    ["GIT_PROXY_COMMAND", "attacker-proxy"],
    ["HTTPS_PROXY", "http://127.0.0.1:9"],
    ["GIT_SSL_NO_VERIFY", "1"],
  ] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      await assert.rejects(
        broker.registerCandidateAuthority(),
        (error: unknown) =>
          error instanceof BrokerError &&
          error.code === "SUBMISSION_GIT_UNSUPPORTED" &&
          error.details?.environmentVariable === name,
      );
      await assert.rejects(
        broker.adoptCandidate({ ref: "producer/candidate" }),
        (error: unknown) =>
          error instanceof BrokerError &&
          error.code === "SUBMISSION_GIT_UNSUPPORTED" &&
          error.details?.environmentVariable === name,
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
  assert.deepEqual((await broker.state()).submissions, {});
});

test("requires the protected-base config locator to match registered Gate authority", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo);
  const explicitLocal = await loadConfig(repo);
  explicitLocal.baseRef = "refs/heads/main";
  await writeFile(configPath(repo), `${JSON.stringify(explicitLocal, null, 2)}\n`, "utf8");
  const broker = await MergeBroker.open(repo);
  await broker.registerCandidateAuthority({ replace: true });

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "GATE_AUTHORITY_MISMATCH",
  );
  assert.deepEqual((await broker.state()).submissions, {});
});

test("requires a fetch target before registering a refreshable base branch", async (context) => {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-refresh-authority-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);

  const config = await loadConfig(repo);
  assert.equal(config.baseRef, config.baseBranch);
  assert.equal(config.integration.refreshBase, true);
  const broker = await MergeBroker.open(repo);
  await assert.rejects(
    broker.registerCandidateAuthority(),
    (error: unknown) => error instanceof BrokerError && error.code === "REMOTE_URL_UNKNOWN",
  );
  assert.equal(await broker.candidateAuthority(), undefined);
});

test("persists a validator rejection against the exact retained candidate", async (context) => {
  const { repo } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "protected rejection",
      command: "node --input-type=commonjs -e \"process.exit(7)\"",
    }];
  });
  const candidate = await candidateCommit(repo);
  const broker = await MergeBroker.open(repo);

  const submission = await broker.adoptCandidate({ ref: candidate });

  assert.equal(submission.status, "rejected");
  assert.equal(submission.errorCode, "VALIDATION_FAILED");
  assert.match(submission.error ?? "", /protected rejection/iu);
  assert.equal(submission.validations.length, 1);
  assert.notEqual(submission.validations[0]?.exitCode, 0);
  assert.equal(await broker.repo.resolveCommit(submission.artifact.retainedRef), candidate);
  assert.equal(
    await broker.repo.listWorktrees().then((worktrees) =>
      worktrees.some((worktree) => path.resolve(worktree.path).includes(submission.id))),
    false,
  );
});

test("derives every path touched by retained history, not only the final tree diff", async (context) => {
  const { repo } = await repository(context);
  await git(repo, "switch", "-c", "producer/history", "main");
  await writeFile(path.join(repo, "transient.txt"), "must remain visible to policy\n", "utf8");
  await git(repo, "add", "transient.txt");
  await git(repo, "commit", "-m", "touch transient path");
  await git(repo, "rm", "transient.txt");
  await writeFile(path.join(repo, "candidate.txt"), "final change\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "restore transient path and finish candidate");
  await git(repo, "switch", "main");

  const submission = await (await MergeBroker.open(repo)).adoptCandidate({ ref: "producer/history" });
  assert.equal(submission.status, "validated", submission.error ?? "unexpected submission status");
  assert.deepEqual(submission.paths, ["candidate.txt", "transient.txt"]);
  assert.equal(submission.commits.length, 2);
});

test("rejects a candidate with a missing blob used only by retained history", async (context) => {
  const { repo } = await repository(context);
  await git(repo, "switch", "-c", "producer/missing-history", "main");
  await writeFile(path.join(repo, "transient.txt"), "historical bytes\n", "utf8");
  await git(repo, "add", "transient.txt");
  await git(repo, "commit", "-m", "add historical blob");
  const historical = await git(repo, "rev-parse", "HEAD:transient.txt");
  await git(repo, "rm", "transient.txt");
  await writeFile(path.join(repo, "candidate.txt"), "final bytes\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "delete historical blob");
  await git(repo, "switch", "main");
  const commonGitDir = await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  await rm(path.join(commonGitDir, "objects", historical.slice(0, 2), historical.slice(2)));

  const broker = await MergeBroker.open(repo);
  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/missing-history" }),
    (error: unknown) => error instanceof BrokerError && error.code === "GIT_OBJECT_READ_FAILED",
  );
  assert.deepEqual((await broker.state()).submissions, {});
});

test("ignores ambient Git replacement objects when materializing the retained candidate", async (context) => {
  const { repo, baseSha } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "exact original bytes",
      command: "node --input-type=commonjs -e \"process.exit(require('node:fs').readFileSync('candidate.txt', 'utf8') === 'original\\n' ? 0 : 1)\"",
    }];
  });
  const candidate = await candidateCommit(repo, "producer/original", "original\n");
  await git(repo, "switch", "-c", "replacement-object", baseSha);
  await writeFile(path.join(repo, "candidate.txt"), "replacement\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "ambient replacement object");
  const replacement = await git(repo, "rev-parse", "HEAD");
  await git(repo, "replace", candidate, replacement);
  await git(repo, "switch", "main");

  const submission = await (await MergeBroker.open(repo)).adoptCandidate({ ref: "producer/original" });
  assert.equal(submission.status, "validated", submission.error ?? "unexpected submission status");
  assert.equal(submission.artifact.sha, candidate);
  assert.notEqual(submission.artifact.sha, replacement);
});

test(
  "does not run repository checkout hooks while materializing a candidate",
  { skip: process.platform === "win32" ? "POSIX executable hook fixture" : false },
  async (context) => {
    const { repo } = await repository(context);
    await candidateCommit(repo, "producer/hook-free");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    const marker = path.join(repo, ".git", "gate-checkout-hook-ran");
    await writeFile(hook, `#!/bin/sh\nprintf 'hook ran\\n' > ${JSON.stringify(marker)}\n`, "utf8");
    await chmod(hook, 0o755);

    const submission = await (await MergeBroker.open(repo)).adoptCandidate({ ref: "producer/hook-free" });
    assert.equal(submission.status, "validated", submission.error ?? "unexpected submission status");
    await assert.rejects(access(marker));
  },
);

test(
  "fails closed when a validator tampers with the retained candidate ref",
  async (context) => {
    const { repo } = await repository(context, (config) => {
      config.validation.authoritative = [{
        name: "tamper with retained ref",
        command: "node --input-type=commonjs -e \"require('node:child_process').execFileSync('git', ['update-ref', '-d', 'refs/merge-broker/adopted/' + process.env.MERGE_BROKER_SUBMISSION_ID])\"",
      }];
    });
    const candidate = await candidateCommit(repo, "producer/ref-tamper");

    const submission = await (await MergeBroker.open(repo)).adoptCandidate({
      ref: "producer/ref-tamper",
    });

    assert.equal(submission.status, "failed");
    assert.equal(submission.errorCode, "SUBMISSION_REF_CHANGED");
    assert.equal(await git(repo, "rev-parse", submission.artifact.retainedRef), candidate);
  },
);

test("keeps a truthful rejection and restores a retained ref deleted by the failing validator", async (context) => {
  const { repo } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "reject after deleting retained ref",
      command: "node --input-type=commonjs -e \"require('node:child_process').execFileSync('git', ['update-ref', '-d', 'refs/merge-broker/adopted/' + process.env.MERGE_BROKER_SUBMISSION_ID]); process.exit(7)\"",
    }];
  });
  const candidate = await candidateCommit(repo, "producer/ref-delete-reject");

  const submission = await (await MergeBroker.open(repo)).adoptCandidate({
    ref: "producer/ref-delete-reject",
  });

  assert.equal(submission.status, "rejected");
  assert.equal(submission.errorCode, "VALIDATION_FAILED");
  assert.notEqual(submission.validations[0]?.exitCode, 0);
  assert.equal(await git(repo, "rev-parse", submission.artifact.retainedRef), candidate);
});

test("discards validation success when cleanup deletes the retained ref", async (context) => {
  const { repo } = await repository(context);
  const candidate = await candidateCommit(repo, "producer/cleanup-ref-delete");
  const broker = await MergeBroker.open(repo);
  const removeWorktree = broker.repo.removeWorktree.bind(broker.repo);
  broker.repo.removeWorktree = async (destination: string): Promise<void> => {
    await removeWorktree(destination);
    const refs = (await git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/merge-broker/adopted",
    )).split("\n").filter(Boolean);
    for (const ref of refs) await git(repo, "update-ref", "-d", ref);
  };

  const submission = await broker.adoptCandidate({ ref: "producer/cleanup-ref-delete" });

  assert.equal(submission.status, "failed");
  assert.equal(submission.errorCode, "SUBMISSION_REF_CHANGED");
  assert.equal(await git(repo, "rev-parse", submission.artifact.retainedRef), candidate);
});

test("retains a durable integrity tombstone when recovery stops after ref repair", async (context) => {
  const { repo } = await repository(context);
  const candidate = await candidateCommit(repo, "producer/ref-repair-crash");
  const broker = await MergeBroker.open(repo);
  const removeWorktree = broker.repo.removeWorktree.bind(broker.repo);
  broker.repo.removeWorktree = async (destination: string, options): Promise<void> => {
    await removeWorktree(destination, options);
    const refs = (await git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/merge-broker/adopted",
    )).split("\n").filter(Boolean);
    for (const ref of refs) await git(repo, "update-ref", "-d", ref);
  };
  const retain = broker.repo.retainPinnedLocalRef.bind(broker.repo);
  broker.repo.retainPinnedLocalRef = async (pinId, expectedOid, beforeRepair) => {
    const result = await retain(pinId, expectedOid, beforeRepair);
    if (result.repaired) throw new Error("simulated stop after retained-ref repair");
    return result;
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/ref-repair-crash" }),
    /simulated stop after retained-ref repair/iu,
  );
  const pending = Object.values((await broker.state()).submissions)[0];
  assert.equal(pending?.status, "validating");
  assert.ok(pending?.retentionCompromisedAt);
  assert.equal(await git(repo, "rev-parse", pending?.artifact.retainedRef ?? "missing"), candidate);

  const restarted = await MergeBroker.open(repo);
  const recovery = await restarted.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
  const recovered = await restarted.submission(pending?.id ?? "missing");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.errorCode, "SUBMISSION_REF_CHANGED");
  assert.equal(recovered.retentionCompromisedAt, pending?.retentionCompromisedAt);
});

test("recovery treats a ref lost after validator execution as compromised", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo, "producer/ref-lost-before-postcheck");
  const broker = await MergeBroker.open(repo);
  const removeWorktree = broker.repo.removeWorktree.bind(broker.repo);
  broker.repo.removeWorktree = async (destination: string, options): Promise<void> => {
    await removeWorktree(destination, options);
    const refs = (await git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      "refs/merge-broker/adopted",
    )).split("\n").filter(Boolean);
    for (const ref of refs) await git(repo, "update-ref", "-d", ref);
    throw new Error("simulated stop before retained-ref post-check");
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/ref-lost-before-postcheck" }),
    /simulated stop before retained-ref post-check/iu,
  );
  const pending = Object.values((await broker.state()).submissions)[0];
  assert.equal(pending?.status, "validating");
  assert.ok(pending?.retentionEstablishedAt);
  assert.equal(pending?.retentionCompromisedAt, undefined);

  const restarted = await MergeBroker.open(repo);
  const recovery = await restarted.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
  const recovered = await restarted.submission(pending?.id ?? "missing");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.errorCode, "SUBMISSION_REF_CHANGED");
  assert.ok(recovered.retentionCompromisedAt);
});

test(
  "repairs validator cache permissions so finalization does not loop",
  { skip: process.platform === "win32" ? "POSIX permission fixture" : false },
  async (context) => {
    const { repo } = await repository(context, (config) => {
      config.validation.authoritative = [{
        name: "lock cache permissions",
        command: "node --input-type=commonjs -e \"require('node:fs').chmodSync(process.env.MERGE_BROKER_CACHE_DIR, 0)\"",
      }];
    });
    await candidateCommit(repo, "producer/cache-permissions");

    const submission = await (await MergeBroker.open(repo)).adoptCandidate({
      ref: "producer/cache-permissions",
    });

    assert.equal(submission.status, "validated", submission.error ?? "unexpected submission status");
  },
);

test(
  "fresh recovery repairs Gate worktree permissions and reaches a terminal rejection",
  { skip: process.platform === "win32" ? "POSIX permission fixture" : false },
  async (context) => {
    const { repo } = await repository(context, (config) => {
      config.validation.authoritative = [{
        name: "lock worktree permissions",
        command: "node --input-type=commonjs -e \"require('node:fs').chmodSync('.', 0)\"",
      }];
    });
    await candidateCommit(repo, "producer/worktree-permissions");
    const broker = await MergeBroker.open(repo);
    broker.repo.removeWorktree = async () => {
      throw new Error("simulated stop with inaccessible Gate worktree");
    };

    await assert.rejects(
      broker.adoptCandidate({ ref: "producer/worktree-permissions" }),
      /simulated stop with inaccessible Gate worktree/iu,
    );
    const pending = Object.values((await broker.state()).submissions ?? {})[0];
    assert.ok(pending?.worktree);
    context.after(async () => {
      await chmod(pending.worktree ?? "", 0o700).catch(() => undefined);
    });
    assert.equal((await lstat(pending.worktree)).mode & 0o777, 0);
    assert.equal(pending.status, "validating");

    const restarted = await MergeBroker.open(repo);
    const recovery = await restarted.recoverAbandonedIntegrations();
    assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
    assert.deepEqual(recovery.submissionsRecovered, [pending.id], JSON.stringify(recovery));
    const recovered = await restarted.submission(pending.id);
    assert.equal(recovered.status, "rejected");
    assert.equal(recovered.errorCode, "VALIDATOR_MUTATED_WORKTREE");
    assert.equal(recovered.worktree, undefined);
    assert.equal((await restarted.repo.listWorktrees()).some((item) =>
      item.path.includes(pending.id)), false);
  },
);

test("fresh recovery repairs a deleted Gate gitfile from its exact prunable registry", async (context) => {
  const { repo } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "delete worktree gitfile",
      command: "node --input-type=commonjs -e \"require('node:fs').unlinkSync('.git')\"",
    }];
  });
  await candidateCommit(repo, "producer/deleted-gitfile");
  const broker = await MergeBroker.open(repo);
  broker.repo.removeWorktree = async () => {
    throw new Error("simulated stop with deleted Gate gitfile");
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/deleted-gitfile" }),
    /simulated stop with deleted Gate gitfile/iu,
  );
  const pending = Object.values((await broker.state()).submissions ?? {})[0];
  assert.ok(pending?.worktree);
  assert.equal(pending.status, "validating");
  await assert.rejects(access(path.join(pending.worktree, ".git")));

  const restarted = await MergeBroker.open(repo);
  const recovery = await restarted.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
  assert.deepEqual(recovery.submissionsRecovered, [pending.id], JSON.stringify(recovery));
  const recovered = await restarted.submission(pending.id);
  assert.equal(recovered.status, "rejected");
  assert.equal(recovered.errorCode, "VALIDATOR_MUTATED_WORKTREE");
  assert.equal(recovered.worktree, undefined);
});

test("fresh recovery clears only an exact stale registry after the Gate root is deleted", async (context) => {
  const { repo } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "delete worktree root",
      command: "node --input-type=commonjs -e \"process.exit(0)\"",
    }];
  });
  await candidateCommit(repo, "producer/deleted-root");
  const broker = await MergeBroker.open(repo);
  broker.repo.removeWorktree = async (destination: string) => {
    await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw new Error("simulated stop with deleted Gate root");
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/deleted-root" }),
    /simulated stop with deleted Gate root/iu,
  );
  const pending = Object.values((await broker.state()).submissions ?? {})[0];
  assert.ok(pending?.worktree);
  assert.equal(pending.status, "validating");
  await assert.rejects(access(pending.worktree));

  const restarted = await MergeBroker.open(repo);
  const recovery = await restarted.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
  assert.deepEqual(recovery.submissionsRecovered, [pending.id], JSON.stringify(recovery));
  const recovered = await restarted.submission(pending.id);
  assert.equal(recovered.status, "validated");
  assert.equal(recovered.errorCode, undefined);
  assert.equal(recovered.worktree, undefined);
  assert.equal((await restarted.repo.listWorktrees()).some((item) =>
    item.path.includes(pending.id)), false);
});

test(
  "fresh Gate cleanup refuses a redirected root and preserves its decoy for operator recovery",
  { skip: process.platform === "win32" ? "symlink fixture requires Windows developer mode" : false },
  async (context) => {
    const { repo } = await repository(context, (config) => {
      config.validation.authoritative = [{
        name: "redirect worktree root",
        command:
          "node --input-type=commonjs -e \"const fs=require('node:fs'),cwd=process.cwd(),decoy=cwd+'-decoy'; if(fs.existsSync(decoy)) process.exit(7); fs.renameSync(cwd,decoy); fs.symlinkSync(decoy,cwd,'dir')\"",
      }];
    });
    await candidateCommit(repo, "producer/root-redirect");
    const broker = await MergeBroker.open(repo);
    broker.repo.removeWorktree = async () => {
      throw new Error("simulated stop with redirected Gate root");
    };

    await assert.rejects(
      broker.adoptCandidate({ ref: "producer/root-redirect" }),
      /simulated stop with redirected Gate root/iu,
    );
    const pending = Object.values((await broker.state()).submissions ?? {})[0];
    assert.ok(pending?.worktree);
    const decoy = `${pending.worktree}-decoy`;
    context.after(async () => {
      await rm(decoy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    assert.equal((await lstat(pending.worktree)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(decoy, "candidate.txt"), "utf8"), "candidate\n");

    const restarted = await MergeBroker.open(repo);
    const refused = await restarted.recoverAbandonedIntegrations();
    assert.equal((refused.submissionWarnings ?? []).length, 1, JSON.stringify(refused));
    assert.match((refused.submissionWarnings ?? [])[0] ?? "", /different directory moved into/iu);
    assert.deepEqual(refused.submissionsRecovered, [], JSON.stringify(refused));
    assert.equal(await readFile(path.join(decoy, "candidate.txt"), "utf8"), "candidate\n");
    assert.equal((await lstat(decoy)).isDirectory(), true);

    // Once an operator restores the exact inode to its recorded path, recovery can safely clean
    // and rerun it. Leave a marker at the decoy name so the test validator rejects without
    // redirecting the replacement worktree again.
    await unlink(pending.worktree);
    await rename(decoy, pending.worktree);
    await mkdir(decoy);
    const recovery = await restarted.recoverAbandonedIntegrations();
    assert.deepEqual(recovery.submissionWarnings, [], JSON.stringify(recovery));
    assert.deepEqual(recovery.submissionsRecovered, [pending.id], JSON.stringify(recovery));
    const recovered = await restarted.submission(pending.id);
    assert.equal(recovered.status, "rejected");
    assert.equal(recovered.worktree, undefined);
  },
);

test(
  "refuses a validator working directory redirected outside the candidate worktree",
  { skip: process.platform === "win32" ? "symlink fixture requires no Windows developer mode" : false },
  async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), "merge-broker-validator-escape-"));
    context.after(async () => {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const { repo } = await repository(context, (config) => {
      config.validation.authoritative = [{
        name: "must stay inside",
        workingDirectory: "validator",
        command: "node --input-type=commonjs -e \"require('node:fs').writeFileSync('escaped.txt', 'bad')\"",
      }];
    });
    await candidateCommit(repo, "producer/cwd-escape");
    await git(repo, "switch", "producer/cwd-escape");
    await symlink(outside, path.join(repo, "validator"));
    await git(repo, "add", "validator");
    await git(repo, "commit", "-m", "redirect validator cwd");
    await git(repo, "switch", "main");

    const submission = await (await MergeBroker.open(repo)).adoptCandidate({
      ref: "producer/cwd-escape",
    });

    assert.equal(submission.status, "rejected");
    assert.equal(submission.errorCode, "VALIDATION_FAILED");
    await assert.rejects(access(path.join(outside, "escaped.txt")));
  },
);

test("replays a validation transaction interrupted before worktree cleanup", async (context) => {
  const { repo } = await repository(context, (config) => {
    config.validation.authoritative = [{
      name: "recoverable validation",
      command: "node --input-type=commonjs -e \"process.exit(0)\"",
    }];
  });
  await candidateCommit(repo);
  const broker = await MergeBroker.open(repo);
  const removeWorktree = broker.repo.removeWorktree.bind(broker.repo);
  let interrupted = false;
  broker.repo.removeWorktree = async () => {
    if (!interrupted) {
      interrupted = true;
      throw new Error("simulated stop before submission finalization");
    }
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    /simulated stop before submission finalization/iu,
  );
  const pending = Object.values((await broker.state()).submissions ?? {})[0];
  assert.ok(pending);
  assert.equal(pending.status, "validating");
  assert.ok(pending.worktree);
  assert.equal(await broker.repo.resolveCommit(pending.artifact.retainedRef), pending.artifact.sha);
  const audited = await broker.auditWorktrees();
  assert.deepEqual(
    audited.worktrees.find((worktree) =>
      path.resolve(worktree.path) === path.resolve(pending.worktree ?? ""))?.registeredSubmissionIds,
    [pending.id],
  );
  assert.equal(audited.unregisteredWorktrees.includes(pending.worktree), false);

  const assertGateGitSupported = broker.repo.assertGateGitSupported.bind(broker.repo);
  broker.repo.assertGateGitSupported = async () => {
    throw new BrokerError("SUBMISSION_GIT_UNSUPPORTED", "simulated unavailable Gate Git");
  };
  const unavailableRecovery = await broker.recoverAbandonedIntegrations();
  assert.deepEqual(unavailableRecovery.submissionsRecovered, []);
  assert.match(unavailableRecovery.submissionWarnings?.[0] ?? "", /unavailable Gate Git/iu);
  assert.equal((await broker.submission(pending.id)).status, "validating");

  broker.repo.assertGateGitSupported = assertGateGitSupported;
  broker.repo.removeWorktree = removeWorktree;
  const recovery = await broker.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsRecovered, [pending.id]);
  assert.deepEqual(recovery.submissionWarnings, []);
  const recovered = await broker.submission(pending.id);
  assert.equal(recovered.status, "validated");
  assert.equal(recovered.worktree, undefined);
  assert.equal(recovered.validations[0]?.name, "recoverable validation");
});

test("recovery repairs a swapped Gate gitfile without removing its sibling worktree", async (context) => {
  const { repo } = await repository(context);
  const decoy = `${repo}-decoy-worktree`;
  context.after(async () => {
    await rm(decoy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const config = await loadConfig(repo);
  const decoyGitFile = path.join(decoy, ".git");
  config.validation.authoritative = [{
    name: "swap worktree administration",
    command:
      `node --input-type=commonjs -e "const fs=require('node:fs'),data=fs.readFileSync(process.argv[1]),fd=fs.openSync('.git','r+'); try{fs.ftruncateSync(fd,0);fs.writeSync(fd,data,0,data.length,0)}finally{fs.closeSync(fd)}" ${JSON.stringify(decoyGitFile)}`,
  }];
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "protect marker-swap validator");
  await (await MergeBroker.open(repo)).registerCandidateAuthority({ replace: true });
  const candidate = await candidateCommit(repo, "producer/gitfile-swap");
  await git(repo, "worktree", "add", "--detach", decoy, candidate);

  const broker = await MergeBroker.open(repo);
  broker.repo.removeWorktree = async () => {
    throw new Error("simulated stop after validator marker swap");
  };
  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/gitfile-swap" }),
    /simulated stop after validator marker swap/iu,
  );
  const pending = Object.values((await broker.state()).submissions ?? {})[0];
  assert.ok(pending?.worktree);
  assert.equal(pending.status, "validating");
  assert.equal(
    await realpath(await git(pending.worktree, "rev-parse", "--absolute-git-dir")),
    await realpath(await git(decoy, "rev-parse", "--absolute-git-dir")),
    "the interrupted worktree remains redirected to the sibling before recovery",
  );

  // A new broker has no in-memory binding. It must recover A from the repository registry's
  // backlink, repair A's marker, and leave the decoy's marker and administration entry untouched.
  const restarted = await MergeBroker.open(repo);
  const recovery = await restarted.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsRecovered, [pending.id]);
  assert.deepEqual(recovery.submissionWarnings, []);
  const recovered = await restarted.submission(pending.id);
  assert.equal(recovered.status, "rejected");
  assert.equal(recovered.errorCode, "VALIDATOR_MUTATED_WORKTREE");
  assert.equal(recovered.worktree, undefined);
  assert.equal(await git(decoy, "rev-parse", "HEAD"), candidate);
  const physicalDecoy = await realpath(decoy);
  const physicalWorktrees = await Promise.all(
    (await restarted.repo.listWorktrees()).map(async (item) => await realpath(item.path)),
  );
  assert.equal(physicalWorktrees.includes(physicalDecoy), true);
});

test("terminal state leads its derived manifest and recovery regenerates a missing sidecar", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo, "producer/manifest-repair");
  const broker = await MergeBroker.open(repo);
  const writeManifest = broker.store.writeSubmissionManifest.bind(broker.store);
  broker.store.writeSubmissionManifest = async () => {
    throw new Error("simulated sidecar write failure");
  };

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/manifest-repair" }),
    (error: unknown) =>
      error instanceof BrokerError && error.code === "SUBMISSION_MANIFEST_WRITE_FAILED",
  );
  const terminal = Object.values((await broker.state()).submissions ?? {})[0];
  assert.ok(terminal);
  assert.equal(terminal.status, "validated");
  assert.deepEqual(await readdir(broker.store.submissionsDirectory), []);

  broker.store.writeSubmissionManifest = writeManifest;
  const recovery = await broker.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsRecovered, []);
  assert.deepEqual(recovery.submissionWarnings, []);
  const manifests = await readdir(broker.store.submissionsDirectory);
  assert.equal(manifests.length, 1);
  const manifestPath = path.join(broker.store.submissionsDirectory, manifests[0] ?? "missing");
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), terminal);

  // Repairing a terminal derived sidecar needs no Git or policy authority. Losing the authority
  // registration must not make a truthful record disappear from filesystem-based inspection.
  await rm(path.join(broker.repo.commonGitDir, "merge-broker-gate-authority.json"), { force: true });
  await rm(manifestPath, { force: true });
  const authoritylessRecovery = await broker.recoverAbandonedIntegrations();
  assert.deepEqual(authoritylessRecovery.submissionsRecovered, []);
  assert.deepEqual(authoritylessRecovery.submissionWarnings, []);
  const repairedWithoutAuthority = await readdir(broker.store.submissionsDirectory);
  assert.equal(repairedWithoutAuthority.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      broker.store.submissionsDirectory,
      repairedWithoutAuthority[0] ?? "missing",
    ), "utf8")),
    terminal,
  );
});

test("does not replay a pending submission under a replaced Gate authority", async (context) => {
  const { repo } = await repository(context);
  await candidateCommit(repo);
  const originalBroker = await MergeBroker.open(repo);
  originalBroker.repo.removeWorktree = async () => {
    throw new Error("simulated stop before authority replacement");
  };
  await assert.rejects(
    originalBroker.adoptCandidate({ ref: "producer/candidate" }),
    /simulated stop before authority replacement/iu,
  );
  const pending = Object.values((await originalBroker.state()).submissions ?? {})[0];
  assert.ok(pending);
  assert.equal(pending.status, "validating");

  const changed = await loadConfig(repo);
  changed.baseRef = "refs/heads/main";
  await writeFile(configPath(repo), `${JSON.stringify(changed, null, 2)}\n`, "utf8");
  const replacementBroker = await MergeBroker.open(repo);
  const replacement = await replacementBroker.registerCandidateAuthority({ replace: true });
  assert.notEqual(replacement.digest, pending.authorityDigest);

  const recovery = await replacementBroker.recoverAbandonedIntegrations();
  assert.deepEqual(recovery.submissionsRecovered, []);
  assert.equal(recovery.submissionWarnings?.length, 1);
  assert.match(recovery.submissionWarnings?.[0] ?? "", /different Gate authority/iu);
  assert.equal((await replacementBroker.submission(pending.id)).status, "validating");
});

test("refreshes a fully qualified remote-tracking base before adopting", async (context) => {
  const { repo } = await repository(context);
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-remote-"));
  context.after(async () => {
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const remote = path.join(remoteParent, "origin.git");
  const updater = path.join(remoteParent, "updater");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);

  const config = await loadConfig(repo);
  config.baseRef = "refs/remotes/origin/main";
  config.integration.refreshBase = true;
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "use fully qualified protected base");
  await git(repo, "push", "-u", "origin", "main");
  await candidateCommit(repo);

  await git(remoteParent, "clone", "--branch", "main", remote, updater);
  await git(updater, "config", "user.name", "Remote Base Updater");
  await git(updater, "config", "user.email", "updater@merge-broker.invalid");
  await writeFile(path.join(updater, "remote-base.txt"), "advanced protected base\n", "utf8");
  await git(updater, "add", "remote-base.txt");
  await git(updater, "commit", "-m", "advance protected base");
  await git(updater, "push", "origin", "main");
  const remoteHead = await git(updater, "rev-parse", "HEAD");
  assert.notEqual(await git(repo, "rev-parse", "refs/remotes/origin/main"), remoteHead);

  const broker = await MergeBroker.open(repo);
  await broker.registerCandidateAuthority({ replace: true });
  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "BASE_NOT_ANCESTOR",
  );
  assert.deepEqual((await broker.state()).submissions, {});
});

test("binds Gate base authority to a remote fetch URL when pushurl names another repository", async (context) => {
  const { repo } = await repository(context);
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-split-remote-"));
  context.after(async () => {
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const fetchRemote = path.join(remoteParent, "protected.git");
  const pushRemote = path.join(remoteParent, "looser-fork.git");
  const updater = path.join(remoteParent, "updater");
  await git(repo, "init", "--bare", fetchRemote);
  await git(repo, "init", "--bare", pushRemote);
  await git(repo, "remote", "add", "origin", fetchRemote);
  await git(repo, "remote", "set-url", "--push", "origin", pushRemote);

  const config = await loadConfig(repo);
  config.baseRef = "refs/remotes/origin/main";
  config.integration.refreshBase = true;
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "bind protected fetch target");
  await git(repo, "push", fetchRemote, "main:main");
  await git(repo, "push", pushRemote, "main:main");
  await git(repo, "fetch", "origin", "main:refs/remotes/origin/main");
  await candidateCommit(repo);

  await git(remoteParent, "clone", "--branch", "main", fetchRemote, updater);
  await git(updater, "config", "user.name", "Protected Base Updater");
  await git(updater, "config", "user.email", "updater@merge-broker.invalid");
  await writeFile(path.join(updater, "protected-only.txt"), "new protected base\n", "utf8");
  await git(updater, "add", "protected-only.txt");
  await git(updater, "commit", "-m", "advance only protected fetch target");
  await git(updater, "push", "origin", "main");

  const broker = await MergeBroker.open(repo);
  const authority = await broker.registerCandidateAuthority({ replace: true });
  const fetchUrl = await broker.repo.remoteFetchUrl("origin");
  const pushUrl = await broker.repo.remotePushUrl("origin");
  assert.equal(authority.target.fetchUrlFingerprint, remoteUrlFingerprint(fetchUrl));
  assert.notEqual(authority.target.fetchUrlFingerprint, remoteUrlFingerprint(pushUrl));

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "BASE_NOT_ANCESTOR",
  );
  assert.deepEqual((await broker.state()).submissions, {});
});

test("rejects non-linear intake before creating durable submission state", async (context) => {
  const { repo, baseSha } = await repository(context);
  await candidateCommit(repo);
  await git(repo, "switch", "-c", "side", baseSha);
  await writeFile(path.join(repo, "side.txt"), "side\n", "utf8");
  await git(repo, "add", "side.txt");
  await git(repo, "commit", "-m", "side change");
  await git(repo, "switch", "producer/candidate");
  await git(repo, "merge", "--no-ff", "side", "-m", "merge side");
  const broker = await MergeBroker.open(repo);

  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "NON_LINEAR_HISTORY",
  );
  assert.deepEqual((await broker.state()).submissions, {});
  assert.deepEqual(
    (await broker.repo.git(["for-each-ref", "--format=%(refname)", "refs/merge-broker/adopted/"])).stdout.trim(),
    "",
  );
});

test("requires committed protected-base policy and local authoritative validation", async (context) => {
  const missing = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-policy-"));
  context.after(async () => {
    await rm(missing, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(missing, "init", "-b", "main");
  await git(missing, "config", "user.name", "Merge Broker Test");
  await git(missing, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(missing, "README.md"), "# no committed policy\n", "utf8");
  await git(missing, "add", "README.md");
  await git(missing, "commit", "-m", "initial");
  await MergeBroker.initialize(missing);
  const missingConfig = await loadConfig(missing);
  missingConfig.integration.refreshBase = false;
  await writeFile(configPath(missing), `${JSON.stringify(missingConfig, null, 2)}\n`, "utf8");
  await (await MergeBroker.open(missing)).registerCandidateAuthority();
  await candidateCommit(missing);
  await assert.rejects(
    (await MergeBroker.open(missing)).adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "SUBMISSION_POLICY_UNAVAILABLE",
  );

  const { repo } = await repository(context, (config) => {
    config.validation.authority = "required-ci";
    const publicKey = config.integration.provenance?.publicKey;
    assert.ok(publicKey);
    config.integration.provenance = {
      enabled: true,
      directory: ".merge-broker/attestations",
      requireSignature: true,
      publicKey,
    };
    config.publish.mode = "pull-request";
  });
  await candidateCommit(repo);
  await assert.rejects(
    (await MergeBroker.open(repo)).adoptCandidate({ ref: "producer/candidate" }),
    (error: unknown) => error instanceof BrokerError && error.code === "SUBMISSION_VALIDATION_UNAVAILABLE",
  );
});

test("rejects an oversized protected-base policy before reading it into broker memory", async (context) => {
  const { repo } = await repository(context);
  const policyPath = configPath(repo);
  const reviewedConfig = await readFile(policyPath, "utf8");
  await writeFile(policyPath, `{"padding":"${"x".repeat(1_100_000)}"}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "oversized protected policy");
  await candidateCommit(repo, "producer/oversized-policy");
  // Opening the broker still uses an operator-reviewed working-tree configuration; adoption must
  // independently bound the committed policy blob selected by the protected base.
  await writeFile(policyPath, reviewedConfig, "utf8");

  const broker = await MergeBroker.open(repo);
  await assert.rejects(
    broker.adoptCandidate({ ref: "producer/oversized-policy" }),
    (error: unknown) =>
      error instanceof BrokerError &&
      error.code === "SUBMISSION_POLICY_INVALID" &&
      /safety limit/iu.test(error.message),
  );
  assert.deepEqual((await broker.state()).submissions, {});
});
