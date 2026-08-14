import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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
    return await this.git(["cherry-pick", "-x", commit], cwd, true);
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
    await this.git(["branch", "-D", "--", name], this.root, true);
  }

  async squash(cwd: string, baseSha: string, message: string): Promise<string> {
    await this.git(["reset", "--soft", baseSha], cwd);
    await this.git(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
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
    await this.git(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
  }

  async push(remote: string, branch: string): Promise<void> {
    await this.git(
      ["push", "--set-upstream", "--", remote, `refs/heads/${branch}:refs/heads/${branch}`],
      this.root,
    );
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
