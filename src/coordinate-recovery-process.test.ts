import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { runCommand } from "./process.js";
import { fakeProcess } from "./test-support/fake-process.js";
import type { BatchRecord } from "./types.js";

const PR_URL = "https://github.example.invalid/owner/repo/pull/1";
type Boundary = "push" | "pull-request" | "approval" | "enable" | "disable" | "revision" | "refresh";
type Operation = "publish" | "approve" | "sync" | "request-changes" | "revise" | "recover" | "refresh";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout.trim();
}

async function fixture(context: TestContext, approval = false) {
  const repo = await mkdtemp(path.join(tmpdir(), "amb-coordinate-restart-"));
  context.after(async () => { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Coordinate Recovery Test");
  await git(repo, "config", "user.email", "restart@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Recovery fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  const remote = path.join(repo, ".git", "origin.git");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.publish.mode = "pull-request";
  config.publish.repository = "github.example.invalid/owner/repo";
  config.publish.autoMerge = approval;
  if (approval) config.approval = {
    required: true, policyRevision: "restart-v1", authorizedActors: ["operator"],
    requiredChecks: [], requiredVerifications: [],
  };
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`);
  await git(repo, "add", ".merge-broker", "AGENTS.md");
  await git(repo, "commit", "-m", "policy");
  await git(repo, "push", "origin", "main");
  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({ id: "RESTART", holder: "worker", expectedPaths: ["feature.txt"] });
  await git(repo, "switch", "-c", "worker/change");
  await writeFile(path.join(repo, "feature.txt"), "immutable work\n");
  await git(repo, "add", "feature.txt");
  await git(repo, "commit", "-m", "feature");
  const sha = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  await broker.submitTask("RESTART", [sha], claim.token);
  const { batch } = await broker.integrate();
  const created = path.join(repo, ".git", "created-pr.log");
  const control = path.join(repo, ".git", "forge-state.json");
  await writeFile(created, "");
  await writeFile(control, JSON.stringify({ state: "OPEN", enabled: false, enables: 0, comments: [] }));
  const forge = await fakeProcess(context, "gh", `
    import { writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const state = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
    const save = () => writeFileSync(${JSON.stringify(control)}, JSON.stringify(state));
    const ref = (name) => execFileSync("git", ["--git-dir", ${JSON.stringify(remote)}, "rev-parse", name],
      { encoding: "utf8", windowsHide: true }).trim();
    if (command.startsWith("pr list") && args.includes("--state") && args.includes("all") &&
        args.includes("github.example.invalid/owner/repo")) {
      console.log(JSON.stringify(readFileSync(${JSON.stringify(created)}, "utf8") ? [{ url: ${JSON.stringify(PR_URL)} }] : []));
    } else if (command.startsWith("pr create")) {
      appendFileSync(${JSON.stringify(created)}, "created\\n");
      console.log(${JSON.stringify(PR_URL)});
    } else if (command.startsWith("pr view")) {
      console.log(JSON.stringify({ state: state.state, autoMergeRequest: state.enabled ? { enabledAt: "2026-01-01T00:00:00Z" } : null,
        headRefOid: ref(${JSON.stringify(batch.branchName)}), baseRefOid: ref("main"), comments: state.comments,
        baseRefName: "main", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
        reviewDecision: "", statusCheckRollup: [] }));
    } else if (command.startsWith("pr merge")) {
      const expected = args.indexOf("--match-head-commit");
      if (expected !== -1 && args[expected + 1] !== ref(${JSON.stringify(batch.branchName)})) {
        console.error("head changed"); process.exitCode = 1;
      } else {
        if (args.includes("--auto")) { state.enabled = true; state.enables += 1; }
        else if (args.includes("--disable-auto")) state.enabled = false;
        else throw new Error("Unexpected direct merge");
        save(); console.log("updated");
      }
    } else if (command.startsWith("pr close")) {
      state.state = "CLOSED"; state.enabled = false;
      const comment = args.indexOf("--comment");
      if (comment !== -1) state.comments.push({ body: args[comment + 1] });
      save(); console.log("closed");
    } else if (command.startsWith("pr edit")) {
      console.log("updated");
    } else { console.error("Unexpected forge command: " + command); process.exitCode = 1; }
  `);
  return { repo, remote, broker, batch, created, control, firstCommit: sha, preload: forge.preload };
}

function startChild(context: TestContext, repo: string, batchId: string, preload: string, boundary?: Boundary,
  operation: Operation = "publish", revision?: { commits: string[]; token: string }) {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const moduleUrl = (name: string) => JSON.stringify(new URL(`./${name}${extension}`, import.meta.url).href);
  const script = `
    import { MergeBroker } from ${moduleUrl("broker")};
    import { GitRepository } from ${moduleUrl("git")};
    import { githubCliPublisher } from ${moduleUrl("publisher")};
    import { StateStore } from ${moduleUrl("store")};
    const boundary = ${JSON.stringify(boundary ?? null)};
    const pause = async () => {
      process.send({ boundary });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
    if (boundary === "push" || boundary === "revision") {
      const method = boundary === "push" ? "push" : "replaceRemoteBranch";
      const original = GitRepository.prototype[method];
      GitRepository.prototype[method] = async function (...args) {
        const result = await original.apply(this, args);
        await pause();
        return result;
      };
    }
    if (boundary === "approval") {
      const transaction = StateStore.prototype.transaction;
      StateStore.prototype.transaction = async function (mutator) {
        let approved = false;
        const result = await transaction.call(this, (state, audit) => mutator(state, (event, fields) => {
          if (event === "batch.approved") approved = true;
          audit(event, fields);
        }));
        if (approved) await pause();
        return result;
      };
    }
    const publisher = { ...githubCliPublisher };
    const method = { "pull-request": "publishBatch", enable: "enableAutoMerge", disable: "disableAutoMerge", refresh: "closePullRequest" }[boundary];
    if (method) {
      publisher[method] = async (...args) => {
        const result = await githubCliPublisher[method](...args);
        await pause();
        return result;
      };
    }
    const broker = await MergeBroker.open(process.argv[1], { publisher });
    const id = process.argv[2];
    const operation = ${JSON.stringify(operation)};
    const candidate = (await broker.state()).batches[id]?.candidate;
    const tuple = candidate && { candidateSha: candidate.sha, baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision, actor: "operator" };
    if (operation === "publish") await broker.publishBatch(id);
    else if (operation === "approve") await broker.approveBatch(id, tuple);
    else if (operation === "sync") await broker.syncBatch(id);
    else if (operation === "request-changes") await broker.requestChanges(id, { ...tuple, reason: "Review correction" });
    else if (operation === "recover") await broker.recoverAbandonedIntegrations();
    else if (operation === "refresh") await broker.refreshBatch(id);
    else if (operation === "revise") {
      const revision = ${JSON.stringify(revision ?? null)};
      await broker.reviseTask("RESTART", revision.commits, revision.token);
    }
    const batch = (await broker.state()).batches[id];
    process.send({ batch });
    process.disconnect();
  `;
  const runtime = extension === ".ts" ? ["--import", "tsx"] : [];
  const child: ChildProcess = spawn(process.execPath, [
    ...runtime, "--import", pathToFileURL(preload).href, "--input-type=module", "-e", script, repo, batchId,
  ], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const reached = new Promise<{ boundary?: Boundary; batch?: BatchRecord }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Publication child timed out at ${boundary ?? "completion"}: ${output}`));
    }, 45_000);
    child.once("message", (message: { boundary?: Boundary; batch?: BatchRecord }) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Publication child exited before response (${code ?? signal}): ${output}`));
    });
  });
  return { child, reached, exited, output: () => output };
}

async function completed(child: ReturnType<typeof startChild>): Promise<BatchRecord> {
  const response = await child.reached;
  const [code] = await child.exited;
  assert.equal(code, 0, child.output());
  assert.ok(response.batch);
  return response.batch;
}

for (const boundary of ["push", "pull-request"] as const) {
  test(`fresh processes recover Coordinate publication killed after ${boundary} without duplicate PRs`, {
    timeout: 120_000,
  }, async (context) => {
    const { repo, remote, broker, batch, created, preload } = await fixture(context);
    const interrupted = startChild(context, repo, batch.id, preload, boundary);
    assert.equal((await interrupted.reached).boundary, boundary);
    assert.equal(interrupted.child.kill("SIGKILL"), true);
    await interrupted.exited;
    assert.equal((await broker.state()).batches[batch.id]?.status, "prepared");
    assert.equal(await git(repo, "--git-dir", remote, "rev-parse", batch.branchName!), batch.headSha);
    assert.equal(await readFile(created, "utf8"), boundary === "push" ? "" : "created\n");

    for (const _attempt of [0, 1]) {
      const restarted = startChild(context, repo, batch.id, preload);
      const response = await restarted.reached;
      const [code] = await restarted.exited;
      assert.equal(code, 0, restarted.output());
      assert.equal(response.batch?.status, "published");
      assert.equal(response.batch?.headSha, batch.headSha);
      assert.equal(response.batch?.pullRequestUrl, PR_URL);
    }
    assert.equal(await readFile(created, "utf8"), "created\n");
    assert.equal(await git(repo, "--git-dir", remote, "rev-parse", batch.branchName!), batch.headSha);
    assert.equal((await broker.task("RESTART")).status, "published");
    assert.equal((await broker.store.readAudit(100)).filter((event) =>
      event.event === "batch.published" && event.batchId === batch.id).length, 1);
  });
}

for (const boundary of ["approval", "enable", "disable", "revision", "refresh"] as const) {
  test(`fresh processes reconcile Coordinate ${boundary} after process death`, { timeout: 120_000 }, async (context) => {
    const setup = await fixture(context, true);
    const { repo, remote, broker, batch, control, preload } = setup;
    const candidate = batch.candidate!;
    const tuple = { candidateSha: candidate.sha, baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision, actor: "operator" };
    await broker.publishBatch(batch.id);
    let operation: Operation = "approve";
    let revision: { commits: string[]; token: string } | undefined;
    if (boundary === "disable") {
      await broker.approveBatch(batch.id, tuple);
      operation = "request-changes";
    } else if (boundary === "revision") {
      await broker.requestChanges(batch.id, { ...tuple, reason: "Correct the candidate" });
      const lease = await broker.reopenTaskForRevision("RESTART", { holder: "worker", reason: "Correction" });
      await git(repo, "switch", "worker/change");
      await writeFile(path.join(repo, "feature.txt"), "corrected immutable work\n");
      await git(repo, "add", "feature.txt");
      await git(repo, "commit", "-m", "correction");
      const correction = await git(repo, "rev-parse", "HEAD");
      await git(repo, "switch", "main");
      revision = { commits: [setup.firstCommit, correction], token: lease.token };
      operation = "revise";
    } else if (boundary === "refresh") {
      await writeFile(path.join(repo, "base-advance.txt"), "new protected base\n");
      await git(repo, "add", "base-advance.txt");
      await git(repo, "commit", "-m", "advance base");
      await git(repo, "push", "origin", "main");
      operation = "refresh";
    }
    const interrupted = startChild(context, repo, batch.id, preload, boundary, operation, revision);
    assert.equal((await interrupted.reached).boundary, boundary);
    assert.equal(interrupted.child.kill("SIGKILL"), true);
    await interrupted.exited;
    const pending = (await broker.state()).batches[batch.id]!;
    if (boundary === "approval") {
      assert.ok(pending.candidate?.approval?.approvedAt);
      assert.equal(pending.candidate.approval.confirmedAt, undefined);
    } else if (boundary === "enable") assert.equal(pending.autoMergePending, true);
    else if (boundary === "disable") assert.ok(pending.changeRequestIntent);
    else if (boundary === "revision") assert.ok(pending.revisionIntent);
    else assert.ok(pending.refreshCloseIntent);

    const resume: Operation = boundary === "revision" ? "recover" : boundary === "refresh" ? "refresh" : "sync";
    const recovered = await completed(startChild(context, repo, batch.id, preload, undefined, resume));
    if (boundary === "approval" || boundary === "enable") {
      assert.ok(recovered.candidate?.approval?.confirmedAt);
      await completed(startChild(context, repo, batch.id, preload));
      const observed = JSON.parse(await readFile(control, "utf8")) as { enabled: boolean; enables: number };
      assert.equal(observed.enabled, true);
      assert.equal(observed.enables, 1);
    } else if (boundary === "disable") {
      assert.equal(recovered.changeRequestIntent, undefined);
      assert.equal(recovered.candidate?.state, "changes_requested");
      assert.equal(recovered.candidate?.approval, undefined);
      assert.equal(recovered.autoMergeEnabled, false);
      await completed(startChild(context, repo, batch.id, preload, undefined, "sync"));
      const observed = JSON.parse(await readFile(control, "utf8")) as { enabled: boolean; enables: number };
      assert.equal(observed.enabled, false);
      assert.equal(observed.enables, 1);
    } else if (boundary === "revision") {
      assert.equal(recovered.revisionIntent, undefined);
      assert.equal(recovered.candidate?.revision, 2);
      assert.notEqual(recovered.headSha, candidate.sha);
      assert.equal(await git(repo, "--git-dir", remote, "rev-parse", batch.branchName!), recovered.headSha);
      assert.deepEqual((await broker.task("RESTART")).commits, revision!.commits);
      await completed(startChild(context, repo, batch.id, preload, undefined, "recover"));
    } else {
      assert.equal(recovered.refreshCloseIntent, undefined);
      assert.equal(recovered.status, "closed");
      assert.equal(recovered.candidate?.state, "superseded");
      const batches = Object.values((await broker.state()).batches);
      assert.equal(batches.length, 2);
      assert.equal(batches.find((item) => item.id !== batch.id)?.status, "prepared");
      await completed(startChild(context, repo, batch.id, preload, undefined, "recover"));
    }
  });
}
