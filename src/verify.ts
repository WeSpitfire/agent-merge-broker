import { BrokerError } from "./errors.js";
import {
  provenanceKeyId,
  provenancePath,
  verifyBatchProvenanceSignature,
} from "./provenance.js";
import type { GitRepository } from "./git.js";
import type { BatchProvenance, BrokerConfig } from "./types.js";

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
  /** Public key read from protected-base policy, never from the pull request. */
  publicKey?: string;
  requireSignature?: boolean;
}

export interface ProvenanceVerification {
  batchId: string;
  manifestPath: string;
  manifest: BatchProvenance;
  /** The commit that introduced the manifest; the integrated work is its parent. */
  provenanceSha: string;
  parentSha: string;
  taskIds: string[];
  /** True only when the manifest is signed by the key trusted on the protected base. */
  authenticated: boolean;
  signatureKeyId?: string;
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
): Promise<{
  baseBranch?: string;
  branchPrefix?: string;
  provenanceDirectory?: string;
  publicKey?: string;
  requireSignature?: boolean;
}> {
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
      ...(typeof config.integration?.provenance?.publicKey === "string"
        ? { publicKey: config.integration.provenance.publicKey }
        : {}),
      ...(typeof config.integration?.provenance?.requireSignature === "boolean"
        ? { requireSignature: config.integration.provenance.requireSignature }
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertAllowedRecordKeys(value: object, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw invalid(`${label} contains unknown fields: ${unexpected.join(", ")}.`);
}

function assertManifestShape(value: unknown): asserts value is BatchProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Manifest must be a JSON object.");
  const manifest = value as Partial<BatchProvenance> & Record<string, unknown>;
  const allowed = new Set([
    "version", "generator", "batchId", "baseBranch", "history", "baseSha", "integratedHeadSha",
    "taskIds", "tasks", "validations", "createdAt", "signature",
  ]);
  const unexpected = Object.keys(manifest).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw invalid(`Manifest contains unknown fields: ${unexpected.join(", ")}.`);
  if (manifest.version !== 1 || manifest.generator !== "agent-merge-broker") {
    throw invalid("Unsupported provenance manifest.");
  }
  if (typeof manifest.batchId !== "string" || typeof manifest.baseBranch !== "string") {
    throw invalid("Manifest batchId and baseBranch must be strings.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(manifest.batchId)) throw invalid("Manifest batchId is unsafe.");
  if (manifest.history !== undefined && manifest.history !== "preserve" && manifest.history !== "squash") {
    throw invalid("Manifest history must be preserve or squash.");
  }
  if (
    typeof manifest.baseSha !== "string" ||
    typeof manifest.integratedHeadSha !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(manifest.baseSha) ||
    !/^[0-9a-f]{40,64}$/u.test(manifest.integratedHeadSha)
  ) {
    throw invalid("Manifest commit IDs are invalid.");
  }
  if (!stringArray(manifest.taskIds) || manifest.taskIds.length === 0 || !Array.isArray(manifest.tasks)) {
    throw invalid("Manifest contains no valid task records.");
  }
  if (new Set(manifest.taskIds).size !== manifest.taskIds.length) throw invalid("Manifest taskIds must be unique.");
  for (const task of manifest.tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      typeof task.id !== "string" ||
      !stringArray(task.commits) ||
      task.commits.length === 0 ||
      task.commits.some((commit) => !/^[0-9a-f]{40,64}$/u.test(commit)) ||
      !stringArray(task.actualPaths) ||
      !stringArray(task.dependsOn)
    ) {
      throw invalid("Manifest contains a malformed task record.");
    }
    assertAllowedRecordKeys(task, ["id", "commits", "actualPaths", "dependsOn"], `Task ${task.id}`);
  }
  if (new Set(manifest.tasks.map((task) => task.id)).size !== manifest.tasks.length) {
    throw invalid("Manifest task records must have unique IDs.");
  }
  if (!Array.isArray(manifest.validations)) throw invalid("Manifest validations must be an array.");
  for (const validation of manifest.validations) {
    if (
      !validation ||
      typeof validation !== "object" ||
      typeof validation.name !== "string" ||
      (validation.scope !== "focused" && validation.scope !== "authoritative") ||
      validation.exitCode !== 0 ||
      !Number.isInteger(validation.durationMs) ||
      validation.durationMs < 0
    ) {
      throw invalid("Manifest contains a malformed or failed validation.");
    }
    if (validation.taskId !== undefined && typeof validation.taskId !== "string") {
      throw invalid("Manifest validation taskId must be a string.");
    }
    assertAllowedRecordKeys(
      validation,
      ["name", "scope", "taskId", "exitCode", "durationMs"],
      `Validation ${validation.name}`,
    );
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw invalid("Manifest createdAt must be a valid timestamp.");
  }
  if (manifest.signature !== undefined) {
    if (
      !manifest.signature ||
      typeof manifest.signature !== "object" ||
      manifest.signature.algorithm !== "ed25519" ||
      typeof manifest.signature.keyId !== "string" ||
      !/^[0-9a-f]{64}$/u.test(manifest.signature.keyId) ||
      typeof manifest.signature.value !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(manifest.signature.value)
    ) {
      throw invalid("Manifest signature is malformed.");
    }
    assertAllowedRecordKeys(manifest.signature, ["algorithm", "keyId", "value"], "Manifest signature");
  }
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
    publicKey,
    requireSignature = false,
  } = options;

  const batchId = batchIdFromBranch(branch, branchPrefix);
  const manifestPath = provenancePath(provenanceDirectory, batchId);
  const shown = await repo.git(["show", `${headSha}:${manifestPath}`], repo.root, true);
  if (shown.exitCode !== 0) {
    throw invalid(`Integration branch ${branch} does not contain ${manifestPath}.`, { manifestPath });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout) as unknown;
  } catch (error) {
    throw invalid(`${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertManifestShape(parsed);
  const manifest = parsed;
  if (manifest.batchId !== batchId) {
    throw invalid(`Manifest batch ${manifest.batchId} does not match branch ${batchId}.`);
  }
  if (manifest.baseBranch !== baseBranch) {
    throw invalid(`Batch targets ${manifest.baseBranch}, not ${baseBranch}.`);
  }

  let authenticated = false;
  if (manifest.signature) {
    if (!publicKey) {
      throw invalid("Manifest is signed, but the protected base policy does not trust a public key.");
    }
    if (!verifyBatchProvenanceSignature(manifest, publicKey)) {
      throw invalid("Manifest signature is invalid or was produced by an untrusted key.");
    }
    authenticated = true;
  }
  if (requireSignature && !authenticated) {
    throw invalid("Protected-base policy requires an authenticated provenance signature.");
  }
  // The batch must sit on real base history, but not necessarily on its current tip. Requiring
  // equality would deadlock every batch: the base advances between integration and this check, and
  // no amount of re-running makes a recorded base match a moving target.
  if (manifest.baseSha !== baseSha && !(await isAncestor(repo, manifest.baseSha, baseSha))) {
    throw invalid(
      `Batch was assembled on ${manifest.baseSha}, which is not an ancestor of ${baseBranch} at ${baseSha}. Re-integrate the batch.`,
    );
  }

  // The provenance commit is immutable. Even a legitimate base-update merge can carry arbitrary
  // conflict resolution in a path the base also changed, so path-only inspection cannot prove its
  // contents. A stale batch must be re-cut and revalidated instead of mutated after assembly.
  const provenanceSha = headSha;
  const listed = await repo.git(["rev-list", "--parents", "-n", "1", provenanceSha]);
  const parents = listed.stdout.trim().split(/\s+/u).slice(1);
  if (parents.length !== 1) {
    throw invalid("No merge may be added after broker assembly. Re-cut the batch with `batch refresh`.");
  }
  const parentSha = parents[0]!;
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

  return {
    batchId,
    manifestPath,
    manifest,
    provenanceSha,
    parentSha,
    taskIds,
    authenticated,
    ...(authenticated && publicKey ? { signatureKeyId: provenanceKeyId(publicKey) } : {}),
  };
}
