import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { enableAutoMerge, publishBatch } from "./publisher.js";

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
        ? `  *"pr list"*) echo "the forge is unavailable" >&2; exit ${options.listExitCode} ;;`
        : `  *"pr list"*) echo '${listBody}' ;;`,
      `  *"pr create"*) echo "${PULL_REQUEST}" ;;`,
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
    branchName: "merge-broker/batch-1",
    validations: [],
    createdAt: new Date(0).toISOString(),
  };
  const tasks = [{ id: "TASK-A", status: "batched" }];
  // Publication pushes before it asks about pull requests; the push itself is not what these cover.
  const repo = { root: process.cwd(), push: async () => {} };
  return { config, batch, tasks, repo };
}

test(
  "reuses the pull request an earlier attempt already opened",
  { skip: process.platform === "win32" ? "POSIX shell fixture" : false },
  async (context) => {
    // The publish that failed after creating a pull request is the ordinary case, not an exotic
    // one: anything after `pr create` can fail. A retry must not open a second one.
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
