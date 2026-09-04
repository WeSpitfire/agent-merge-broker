import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import {
  closePullRequest,
  disableAutoMerge,
  enableAutoMerge,
  inspectPullRequest,
  publishBatch,
} from "./publisher.js";

const PULL_REQUEST = "https://github.example.invalid/owner/repo/pull/1";

/**
 * Installs a fake `gh` ahead of the real one. The auto-merge decision is a branch of behavior that
 * only appears when GitHub declines to queue a merge, which is impractical to reach against the
 * real forge.
 */
async function fakeGh(context: TestContext, mergeStateStatus: string): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      "case \"$*\" in",
      // GitHub refuses to queue auto-merge here. The message is deliberately not English prose the
      // broker could pattern-match; the decision must come from the structured state below.
      '  *--auto*) echo "auto-merge konnte nicht aktiviert werden" >&2; exit 1 ;;',
      `  *"pr view"*) echo '{"state":"OPEN","mergeStateStatus":"${mergeStateStatus}","mergeable":"MERGEABLE"}' ;;`,
      '  *"pr merge"*) echo "merged" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  context.after(async () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(bin, { recursive: true, force: true });
  });
  return bin;
}

test(
  "merges directly when GitHub reports a clean pull request in any language",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    await fakeGh(context, "CLEAN");
    assert.equal(await enableAutoMerge(process.cwd(), PULL_REQUEST, defaultConfig()), true);
  },
);

test(
  "reports the merge state instead of guessing when auto-merge is unavailable",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    await fakeGh(context, "BLOCKED");
    await assert.rejects(
      enableAutoMerge(process.cwd(), PULL_REQUEST, defaultConfig()),
      (error: unknown) =>
        error instanceof BrokerError &&
        error.code === "AUTO_MERGE_FAILED" &&
        (error.details?.mergeState as { mergeStateStatus?: string } | undefined)?.mergeStateStatus === "BLOCKED",
    );
  },
);

test(
  "recognizes auto-merge that an interrupted earlier attempt already queued",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"--auto"*) echo "response lost" >&2; exit 1 ;;',
        '  *"pr view"*) echo \'{"state":"OPEN","autoMergeRequest":{"enabledAt":"2026-01-01T00:00:00Z"}}\' ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
    context.after(async () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(bin, { recursive: true, force: true });
    });

    const config = defaultConfig();
    config.publish.autoMerge = true;
    assert.equal(await enableAutoMerge(process.cwd(), PULL_REQUEST, config, "1".repeat(40)), true);
  },
);

test(
  "only treats an already-closed pull request as our completed close when its intent marker exists",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"pr close"*) echo "already closed"; exit 0 ;;',
        '  *"pr view"*) echo \'{"state":"CLOSED","comments":[{"body":"done <!-- merge-broker-refresh:ours -->"}]}\' ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
    context.after(async () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(bin, { recursive: true, force: true });
    });

    assert.equal(
      await closePullRequest(process.cwd(), PULL_REQUEST, "superseded <!-- merge-broker-refresh:ours -->"),
      true,
    );
    await assert.rejects(
      closePullRequest(process.cwd(), PULL_REQUEST, "superseded <!-- merge-broker-refresh:theirs -->"),
      (error: unknown) => error instanceof BrokerError && error.code === "PULL_REQUEST_ALREADY_CLOSED",
    );
  },
);

test(
  "treats already-disabled or closed auto-merge as a completed revocation retry",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"--disable-auto"*) echo "not enabled" >&2; exit 1 ;;',
        '  *"pr view"*) echo \'{"state":"OPEN","autoMergeRequest":null}\' ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
    context.after(async () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(bin, { recursive: true, force: true });
    });

    assert.equal(await disableAutoMerge(process.cwd(), PULL_REQUEST), true);

    // Refresh can stop after closing its PR but before finalizing local state. A retry must regard a
    // terminal CLOSED PR as having no live queue instead of wedging on the redundant disable call.
    await writeFile(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"--disable-auto"*) echo "already closed" >&2; exit 1 ;;',
        '  *"pr view"*) echo \'{"state":"CLOSED","autoMergeRequest":null}\' ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    assert.equal(await disableAutoMerge(process.cwd(), PULL_REQUEST), true);
  },
);

async function fakeLegacyGh(
  context: TestContext,
  apiHeadRefOid = "1".repeat(40),
): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
  const log = path.join(bin, "gh.log");
  await writeFile(log, "", "utf8");
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${log}"`,
      "case \"$*\" in",
      `  *"pr view"*baseRefOid*) echo 'Unknown JSON field: "baseRefOid"' >&2; exit 1 ;;`,
      `  *"pr view"*) echo '{"state":"OPEN","headRefOid":"${"1".repeat(40)}","baseRefName":"main","mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","statusCheckRollup":[]}' ;;`,
      `  *"api repos/owner/repo/pulls/1"*) echo '{"headRefOid":"${apiHeadRefOid}","baseRefOid":"${"0".repeat(40)}","baseRefName":"main"}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  context.after(async () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(bin, { recursive: true, force: true });
  });
  return log;
}

test(
  "falls back to the GitHub API when gh pr view does not support baseRefOid",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    const log = await fakeLegacyGh(context);

    const state = await inspectPullRequest(process.cwd(), PULL_REQUEST);

    assert.equal(state.headRefOid, "1".repeat(40));
    assert.equal(state.baseRefOid, "0".repeat(40));
    assert.equal(state.baseRefName, "main");
    const calls = await readFile(log, "utf8");
    assert.match(calls, /pr view.*baseRefOid/u);
    assert.match(calls, /api repos\/owner\/repo\/pulls\/1 --hostname github\.example\.invalid/u);
  },
);

test(
  "fails closed when the pull request head moves during the legacy fallback",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    await fakeLegacyGh(context, "2".repeat(40));

    await assert.rejects(
      inspectPullRequest(process.cwd(), PULL_REQUEST),
      (error: unknown) =>
        error instanceof BrokerError &&
        error.code === "PULL_REQUEST_CHANGED_DURING_INSPECTION",
    );
  },
);

async function fakeGhForInspection(
  context: TestContext,
  viewResponse: Record<string, unknown>,
  apiResponse: Record<string, unknown> = {},
): Promise<void> {
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      "case \"$*\" in",
      `  *"pr view"*) echo '${JSON.stringify(viewResponse)}' ;;`,
      `  *"api repos/owner/repo/pulls/1"*) echo '${JSON.stringify(apiResponse)}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  context.after(async () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(bin, { recursive: true, force: true });
  });
}

test(
  "fails closed when GitHub omits the pull request head or target branch",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    for (const response of [
      { state: "MERGED", baseRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [] },
      { state: "MERGED", headRefOid: "1".repeat(40), baseRefOid: "0".repeat(40), statusCheckRollup: [] },
    ]) {
      await context.test(JSON.stringify(response), async (subcontext) => {
        await fakeGhForInspection(subcontext, response);
        await assert.rejects(
          inspectPullRequest(process.cwd(), PULL_REQUEST),
          (error: unknown) =>
            error instanceof BrokerError && error.code === "PULL_REQUEST_REF_LOOKUP_FAILED",
        );
      });
    }
  },
);

test(
  "fails closed when an open pull request has no current base SHA",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    const headRefOid = "1".repeat(40);
    await fakeGhForInspection(
      context,
      { state: "OPEN", headRefOid, baseRefName: "main", statusCheckRollup: [] },
      { headRefOid, baseRefName: "main" },
    );

    await assert.rejects(
      inspectPullRequest(process.cwd(), PULL_REQUEST),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "PULL_REQUEST_REF_LOOKUP_FAILED",
    );
  },
);

/**
 * A `gh` that can open a pull request, and that reports whether one already exists. `pr list` is
 * what decides between reusing and creating, so it is the switch these tests drive.
 */
async function fakeGhForPublish(
  context: TestContext,
  options: { existingUrl?: string; listExitCode?: number },
): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "merge-broker-bin-"));
  const listBody = options.existingUrl ? `[{"url":"${options.existingUrl}"}]` : "[]";
  await writeFile(
    path.join(bin, "gh"),
    [
      "#!/bin/sh",
      "case \"$*\" in",
      options.listExitCode
        ? `  *"pr list"*"--repo github.example.invalid/owner/repo"*"--state all"*) echo "the forge is unavailable" >&2; exit ${options.listExitCode} ;;`
        : `  *"pr list"*"--repo github.example.invalid/owner/repo"*"--state all"*) echo '${listBody}' ;;`,
      // The body arrives on stdin. Exiting without draining it makes the writer see EPIPE on Linux,
      // where the pipe is torn down promptly; macOS hid this.
      `  *"pr create"*"--repo github.example.invalid/owner/repo"*) cat >/dev/null; echo "${PULL_REQUEST}" ;;`,
      '  *--auto*) echo "queued" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  context.after(async () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(bin, { recursive: true, force: true });
  });
  return bin;
}

function publishFixture() {
  const config = defaultConfig();
  config.publish.mode = "pull-request";
  const batch = {
    id: "batch-1",
    status: "prepared",
    taskIds: ["TASK-A"],
    baseBranch: config.baseBranch,
    baseSha: "0".repeat(40),
    publicationMode: "pull-request" as const,
    remoteUrlFingerprint: "f".repeat(64),
    forgeRepository: "github.example.invalid/owner/repo",
    branchName: "merge-broker/batch-1",
    headSha: "1".repeat(40),
    validations: [],
    createdAt: new Date(0).toISOString(),
  };
  const tasks = [{ id: "TASK-A", status: "batched" }];
  const pushes: Array<{ remote: string; branch: string; headSha: string }> = [];
  const repo = {
    root: process.cwd(),
    boundRemoteUrl: async (remote: string) => remote,
    forgeRepository: async () => "github.example.invalid/owner/repo",
    forgeRepositoryFromUrl: () => "github.example.invalid/owner/repo",
    push: async (remote: string, branch: string, headSha: string) => {
      pushes.push({ remote, branch, headSha });
    },
  };
  return { config, batch, tasks, repo, pushes };
}

test("pushes the recorded batch head instead of relying on the local branch", async () => {
  const { config, batch, tasks, repo, pushes } = publishFixture();
  config.publish.mode = "branch";

  await publishBatch({ repo: repo as never, config, batch: batch as never, tasks: tasks as never });

  assert.deepEqual(pushes, [{
    remote: config.remote,
    branch: batch.branchName,
    headSha: batch.headSha,
  }]);
});

test("refuses publication when the durable batch has no recorded head", async () => {
  const { config, batch, tasks, repo, pushes } = publishFixture();
  config.publish.mode = "branch";
  const batchWithoutHead = { ...batch, headSha: undefined };

  await assert.rejects(
    publishBatch({ repo: repo as never, config, batch: batchWithoutHead as never, tasks: tasks as never }),
    (error: unknown) => error instanceof BrokerError && error.code === "NO_CANDIDATE",
  );
  assert.deepEqual(pushes, []);
});

test(
  "reuses the pull request an earlier attempt already opened even if it is no longer open",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    // The process can die after `pr create` and the PR can close or merge before recovery. Looking
    // only at open PRs would then create a second PR for the same immutable batch.
    await fakeGhForPublish(context, { existingUrl: PULL_REQUEST });
    const { config, batch, tasks, repo } = publishFixture();

    const result = await publishBatch({
      repo: repo as never,
      config,
      batch: batch as never,
      tasks: tasks as never,
    });

    assert.equal(result.pullRequestUrl, PULL_REQUEST);
    assert.equal(result.reusedPullRequest, true);
  },
);

test(
  "refuses to publish when the forge cannot say whether a pull request exists",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    // "I do not know" must not read as "there is none": the response to none is to create one, and
    // that is how a retry during an outage produces duplicates.
    await fakeGhForPublish(context, { listExitCode: 1 });
    const { config, batch, tasks, repo } = publishFixture();

    await assert.rejects(
      publishBatch({ repo: repo as never, config, batch: batch as never, tasks: tasks as never }),
      (error: unknown) =>
        error instanceof BrokerError && error.code === "PULL_REQUEST_LOOKUP_FAILED",
    );
  },
);

test(
  "opens one when the branch provably has none",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    await fakeGhForPublish(context, {});
    const { config, batch, tasks, repo } = publishFixture();

    const result = await publishBatch({
      repo: repo as never,
      config,
      batch: batch as never,
      tasks: tasks as never,
    });

    assert.equal(result.pullRequestUrl, PULL_REQUEST);
    assert.equal(result.reusedPullRequest, false);
  },
);

test(
  "uses the forge repository durably recorded on the batch",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    await fakeGhForPublish(context, {});
    const { config, batch, tasks, repo } = publishFixture();
    const boundBatch = { ...batch, forgeRepository: "github.example.invalid/owner/repo" };
    const repoWithChangedDefault = {
      ...repo,
      forgeRepository: async () => {
        throw new Error("publication must not re-derive the forge after assembly");
      },
    };

    const result = await publishBatch({
      repo: repoWithChangedDefault as never,
      config,
      batch: boundBatch as never,
      tasks: tasks as never,
    });

    assert.equal(result.pullRequestUrl, PULL_REQUEST);
  },
);
