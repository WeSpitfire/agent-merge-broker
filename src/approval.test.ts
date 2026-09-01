import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";

const PULL_REQUEST = "https://github.example.invalid/owner/repo/pull/42";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function repository(context: TestContext): Promise<{
  repo: string;
  remote: string;
  headFile: string;
  baseFile: string;
  checkFile: string;
  logFile: string;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-approval-"));
  const remoteParent = await mkdtemp(path.join(tmpdir(), "merge-broker-approval-remote-"));
  const remote = path.join(remoteParent, "origin.git");
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-approval-bin-"));
  const headFile = path.join(bin, "head");
  const baseFile = path.join(bin, "base");
  const checkFile = path.join(bin, "check");
  const logFile = path.join(bin, "gh.log");
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await runCommand("git", ["init", "--bare", remote], { cwd: repo });
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  const baseSha = await git(repo, "rev-parse", "main");
  await writeFile(baseFile, `${baseSha}\n`, "utf8");
  await writeFile(headFile, `${baseSha}\n`, "utf8");
  await writeFile(checkFile, "SUCCESS\n", "utf8");
  await writeFile(logFile, "", "utf8");
  const script = path.join(bin, "gh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$MERGE_BROKER_GH_LOG\"",
      "case \"$*\" in",
      "  *\"pr list\"*) echo '[]' ;;",
      `  *"pr create"*) cat >/dev/null; echo "${PULL_REQUEST}" ;;`,
      "  *\"pr edit\"*) cat >/dev/null; echo updated ;;",
      "  *\"pr view\"*)",
      "    head=$(tr -d '\\n' < \"$MERGE_BROKER_GH_HEAD\")",
      "    base=$(tr -d '\\n' < \"$MERGE_BROKER_GH_BASE\")",
      "    check=$(tr -d '\\n' < \"$MERGE_BROKER_GH_CHECK\")",
      "    printf '{\"state\":\"OPEN\",\"headRefOid\":\"%s\",\"baseRefOid\":\"%s\",\"baseRefName\":\"main\",\"mergeStateStatus\":\"CLEAN\",\"mergeable\":\"MERGEABLE\",\"reviewDecision\":\"\",\"statusCheckRollup\":[{\"name\":\"CI\",\"status\":\"COMPLETED\",\"conclusion\":\"%s\",\"detailsUrl\":\"https://ci.example.invalid/run/1\"}]}\\n' \"$head\" \"$base\" \"$check\" ;;",
      "  *\"--disable-auto\"*) echo disabled ;;",
      "  *\"--auto\"*) echo queued ;;",
      "  *\"pr merge\"*) echo merged ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.MERGE_BROKER_GH_LOG = logFile;
  process.env.MERGE_BROKER_GH_HEAD = headFile;
  process.env.MERGE_BROKER_GH_BASE = baseFile;
  process.env.MERGE_BROKER_GH_CHECK = checkFile;
  context.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.MERGE_BROKER_GH_LOG;
    delete process.env.MERGE_BROKER_GH_HEAD;
    delete process.env.MERGE_BROKER_GH_BASE;
    delete process.env.MERGE_BROKER_GH_CHECK;
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(remoteParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await MergeBroker.initialize(repo);
  const config = await loadConfig(repo);
  config.baseRef = "origin/main";
  config.publish.mode = "pull-request";
  config.publish.autoMerge = true;
  config.approval = {
    required: true,
    policyRevision: "release-v1",
    requiredVerifications: ["browser", "responsive"],
    requiredChecks: ["CI"],
    authorizedActors: ["release-manager"],
  };
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { repo, remote, headFile, baseFile, checkFile, logFile };
}

async function taskCommit(repo: string): Promise<string> {
  await git(repo, "switch", "-c", "agent/task", "main");
  await writeFile(path.join(repo, "feature.ts"), "export const value = 1;\n", "utf8");
  await git(repo, "add", "feature.ts");
  await git(repo, "commit", "-m", "add feature");
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return commit;
}

async function fixCommit(repo: string): Promise<string> {
  await git(repo, "switch", "agent/task");
  await appendFile(path.join(repo, "feature.ts"), "export const responsive = true;\n", "utf8");
  await git(repo, "add", "feature.ts");
  await git(repo, "commit", "-m", "fix responsive behavior");
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  return commit;
}

test(
  "gates auto-merge on exact evidence and approval, then revises on the same pull request",
  { skip: process.platform === "win32" ? "POSIX fake GitHub fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const broker = await MergeBroker.open(fixture.repo);
    const claim = await broker.claimTask({
      id: "SAFE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const firstCommit = await taskCommit(fixture.repo);
    await broker.submitTask("SAFE", [firstCommit], claim.token);
    const integrated = await broker.integrate();
    const firstCandidate = integrated.batch.candidate;
    assert.ok(firstCandidate);
    assert.equal(firstCandidate.state, "verifying");
    await writeFile(fixture.headFile, `${firstCandidate.sha}\n`, "utf8");

    let published = await broker.publishBatch(integrated.batch.id);
    assert.equal(published.pullRequestUrl, PULL_REQUEST);
    assert.equal(published.autoMergeEnabled, undefined);
    assert.doesNotMatch(await readFile(fixture.logFile, "utf8"), /--auto/u);
    await assert.rejects(
      broker.markBatchMerged(published.id),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_NOT_APPROVED",
    );

    published = await broker.syncBatch(published.id);
    assert.equal(
      published.candidate?.verifications.find((item) => item.name === "github-check:CI")?.status,
      "passed",
    );
    assert.equal(published.candidate?.state, "verifying");

    await assert.rejects(
      broker.recordVerification(published.id, {
        name: "browser",
        status: "passed",
        candidateSha: "f".repeat(40),
        baseSha: firstCandidate.baseSha,
        actor: "browser-agent",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_MISMATCH",
    );
    published = await broker.recordVerification(published.id, {
      name: "browser",
      status: "passed",
      candidateSha: firstCandidate.sha,
      baseSha: firstCandidate.baseSha,
      policyRevision: firstCandidate.policyRevision,
      actor: "browser-agent",
      evidenceUrl: "https://evidence.example.invalid/browser/1",
    });
    published = await broker.recordVerification(published.id, {
      name: "responsive",
      status: "failed",
      candidateSha: firstCandidate.sha,
      baseSha: firstCandidate.baseSha,
      actor: "responsive-agent",
    });
    assert.equal(published.candidate?.state, "verification_failed");
    await assert.rejects(
      broker.approveBatch(published.id, {
        candidateSha: firstCandidate.sha,
        baseSha: firstCandidate.baseSha,
        actor: "release-manager",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_NOT_READY",
    );

    await broker.requestChanges(published.id, {
      candidateSha: firstCandidate.sha,
      baseSha: firstCandidate.baseSha,
      actor: "reviewer",
      reason: "Responsive verification failed.",
    });
    const revisionLease = await broker.reopenTaskForRevision("SAFE", {
      holder: "worker",
      reason: "Fix the responsive failure.",
    });
    const correction = await fixCommit(fixture.repo);
    const revised = await broker.reviseTask("SAFE", [firstCommit, correction], revisionLease.token);
    assert.equal(revised.batch.pullRequestUrl, PULL_REQUEST);
    assert.notEqual(revised.batch.candidate?.sha, firstCandidate.sha);
    assert.equal(revised.batch.candidate?.revision, 2);
    assert.equal(revised.batch.candidate?.verifications.length, 0);
    assert.equal(revised.previousCandidate.state, "superseded");
    assert.equal(revised.batch.candidateHistory?.at(-1)?.sha, firstCandidate.sha);
    assert.match(await readFile(fixture.logFile, "utf8"), /pr edit/u);
    assert.equal(
      await git(
        fixture.repo,
        "--git-dir",
        fixture.remote,
        "rev-parse",
        `refs/heads/${revised.batch.branchName ?? ""}`,
      ),
      revised.batch.candidate?.sha,
    );

    const nextCandidate = revised.batch.candidate;
    assert.ok(nextCandidate);
    await writeFile(fixture.headFile, `${nextCandidate.sha}\n`, "utf8");
    published = await broker.syncBatch(revised.batch.id);
    published = await broker.recordVerification(published.id, {
      name: "browser",
      status: "passed",
      candidateSha: nextCandidate.sha,
      baseSha: nextCandidate.baseSha,
      actor: "browser-agent",
    });
    published = await broker.recordVerification(published.id, {
      name: "responsive",
      status: "passed",
      candidateSha: nextCandidate.sha,
      baseSha: nextCandidate.baseSha,
      actor: "responsive-agent",
    });
    assert.equal(published.candidate?.state, "ready_for_approval");

    await assert.rejects(
      broker.approveBatch(published.id, {
        candidateSha: nextCandidate.sha,
        baseSha: nextCandidate.baseSha,
        actor: "worker",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "APPROVAL_FORBIDDEN",
    );
    const approved = await broker.approveBatch(published.id, {
      candidateSha: nextCandidate.sha,
      baseSha: nextCandidate.baseSha,
      policyRevision: nextCandidate.policyRevision,
      actor: "release-manager",
    });
    assert.equal(approved.candidate?.state, "merging");
    assert.equal(approved.candidate?.approval?.candidateSha, nextCandidate.sha);
    assert.equal(approved.autoMergeEnabled, true);
    assert.match(
      await readFile(fixture.logFile, "utf8"),
      new RegExp(`--auto --match-head-commit ${nextCandidate.sha}`, "u"),
    );
    await writeFile(fixture.checkFile, "FAILURE\n", "utf8");
    const revoked = await broker.syncBatch(approved.id);
    assert.equal(revoked.candidate?.state, "verification_failed");
    assert.equal(revoked.candidate?.approval, undefined);
    assert.equal(revoked.autoMergeEnabled, false);
    assert.match(await readFile(fixture.logFile, "utf8"), /--disable-auto/u);
  },
);

test(
  "blocks evidence and approval when the pull request head changes outside the broker",
  { skip: process.platform === "win32" ? "POSIX fake GitHub fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const broker = await MergeBroker.open(fixture.repo);
    const claim = await broker.claimTask({ id: "MUTATED", holder: "worker", expectedPaths: ["feature.ts"] });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("MUTATED", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    await broker.publishBatch(integrated.batch.id);
    await writeFile(fixture.headFile, `${"e".repeat(40)}\n`, "utf8");
    const blocked = await broker.syncBatch(integrated.batch.id);
    assert.equal(blocked.candidate?.state, "blocked");
    assert.match(blocked.candidate?.reason ?? "", /head changed/u);
    await assert.rejects(
      broker.recordVerification(blocked.id, {
        name: "browser",
        status: "passed",
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        actor: "browser-agent",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_MISMATCH",
    );
  },
);

test(
  "recovers a candidate revision when the branch moved before state finalization",
  { skip: process.platform === "win32" ? "POSIX fake GitHub fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const broker = await MergeBroker.open(fixture.repo);
    const claim = await broker.claimTask({ id: "RECOVER-REVISION", holder: "worker", expectedPaths: ["feature.ts"] });
    const firstCommit = await taskCommit(fixture.repo);
    await broker.submitTask("RECOVER-REVISION", [firstCommit], claim.token);
    const integrated = await broker.integrate();
    const firstCandidate = integrated.batch.candidate;
    assert.ok(firstCandidate);
    await writeFile(fixture.headFile, `${firstCandidate.sha}\n`, "utf8");
    await broker.publishBatch(integrated.batch.id);
    await broker.requestChanges(integrated.batch.id, {
      candidateSha: firstCandidate.sha,
      baseSha: firstCandidate.baseSha,
      actor: "reviewer",
      reason: "Needs one correction.",
    });
    const revisionLease = await broker.reopenTaskForRevision("RECOVER-REVISION", {
      holder: "worker",
      reason: "Apply the correction.",
    });
    const correction = await fixCommit(fixture.repo);
    const replaceRemoteBranch = broker.repo.replaceRemoteBranch.bind(broker.repo);
    broker.repo.replaceRemoteBranch = async (remote, branch, nextHead, expectedHead) => {
      await replaceRemoteBranch(remote, branch, nextHead, expectedHead);
      await writeFile(fixture.headFile, `${nextHead}\n`, "utf8");
      throw new Error("simulated stop after branch update");
    };

    await assert.rejects(
      broker.reviseTask("RECOVER-REVISION", [firstCommit, correction], revisionLease.token),
      /simulated stop/u,
    );
    broker.repo.replaceRemoteBranch = replaceRemoteBranch;
    const interrupted = (await broker.state()).batches[integrated.batch.id];
    assert.ok(interrupted?.revisionIntent);
    assert.equal(interrupted?.candidate?.sha, firstCandidate.sha);

    const recovery = await broker.recoverAbandonedIntegrations();
    assert.deepEqual(recovery.candidateRevisionsRecovered, [integrated.batch.id]);
    assert.deepEqual(recovery.candidateRevisionWarnings, []);
    const recovered = (await broker.state()).batches[integrated.batch.id];
    assert.equal(recovered?.revisionIntent, undefined);
    assert.equal(recovered?.candidate?.revision, 2);
    assert.notEqual(recovered?.candidate?.sha, firstCandidate.sha);
    assert.deepEqual((await broker.task("RECOVER-REVISION")).commits, [firstCommit, correction]);
  },
);
