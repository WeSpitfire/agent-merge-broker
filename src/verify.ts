import { BrokerError } from "./errors.js";
import { provenancePath } from "./provenance.js";
import type { GitRepository } from "./git.js";
import type { BatchProvenance, BrokerConfig } from "./types.js";

const MAX_BRANCH_UPDATE_MERGES = 50;

export interface VerifyProvenanceOptions {
  repo: GitRepository;
  /** The pull request's head branch, which must be a broker integration branch. */
  branch: string;
  headSha: string;
  /** The current tip of the target branch. */
  baseSha: string;
  baseBranch: string;
  branchPrefix?: string;
  provenanceDirectory?: string;
}

export interface ProvenanceVerification {
  batchId: string;
  manifestPath: string;
  manifest: BatchProvenance;
  /** The commit that introduced the manifest; the integrated work is its parent. */
  provenanceSha: string;
  parentSha: string;
  taskIds: string[];
}

function invalid(message: string, details?: Record<string, unknown>): BrokerError {
  return new BrokerError("PROVENANCE_INVALID", message, details);
}

/**
 * Reads verification policy from the configuration as it exists on the base branch. The checked-out
 * tree belongs to the change being verified, so trusting its configuration would let a pull request
 * widen the rules it is about to be judged by.
 */
export async function policyFromBase(
  repo: GitRepository,
  baseSha: string,
): Promise<{ baseBranch?: string; branchPrefix?: string; provenanceDirectory?: string }> {
  const shown = await repo.git(["show", `${baseSha}:.merge-broker/config.json`], repo.root, true);
  if (shown.exitCode !== 0) return {};
  try {
    const config = JSON.parse(shown.stdout) as Partial<BrokerConfig>;
    return {
      ...(typeof config.baseBranch === "string" ? { baseBranch: config.baseBranch } : {}),
      ...(typeof config.integration?.branchPrefix === "string"
        ? { branchPrefix: config.integration.branchPrefix }
        : {}),
      ...(typeof config.integration?.provenance?.directory === "string"
        ? { provenanceDirectory: config.integration.provenance.directory }
        : {}),
    };
  } catch {
    return {};
  }
}

export function batchIdFromBranch(branch: string, prefix: string): string {
  if (!branch.startsWith(prefix) || branch.length === prefix.length) {
    throw invalid(
      `Expected a ${prefix}<batch-id> branch, received ${branch}. Work reaches the base branch through the broker, not directly.`,
      { branch, prefix },
    );
  }
  const batchId = branch.slice(prefix.length);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(batchId)) {
    throw invalid(`Unsafe batch id in branch ${branch}.`, { branch });
  }
  return batchId;
}

async function isAncestor(repo: GitRepository, ancestor: string, descendant: string): Promise<boolean> {
  const result = await repo.git(["merge-base", "--is-ancestor", ancestor, descendant], repo.root, true);
  return result.exitCode === 0;
}

/**
 * Finds the commit that introduced the manifest, stepping over the merges GitHub creates when a
 * protected base requires branches to be up to date. Such a merge is accepted only when its merged
 * side is already contained in the base and it changed nothing the base did not: anything else is a
 * commit somebody pushed onto the branch after the broker assembled it.
 */
async function findProvenanceCommit(repo: GitRepository, headSha: string, baseSha: string): Promise<string> {
  let current = headSha;
  for (let depth = 0; depth < MAX_BRANCH_UPDATE_MERGES; depth += 1) {
    const listed = await repo.git(["rev-list", "--parents", "-n", "1", current]);
    const parents = listed.stdout.trim().split(/\s+/u).slice(1);
    if (parents.length < 2) return current;
    if (parents.length > 2) throw invalid(`Octopus merge ${current} is not a recognised branch update.`);
    const [firstParent, secondParent] = parents as [string, string];

    if (!(await isAncestor(repo, secondParent, baseSha))) {
      throw invalid(
        `Merge ${current} brings in ${secondParent}, which is not part of ${baseSha}. Only base-branch updates may be added to an integration branch.`,
      );
    }
    const conflictEdits = (await repo.git(["diff", "--name-only", firstParent, current])).stdout
      .split("\n")
      .filter(Boolean);
    const baseChanges = new Set(
      (await repo.git(["diff", "--name-only", `${firstParent}...${secondParent}`])).stdout
        .split("\n")
        .filter(Boolean),
    );
    const unexplained = conflictEdits.filter((file) => !baseChanges.has(file));
    if (unexplained.length > 0) {
      throw invalid(`Branch update ${current} changed files the base branch did not: ${unexplained.join(", ")}.`, {
        files: unexplained,
      });
    }
    current = firstParent;
  }
  throw invalid("Integration branch has too many merge commits to verify.");
}

/**
 * Proves that a pull request is an unaltered broker batch: assembled on real base history, carrying
 * every commit its receipts claim, changing exactly the files those receipts account for, and
 * validated. Reads nothing but Git, so it works on any forge and before any dependency is installed.
 */
export async function verifyProvenance(options: VerifyProvenanceOptions): Promise<ProvenanceVerification> {
  const {
    repo,
    branch,
    headSha,
    baseSha,
    baseBranch,
    branchPrefix = "merge-broker/",
    provenanceDirectory = ".merge-broker/attestations",
  } = options;

  const batchId = batchIdFromBranch(branch, branchPrefix);
  const manifestPath = provenancePath(provenanceDirectory, batchId);
  const shown = await repo.git(["show", `${headSha}:${manifestPath}`], repo.root, true);
  if (shown.exitCode !== 0) {
    throw invalid(`Integration branch ${branch} does not contain ${manifestPath}.`, { manifestPath });
  }
  let manifest: BatchProvenance;
  try {
    manifest = JSON.parse(shown.stdout) as BatchProvenance;
  } catch (error) {
    throw invalid(`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (manifest.version !== 1 || manifest.generator !== "agent-merge-broker") {
    throw invalid(`Unsupported provenance manifest in ${manifestPath}.`);
  }
  if (manifest.batchId !== batchId) {
    throw invalid(`Manifest batch ${manifest.batchId} does not match branch ${batchId}.`);
  }
  if (manifest.baseBranch !== baseBranch) {
    throw invalid(`Batch targets ${manifest.baseBranch}, not ${baseBranch}.`);
  }
  // The batch must sit on real base history, but not necessarily on its current tip. Requiring
  // equality would deadlock every batch: the base advances between integration and this check, and
  // no amount of re-running makes a recorded base match a moving target.
  if (manifest.baseSha !== baseSha && !(await isAncestor(repo, manifest.baseSha, baseSha))) {
    throw invalid(
      `Batch was assembled on ${manifest.baseSha}, which is not an ancestor of ${baseBranch} at ${baseSha}. Re-integrate the batch.`,
    );
  }

  const provenanceSha = await findProvenanceCommit(repo, headSha, baseSha);
  const parentSha = (await repo.git(["rev-parse", `${provenanceSha}^`])).stdout.trim();
  if (manifest.integratedHeadSha !== parentSha) {
    throw invalid("The manifest is not the final provenance-only commit on this branch.", {
      recorded: manifest.integratedHeadSha,
      actual: parentSha,
    });
  }
  const changedByManifest = (
    await repo.git(["diff-tree", "--no-commit-id", "--name-only", "-r", provenanceSha])
  ).stdout
    .split("\n")
    .filter(Boolean);
  if (changedByManifest.length !== 1 || changedByManifest[0] !== manifestPath) {
    throw invalid("The final broker commit must change only its provenance manifest.", {
      changed: changedByManifest,
    });
  }
  if (!(await isAncestor(repo, manifest.baseSha, parentSha))) {
    throw invalid("Integrated head does not descend from the recorded base.");
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw invalid("Manifest contains no tasks.");
  }
  const taskIds = manifest.tasks.map((task) => task.id);
  if (JSON.stringify(taskIds) !== JSON.stringify(manifest.taskIds)) {
    throw invalid("Manifest taskIds do not match its task records.");
  }

  // Compared against the base the manifest records, not the current tip: a later unrelated commit on
  // the base branch would otherwise look like an unaccounted change.
  const claimedPaths = [...new Set(manifest.tasks.flatMap((task) => task.actualPaths ?? []))].sort();
  const integratedPaths = [
    ...new Set(
      (await repo.git(["diff", "--name-only", `${manifest.baseSha}..${parentSha}`])).stdout
        .split("\n")
        .filter(Boolean),
    ),
  ].sort();
  if (JSON.stringify(claimedPaths) !== JSON.stringify(integratedPaths)) {
    throw invalid("Manifest paths do not match the integrated diff.", {
      claimed: claimedPaths,
      integrated: integratedPaths,
    });
  }

  // Squashing rewrites the batch into one commit and drops the cherry-pick trail, so submitted
  // commits are only traceable when history was preserved. Manifests written before this field
  // existed always preserved it.
  if ((manifest.history ?? "preserve") === "preserve") {
    const history = (await repo.git(["log", "--format=%B", `${manifest.baseSha}..${parentSha}`])).stdout;
    for (const task of manifest.tasks) {
      if (!Array.isArray(task.commits) || task.commits.length === 0) {
        throw invalid(`Task ${task.id} records no submitted commits.`);
      }
      for (const commit of task.commits) {
        if (!history.includes(`cherry picked from commit ${commit}`)) {
          throw invalid(`Integrated history is missing submitted commit ${commit} from task ${task.id}.`);
        }
      }
    }
  }

  if (!Array.isArray(manifest.validations) || manifest.validations.some((item) => item.exitCode !== 0)) {
    throw invalid("Manifest records a failed validation.");
  }

  return { batchId, manifestPath, manifest, provenanceSha, parentSha, taskIds };
}
