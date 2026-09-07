import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { runCommand } from "./process.js";
import type { RecoveryResult } from "./types.js";

type Checkpoint = "pin" | "validation" | "cleanup";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

function childScript(checkpoint?: Checkpoint): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const brokerModule = JSON.stringify(new URL(`./broker${extension}`, import.meta.url).href);
  const gitModule = JSON.stringify(new URL(`./git${extension}`, import.meta.url).href);
  return `
    import { MergeBroker } from ${brokerModule};
    import { GitRepository } from ${gitModule};
    const checkpoint = ${JSON.stringify(checkpoint ?? null)};
    const pause = async () => {
      process.send({ checkpoint });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
    if (checkpoint) {
      const method = { pin: "pinLocalRef", validation: "assertRawWorktree", cleanup: "removeWorktree" }[checkpoint];
      const original = GitRepository.prototype[method];
      GitRepository.prototype[method] = async function (...args) {
        const result = await original.apply(this, args);
        // These methods are reached after the Git pin, a completed focused validator, or exact
        // worktree cleanup. SIGKILL interrupts the parent operation before its next durable step.
        await pause();
        return result;
      };
    }
    const broker = await MergeBroker.open(process.argv[1]);
    const result = checkpoint
      ? await broker.adoptCandidate({ ref: "producer/candidate" })
      : await broker.recoverAbandonedIntegrations();
    process.send({ result });
    process.disconnect();
  `;
}

function startChild(repo: string, checkpoint?: Checkpoint): {
  child: ChildProcess;
  reached: Promise<{ checkpoint?: Checkpoint; result?: RecoveryResult }>;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
  output: () => string;
} {
  const runtime = import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
  const child = spawn(process.execPath, [...runtime, "--input-type=module", "-e", childScript(checkpoint), repo], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    // A killed validator owner cannot run its finally block. Keep all process scratch/cache
    // directories inside this test's Git directory so fixture cleanup also collects those bytes.
    env: {
      ...process.env,
      TMPDIR: path.join(repo, ".git", "process-tmp"),
      TEMP: path.join(repo, ".git", "process-tmp"),
      TMP: path.join(repo, ".git", "process-tmp"),
    },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const reached = new Promise<{ checkpoint?: Checkpoint; result?: RecoveryResult }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Recovery child did not reach ${checkpoint ?? "completion"}: ${output}`));
    }, 45_000);
    child.once("message", (message: { checkpoint?: Checkpoint; result?: RecoveryResult }) => {
      clearTimeout(timeout);
      resolve(message);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Recovery child exited before ${checkpoint ?? "completion"} (${code ?? signal}): ${output}`));
    });
  });
  return { child, reached, exited, output: () => output };
}

async function repository(context: TestContext): Promise<{ repo: string; candidate: string; base: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-process-recovery-"));
  context.after(async () => { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await git(repo, "init", "-b", "main");
  await mkdir(path.join(repo, ".git", "process-tmp"));
  await git(repo, "config", "user.name", "Recovery Process Test");
  await git(repo, "config", "user.email", "recovery@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Recovery fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.leases.lockTimeoutSeconds = 15;
  config.validation.focused = [{
    name: "read candidate", paths: ["candidate.txt"],
    command: "node --input-type=commonjs -e \"process.stdout.write(require('node:fs').readFileSync('candidate.txt', 'utf8'))\"",
  }];
  config.validation.authoritative = [{ name: "complete", command: "node --input-type=commonjs -e \"console.log('complete')\"" }];
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "protected validation policy");
  await (await MergeBroker.open(repo)).registerCandidateAuthority();
  const base = await git(repo, "rev-parse", "main");
  await git(repo, "switch", "-c", "producer/candidate");
  await writeFile(path.join(repo, "candidate.txt"), "candidate preserved\n", "utf8");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate");
  const candidate = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return { repo, candidate, base };
}

for (const checkpoint of ["pin", "validation", "cleanup"] as const) {
  test(`fresh processes recover a broker killed after ${checkpoint}, reclaim its locks, and remain idempotent`, {
    timeout: 120_000,
  }, async (context) => {
    const fixture = await repository(context);
    const interrupted = startChild(fixture.repo, checkpoint);
    context.after(async () => {
      if (interrupted.child.exitCode === null && interrupted.child.signalCode === null) interrupted.child.kill("SIGKILL");
      await interrupted.exited;
    });
    assert.equal((await interrupted.reached).checkpoint, checkpoint);
    assert.equal(interrupted.child.kill("SIGKILL"), true);
    await interrupted.exited;

    const broker = await MergeBroker.open(fixture.repo);
    const pending = Object.values((await broker.state()).submissions);
    assert.equal(pending.length, 1);
    const before = pending[0]!;
    assert.equal(before.status, "validating");
    assert.equal(before.artifact.sha, fixture.candidate);
    assert.equal(await broker.repo.resolveCommit(before.artifact.retainedRef), fixture.candidate);
    assert.equal((await broker.store.inspectGateAuthorityLock()).abandoned, true);
    assert.equal((await broker.store.inspectLock("integration")).abandoned, true);
    if (checkpoint === "validation") {
      assert.ok(before.worktreeIdentity);
      assert.equal(await readFile(path.join(before.worktree!, "candidate.txt"), "utf8"), "candidate preserved\n");
    }
    if (checkpoint === "cleanup") await assert.rejects(access(before.worktree!));

    // Recovery is another process with fresh repository/worktree identity caches. The second
    // restart checks that it does not validate, emit a second terminal event, or alter the result.
    for (const attempt of [0, 1]) {
      const restarted = startChild(fixture.repo);
      context.after(async () => {
        if (restarted.child.exitCode === null && restarted.child.signalCode === null) restarted.child.kill("SIGKILL");
        await restarted.exited;
      });
      const response = await restarted.reached;
      const [code] = await restarted.exited;
      assert.equal(code, 0, restarted.output());
      assert.deepEqual(response.result?.submissionWarnings ?? [], []);
      assert.deepEqual(response.result?.submissionsRecovered ?? [], attempt === 0 ? [before.id] : []);
    }
    const recovered = (await broker.state()).submissions[before.id]!;
    assert.equal(recovered.status, "validated");
    assert.equal(recovered.artifact.sha, fixture.candidate);
    assert.equal(recovered.base.sha, fixture.base);
    assert.equal(recovered.worktree, undefined);
    assert.equal(recovered.worktreeIdentity, undefined);
    assert.deepEqual(recovered.validations.map((result) => result.exitCode), [0, 0]);
    assert.equal(await git(fixture.repo, "rev-parse", "main"), fixture.base);
    assert.equal(await broker.repo.resolveCommit(recovered.artifact.retainedRef), fixture.candidate);
    assert.equal((await broker.store.inspectGateAuthorityLock()).held, false);
    assert.equal((await broker.store.inspectLock("integration")).held, false);
    assert.equal((await broker.store.readAudit(100)).filter((event) =>
      event.submissionId === before.id && event.event === "submission.validated").length, 1);
  });
}
