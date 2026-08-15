import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { enableAutoMerge } from "./publisher.js";

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
