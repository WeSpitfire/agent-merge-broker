import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { githubCliPublisher } from "./publisher.js";

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
  config.publish.repository = "github.example.invalid/owner/repo";
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
    assert.equal(published.autoMergeEnabled, false);
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
  "revises a published candidate against its durable target after configuration drift",
  { skip: process.platform === "win32" ? "POSIX fake GitHub fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    let broker = await MergeBroker.open(fixture.repo);
    const claim = await broker.claimTask({
      id: "DURABLE-REVISION-TARGET",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const firstCommit = await taskCommit(fixture.repo);
    await broker.submitTask("DURABLE-REVISION-TARGET", [firstCommit], claim.token);
    const integrated = await broker.integrate();
    const firstCandidate = integrated.batch.candidate;
    assert.ok(firstCandidate);
    assert.equal(integrated.batch.remote, "origin");
    assert.equal(integrated.batch.baseBranch, "main");
    await writeFile(fixture.headFile, `${firstCandidate.sha}\n`, "utf8");
    await broker.publishBatch(integrated.batch.id);
    await broker.requestChanges(integrated.batch.id, {
      candidateSha: firstCandidate.sha,
      baseSha: firstCandidate.baseSha,
      actor: "reviewer",
      reason: "Rework this candidate.",
    });
    const revisionLease = await broker.reopenTaskForRevision("DURABLE-REVISION-TARGET", {
      holder: "worker",
      reason: "Apply the requested correction.",
    });
    const correction = await fixCommit(fixture.repo);

    // Move the batch's original target after publication. The replacement candidate must be cut
    // from this fetched tip even though the operator subsequently points future batches elsewhere.
    await writeFile(path.join(fixture.repo, "BASE-ADVANCED.md"), "new original target tip\n", "utf8");
    await git(fixture.repo, "add", "BASE-ADVANCED.md");
    await git(fixture.repo, "commit", "-m", "advance original revision target");
    const advancedOriginalBase = await git(fixture.repo, "rev-parse", "HEAD");
    await git(fixture.repo, "push", "origin", "main");
    await writeFile(fixture.baseFile, `${advancedOriginalBase}\n`, "utf8");

    const drifted = await loadConfig(fixture.repo);
    drifted.remote = "replacement";
    drifted.baseBranch = "develop";
    drifted.baseRef = "replacement/develop";
    await writeFile(configPath(fixture.repo), `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
    broker = await MergeBroker.open(fixture.repo);

    const revised = await broker.reviseTask(
      "DURABLE-REVISION-TARGET",
      [firstCommit, correction],
      revisionLease.token,
    );

    assert.equal(revised.batch.remote, "origin");
    assert.equal(revised.batch.baseBranch, "main");
    assert.equal(revised.batch.baseSha, advancedOriginalBase);
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
  },
);

test(
  "rechecks required GitHub checks in the approval snapshot",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let inspections = 0;
    let enableCalls = 0;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
          mode: "pull-request" as const,
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => {
          inspections += 1;
          return {
            state: "OPEN",
            autoMergeEnabled: false,
            headRefOid: expectedHead,
            baseRefOid: expectedBase,
            baseRefName: "main",
            checks: [{
              name: "CI",
              status: "COMPLETED",
              conclusion: inspections < 3 ? "SUCCESS" : "FAILURE",
            }],
          };
        },
        enableAutoMerge: async () => {
          enableCalls += 1;
          return true;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "CHECK-APPROVAL-RACE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("CHECK-APPROVAL-RACE", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    assert.equal((await broker.syncBatch(integrated.batch.id)).candidate?.state, "ready_for_approval");

    await assert.rejects(
      broker.approveBatch(integrated.batch.id, {
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        policyRevision: candidate.policyRevision,
        actor: "release-manager",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_NOT_READY",
    );
    assert.equal(enableCalls, 0);
    assert.equal((await broker.state()).batches[integrated.batch.id]?.candidate?.approval, undefined);
  },
);

test(
  "does not retroactively authorize a pull request that merged before approval confirmation",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let inspections = 0;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }) => ({
          mode: "pull-request",
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => {
          inspections += 1;
          // publish sync, approval's preliminary sync, and approval's locked snapshot are OPEN.
          // The third response simulates a privileged merge immediately after that snapshot.
          const state = inspections >= 4 ? "MERGED" : "OPEN";
          return {
            state,
            autoMergeEnabled: false,
            headRefOid: expectedHead,
            baseRefOid: expectedBase,
            baseRefName: "main",
            ...(state === "MERGED" ? { mergedAt: new Date().toISOString() } : {}),
            checks: [],
          };
        },
        enableAutoMerge: async () => {
          throw new Error("auto-merge must not be reached");
        },
      },
    });
    const claim = await broker.claimTask({
      id: "PRE-APPROVAL-MERGE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("PRE-APPROVAL-MERGE", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);

    await assert.rejects(
      broker.approveBatch(integrated.batch.id, {
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        policyRevision: candidate.policyRevision,
        actor: "release-manager",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_CHANGED",
    );
    const failed = (await broker.state()).batches[integrated.batch.id];
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.candidate?.approval, undefined);
    assert.equal((await broker.task("PRE-APPROVAL-MERGE")).status, "failed");
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

test(
  "serializes approval and revocation so a revoked candidate cannot be re-queued",
  { skip: process.platform === "win32" ? "POSIX fake GitHub fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let announceEnable: (() => void) | undefined;
    const enableStarted = new Promise<void>((resolve) => {
      announceEnable = resolve;
    });
    let finishEnable: (() => void) | undefined;
    const enableRelease = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        enableAutoMerge: async () => {
          announceEnable?.();
          await enableRelease;
          return true;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "APPROVE-REVOKE-RACE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("APPROVE-REVOKE-RACE", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    await writeFile(fixture.headFile, `${candidate.sha}\n`, "utf8");
    await broker.publishBatch(integrated.batch.id);

    const approving = broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    await enableStarted;
    const revoking = broker.requestChanges(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "reviewer",
      reason: "Revoke while the forge call is in flight.",
    });
    finishEnable?.();
    await approving;
    const revoked = await revoking;

    assert.equal(revoked.candidate?.state, "changes_requested");
    assert.equal(revoked.candidate?.approval, undefined);
    assert.equal(revoked.autoMergeEnabled, false);
  },
);

test(
  "finishes durable revocation before a publication retry can re-enable auto-merge",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let enableCalls = 0;
    let disableCalls = 0;
    let remoteAutoMerge = false;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
          mode: "pull-request" as const,
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => ({
          state: "OPEN",
          autoMergeEnabled: remoteAutoMerge,
          headRefOid: expectedHead,
          baseRefOid: expectedBase,
          baseRefName: "main",
          checks: [],
        }),
        enableAutoMerge: async () => {
          enableCalls += 1;
          remoteAutoMerge = true;
          return true;
        },
        disableAutoMerge: async () => {
          disableCalls += 1;
          remoteAutoMerge = false;
          if (disableCalls === 1) throw new Error("simulated stop after remote disable");
          return true;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "REVOCATION-CRASH",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("REVOCATION-CRASH", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });

    await assert.rejects(
      broker.requestChanges(integrated.batch.id, {
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        policyRevision: candidate.policyRevision,
        actor: "reviewer",
        reason: "A regression was found.",
      }),
      /simulated stop/u,
    );
    const interrupted = (await broker.state()).batches[integrated.batch.id];
    assert.ok(interrupted?.changeRequestIntent);
    assert.equal(interrupted?.autoMergeEnabled, true);
    await assert.rejects(
      broker.closeBatch(integrated.batch.id, "manual close must not erase revocation"),
      (error: unknown) => error instanceof BrokerError && error.code === "CHANGE_REQUEST_PENDING",
    );
    await assert.rejects(
      broker.markBatchMerged(integrated.batch.id),
      (error: unknown) => error instanceof BrokerError && error.code === "CHANGE_REQUEST_PENDING",
    );

    // Also model the enable-side crash shape: the queue may be live while only the pending marker
    // survived. A generic publication retry must honor revocation before considering re-enable.
    await broker.store.transaction((state) => {
      const batch = state.batches[integrated.batch.id];
      assert.ok(batch);
      batch.autoMergeEnabled = false;
      batch.autoMergePending = true;
    });
    const resumed = await broker.publishBatch(integrated.batch.id);
    assert.equal(disableCalls, 2);
    assert.equal(enableCalls, 1);
    assert.equal(resumed.changeRequestIntent, undefined);
    assert.equal(resumed.autoMergeEnabled, false);
    assert.equal(resumed.candidate?.state, "changes_requested");
    assert.equal(resumed.candidate?.approval, undefined);
  },
);

test(
  "keeps revocation durable when a changed pull-request head wins the disable race",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let revoking = false;
    let revocationInspections = 0;
    let disableCalls = 0;
    let remoteAutoMerge = false;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
          mode: "pull-request" as const,
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => {
          if (revoking) revocationInspections += 1;
          return {
            state: "OPEN",
            autoMergeEnabled: remoteAutoMerge,
            // The requestChanges preflight sees the approved candidate. Its post-intent inspection
            // sees a force-pushed head whose queued auto-merge must still be revoked.
            headRefOid: revoking && revocationInspections >= 2 ? "f".repeat(40) : expectedHead,
            baseRefOid: expectedBase,
            baseRefName: "main",
            mergeable: "MERGEABLE",
            checks: [],
          };
        },
        enableAutoMerge: async () => {
          remoteAutoMerge = true;
          return true;
        },
        disableAutoMerge: async () => {
          disableCalls += 1;
          remoteAutoMerge = false;
          return false;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "CHANGED-HEAD-REVOCATION",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("CHANGED-HEAD-REVOCATION", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });

    revoking = true;
    await assert.rejects(
      broker.requestChanges(integrated.batch.id, {
        candidateSha: candidate.sha,
        baseSha: candidate.baseSha,
        policyRevision: candidate.policyRevision,
        actor: "reviewer",
        reason: "Do not merge the force-pushed replacement.",
      }),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_FINAL",
    );

    const interrupted = (await broker.state()).batches[integrated.batch.id];
    assert.equal(disableCalls, 1);
    assert.equal(interrupted?.status, "published");
    assert.ok(interrupted?.changeRequestIntent);
    assert.ok(interrupted?.candidate?.approval);
    assert.equal(interrupted?.autoMergeEnabled, true);
  },
);

test(
  "keeps automatic approval revocation durable after losing the remote disable response",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = ["CI"];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let checkConclusion = "SUCCESS";
    let remoteAutoMerge = false;
    let enableCalls = 0;
    let disableCalls = 0;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: "OPEN",
        autoMergeEnabled: remoteAutoMerge,
        headRefOid: expectedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        checks: [{ name: "CI", status: "COMPLETED", conclusion: checkConclusion }],
      }),
      enableAutoMerge: async () => {
        enableCalls += 1;
        remoteAutoMerge = true;
        return true;
      },
      disableAutoMerge: async () => {
        disableCalls += 1;
        remoteAutoMerge = false;
        if (disableCalls === 1) throw new Error("simulated stop after remote disable");
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "AUTOMATIC-REVOCATION-CRASH",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("AUTOMATIC-REVOCATION-CRASH", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    const approved = await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    assert.ok(approved.candidate?.approval?.confirmedAt);
    assert.equal(approved.autoMergeEnabled, true);
    assert.equal(remoteAutoMerge, true);
    await assert.rejects(
      broker.closeBatch(integrated.batch.id, "must not orphan an open auto-merge queue"),
      (error: unknown) => error instanceof BrokerError && error.code === "PULL_REQUEST_STILL_OPEN",
    );
    const stillQueued = (await broker.state()).batches[integrated.batch.id];
    assert.equal(stillQueued?.status, "published");
    assert.ok(stillQueued?.candidate?.approval?.confirmedAt);
    assert.equal(stillQueued?.autoMergeEnabled, true);

    checkConclusion = "FAILURE";
    await assert.rejects(
      broker.syncBatch(integrated.batch.id),
      /simulated stop after remote disable/u,
    );
    const interrupted = (await broker.state()).batches[integrated.batch.id];
    assert.ok(interrupted?.candidate?.approval?.revocationRequestedAt);
    assert.match(interrupted?.candidate?.approval?.revocationReason ?? "", /required GitHub verification/iu);
    assert.equal(interrupted?.autoMergeEnabled, true);
    assert.equal(remoteAutoMerge, false);
    await assert.rejects(
      broker.closeBatch(integrated.batch.id, "manual close must not erase automatic revocation"),
      (error: unknown) => error instanceof BrokerError && error.code === "APPROVAL_REVOCATION_REQUIRED",
    );
    const stillInterrupted = (await broker.state()).batches[integrated.batch.id];
    assert.equal(stillInterrupted?.status, "published");
    assert.equal(
      stillInterrupted?.candidate?.approval?.revocationRequestedAt,
      interrupted?.candidate?.approval?.revocationRequestedAt,
    );

    // The check recovering must not erase the already-durable revocation request or let the old
    // human approval become live again after restart.
    checkConclusion = "SUCCESS";
    const restarted = await MergeBroker.open(fixture.repo, { publisher: forge });
    const revoked = await restarted.syncBatch(integrated.batch.id);

    assert.equal(disableCalls, 2);
    assert.equal(enableCalls, 1);
    assert.equal(revoked.candidate?.approval, undefined);
    assert.equal(revoked.candidate?.state, "ready_for_approval");
    assert.match(revoked.candidate?.reason ?? "", /required GitHub verification/iu);
    assert.equal(revoked.autoMergeEnabled, false);
    assert.equal(revoked.autoMergePending, undefined);
  },
);

test(
  "keeps a confirmed queued approval immutable when the identical approval is retried",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let enableCalls = 0;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
          mode: "pull-request" as const,
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => ({
          state: "OPEN",
          autoMergeEnabled: enableCalls > 0,
          headRefOid: expectedHead,
          baseRefOid: expectedBase,
          baseRefName: "main",
          checks: [],
        }),
        enableAutoMerge: async () => {
          enableCalls += 1;
          return true;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "IDEMPOTENT-APPROVAL",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("IDEMPOTENT-APPROVAL", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);

    const input = {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    };
    const approved = await broker.approveBatch(integrated.batch.id, input);
    const firstApproval = approved.candidate?.approval;
    assert.ok(firstApproval?.confirmedAt);
    assert.equal(approved.candidate?.state, "merging");
    assert.equal(approved.autoMergeEnabled, true);

    // Make a timestamp rewrite observable even on platforms with millisecond clock resolution.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const retried = await broker.approveBatch(integrated.batch.id, input);

    assert.equal(retried.candidate?.approval?.approvedAt, firstApproval.approvedAt);
    assert.equal(retried.candidate?.approval?.confirmedAt, firstApproval.confirmedAt);
    assert.equal(retried.candidate?.state, "merging");
    assert.equal(retried.autoMergeEnabled, true);
    assert.equal(enableCalls, 1);
  },
);

test(
  "records an approved merged candidate without trying to disable auto-merge after the base advances",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let pullRequestState = "OPEN";
    let expectedHead = "";
    let expectedBase = "";
    let mergeCommitSha = "";
    let disableCalled = false;
    let remoteAutoMerge = false;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }) => ({
          mode: "pull-request",
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => ({
          state: pullRequestState,
          autoMergeEnabled: pullRequestState === "OPEN" && remoteAutoMerge,
          headRefOid: expectedHead,
          // GitHub may report the base ref's new tip after the PR has merged.
          baseRefOid: pullRequestState === "MERGED" ? "a".repeat(40) : expectedBase,
          baseRefName: "main",
          ...(pullRequestState === "MERGED" ? { mergeCommitSha } : {}),
          checks: [],
        }),
        enableAutoMerge: async () => {
          remoteAutoMerge = true;
          return true;
        },
        disableAutoMerge: async () => {
          disableCalled = true;
          return false;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "MERGED-BASE-MOVED",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("MERGED-BASE-MOVED", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;

    await broker.publishBatch(integrated.batch.id);
    const approved = await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    assert.equal(approved.autoMergeEnabled, true);
    mergeCommitSha = candidate.sha;
    await git(fixture.repo, "push", "origin", `${candidate.sha}:main`);
    pullRequestState = "MERGED";

    const merged = await broker.syncBatch(integrated.batch.id);
    assert.equal(merged.status, "merged");
    assert.equal(disableCalled, false);
    assert.equal((await broker.task("MERGED-BASE-MOVED")).status, "merged");
  },
);

test(
  "rejects a same-length forged merge history that only copies the candidate's final tree",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let pullRequestState = "OPEN";
    let expectedHead = "";
    let expectedBase = "";
    let reportedBase = "";
    let mergeCommitSha = "";
    let remoteAutoMerge = false;
    const broker = await MergeBroker.open(fixture.repo, {
      publisher: {
        ...githubCliPublisher,
        publishBatch: async ({ batch }) => ({
          mode: "pull-request",
          branchName: batch.branchName ?? "missing",
          pullRequestUrl: PULL_REQUEST,
        }),
        inspectPullRequest: async () => ({
          state: pullRequestState,
          autoMergeEnabled: pullRequestState === "OPEN" && remoteAutoMerge,
          headRefOid: expectedHead,
          baseRefOid: pullRequestState === "MERGED" ? reportedBase : expectedBase,
          baseRefName: "main",
          ...(pullRequestState === "MERGED" ? { mergeCommitSha } : {}),
          checks: [],
        }),
        enableAutoMerge: async () => {
          remoteAutoMerge = true;
          return true;
        },
      },
    });
    const claim = await broker.claimTask({
      id: "FORGED-MERGE-HISTORY",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("FORGED-MERGE-HISTORY", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });

    // Match the candidate's two-commit length and final tree, but take a different first step.
    // The old count-only proof accepted this history even though it did not land on the approved
    // base/candidate sequence.
    await writeFile(path.join(fixture.repo, "unrelated.txt"), "not validated\n", "utf8");
    await git(fixture.repo, "add", "unrelated.txt");
    await git(fixture.repo, "commit", "-m", "unrelated target change");
    await git(fixture.repo, "read-tree", "--reset", "-u", `${candidate.sha}^{tree}`);
    await git(fixture.repo, "commit", "-m", "copy candidate tree without its history");
    mergeCommitSha = await git(fixture.repo, "rev-parse", "HEAD");
    reportedBase = mergeCommitSha;
    await git(fixture.repo, "push", "origin", "main");
    pullRequestState = "MERGED";

    const rejected = await broker.syncBatch(integrated.batch.id);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error ?? "", /candidate, target, and approval invariant/u);
    assert.equal((await broker.task("FORGED-MERGE-HISTORY")).status, "failed");
  },
);

test(
  "revokes queued auto-merge when the protected approval policy changes",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let disableCalled = false;
    let remoteAutoMerge = false;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: "OPEN",
        autoMergeEnabled: remoteAutoMerge,
        headRefOid: expectedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        checks: [],
      }),
      enableAutoMerge: async () => {
        remoteAutoMerge = true;
        return true;
      },
      disableAutoMerge: async () => {
        disableCalled = true;
        remoteAutoMerge = false;
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "POLICY-DRIFT",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("POLICY-DRIFT", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    const approved = await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    assert.equal(approved.autoMergeEnabled, true);

    // This is the durable shape left if GitHub accepted auto-merge and the process stopped before
    // saving that success. Policy revocation must disable the possibly-live remote queue based on
    // the intent marker, not only on `autoMergeEnabled`.
    await broker.store.transaction((state) => {
      const batch = state.batches[integrated.batch.id];
      assert.ok(batch);
      batch.autoMergeEnabled = false;
      batch.autoMergePending = true;
    });

    const nextConfig = await loadConfig(fixture.repo);
    if (!nextConfig.approval) throw new Error("Expected approval policy.");
    nextConfig.approval.policyRevision = "release-v2";
    await writeFile(configPath(fixture.repo), `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    const restarted = await MergeBroker.open(fixture.repo, { publisher: forge });
    const revoked = await restarted.syncBatch(integrated.batch.id);

    assert.equal(disableCalled, true);
    assert.equal(revoked.candidate?.state, "blocked");
    assert.match(revoked.candidate?.reason ?? "", /policy changed/u);
    assert.equal(revoked.candidate?.approval, undefined);
    assert.equal(revoked.autoMergeEnabled, false);
    assert.equal(revoked.autoMergePending, undefined);
  },
);

test(
  "revokes a queued approval when its actor is removed without a policy revision bump",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    config.approval.authorizedActors = ["alice"];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let pullRequestState = "OPEN";
    let expectedHead = "";
    let expectedBase = "";
    let remoteAutoMerge = false;
    let disableCalls = 0;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: pullRequestState,
        autoMergeEnabled: pullRequestState === "OPEN" && remoteAutoMerge,
        headRefOid: expectedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        checks: [],
      }),
      enableAutoMerge: async () => {
        remoteAutoMerge = true;
        return true;
      },
      disableAutoMerge: async () => {
        disableCalls += 1;
        remoteAutoMerge = false;
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "APPROVER-REMOVED",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("APPROVER-REMOVED", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "alice",
    });
    assert.equal(remoteAutoMerge, true);

    const restricted = await loadConfig(fixture.repo);
    if (!restricted.approval) throw new Error("Expected approval policy.");
    restricted.approval.authorizedActors = ["bob"];
    assert.equal(restricted.approval.policyRevision, candidate.policyRevision);
    await writeFile(configPath(fixture.repo), `${JSON.stringify(restricted, null, 2)}\n`, "utf8");
    const restarted = await MergeBroker.open(fixture.repo, { publisher: forge });
    await assert.rejects(
      restarted.markBatchMerged(integrated.batch.id),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_POLICY_STALE",
    );
    assert.equal((await restarted.state()).batches[integrated.batch.id]?.status, "published");
    const revoked = await restarted.syncBatch(integrated.batch.id);

    assert.equal(disableCalls, 1);
    assert.equal(remoteAutoMerge, false);
    assert.equal(revoked.candidate?.approval, undefined);
    assert.equal(revoked.candidate?.state, "ready_for_approval");
    assert.match(revoked.candidate?.reason ?? "", /no longer authorized/iu);

    // Even a later out-of-band merge cannot resurrect the removed actor's approval.
    pullRequestState = "MERGED";
    const rejected = await restarted.syncBatch(integrated.batch.id);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.candidate?.approval, undefined);
    assert.equal((await restarted.task("APPROVER-REMOVED")).status, "failed");
  },
);

test(
  "disables a forge-observed legacy auto-merge queue after local markers are lost",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let remoteAutoMerge = false;
    let disableCalls = 0;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: "OPEN",
        autoMergeEnabled: remoteAutoMerge,
        headRefOid: expectedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        checks: [],
      }),
      enableAutoMerge: async () => {
        remoteAutoMerge = true;
        return true;
      },
      disableAutoMerge: async () => {
        disableCalls += 1;
        remoteAutoMerge = false;
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "LEGACY-REMOTE-QUEUE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("LEGACY-REMOTE-QUEUE", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    assert.equal(remoteAutoMerge, true);

    // Model a pre-intent release stopping after GitHub accepted enableAutoMerge but before either
    // local queue marker was saved.
    await broker.store.transaction((state) => {
      const batch = state.batches[integrated.batch.id];
      assert.ok(batch);
      delete batch.autoMergeEnabled;
      delete batch.autoMergePending;
    });
    const disabledConfig = await loadConfig(fixture.repo);
    disabledConfig.publish.autoMerge = false;
    await writeFile(configPath(fixture.repo), `${JSON.stringify(disabledConfig, null, 2)}\n`, "utf8");
    const restarted = await MergeBroker.open(fixture.repo, { publisher: forge });
    const synced = await restarted.syncBatch(integrated.batch.id);

    assert.equal(disableCalls, 1);
    assert.equal(remoteAutoMerge, false);
    assert.equal(synced.status, "published");
    assert.equal(synced.autoMergeEnabled, false);
    assert.equal(synced.autoMergePending, undefined);
    assert.ok(synced.candidate?.approval?.confirmedAt);
  },
);

test(
  "revokes a force-pushed legacy queue before reporting its missing candidate identity",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let reportedHead = "";
    let expectedBase = "";
    let remoteAutoMerge = false;
    let disableCalls = 0;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: "OPEN",
        autoMergeEnabled: remoteAutoMerge,
        headRefOid: reportedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        checks: [],
      }),
      enableAutoMerge: async () => {
        remoteAutoMerge = true;
        return true;
      },
      disableAutoMerge: async () => {
        disableCalls += 1;
        remoteAutoMerge = false;
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "LEGACY-FORCE-PUSH",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("LEGACY-FORCE-PUSH", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    reportedHead = expectedHead;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);
    await broker.approveBatch(integrated.batch.id, {
      candidateSha: candidate.sha,
      baseSha: candidate.baseSha,
      policyRevision: candidate.policyRevision,
      actor: "release-manager",
    });
    assert.equal(remoteAutoMerge, true);

    // Model a pre-candidate legacy record after a write-capable actor force-pushed its queued PR.
    await broker.store.transaction((state) => {
      const batch = state.batches[integrated.batch.id];
      assert.ok(batch);
      delete batch.candidate;
      delete batch.autoMergeEnabled;
      delete batch.autoMergePending;
    });
    reportedHead = "f".repeat(40);

    await assert.rejects(
      broker.syncBatch(integrated.batch.id),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_MISMATCH",
    );

    assert.equal(disableCalls, 1);
    assert.equal(remoteAutoMerge, false);
    const stored = (await broker.state()).batches[integrated.batch.id];
    assert.ok(stored);
    assert.equal(stored.status, "published");
    assert.equal(stored.candidate, undefined);
    assert.equal(stored.autoMergeEnabled, false);
    assert.equal(stored.autoMergePending, undefined);
  },
);

test(
  "does not let a config downgrade auto-merge a candidate assembled under required approval",
  { skip: process.platform === "win32" ? "POSIX Git fixture" : false },
  async (context) => {
    const fixture = await repository(context);
    const config = await loadConfig(fixture.repo);
    if (!config.approval) throw new Error("Expected approval policy.");
    config.approval.requiredVerifications = [];
    config.approval.requiredChecks = [];
    await writeFile(configPath(fixture.repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let expectedHead = "";
    let expectedBase = "";
    let enableCalls = 0;
    const forge = {
      ...githubCliPublisher,
      publishBatch: async ({ batch }: Parameters<typeof githubCliPublisher.publishBatch>[0]) => ({
        mode: "pull-request" as const,
        branchName: batch.branchName ?? "missing",
        pullRequestUrl: PULL_REQUEST,
      }),
      inspectPullRequest: async () => ({
        state: "OPEN",
        autoMergeEnabled: false,
        headRefOid: expectedHead,
        baseRefOid: expectedBase,
        baseRefName: "main",
        checks: [],
      }),
      enableAutoMerge: async () => {
        enableCalls += 1;
        return true;
      },
    };
    const broker = await MergeBroker.open(fixture.repo, { publisher: forge });
    const claim = await broker.claimTask({
      id: "POLICY-DOWNGRADE",
      holder: "worker",
      expectedPaths: ["feature.ts"],
    });
    const commit = await taskCommit(fixture.repo);
    await broker.submitTask("POLICY-DOWNGRADE", [commit], claim.token);
    const integrated = await broker.integrate();
    const candidate = integrated.batch.candidate;
    assert.ok(candidate);
    expectedHead = candidate.sha;
    expectedBase = candidate.baseSha;
    await broker.publishBatch(integrated.batch.id);

    const downgraded = await loadConfig(fixture.repo);
    if (!downgraded.approval) throw new Error("Expected approval policy.");
    downgraded.approval.required = false;
    await writeFile(configPath(fixture.repo), `${JSON.stringify(downgraded, null, 2)}\n`, "utf8");
    const restarted = await MergeBroker.open(fixture.repo, { publisher: forge });

    await assert.rejects(
      restarted.publishBatch(integrated.batch.id),
      (error: unknown) => error instanceof BrokerError && error.code === "CANDIDATE_POLICY_STALE",
    );
    assert.equal(enableCalls, 0);
    const blocked = await restarted.syncBatch(integrated.batch.id);
    assert.equal(blocked.candidate?.state, "blocked");
    assert.equal(blocked.candidate?.approval, undefined);
    assert.equal(enableCalls, 0);
  },
);
