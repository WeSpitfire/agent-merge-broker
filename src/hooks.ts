import path from "node:path";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { BrokerError } from "./errors.js";
import type { GitRepository } from "./git.js";

export const HOOKS_DIRECTORY = ".githooks";
export const BYPASS_VARIABLE = "MERGE_BROKER_ALLOW_DIRECT_PUSH";
const MARKER = "Installed by Agent Merge Broker";

export interface HookInstallation {
  hooksPath: string;
  hookFile: string;
  installed: boolean;
  previousHooksPath?: string;
}

/**
 * Refuses a direct push of an implementation branch. Integration branches still publish normally,
 * deletions and tags are untouched, and an operator can bypass the guard deliberately for an
 * emergency.
 */
export function prePushHook(branchPrefix: string): string {
  return `#!/bin/sh
# ${MARKER}. Remove with: merge-broker install-hooks --uninstall
#
# Work reaches the base branch through the broker: commit locally, then run
#   merge-broker task submit <task-id> --since-base
# Only ${branchPrefix}* branches may be pushed directly.

if [ "\${${BYPASS_VARIABLE}:-}" = "1" ]; then
  exit 0
fi

while read -r local_ref _local_sha _remote_ref _remote_sha; do
  case "$local_ref" in
    refs/heads/${branchPrefix}*)
      ;;
    refs/heads/*)
      echo "Direct implementation pushes are disabled by Agent Merge Broker." >&2
      echo "Submit the work instead:  merge-broker task submit <task-id> --since-base" >&2
      echo "Emergency bypass:         ${BYPASS_VARIABLE}=1 git push ..." >&2
      exit 1
      ;;
  esac
done

exit 0
`;
}

async function configuredHooksPath(repo: GitRepository): Promise<string | undefined> {
  const result = await repo.git(["config", "--get", "core.hooksPath"], repo.root, true);
  const value = result.stdout.trim();
  return result.exitCode === 0 && value !== "" ? value : undefined;
}

/**
 * Hooks already living in Git's default directory stop running the moment core.hooksPath moves.
 * Silently disabling somebody's existing tooling is not an acceptable side effect of installing a
 * guard, so they have to be acknowledged.
 */
async function existingDefaultHooks(repo: GitRepository): Promise<string[]> {
  const directory = path.join(repo.commonGitDir, "hooks");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".sample"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function installHooks(options: {
  repo: GitRepository;
  branchPrefix: string;
  force?: boolean;
}): Promise<HookInstallation> {
  const { repo, branchPrefix, force = false } = options;
  const current = await configuredHooksPath(repo);
  if (current !== undefined && current !== HOOKS_DIRECTORY && !force) {
    throw new BrokerError(
      "HOOKS_PATH_CONFLICT",
      `core.hooksPath is already set to ${current}. Installing would disable those hooks. Re-run with --force to replace it, or add the pre-push guard to ${current} yourself.`,
      { current },
    );
  }
  if (current === undefined) {
    const inherited = await existingDefaultHooks(repo);
    if (inherited.length > 0 && !force) {
      throw new BrokerError(
        "HOOKS_PATH_CONFLICT",
        `This repository already has Git hooks that would stop running once core.hooksPath moves: ${inherited.join(
          ", ",
        )}. Move them into ${HOOKS_DIRECTORY}/ and re-run with --force.`,
        { hooks: inherited },
      );
    }
  }

  const hooksPath = path.join(repo.root, HOOKS_DIRECTORY);
  const hookFile = path.join(hooksPath, "pre-push");
  await mkdir(hooksPath, { recursive: true });
  await writeFile(hookFile, prePushHook(branchPrefix), { encoding: "utf8", mode: 0o755 });
  await chmod(hookFile, 0o755).catch(() => undefined);
  await repo.git(["config", "core.hooksPath", HOOKS_DIRECTORY]);
  return {
    hooksPath,
    hookFile,
    installed: true,
    ...(current !== undefined && current !== HOOKS_DIRECTORY ? { previousHooksPath: current } : {}),
  };
}

export async function uninstallHooks(repo: GitRepository): Promise<HookInstallation> {
  const hooksPath = path.join(repo.root, HOOKS_DIRECTORY);
  const hookFile = path.join(hooksPath, "pre-push");
  let ours = false;
  try {
    ours = (await readFile(hookFile, "utf8")).includes(MARKER);
  } catch {
    ours = false;
  }
  // Only ever remove the broker's own hook; a hand-written one at the same path is not ours to
  // delete.
  if (ours) await rm(hookFile, { force: true });
  const current = await configuredHooksPath(repo);
  if (current === HOOKS_DIRECTORY) {
    const remaining = await readdir(hooksPath).catch(() => [] as string[]);
    if (remaining.length === 0) await repo.git(["config", "--unset", "core.hooksPath"], repo.root, true);
  }
  return { hooksPath, hookFile, installed: false };
}
