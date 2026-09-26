import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "./config.js";
import { GitRepository, remoteUrlFingerprint } from "./git.js";
import { runCommand } from "./process.js";
import { githubCliPublisher } from "./publisher.js";
import { fakeProcess } from "./test-support/fake-process.js";
import {
  runForgePublisherContract,
  type ContractPullRequest,
  type ForgeContractFaults,
  type ForgeContractFixture,
} from "./test-support/forge-contract.js";

interface RemoteModel {
  requests: ContractPullRequest[];
  faults: ForgeContractFaults;
  acceptedMergeHeads: string[];
}

/** The model implements gh observations and side effects, never ForgePublisher methods. Git pushes
 * go to real local bare repositories; only gh is replaced, with no network or credentials. */
async function githubContractFixture(context: TestContext): Promise<ForgeContractFixture> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "merge-broker-forge-contract-")));
  context.after(async () => await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(directory, "work");
  const remote = path.join(directory, "recorded.git");
  const ambient = path.join(directory, "ambient.git");
  const git = async (...args: string[]) => (await runCommand("git", args, { cwd: directory })).stdout.trim();
  await git("init", "--bare", remote);
  await git("init", "--bare", ambient);
  await git("init", "-b", "main", root);
  await git("-C", root, "config", "user.name", "Forge Contract");
  await git("-C", root, "config", "user.email", "contract@merge-broker.invalid");
  await git("-C", root, "commit", "--allow-empty", "-m", "base");
  const baseSha = await git("-C", root, "rev-parse", "HEAD");
  await git("-C", root, "commit", "--allow-empty", "-m", "candidate");
  const headSha = await git("-C", root, "rev-parse", "HEAD");
  await git("-C", root, "commit", "--allow-empty", "-m", "unrelated local head");
  const alternateHead = await git("-C", root, "rev-parse", "HEAD");
  const branchName = "merge-broker/contract-batch";
  await git("-C", root, "branch", branchName, alternateHead);
  await git("-C", root, "remote", "add", "recorded", remote);
  await git("-C", root, "remote", "add", "ambient", ambient);
  const repo = await GitRepository.discover(root);
  const config = defaultConfig("ambient-base", "ambient");
  config.publish.mode = "pull-request";
  config.publish.repository = "github.example.invalid/ambient/repo";
  config.publish.autoMerge = true;
  const at = "2026-01-01T00:00:00.000Z";
  const batch = {
    id: "contract-batch", status: "prepared" as const, taskIds: ["CONTRACT-TASK"], remote: "recorded",
    publicationMode: "pull-request" as const, remoteUrlFingerprint: remoteUrlFingerprint(remote),
    forgeRepository: "github.example.invalid/owner/repo", baseBranch: "main", baseSha,
    branchName, headSha, validations: [], createdAt: at,
  };
  const tasks = [{
    id: "CONTRACT-TASK", title: "Adapter contract task", status: "batched" as const, priority: 0,
    baseSha, expectedPaths: ["src/**"], actualPaths: [], dependsOn: [], commits: [headSha],
    warnings: [], validations: [], createdAt: at, updatedAt: at,
  }];
  const pullRequestUrl = "https://github.example.invalid/owner/repo/pull/1";
  const defaults: ContractPullRequest = {
    url: pullRequestUrl, repository: batch.forgeRepository, branch: branchName, baseBranch: "main",
    headSha, baseSha, state: "OPEN", autoMerge: false, mergeState: "BLOCKED", mergeable: "MERGEABLE",
    reviewDecision: "APPROVED", mergeCommitSha: alternateHead, checks: [], comments: [], body: "original body",
  };
  const modelFile = path.join(directory, "remote.json");
  await writeFile(modelFile, JSON.stringify({ requests: [], faults: {}, acceptedMergeHeads: [] } satisfies RemoteModel));
  await fakeProcess(context, "gh", `
    import { writeFileSync } from "node:fs";
    const modelFile = ${JSON.stringify(modelFile)};
    const model = JSON.parse(readFileSync(modelFile, "utf8"));
    const defaults = ${JSON.stringify(defaults)};
    const fault = model.faults;
    const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const fail = (message) => { console.error(message); process.exitCode = 1; };
    const request = model.requests.find((item) => item.url === args[2]);
    if (args[0] === "pr" && args[1] === "list") {
      if (fault.discovery === "unavailable") fail("discovery unavailable");
      else if (fault.discovery === "invalid-json") console.log("{ incomplete JSON");
      else console.log(JSON.stringify(model.requests.filter((item) =>
        item.repository === flag("--repo") && item.branch === flag("--head") && item.baseBranch === flag("--base") &&
        (flag("--state") === "all" || item.state === "OPEN")
      ).map(({ url }) => ({ url }))));
    } else if (args[0] === "pr" && args[1] === "create") {
      const created = { ...defaults, url: defaults.url.replace(/1$/, String(model.requests.length + 1)),
        repository: flag("--repo"), branch: flag("--head"), baseBranch: flag("--base"), body: input };
      model.requests.push(created);
      if (fault.create === "response-lost") fail("create response lost after remote accepted");
      else console.log(created.url);
    } else if (args[0] === "pr" && args[1] === "view" && request) {
      const fields = flag("--json").split(",");
      if (fault.inspection === "unavailable") fail("observation unavailable");
      else if (fault.inspection === "head-changes-between-reads" && fields.includes("baseRefOid")) fail('Unknown JSON field: "baseRefOid"');
      else {
        const value = {
          state: request.state, headRefOid: request.headSha, baseRefOid: request.baseSha, baseRefName: request.baseBranch,
          mergeStateStatus: request.mergeState, mergeable: request.mergeable, reviewDecision: request.reviewDecision,
          mergeCommit: { oid: request.mergeCommitSha }, statusCheckRollup: request.checks,
          comments: request.comments.map((body) => ({ body })),
          ...(request.autoMerge === "unknown" ? {} : { autoMergeRequest: request.autoMerge ? { enabledAt: ${JSON.stringify(at)} } : null }),
        };
        if (fault.inspection === "head-changes-between-reads") delete value.baseRefOid;
        if (fault.inspection === "missing-head") delete value.headRefOid;
        console.log(JSON.stringify(Object.fromEntries(fields.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]))));
      }
    } else if (args[0] === "api" && model.requests[0]) {
      const current = model.requests[0];
      if (fault.inspection === "unavailable") fail("observation unavailable");
      else console.log(JSON.stringify({ headRefOid: fault.inspection === "head-changes-between-reads" ? ${JSON.stringify(alternateHead)} : current.headSha,
        baseRefOid: current.baseSha, baseRefName: current.baseBranch }));
    } else if (args[0] === "pr" && args[1] === "merge" && request) {
      if (!args.includes("--auto") && !args.includes("--disable-auto") && fault.directMerge === "head-changed") {
        request.headSha = ${JSON.stringify(alternateHead)};
      }
      if (args.includes("--disable-auto")) {
        if (fault.disable === "rejected" || request.state !== "OPEN") fail("disable not accepted");
        else {
          request.autoMerge = false;
          if (fault.disable === "response-lost") fail("disable response lost");
        }
      } else if (flag("--match-head-commit") && flag("--match-head-commit") !== request.headSha) fail("head guard rejected");
      else if (request.state !== "OPEN") fail("request is terminal");
      else if (args.includes("--auto") && fault.enable === "rejected") fail("auto-merge unavailable");
      else {
        model.acceptedMergeHeads.push(request.headSha);
        if (args.includes("--auto")) request.autoMerge = true;
        else request.state = "MERGED";
        if (args.includes("--auto") && fault.enable === "response-lost") fail("enable response lost");
      }
    } else if (args[0] === "pr" && args[1] === "close" && request) {
      if (request.state === "CLOSED") console.log("already closed");
      else if (request.state !== "OPEN" || fault.close === "rejected") fail("close not accepted");
      else {
        request.state = "CLOSED";
        request.comments.push(flag("--comment"));
        if (fault.close === "response-lost") fail("close response lost");
      }
    } else if (args[0] === "pr" && args[1] === "edit" && request) {
      if (fault.body === "rejected") fail("body update unavailable");
      else request.body = input;
    } else fail("unexpected command: " + command);
    writeFileSync(modelFile, JSON.stringify(model));
  `);
  const readModel = async () => JSON.parse(await readFile(modelFile, "utf8")) as RemoteModel;
  const branchHead = async (directory: string) => {
    const result = await runCommand("git", ["--git-dir", directory, "rev-parse", "--verify", `refs/heads/${branchName}`], {
      cwd: root, allowFailure: true,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  };
  return {
    publisher: githubCliPublisher, publication: { repo, config, batch, tasks }, pullRequestUrl, alternateHead,
    arrange: async ({ request, faults }) => {
      const model = await readModel();
      if (request) model.requests[0] = { ...defaults, ...model.requests[0], ...request };
      if (faults) model.faults = faults;
      await writeFile(modelFile, JSON.stringify(model));
    },
    snapshot: async () => ({ ...(await readModel()), branchHead: await branchHead(remote), ambientBranchHead: await branchHead(ambient) }),
    replaceRemoteHead: async (sha) => { await git("-C", root, "push", "--force", remote, `${sha}:refs/heads/${branchName}`); },
    redirectRecordedRemote: async () => { await git("-C", root, "remote", "set-url", "recorded", ambient); },
  };
}

test("GitHub CLI publisher satisfies the reusable ForgePublisher contract", async (context) => {
  await runForgePublisherContract(context, githubContractFixture);
});
