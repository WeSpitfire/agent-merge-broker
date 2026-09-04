import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { runCommand, type CommandResult } from "./process.js";

const PULL_REQUEST = "https://github.example.invalid/owner/repo/pull/17";
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function repository(context: TestContext): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-cli-"));
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
  return repo;
}

async function submitTask(broker: MergeBroker, repo: string, id: string): Promise<void> {
  const claim = await broker.claimTask({ id, holder: "agent", expectedPaths: [`src/${id}.ts`] });
  await git(repo, "switch", "-c", `agent/${id}`, "main");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "src", `${id}.ts`),
    `export const ${id.replaceAll("-", "_")} = true;\n`,
    "utf8",
  );
  await git(repo, "add", path.posix.join("src", `${id}.ts`));
  await git(repo, "commit", "-m", `implement ${id}`);
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  await broker.submitTask(id, [commit], claim.token);
}

function cliArguments(repo: string): string[] {
  const sourceTest = fileURLToPath(import.meta.url).endsWith(".ts");
  const cli = fileURLToPath(new URL(sourceTest ? "./cli.ts" : "./cli.js", import.meta.url));
  return [
    ...(sourceTest ? ["--import", "tsx"] : []),
    cli,
    "--cwd",
    repo,
    "--json",
    "serve",
    "--once",
    "--publish",
  ];
}

function commandArguments(repo: string, ...args: string[]): string[] {
  const sourceTest = fileURLToPath(import.meta.url).endsWith(".ts");
  const cli = fileURLToPath(new URL(sourceTest ? "./cli.ts" : "./cli.js", import.meta.url));
  return [
    ...(sourceTest ? ["--import", "tsx"] : []),
    cli,
    "--cwd",
    repo,
    "--json",
    ...args,
  ];
}

async function candidateCommit(repo: string, branch = "candidate/local-ref"): Promise<string> {
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "commit broker policy");
  await git(repo, "switch", "-c", branch);
  await writeFile(path.join(repo, "candidate.txt"), "trusted local candidate\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate change");
  const sha = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return sha;
}

async function serveOnce(repo: string): Promise<CommandResult> {
  const result = await runCommand(process.execPath, cliArguments(repo), {
    cwd: PROJECT_ROOT,
    timeoutMs: 30_000,
    allowFailure: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), "serve --once --json must emit one JSON document");
  return result;
}

test("JSON mode envelopes command-line usage errors", async () => {
  const sourceTest = fileURLToPath(import.meta.url).endsWith(".ts");
  const cli = fileURLToPath(new URL(sourceTest ? "./cli.ts" : "./cli.js", import.meta.url));
  const runtime = [...(sourceTest ? ["--import", "tsx"] : []), cli];

  const malformed = await runCommand(process.execPath, [...runtime, "--json", "task", "claim"], {
    cwd: PROJECT_ROOT,
    allowFailure: true,
  });
  assert.equal(malformed.exitCode, 1);
  assert.equal(malformed.stdout, "");
  const body = JSON.parse(malformed.stderr) as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, "INVALID_ARGUMENTS");
  assert.match(body.error?.message ?? "", /missing required argument 'id'/iu);

  const missingCommand = await runCommand(process.execPath, [...runtime, "--json"], {
    cwd: PROJECT_ROOT,
    allowFailure: true,
  });
  assert.equal(missingCommand.exitCode, 1);
  const missingBody = JSON.parse(missingCommand.stderr) as { error?: { code?: string; message?: string } };
  assert.equal(missingBody.error?.code, "INVALID_ARGUMENTS");
  assert.match(missingBody.error?.message ?? "", /command or subcommand is required/iu);

  const help = await runCommand(process.execPath, [...runtime, "--json", "--help"], {
    cwd: PROJECT_ROOT,
    allowFailure: true,
  });
  assert.equal(help.exitCode, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /Usage: merge-broker/iu);

  const missingRef = await runCommand(process.execPath, [...runtime, "--json", "candidate", "adopt"], {
    cwd: PROJECT_ROOT,
    allowFailure: true,
  });
  assert.equal(missingRef.exitCode, 1);
  assert.equal(missingRef.stdout, "");
  const missingRefBody = JSON.parse(missingRef.stderr) as { error?: { code?: string; message?: string } };
  assert.equal(missingRefBody.error?.code, "INVALID_ARGUMENTS");
  assert.match(missingRefBody.error?.message ?? "", /required option '--ref <revision>' not specified/iu);
});

test("candidate adopt retains and validates a local ref without creating Coordinate records", async (context) => {
  const repo = await repository(context);
  const artifactSha = await candidateCommit(repo);

  const unregistered = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "adopt", "--ref", "candidate/local-ref"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(unregistered.exitCode, 1);
  assert.equal(unregistered.stdout, "");
  const unregisteredBody = JSON.parse(unregistered.stderr) as { error?: { code?: string } };
  assert.equal(unregisteredBody.error?.code, "GATE_AUTHORITY_REQUIRED");

  const setup = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "authority", "setup"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(setup.exitCode, 0, setup.stderr);
  const registration = JSON.parse(setup.stdout) as { digest: string; target: { baseRef: string } };
  assert.match(registration.digest, /^[0-9a-f]{64}$/u);
  assert.equal(registration.target.baseRef, "main");

  const shownAuthority = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "authority", "show"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(shownAuthority.exitCode, 0, shownAuthority.stderr);
  assert.deepEqual(JSON.parse(shownAuthority.stdout), JSON.parse(setup.stdout));

  const adopted = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "adopt", "--ref", "candidate/local-ref"),
    { cwd: PROJECT_ROOT, allowFailure: true, timeoutMs: 30_000 },
  );
  assert.equal(adopted.exitCode, 0, adopted.stderr);
  assert.equal(adopted.stderr, "");
  const submission = JSON.parse(adopted.stdout) as {
    id: string;
    status: string;
    source: { ref: string };
    artifact: { sha: string; retainedRef: string };
    paths: string[];
  };
  assert.equal(submission.status, "validated");
  assert.equal(submission.source.ref, "candidate/local-ref");
  assert.equal(submission.artifact.sha, artifactSha);
  assert.deepEqual(submission.paths, ["candidate.txt"]);
  assert.equal(await git(repo, "rev-parse", submission.artifact.retainedRef), artifactSha);

  const shown = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "show", submission.id),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), JSON.parse(adopted.stdout));

  const listed = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "list"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(listed.exitCode, 0, listed.stderr);
  const submissions = JSON.parse(listed.stdout) as Array<{ id: string; artifact: { sha: string } }>;
  assert.deepEqual(submissions.map((item) => item.id), [submission.id]);
  assert.equal(submissions[0]?.artifact.sha, artifactSha);

  const state = await (await MergeBroker.open(repo)).state();
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.batches, {});
  assert.equal(state.submissions?.[submission.id]?.artifact.sha, artifactSha);
});

test("candidate adopt exits unsuccessfully when protected-base validation rejects it", async (context) => {
  const repo = await repository(context);
  const config = await loadConfig(repo);
  config.validation.focused = [{ name: "reject-candidate", command: 'node -e "process.exit(9)"' }];
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await candidateCommit(repo, "candidate/rejected");
  await (await MergeBroker.open(repo)).registerCandidateAuthority();

  const adopted = await runCommand(
    process.execPath,
    commandArguments(repo, "candidate", "adopt", "--ref", "candidate/rejected"),
    { cwd: PROJECT_ROOT, allowFailure: true, timeoutMs: 30_000 },
  );
  assert.equal(adopted.exitCode, 1);
  assert.equal(adopted.stderr, "");
  const submission = JSON.parse(adopted.stdout) as {
    status: string;
    errorCode?: string;
    validations: Array<{ name: string; exitCode: number }>;
  };
  assert.equal(submission.status, "rejected");
  assert.equal(submission.validations[0]?.name, "reject-candidate");
  assert.notEqual(submission.validations[0]?.exitCode, 0);
  assert.ok(submission.errorCode);
});

test("inspects and force-releases the config-independent Gate authority lock", async (context) => {
  const repo = await repository(context);
  const lock = path.join(repo, ".git", "merge-broker-gate-authority.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(
    path.join(lock, "owner.json"),
    `${JSON.stringify({
      pid: 424242,
      host: "different-host.invalid",
      createdAt: "2026-09-04T12:00:00.000Z",
      nonce: "foreign-gate-lock",
    })}\n`,
    "utf8",
  );

  const inspected = await runCommand(
    process.execPath,
    commandArguments(repo, "unlock"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(inspected.exitCode, 0, inspected.stderr);
  const locks = JSON.parse(inspected.stdout) as Array<{ name: string; held: boolean; path: string }>;
  const gate = locks.find((item) => item.name === "gate-authority");
  assert.equal(gate?.held, true);
  assert.equal(gate?.path, await realpath(lock));

  const refused = await runCommand(
    process.execPath,
    commandArguments(repo, "unlock", "gate-authority"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(refused.exitCode, 1);
  assert.equal((JSON.parse(refused.stderr) as { error?: { code?: string } }).error?.code, "LOCK_HELD");

  const released = await runCommand(
    process.execPath,
    commandArguments(repo, "unlock", "gate-authority", "--force"),
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  assert.equal(released.exitCode, 0, released.stderr);
  assert.equal((JSON.parse(released.stdout) as { held?: boolean }).held, false);
});

test("serve --once --json returns one summary document when idle", async (context) => {
  const repo = await repository(context);
  const served = await serveOnce(repo);
  const summary = JSON.parse(served.stdout) as {
    recovery?: { batches?: string[]; tasks?: string[] };
    events?: unknown[];
    results?: unknown[];
  };
  assert.deepEqual(summary.recovery?.batches, []);
  assert.deepEqual(summary.recovery?.tasks, []);
  assert.deepEqual(summary.events, []);
  assert.deepEqual(summary.results, []);
});

test("serve retries a prepared batch after a transient push failure", async (context) => {
  const repo = await repository(context);
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-cli-remote-"));
  const remote = path.join(remoteParent, "origin.git");
  context.after(async () => {
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  await git(repo, "remote", "add", "origin", remote);

  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.publish.mode = "branch";
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const broker = await MergeBroker.open(repo);
  await submitTask(broker, repo, "PUSH-RETRY");
  const integrated = await broker.integrate();
  await rm(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await assert.rejects(broker.publishBatch(integrated.batch.id));
  assert.equal((await broker.state()).batches[integrated.batch.id]?.status, "prepared");

  // The same service process would reach this path on its next poll. `--once` keeps the regression
  // deterministic while exercising the real command and persisted state.
  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  const served = await serveOnce(repo);

  const retried = (await broker.state()).batches[integrated.batch.id];
  assert.equal(retried?.status, "published");
  assert.equal(retried?.error, undefined);
  assert.equal(
    await git(repo, "ls-remote", remote, `refs/heads/${retried?.branchName ?? "missing"}`),
    `${retried?.headSha}\trefs/heads/${retried?.branchName}`,
  );
  assert.match(served.stdout, /"status": "published"/u);

  await submitTask(broker, repo, "NEXT-BATCH");
  await broker.markBatchMerged(integrated.batch.id);
  await serveOnce(repo);
  assert.equal((await broker.task("NEXT-BATCH")).status, "published");
});

test("serve re-cuts a stale prepared batch before publishing it", async (context) => {
  const repo = await repository(context);
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-cli-remote-"));
  const remote = path.join(remoteParent, "origin.git");
  context.after(async () => {
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");

  const config = await loadConfig(repo);
  config.baseRef = "origin/main";
  config.integration.refreshBase = true;
  config.publish.mode = "branch";
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const broker = await MergeBroker.open(repo);
  await submitTask(broker, repo, "STALE-RECOVERY");
  const original = await broker.integrate();

  await writeFile(path.join(repo, "base-moved.txt"), "new base\n", "utf8");
  await git(repo, "add", "base-moved.txt");
  await git(repo, "commit", "-m", "advance base");
  await git(repo, "push", "origin", "main");
  const currentBase = await git(repo, "rev-parse", "main");

  await assert.rejects(broker.publishBatch(original.batch.id), /validated on.*is now/iu);
  assert.equal((await broker.state()).batches[original.batch.id]?.refreshRequired, true);

  const served = await serveOnce(repo);
  const state = await broker.state();
  const replacement = Object.values(state.batches).find(
    (batch) => batch.id !== original.batch.id && batch.taskIds.includes("STALE-RECOVERY"),
  );
  assert.equal(state.batches[original.batch.id]?.status, "closed");
  assert.ok(replacement);
  assert.equal(replacement.status, "published");
  assert.equal(replacement.baseSha, currentBase);
  assert.equal(replacement.refreshRequired, undefined);
  assert.equal((await broker.task("STALE-RECOVERY")).batchId, replacement.id);
  assert.match(served.stdout, /"refreshed": true/u);
});

test("serve finishes warning and warning-free auto-merge hand-offs", {
  skip: process.platform === "win32" ? "POSIX gh fixture" : false,
}, async (context) => {
  const repo = await repository(context);
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-cli-remote-"));
  const remote = path.join(remoteParent, "origin.git");
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-cli-bin-"));
  const gh = path.join(bin, "gh");
  const headFile = path.join(bin, "head");
  const baseFile = path.join(bin, "base");
  const logFile = path.join(bin, "gh.log");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.MERGE_BROKER_GH_HEAD = headFile;
  process.env.MERGE_BROKER_GH_BASE = baseFile;
  process.env.MERGE_BROKER_GH_LOG = logFile;
  context.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.MERGE_BROKER_GH_HEAD;
    delete process.env.MERGE_BROKER_GH_BASE;
    delete process.env.MERGE_BROKER_GH_LOG;
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  const baseSha = await git(repo, "rev-parse", "main");
  await writeFile(baseFile, `${baseSha}\n`, "utf8");
  await writeFile(logFile, "", "utf8");
  await writeFile(
    gh,
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      `  *"pr create"*) cat >/dev/null; echo "${PULL_REQUEST}" ;;`,
      '  *"pr view"*)',
      '    head=$(tr -d "\\n" < "$MERGE_BROKER_GH_HEAD")',
      '    base=$(tr -d "\\n" < "$MERGE_BROKER_GH_BASE")',
      '    printf \'{"state":"OPEN","headRefOid":"%s","baseRefOid":"%s","baseRefName":"main","mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","autoMergeRequest":null,"statusCheckRollup":[]}\\n\' "$head" "$base" ;;',
      '  *) echo "temporary forge failure" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gh, 0o755);

  const config = await loadConfig(repo);
  config.baseRef = "origin/main";
  config.publish.mode = "pull-request";
  config.publish.repository = "github.example.invalid/owner/repo";
  config.publish.autoMerge = true;
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const broker = await MergeBroker.open(repo);
  await submitTask(broker, repo, "AUTO-RETRY");
  const integrated = await broker.integrate();
  await writeFile(headFile, `${integrated.batch.headSha}\n`, "utf8");
  const partial = await broker.publishBatch(integrated.batch.id);
  assert.equal(partial.status, "published");
  assert.equal(partial.autoMergeEnabled, false);
  assert.match(partial.publishWarning ?? "", /auto-merge/iu);

  await writeFile(
    gh,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$MERGE_BROKER_GH_LOG"',
      'case "$*" in',
      `  *"pr list"*) echo '[{"url":"${PULL_REQUEST}"}]' ;;`,
      '  *"pr view"*)',
      '    head=$(tr -d "\\n" < "$MERGE_BROKER_GH_HEAD")',
      '    base=$(tr -d "\\n" < "$MERGE_BROKER_GH_BASE")',
      '    printf \'{"state":"OPEN","headRefOid":"%s","baseRefOid":"%s","baseRefName":"main","mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","statusCheckRollup":[]}\\n\' "$head" "$base" ;;',
      '  *"--auto"*) echo queued ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gh, 0o755);

  await serveOnce(repo);
  let recovered = (await broker.state()).batches[integrated.batch.id];
  assert.equal(recovered?.autoMergeEnabled, true);
  assert.equal(recovered?.publishWarning, undefined);

  // A custom forge adapter may report a clean, warning-free "not yet queued" result. That durable
  // state also has to be resumed, not only the built-in adapter's explicit warning path.
  await broker.store.transaction((state) => {
    const batch = state.batches[integrated.batch.id];
    assert.ok(batch);
    batch.autoMergeEnabled = false;
    delete batch.publishWarning;
  });
  await writeFile(logFile, "", "utf8");

  await serveOnce(repo);
  recovered = (await broker.state()).batches[integrated.batch.id];
  assert.equal(recovered?.autoMergeEnabled, true);
  assert.match(await readFile(logFile, "utf8"), /pr merge .*--auto/u);
});
