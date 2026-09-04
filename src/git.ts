import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BrokerError } from "./errors.js";
import { runCommand, type CommandResult } from "./process.js";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

function splitNull(value: string): string[] {
  return value.split("\0").map((part) => part.trim()).filter(Boolean);
}

export function remoteUrlFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isHostQualifiedForgeRepository(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split("/");
  return parts.length === 3 && parts.every(Boolean);
}

function forgeRepositoryFromRemote(value: string): string | undefined {
  let host: string | undefined;
  let remotePath = value.trim();
  try {
    const parsed = new URL(remotePath);
    // gh operates on a hosted forge, not a filesystem path. Treating `/tmp/acme/repo.git` or a
    // `file:` URL as `acme/repo` would silently redirect PR operations to gh's github.com default
    // while Git pushes somewhere else.
    // `gh --repo HOST/OWNER/REPO` has no separately bound port in this adapter. Dropping an
    // explicit GHES port would query a different forge than Git pushes to, so reject it.
    if (
      !parsed.hostname ||
      parsed.protocol === "file:" ||
      parsed.port ||
      parsed.hostname.includes(":")
    ) return undefined;
    host = parsed.hostname;
    remotePath = parsed.pathname;
  } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(remotePath);
    if (scp && !/^[A-Za-z]:[\\/]/u.test(remotePath)) {
      host = scp[1];
      remotePath = scp[2] ?? "";
    }
  }
  if (!host) return undefined;
  const parts = remotePath.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const repository = (parts.at(-1) ?? "").replace(/\.git$/u, "");
  const owner = parts.at(-2) ?? "";
  if (!owner || !repository) return undefined;
  return `${host.toLowerCase()}/${owner}/${repository}`;
}

function canonicalRemoteUrl(value: string, repoRoot: string): string {
  const remote = value.trim();
  if (path.isAbsolute(remote) || path.win32.isAbsolute(remote)) return path.normalize(remote);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(remote) && !/^[A-Za-z]:[\\/]/u.test(remote)) {
    return remote;
  }
  const scp = /^(?:[^@/]+@)?[^:/]+:.+$/u.test(remote);
  if (scp) return remote;
  // Passing a relative configured URL back to Git verbatim is ambiguous: if another remote has
  // that name, `git push <token>` selects the remote instead of the filesystem path. Resolve local
  // paths while we still know the repository directory in which Git interpreted them.
  return path.resolve(repoRoot, remote);
}

export class GitRepository {
  readonly root: string;
  readonly commonGitDir: string;

  private constructor(root: string, commonGitDir: string) {
    this.root = root;
    this.commonGitDir = commonGitDir;
  }

  static async discover(cwd = process.cwd()): Promise<GitRepository> {
    const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = path.resolve(top.stdout.trim());
    const common = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
    });
    return new GitRepository(root, path.resolve(common.stdout.trim()));
  }

  async git(args: string[], cwd = this.root, allowFailure = false): Promise<CommandResult> {
    return await runCommand("git", args, { cwd, allowFailure });
  }

  /** Resolve gh's host-qualified `HOST/OWNER/REPO` selector from the exact Git push remote. */
  async forgeRepository(remote: string): Promise<string> {
    const value = await this.remotePushUrl(remote);
    return this.forgeRepositoryFromUrl(value);
  }

  forgeRepositoryFromUrl(value: string): string {
    const repository = forgeRepositoryFromRemote(value);
    if (!repository) {
      throw new BrokerError(
        "REMOTE_REPOSITORY_UNKNOWN",
        `Could not derive a GitHub repository from publication remote ${value}; refusing to use gh's ambient default.`,
        { remote: value },
      );
    }
    return repository;
  }

  async remotePushUrl(remote: string): Promise<string> {
    const configured = await this.git(["remote", "get-url", "--push", remote], this.root, true);
    const value = configured.stdout.trim();
    if (configured.exitCode !== 0 || !value) {
      throw new BrokerError("REMOTE_URL_UNKNOWN", `Could not resolve the push URL for remote ${remote}.`, { remote });
    }
    const canonical = canonicalRemoteUrl(value, this.root);
    let localPath: string | undefined;
    if (canonical.startsWith("file:")) {
      try {
        localPath = fileURLToPath(canonical);
      } catch {
        throw new BrokerError(
          "REMOTE_URL_UNKNOWN",
          `Could not resolve local publication remote ${remote}.`,
          { remote, url: value },
        );
      }
    } else if (path.isAbsolute(canonical)) {
      localPath = canonical;
    }
    if (!localPath) return canonical;
    try {
      // Use the physical target for both the durable fingerprint and later Git commands. Otherwise
      // a symlink (or Windows junction) can be redirected after assembly while retaining the same
      // configured URL, sending a validated batch to a different repository.
      return await realpath(localPath);
    } catch {
      throw new BrokerError(
        "REMOTE_URL_UNKNOWN",
        `Could not resolve local publication remote ${remote}.`,
        { remote, url: value },
      );
    }
  }

  /** Return the exact URL whose fingerprint was bound when the batch was assembled. */
  async boundRemoteUrl(remote: string, expectedFingerprint?: string): Promise<string> {
    const value = await this.remotePushUrl(remote);
    if (expectedFingerprint && remoteUrlFingerprint(value) !== expectedFingerprint) {
      throw new BrokerError(
        "REMOTE_TARGET_CHANGED",
        `Remote ${remote} no longer points at the Git target recorded when this batch was assembled.`,
        { remote, expectedFingerprint, actualFingerprint: remoteUrlFingerprint(value) },
      );
    }
    return value;
  }

  /**
   * Commit-producing broker operations run with a stable committer identity, signing disabled,
   * and an empty broker-owned hook directory. Ambient user config and repository hooks must not be
   * able to inject bytes after validation or make a fresh clone fail with no Git identity.
   */
  private async brokerCommitGit(
    args: string[],
    cwd: string,
    allowFailure = false,
  ): Promise<CommandResult> {
    const hooksDirectory = path.join(this.commonGitDir, "merge-broker-disabled-hooks");
    await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
    return await runCommand("git", [
      "-c", `core.hooksPath=${hooksDirectory}`,
      "-c", "commit.gpgSign=false",
      "-c", "user.useConfigOnly=true",
      "-c", "user.name=Agent Merge Broker",
      "-c", "user.email=merge-broker@localhost",
      ...args,
    ], { cwd, allowFailure });
  }

  async resolveCommit(revision: string): Promise<string> {
    const result = await this.git(
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      this.root,
      true,
    );
    if (result.exitCode !== 0) {
      throw new BrokerError("UNKNOWN_COMMIT", `Git revision is not a commit: ${revision}`, {
        revision,
        stderr: result.stderr,
      });
    }
    return result.stdout.trim();
  }

  async currentHead(cwd = this.root): Promise<string> {
    return await this.resolveCommitAt("HEAD", cwd);
  }

  async resolveCommitAt(revision: string, cwd: string): Promise<string> {
    const result = await this.git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], cwd, true);
    if (result.exitCode !== 0) {
      throw new BrokerError("UNKNOWN_COMMIT", `Git revision is not a commit: ${revision}`, {
        revision,
        cwd,
        stderr: result.stderr,
      });
    }
    return result.stdout.trim();
  }

  async changedFiles(commit: string): Promise<string[]> {
    const result = await this.git(
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit],
    );
    return [...new Set(splitNull(result.stdout))].sort();
  }

  async changedFilesForCommits(commits: string[]): Promise<string[]> {
    const files = new Set<string>();
    for (const commit of commits) {
      for (const file of await this.changedFiles(commit)) files.add(file);
    }
    return [...files].sort();
  }

  async changedFilesBetween(base: string, head: string): Promise<string[]> {
    const result = await this.git([
      "diff",
      "--name-only",
      "-z",
      `${base}..${head}`,
    ]);
    return [...new Set(splitNull(result.stdout))].sort();
  }

  /**
   * Everything that differs from `base` in a working tree, committed or not, including files Git
   * does not track yet.
   *
   * Pre-flight validation runs while the work is still in progress, so a diff limited to `base..HEAD`
   * would miss uncommitted edits, and one limited to tracked files would miss a new module -- which
   * is exactly what a new surface adds.
   */
  async changedFilesInWorkingTree(base: string, cwd = this.root): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", "-z", base], cwd);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
    return [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])].sort();
  }

  /**
   * Linear commits on HEAD after `base`, oldest first. `git cherry` compares patch identities, so a
   * change already contained in the base under a different SHA -- the ordinary result of a rebase --
   * is not submitted a second time.
   */
  async commitsSinceBase(cwd: string, base: string): Promise<string[]> {
    const cherry = await this.git(["cherry", base, "HEAD"], cwd);
    const notUpstream = new Set(
      cherry.stdout
        .split("\n")
        .filter((line) => line.startsWith("+ "))
        .map((line) => line.slice(2).trim()),
    );
    const listed = await this.git(["rev-list", "--reverse", "--no-merges", `${base}..HEAD`], cwd);
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((commit) => commit !== "" && notUpstream.has(commit));
  }

  async parentCount(commit: string): Promise<number> {
    const result = await this.git(["rev-list", "--parents", "-n", "1", commit]);
    return Math.max(0, result.stdout.trim().split(/\s+/u).length - 1);
  }

  async isClean(cwd = this.root): Promise<boolean> {
    const result = await this.git(["status", "--porcelain=v1", "-z"], cwd);
    return result.stdout.length === 0;
  }

  async addDetachedWorktree(destination: string, startPoint: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    await this.git(["worktree", "add", "--detach", destination, startPoint]);
  }

  async removeWorktree(destination: string): Promise<void> {
    const result = await this.git(["worktree", "remove", "--force", destination], this.root, true);
    if (result.exitCode !== 0) {
      await this.git(["worktree", "prune"], this.root, true);
      throw new BrokerError("WORKTREE_REMOVE_FAILED", `Could not remove integration worktree: ${destination}`, {
        stderr: result.stderr,
      });
    }
  }

  async cherryPick(cwd: string, commit: string): Promise<CommandResult> {
    return await this.brokerCommitGit(["cherry-pick", "-x", commit], cwd, true);
  }

  async abortCherryPick(cwd: string): Promise<void> {
    await this.git(["cherry-pick", "--abort"], cwd, true);
  }

  async createBranch(name: string, commit: string): Promise<void> {
    const exists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.root, true);
    if (exists.exitCode === 0) {
      throw new BrokerError("BRANCH_EXISTS", `Integration branch already exists: ${name}`);
    }
    await this.git(["branch", "--", name, commit]);
  }

  async deleteBranch(name: string): Promise<void> {
    const deleted = await this.git(["branch", "-D", "--", name], this.root, true);
    if (deleted.exitCode === 0) return;
    const exists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.root, true);
    if (exists.exitCode !== 0) return;
    throw new BrokerError("BRANCH_DELETE_FAILED", `Could not delete integration branch ${name}.`, {
      stdout: deleted.stdout,
      stderr: deleted.stderr,
    });
  }

  async squash(cwd: string, baseSha: string, message: string): Promise<string> {
    await this.git(["reset", "--soft", baseSha], cwd);
    await this.brokerCommitGit(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
  }

  /**
   * Best-effort refresh of the remote-tracking base. Integration must still work in a repository
   * with no remote or no network, so a failed fetch is reported rather than thrown.
   */
  async fetchBranch(remote: string, branch: string): Promise<boolean> {
    const result = await this.git(["fetch", "--quiet", "--", remote, branch], this.root, true);
    return result.exitCode === 0;
  }

  /** Fetch a branch through an exact URL without sharing FETCH_HEAD or a durable tracking ref. */
  async fetchBranchHead(remote: string, branch: string): Promise<string | undefined> {
    const temporaryRef = `refs/merge-broker/fetch/${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      const result = await this.git(
        ["fetch", "--quiet", "--no-tags", "--force", "--", remote, `refs/heads/${branch}:${temporaryRef}`],
        this.root,
        true,
      );
      if (result.exitCode !== 0) return undefined;
      return await this.resolveCommit(temporaryRef);
    } finally {
      await this.git(["update-ref", "-d", temporaryRef], this.root, true);
    }
  }

  async commitGeneratedFile(
    cwd: string,
    relativePath: string,
    contents: string,
    message: string,
  ): Promise<string> {
    const target = path.resolve(cwd, relativePath);
    const relative = path.relative(cwd, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new BrokerError("UNSAFE_PATH", `Generated file escapes the integration worktree: ${relativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    await this.git(["add", "--", relativePath], cwd);
    await this.brokerCommitGit(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
  }

  /**
   * Publishes an assembled batch from its recorded commit, never from the mutable local branch.
   * An empty expected value makes the lease a create-only guard. Git still treats a retry at the
   * same SHA as up to date, while refusing to replace any different remote value -- including a
   * value that the recorded commit could fast-forward.
   */
  async push(remote: string, branch: string, headSha: string): Promise<void> {
    await this.git([
      "push",
      `--force-with-lease=refs/heads/${branch}:`,
      "--",
      remote,
      `${headSha}:refs/heads/${branch}`,
    ]);
  }

  /**
   * Advances an existing broker branch only when the remote still points at the candidate we are
   * superseding. This is the one permitted force update: it keeps a revision on the same PR while
   * refusing to overwrite somebody else's concurrent push.
   */
  async replaceRemoteBranch(
    remote: string,
    branch: string,
    nextHead: string,
    expectedHead: string,
  ): Promise<void> {
    await this.git([
      "push",
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
      "--",
      remote,
      `${nextHead}:refs/heads/${branch}`,
    ]);
    await this.git(["branch", "-f", "--", branch, nextHead]);
  }

  async replaceLocalBranch(branch: string, nextHead: string): Promise<void> {
    await this.git(["branch", "-f", "--", branch, nextHead]);
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await this.git(["worktree", "list", "--porcelain"]);
    const records: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    const flush = (): void => {
      if (current.path && current.head) {
        records.push({
          path: current.path,
          head: current.head,
          ...(current.branch ? { branch: current.branch } : {}),
          bare: current.bare ?? false,
          detached: current.detached ?? false,
          prunable: current.prunable ?? false,
        });
      }
      current = {};
    };

    for (const line of result.stdout.split("\n")) {
      if (!line) {
        flush();
        continue;
      }
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      if (key === "worktree") current.path = value;
      else if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
      else if (key === "prunable") current.prunable = true;
    }
    flush();
    return records;
  }
}
