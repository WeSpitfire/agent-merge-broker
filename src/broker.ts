import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { BrokerError, CommandError, ValidationError } from "./errors.js";
import {
  GitRepository,
  isHostQualifiedForgeRepository,
  remoteUrlFingerprint,
} from "./git.js";
import { initializeConfig, loadConfig, writeConfig } from "./config.js";
import {
  applyBootstrapPlan,
  detectBootstrapPlan,
  hasAgentContract,
  installAgentContract,
  type AgentContractResult,
  type BootstrapPlan,
} from "./bootstrap.js";
import { patternSetsMayOverlap, unexpectedPaths } from "./patterns.js";
import { scheduleTasks } from "./scheduler.js";
import { StateStore, type AuditRecorder, type LockStatus } from "./store.js";
import {
  createValidationCacheDirectory,
  removeValidationCacheDirectory,
  runValidators,
} from "./validation.js";
import { nativeArchitecture, runCommand } from "./process.js";
import {
  githubCliPublisher,
  type ForgePublisher,
} from "./publisher.js";
import {
  buildBatchProvenance,
  provenanceKeyId,
  provenancePath,
  publicKeyFromPrivate,
  signBatchProvenance,
} from "./provenance.js";
import { installHooks, uninstallHooks, type HookInstallation } from "./hooks.js";
import { LocalRefSubmissionManager } from "./submission.js";
import {
  assertGateAuthorityMatchesCurrentConfig,
  deriveGateAuthorityRegistration,
  GateAuthorityStore,
} from "./gate-authority.js";
import {
  currentServicePlatform,
  installService,
  SERVICE_MARKER,
  serviceFilePath,
  serviceName,
  uninstallService,
  type ServiceInstallation,
} from "./service.js";
import type {
  BatchRecord,
  CandidateRecord,
  CandidateRevisionIntent,
  BrokerConfig,
  BrokerState,
  CommitReceipt,
  CurrentBrokerState,
  GateAuthorityRegistration,
  IntegrationOptions,
  IntegrationResult,
  LocalValidationResult,
  RefreshResult,
  RevisionResult,
  RecoveryResult,
  PruneOptions,
  PruneResult,
  SchedulePlan,
  SubmissionRecord,
  TaskRecord,
  ValidationResult,
  VerificationEvidence,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createToken(): string {
  return randomBytes(24).toString("base64url");
}

function versionAtLeast(version: string, minimum: [number, number]): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

function leaseExpired(task: TaskRecord, at = Date.now()): boolean {
  return Boolean(task.lease && Date.parse(task.lease.expiresAt) <= at);
}

function requireTask(state: BrokerState, taskId: string): TaskRecord {
  const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
  if (!task) throw new BrokerError("UNKNOWN_TASK", `Unknown task: ${taskId}`);
  return task;
}

function requireBatch(state: BrokerState, id: string): BatchRecord {
  const batch = Object.hasOwn(state.batches, id) ? state.batches[id] : undefined;
  if (!batch) throw new BrokerError("UNKNOWN_BATCH", `Unknown batch: ${id}`);
  return batch;
}

function sameSubmittedReceipt(current: TaskRecord, selected: TaskRecord): boolean {
  return (
    current.updatedAt === selected.updatedAt &&
    current.submittedAt === selected.submittedAt &&
    current.baseSha === selected.baseSha &&
    JSON.stringify(current.commits) === JSON.stringify(selected.commits) &&
    JSON.stringify(current.actualPaths) === JSON.stringify(selected.actualPaths) &&
    JSON.stringify(current.dependsOn) === JSON.stringify(selected.dependsOn)
  );
}

function assertTaskId(taskId: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u.test(taskId) ||
    new Set(["constructor", "prototype", "__proto__"]).has(taskId)
  ) {
    throw new BrokerError(
      "INVALID_TASK",
      "Task ID must be 1-128 safe identifier characters and cannot be a JavaScript prototype key.",
    );
  }
}

function verifyLease(task: TaskRecord, token: string): void {
  if (!task.lease) throw new BrokerError("LEASE_REQUIRED", `Task ${task.id} does not have an active lease.`);
  if (leaseExpired(task)) throw new BrokerError("LEASE_EXPIRED", `The lease for task ${task.id} has expired.`);
  if (task.lease.tokenHash !== hashToken(token)) {
    throw new BrokerError("LEASE_TOKEN", `Invalid lease token for task ${task.id}.`);
  }
}

function approvalPolicy(config: BrokerConfig): NonNullable<BrokerConfig["approval"]> {
  return config.approval ?? {
    required: false,
    policyRevision: "default",
    requiredVerifications: [],
    requiredChecks: [],
    authorizedActors: [],
  };
}

function requiredEvidenceNames(config: BrokerConfig): string[] {
  const policy = approvalPolicy(config);
  return [
    ...policy.requiredVerifications,
    ...policy.requiredChecks.map((name) => `github-check:${name}`),
  ];
}

function candidateState(candidate: CandidateRecord): CandidateRecord["state"] {
  if (
    candidate.state === "changes_requested" ||
    candidate.state === "blocked" ||
    candidate.state === "superseded" ||
    candidate.state === "abandoned" ||
    candidate.state === "merged"
  ) {
    return candidate.state;
  }
  const evidence = new Map(candidate.verifications.map((item) => [item.name, item]));
  if (candidate.requiredVerifications.some((name) => evidence.get(name)?.status === "failed")) {
    return "verification_failed";
  }
  if (candidate.requiredVerifications.every((name) => evidence.get(name)?.status === "passed")) {
    return candidate.approval ? (candidate.state === "merging" ? "merging" : "approved") : "ready_for_approval";
  }
  return "verifying";
}

function makeCandidate(config: BrokerConfig, sha: string, baseSha: string, revision: number): CandidateRecord {
  const policy = approvalPolicy(config);
  const candidate: CandidateRecord = {
    revision,
    sha,
    baseSha,
    policyRevision: policy.policyRevision,
    state: "verifying",
    requiredVerifications: requiredEvidenceNames(config),
    verifications: [],
    createdAt: now(),
  };
  candidate.state = candidateState(candidate);
  return candidate;
}

function requireCurrentCandidate(batch: BatchRecord): CandidateRecord {
  if (!batch.candidate) {
    throw new BrokerError("NO_CANDIDATE", `Batch ${batch.id} has no approval candidate.`);
  }
  return batch.candidate;
}

function assertNoPendingRevision(batch: BatchRecord): void {
  if (batch.revisionIntent) {
    throw new BrokerError(
      "REVISION_IN_PROGRESS",
      `Batch ${batch.id} has a candidate revision awaiting recovery; retry after recovery completes.`,
      { batchId: batch.id, candidateSha: batch.revisionIntent.candidateSha },
    );
  }
}

function finalizeCandidateRevision(
  state: BrokerState,
  audit: AuditRecorder,
  batchId: string,
  intent: CandidateRevisionIntent,
): RevisionResult {
  const storedBatch = requireBatch(state, batchId);
  const storedIntent = storedBatch.revisionIntent;
  if (
    !storedIntent ||
    storedIntent.candidateSha !== intent.candidateSha ||
    storedIntent.previousCandidateSha !== intent.previousCandidateSha
  ) {
    throw new BrokerError("REVISION_INTENT_CHANGED", `Candidate revision intent changed for batch ${batchId}.`);
  }
  const storedCandidate = requireCurrentCandidate(storedBatch);
  if (
    storedCandidate.sha !== intent.previousCandidateSha ||
    storedCandidate.state !== "changes_requested"
  ) {
    throw new BrokerError("CANDIDATE_CHANGED", "Candidate state changed while its revision was published.");
  }
  const superseded: CandidateRecord = {
    ...structuredClone(storedCandidate),
    state: "superseded",
    reason: `Superseded by candidate revision ${intent.revision}.`,
  };
  const nextBatch = structuredClone(intent.nextBatch) as BatchRecord;
  nextBatch.candidateHistory = [...(storedBatch.candidateHistory ?? []), superseded];
  delete nextBatch.revisionIntent;
  state.batches[batchId] = nextBatch;

  const nextTask = requireTask(state, intent.taskId);
  const actor = nextTask.lease?.holder;
  nextTask.commits = [...intent.revisedTask.commits];
  nextTask.actualPaths = [...intent.revisedTask.actualPaths];
  nextTask.warnings = [...intent.revisedTask.warnings];
  nextTask.submittedAt = intent.revisedTask.submittedAt;
  nextTask.updatedAt = now();
  delete nextTask.lease;
  delete nextTask.lastError;
  for (const id of nextBatch.taskIds) {
    const batchTask = requireTask(state, id);
    batchTask.validations = nextBatch.validations.filter(
      (result) => !result.taskId || result.taskId === id,
    );
    batchTask.updatedAt = now();
  }
  audit("batch.candidate_revised", {
    ...(actor ? { actor } : {}),
    taskId: intent.taskId,
    batchId,
    details: {
      previousCandidateSha: intent.previousCandidateSha,
      candidateSha: intent.candidateSha,
      previousBaseSha: superseded.baseSha,
      baseSha: nextBatch.candidate?.baseSha,
      revision: intent.revision,
    },
  });
  return {
    batch: structuredClone(nextBatch),
    task: structuredClone(nextTask),
    previousCandidate: superseded,
  };
}

function assertCandidateBinding(
  candidate: CandidateRecord,
  binding: { candidateSha: string; baseSha: string; policyRevision?: string },
): void {
  const policyRevision = binding.policyRevision ?? candidate.policyRevision;
  if (
    binding.candidateSha !== candidate.sha ||
    binding.baseSha !== candidate.baseSha ||
    policyRevision !== candidate.policyRevision
  ) {
    throw new BrokerError(
      "CANDIDATE_MISMATCH",
      "The supplied candidate SHA, base SHA, or policy revision does not match the current candidate.",
      {
        expected: {
          candidateSha: candidate.sha,
          baseSha: candidate.baseSha,
          policyRevision: candidate.policyRevision,
        },
        supplied: { ...binding, policyRevision },
      },
    );
  }
}

function assertCurrentApprovalPolicy(config: BrokerConfig, candidate: CandidateRecord): void {
  const policy = approvalPolicy(config);
  const required = requiredEvidenceNames(config);
  const approvalActorCurrent =
    !candidate.approval ||
    policy.authorizedActors.length === 0 ||
    policy.authorizedActors.includes(candidate.approval.actor);
  if (
    candidate.policyRevision !== policy.policyRevision ||
    candidate.requiredVerifications.length !== required.length ||
    candidate.requiredVerifications.some((name) => !required.includes(name)) ||
    !approvalActorCurrent
  ) {
    throw new BrokerError(
      "CANDIDATE_POLICY_STALE",
      "The approval policy changed after this candidate was assembled. Rebuild it before verification or approval.",
      {
        candidatePolicyRevision: candidate.policyRevision,
        currentPolicyRevision: policy.policyRevision,
        candidateRequiredVerifications: candidate.requiredVerifications,
        currentRequiredVerifications: required,
        candidateApprover: candidate.approval?.actor,
        currentAuthorizedActors: policy.authorizedActors,
      },
    );
  }
}

function upsertEvidence(candidate: CandidateRecord, evidence: VerificationEvidence): void {
  candidate.verifications = candidate.verifications.filter((item) => item.name !== evidence.name);
  candidate.verifications.push(evidence);
  candidate.state = candidateState(candidate);
  delete candidate.reason;
}

/**
 * Editing leases are coordinated on declared globs, before any commit exists. Two glob languages
 * cannot always be proven disjoint cheaply, so overlap is treated conservatively as a conflict.
 */
function assertNoLeaseConflict(
  state: BrokerState,
  taskId: string,
  expectedPaths: string[],
  serializedPatterns: string[],
): void {
  for (const existing of Object.values(state.tasks)) {
    if (existing.id === taskId || !existing.lease || leaseExpired(existing)) continue;
    if (patternSetsMayOverlap(expectedPaths, existing.expectedPaths)) {
      throw new BrokerError(
        "LEASE_CONFLICT",
        `Expected paths overlap active task ${existing.id}, leased by ${existing.lease.holder}.`,
        { conflictingTask: existing.id },
      );
    }
    const resources = serializedPatterns.filter((resource) => patternSetsMayOverlap(expectedPaths, [resource]));
    const existingResources = serializedPatterns.filter((resource) =>
      patternSetsMayOverlap(existing.expectedPaths, [resource]),
    );
    const sharedResource = resources.find((resource) => existingResources.includes(resource));
    if (sharedResource) {
      throw new BrokerError("LEASE_CONFLICT", `Serialized resource ${sharedResource} is leased by task ${existing.id}.`, {
        conflictingTask: existing.id,
        resource: sharedResource,
      });
    }
  }
}

function batchId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function cleanBranchFragment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._/-]/gu, "-").replace(/\.{2,}/gu, ".");
  return cleaned.replace(/^[-./]+/u, "") || "merge-broker/batch";
}

function errorMessage(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (error instanceof CommandError) return `${error.message}\n${error.stderr.trim()}`.trim();
  return error instanceof Error ? error.message : String(error);
}

function validationResultsFromError(error: unknown): ValidationResult[] {
  if (!(error instanceof ValidationError)) return [];
  const results = error.details?.completedValidations;
  return Array.isArray(results) ? (results as ValidationResult[]) : [];
}

const PRUNABLE_TASK_STATUSES = new Set<TaskRecord["status"]>(["merged", "cancelled"]);
const PRUNABLE_BATCH_STATUSES = new Set<BatchRecord["status"]>(["merged", "closed", "failed"]);

/**
 * Local validation belongs to no batch. The validator contract still promises MERGE_BROKER_BATCH_ID,
 * so it gets a reserved value a command can recognise rather than an empty string it cannot.
 */
const LOCAL_VALIDATION_BATCH_ID = "local";

/**
 * Every status whose commits no batch has read yet. A worker holding the lease may keep revising
 * its receipt across all of them.
 */
const SUBMITTABLE_STATUSES = new Set<TaskRecord["status"]>(["claimed", "failed", "submitted"]);

/**
 * The state machine is invisible from the outside, so a refusal that only names the current status
 * leaves the worker guessing which of a dozen subcommands moves it. Each refusal names the command
 * that does.
 */
function recoveryHint(status: TaskRecord["status"]): string {
  switch (status) {
    case "integrating":
      return "It is being integrated right now; wait for the batch to finish, then act on the result.";
    case "batched":
    case "published":
      return "Its batch is already assembled. Land or close that batch, then start a new task for further work.";
    case "merged":
      return "It is already merged. Start a new task for further work.";
    case "cancelled":
      return "It was cancelled, which is final. Start a new task with `task claim`.";
    case "registered":
      return "Acquire a lease first with `task claim`.";
    default:
      return "";
  }
}

function taskRetiredAt(task: TaskRecord): number {
  return Date.parse(task.mergedAt ?? task.updatedAt);
}

function batchRetiredAt(batch: BatchRecord): number {
  return Date.parse(batch.finishedAt ?? batch.closedAt ?? batch.createdAt);
}

/**
 * Chooses completed records that are safe to retire. An unparsable timestamp compares false and so
 * keeps the record: forgetting work is worse than keeping it a while longer.
 */
function selectPrunable(
  state: BrokerState,
  cutoffMs: number,
): { tasks: string[]; batches: string[]; retainedForDependencies: string[] } {
  const candidateIds = new Set(
    Object.values(state.tasks)
      .filter((task) => PRUNABLE_TASK_STATUSES.has(task.status) && taskRetiredAt(task) <= cutoffMs)
      .map((task) => task.id),
  );

  // Removing a task that a retained task still depends on would strand the dependent forever: the
  // scheduler cannot distinguish a pruned dependency from one that has never merged.
  const retainedForDependencies = new Set<string>();
  for (const task of Object.values(state.tasks)) {
    if (candidateIds.has(task.id)) continue;
    for (const dependency of task.dependsOn) {
      if (candidateIds.has(dependency)) retainedForDependencies.add(dependency);
    }
  }
  for (const id of retainedForDependencies) candidateIds.delete(id);

  const batchIds = new Set(
    Object.values(state.batches)
      .filter((batch) => PRUNABLE_BATCH_STATUSES.has(batch.status) && batchRetiredAt(batch) <= cutoffMs)
      // A batch whose tasks are staying would become an orphaned reference; retire the two together.
      .filter((batch) => batch.taskIds.every((id) => candidateIds.has(id) || !Object.hasOwn(state.tasks, id)))
      .map((batch) => batch.id),
  );
  const tasks = [...candidateIds].filter((id) => {
    const batchId = state.tasks[id]?.batchId;
    return !batchId || batchIds.has(batchId) || !Object.hasOwn(state.batches, batchId);
  });

  return {
    tasks: tasks.sort(),
    batches: [...batchIds].sort(),
    retainedForDependencies: [...retainedForDependencies].sort(),
  };
}

export interface RegisterTaskInput {
  id: string;
  title?: string;
  agent?: string;
  base?: string;
  expectedPaths?: string[];
  dependsOn?: string[];
  priority?: number;
  worktree?: string;
}

export interface ClaimTaskInput extends RegisterTaskInput {
  holder: string;
  /** Set false to keep the token out of broker state entirely and handle custody elsewhere. */
  storeToken?: boolean;
  /** Write the token here instead of the default location inside the broker state directory. */
  tokenFile?: string;
}

export interface AdoptCandidateInput {
  /** Repository-local ref or full commit ID. The broker resolves and retains the exact commit. */
  ref: string;
}

export interface RegisterCandidateAuthorityOptions {
  /** Replace a different registered target only after the caller has reviewed that authority change. */
  replace?: boolean;
}

export class MergeBroker {
  readonly repo: GitRepository;
  readonly config: BrokerConfig;
  readonly store: StateStore;
  readonly publisher: ForgePublisher;

  private constructor(
    repo: GitRepository,
    config: BrokerConfig,
    store: StateStore,
    publisher: ForgePublisher,
  ) {
    this.repo = repo;
    this.config = config;
    this.store = store;
    this.publisher = publisher;
  }

  static async open(
    cwd = process.cwd(),
    options: { publisher?: ForgePublisher } = {},
  ): Promise<MergeBroker> {
    const repo = await GitRepository.discover(cwd);
    const config = await loadConfig(repo.root);
    const store = new StateStore(repo.commonGitDir, config.stateDirectory, config.leases.lockTimeoutSeconds);
    await store.initialize();
    return new MergeBroker(repo, config, store, options.publisher ?? githubCliPublisher);
  }

  static async initialize(
    cwd = process.cwd(),
    options: {
      baseBranch?: string;
      baseRef?: string;
      remote?: string;
      force?: boolean;
      detect?: boolean;
      agentContract?: boolean;
    } = {},
  ): Promise<{
    repoRoot: string;
    configPath: string;
    created: boolean;
    updated: boolean;
    operational: boolean;
    signingConfigured: boolean;
    bootstrap?: BootstrapPlan;
    agentContract?: AgentContractResult;
  }> {
    const repo = await GitRepository.discover(cwd);
    const initialized = await initializeConfig(repo.root, options);
    const store = new StateStore(
      repo.commonGitDir,
      initialized.config.stateDirectory,
      initialized.config.leases.lockTimeoutSeconds,
    );
    await store.initialize();
    let configChanged = false;
    const bootstrap = options.detect === false ? undefined : await detectBootstrapPlan(repo.root);
    if (bootstrap) configChanged = applyBootstrapPlan(initialized.config, bootstrap) || configChanged;
    const provenance = initialized.config.integration.provenance;
    if (provenance?.enabled && (!provenance.requireSignature || !provenance.publicKey)) {
      const identity = await store.provisionProvenanceSigningKey();
      provenance.requireSignature = true;
      provenance.publicKey = identity.publicKey;
      configChanged = true;
    }
    if (configChanged) await writeConfig(repo.root, initialized.config);
    const agentContract = options.agentContract === false ? undefined : await installAgentContract(repo.root);
    const validationReady = initialized.config.validation.authority === "required-ci"
      || initialized.config.validation.authoritative.length > 0;
    const signingConfigured = Boolean(
      !provenance?.enabled || (provenance.requireSignature && provenance.publicKey),
    );
    return {
      repoRoot: repo.root,
      configPath: initialized.path,
      created: initialized.created,
      updated: !initialized.created && (configChanged || Boolean(agentContract?.changed)),
      operational: validationReady && signingConfigured
        && (options.agentContract === false || Boolean(agentContract)),
      signingConfigured,
      ...(bootstrap ? { bootstrap } : {}),
      ...(agentContract ? { agentContract } : {}),
    };
  }

  /**
   * Enables authenticated provenance for an existing repository or rotates/imports its identity.
   * The private key stays in Git's runtime state; configuration receives only the public key.
   */
  async setupProvenanceSigning(options: {
    privateKeyFile?: string;
    rotate?: boolean;
  } = {}): Promise<{ publicKey: string; keyId: string; keyPath: string }> {
    const privateKey = options.privateKeyFile
      ? await readFile(path.resolve(options.privateKeyFile), "utf8")
      : undefined;
    const identity = await this.store.provisionProvenanceSigningKey({
      ...(privateKey ? { privateKey } : {}),
      rotate: options.rotate ?? false,
    });
    this.config.integration.provenance ??= {
      enabled: true,
      directory: ".merge-broker/attestations",
    };
    this.config.integration.provenance.enabled = true;
    this.config.integration.provenance.requireSignature = true;
    this.config.integration.provenance.publicKey = identity.publicKey;
    await writeConfig(this.repo.root, this.config);
    return identity;
  }

  private async provenanceSigningPrivateKey(): Promise<string | undefined> {
    const provenance = this.config.integration.provenance;
    if (!provenance?.enabled || !provenance.publicKey) {
      if (provenance?.requireSignature) {
        throw new BrokerError(
          "SIGNING_KEY_REQUIRED",
          "Signed provenance is required, but configuration has no trusted public key. Run `merge-broker provenance setup-signing`.",
        );
      }
      return undefined;
    }

    const fromEnvironment = process.env.MERGE_BROKER_SIGNING_KEY;
    const fromFile = process.env.MERGE_BROKER_SIGNING_KEY_FILE
      ? await readFile(path.resolve(process.env.MERGE_BROKER_SIGNING_KEY_FILE), "utf8")
      : undefined;
    const privateKey =
      fromEnvironment ?? fromFile ?? (await this.store.readProvenanceSigningKey(provenance.publicKey));
    if (!privateKey) {
      if (!provenance.requireSignature) return undefined;
      throw new BrokerError(
        "SIGNING_KEY_REQUIRED",
        `Signed provenance is required, but the private key is unavailable. Restore ${this.store.provenanceSigningKeyFile}, set MERGE_BROKER_SIGNING_KEY_FILE, or import it with \`merge-broker provenance setup-signing --private-key <path>\`.`,
      );
    }
    const expectedKeyId = provenanceKeyId(provenance.publicKey);
    const actualKeyId = provenanceKeyId(publicKeyFromPrivate(privateKey));
    if (expectedKeyId !== actualKeyId) {
      throw new BrokerError(
        "SIGNING_KEY_MISMATCH",
        "The available provenance private key does not match the public key committed in configuration.",
        { expectedKeyId, actualKeyId },
      );
    }
    return privateKey;
  }

  /**
   * Resolves the exact base used for a new merge candidate. The generated configuration names the
   * local branch for repositories that have no remote, but once refresh succeeds that local ref is
   * not the refreshed value; the remote-tracking branch is. Publication fails closed when the
   * requested refresh cannot be performed.
   */
  private async currentIntegrationBaseSha(boundRemoteUrl?: string): Promise<string> {
    let baseRef = this.config.baseRef;
    if (this.config.integration.refreshBase) {
      if (boundRemoteUrl) {
        const targetSha = await this.repo.fetchBranchHead(boundRemoteUrl, this.config.baseBranch);
        if (!targetSha) {
          throw new BrokerError(
            "BASE_REFRESH_FAILED",
            `Could not refresh ${this.config.remote}/${this.config.baseBranch}; refusing to assemble a publishable batch from stale state.`,
          );
        }
        if (
          baseRef === this.config.baseBranch ||
          baseRef === `${this.config.remote}/${this.config.baseBranch}`
        ) {
          return targetSha;
        }
      }
      const fetched = await this.repo.fetchBranch(this.config.remote, this.config.baseBranch);
      if (fetched && baseRef === this.config.baseBranch) {
        baseRef = `${this.config.remote}/${this.config.baseBranch}`;
      }
    }
    return await this.repo.resolveCommit(baseRef);
  }

  /** Resolve the current tip of the immutable forge target recorded on an existing batch. */
  private async currentBatchTargetSha(batch: BatchRecord): Promise<string> {
    const remoteName = batch.remote ?? this.config.remote;
    const remote = await this.repo.boundRemoteUrl(remoteName, batch.remoteUrlFingerprint);
    const targetSha = await this.repo.fetchBranchHead(remote, batch.baseBranch);
    if (!targetSha) {
      throw new BrokerError(
        "BASE_REFRESH_FAILED",
        `Could not refresh ${remoteName}/${batch.baseBranch}; refusing to rebuild an existing batch against a different or stale target.`,
      );
    }
    return targetSha;
  }

  private async assertBatchBaseFresh(batch: BatchRecord): Promise<void> {
    if (!this.config.integration.refreshBase) return;
    const remoteName = batch.remote ?? this.config.remote;
    const remote = await this.repo.boundRemoteUrl(remoteName, batch.remoteUrlFingerprint);
    const remoteBase = await this.repo.fetchBranchHead(remote, batch.baseBranch);
    if (!remoteBase) {
      throw new BrokerError(
        "BASE_REFRESH_FAILED",
        `Could not refresh ${remoteName}/${batch.baseBranch}; refusing to publish from a potentially stale base.`,
      );
    }
    if (remoteBase !== batch.baseSha) {
      throw new BrokerError(
        "BATCH_BASE_STALE",
        `Batch ${batch.id} was validated on ${batch.baseSha}, but ${remoteName}/${batch.baseBranch} is now ${remoteBase}. Refresh the batch before publication.`,
        { batchId: batch.id, batchBaseSha: batch.baseSha, remoteBaseSha: remoteBase },
      );
    }
  }

  /**
   * GitHub can report the target branch's newer tip as `baseRefOid` after a merge. In that case,
   * prove from Git itself that the recorded merge commit landed the approved candidate tree on a
   * history rooted at the approved base. A transient inability to fetch is retryable; a graph/tree
   * mismatch is an authorization failure.
   */
  private async proveMergedCandidate(
    batch: BatchRecord,
    candidate: Pick<CandidateRecord, "sha" | "baseSha">,
    mergeCommitSha: string | undefined,
  ): Promise<boolean> {
    if (!mergeCommitSha) return false;
    if (!batch.remoteUrlFingerprint) {
      throw new BrokerError(
        "BATCH_TARGET_UNBOUND",
        `Batch ${batch.id} predates durable remote binding, so a changed-base merge cannot be proven automatically.`,
      );
    }
    const remoteName = batch.remote ?? this.config.remote;
    const remote = await this.repo.boundRemoteUrl(remoteName, batch.remoteUrlFingerprint);
    const targetSha = await this.repo.fetchBranchHead(remote, batch.baseBranch);
    if (!targetSha) {
      throw new BrokerError(
        "MERGE_PROOF_UNAVAILABLE",
        `Could not fetch ${remoteName}/${batch.baseBranch} to verify merged candidate ${candidate.sha}.`,
      );
    }
    const targetRef = targetSha;
    const [
      mergeExists,
      onTarget,
      baseAncestor,
      candidateBaseAncestor,
      mergeTree,
      candidateTree,
      parents,
      candidateHistory,
      mergedHistory,
    ] =
      await Promise.all([
        this.repo.git(["cat-file", "-e", `${mergeCommitSha}^{commit}`], this.repo.root, true),
        this.repo.git(["merge-base", "--is-ancestor", mergeCommitSha, targetRef], this.repo.root, true),
        this.repo.git(["merge-base", "--is-ancestor", candidate.baseSha, mergeCommitSha], this.repo.root, true),
        this.repo.git(["merge-base", "--is-ancestor", candidate.baseSha, candidate.sha], this.repo.root, true),
        this.repo.git(["rev-parse", `${mergeCommitSha}^{tree}`], this.repo.root, true),
        this.repo.git(["rev-parse", `${candidate.sha}^{tree}`], this.repo.root, true),
        this.repo.git(["rev-list", "--parents", "-n", "1", mergeCommitSha], this.repo.root, true),
        this.repo.git(["rev-list", "--reverse", "--first-parent", `${candidate.baseSha}..${candidate.sha}`], this.repo.root, true),
        this.repo.git(["rev-list", "--reverse", "--first-parent", `${candidate.baseSha}..${mergeCommitSha}`], this.repo.root, true),
      ]);
    if (
      mergeExists.exitCode !== 0 ||
      onTarget.exitCode !== 0 ||
      baseAncestor.exitCode !== 0 ||
      candidateBaseAncestor.exitCode !== 0 ||
      mergeTree.exitCode !== 0 ||
      candidateTree.exitCode !== 0 ||
      mergeTree.stdout.trim() !== candidateTree.stdout.trim()
    ) {
      return false;
    }
    // Fast-forward preserves the candidate commit itself.
    if (mergeCommitSha === candidate.sha) return true;
    const mergeParents = parents.exitCode === 0
      ? parents.stdout.trim().split(/\s+/u).slice(1)
      : [];
    // A squash has the exact base as its only parent. A merge commit has that base as first parent
    // and the validated candidate as another parent. Merely mentioning the base somewhere in an
    // unrelated merge is not enough.
    if (mergeParents[0] === candidate.baseSha) {
      if (mergeParents.length === 1) return true;
      return mergeParents.length === 2 && mergeParents[1] === candidate.sha;
    }
    if (candidateHistory.exitCode !== 0 || mergedHistory.exitCode !== 0) return false;

    // GitHub's rebase method creates new commit IDs. Prove that the entire first-parent sequence
    // from the recorded base visits the same trees as the validated candidate, in the same order.
    // A count alone is unsafe: unrelated commits can have the same length and end at a forged tree.
    const commits = (output: string): string[] => output.split("\n").map((item) => item.trim()).filter(Boolean);
    const expectedCommits = commits(candidateHistory.stdout);
    const actualCommits = commits(mergedHistory.stdout);
    if (expectedCommits.length === 0 || expectedCommits.length !== actualCommits.length) return false;
    const [expectedTrees, actualTrees, expectedParentCounts, actualParentCounts] = await Promise.all([
      Promise.all(expectedCommits.map(async (commit) =>
        await this.repo.git(["rev-parse", `${commit}^{tree}`], this.repo.root, true))),
      Promise.all(actualCommits.map(async (commit) =>
        await this.repo.git(["rev-parse", `${commit}^{tree}`], this.repo.root, true))),
      Promise.all(expectedCommits.map(async (commit) => await this.repo.parentCount(commit))),
      Promise.all(actualCommits.map(async (commit) => await this.repo.parentCount(commit))),
    ]);
    return expectedTrees.every((tree, index) =>
      tree.exitCode === 0 &&
      actualTrees[index]?.exitCode === 0 &&
      expectedParentCounts[index] === 1 &&
      actualParentCounts[index] === 1 &&
      tree.stdout.trim() === actualTrees[index]?.stdout.trim());
  }

  async registerTask(input: RegisterTaskInput): Promise<TaskRecord> {
    assertTaskId(input.id);
    if (input.priority !== undefined && !Number.isInteger(input.priority)) {
      throw new BrokerError("INVALID_TASK", "Task priority must be an integer.");
    }
    const baseSha = await this.repo.resolveCommit(input.base ?? this.config.baseRef);
    const timestamp = now();
    return await this.store.transaction((state, audit) => {
      if (Object.hasOwn(state.tasks, input.id)) throw new BrokerError("TASK_EXISTS", `Task already exists: ${input.id}`);
      const task: TaskRecord = {
        id: input.id,
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        status: "registered",
        priority: input.priority ?? 0,
        baseSha,
        expectedPaths: input.expectedPaths ?? [],
        actualPaths: [],
        dependsOn: [...new Set(input.dependsOn ?? [])],
        commits: [],
        ...(input.worktree ? { worktree: path.resolve(input.worktree) } : {}),
        warnings: [],
        validations: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.tasks[task.id] = task;
      audit("task.registered", { ...(input.agent ? { actor: input.agent } : {}), taskId: task.id });
      return structuredClone(task);
    });
  }

  async claimTask(input: ClaimTaskInput): Promise<{ task: TaskRecord; token: string; tokenPath?: string }> {
    assertTaskId(input.id);
    if (input.priority !== undefined && !Number.isInteger(input.priority)) {
      throw new BrokerError("INVALID_TASK", "Task priority must be an integer.");
    }
    const token = createToken();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.config.leases.ttlSeconds * 1_000).toISOString();
    const defaultBase = await this.repo.resolveCommit(input.base ?? this.config.baseRef);
    const claimed = await this.store.transaction((state, audit) => {
      let task = Object.hasOwn(state.tasks, input.id) ? state.tasks[input.id] : undefined;
      if (!task) {
        task = {
          id: input.id,
          ...(input.title ? { title: input.title } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          status: "registered",
          priority: input.priority ?? 0,
          baseSha: defaultBase,
          expectedPaths: input.expectedPaths ?? [],
          actualPaths: [],
          dependsOn: [...new Set(input.dependsOn ?? [])],
          commits: [],
          ...(input.worktree ? { worktree: path.resolve(input.worktree) } : {}),
          warnings: [],
          validations: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.tasks[input.id] = task;
        audit("task.registered", { actor: input.holder, taskId: task.id });
      } else if (!new Set<TaskRecord["status"]>(["registered", "claimed", "failed"]).has(task.status)) {
        throw new BrokerError(
          "TASK_NOT_CLAIMABLE",
          `Task ${task.id} cannot be claimed while ${task.status}. ${recoveryHint(task.status)}`,
        );
      }
      if (task.lease && !leaseExpired(task)) {
        throw new BrokerError("LEASE_CONFLICT", `Task ${task.id} is already leased by ${task.lease.holder}.`);
      }

      const expectedPaths = input.expectedPaths ?? task.expectedPaths;
      if (expectedPaths.length === 0) {
        throw new BrokerError("PATHS_REQUIRED", "At least one expected path pattern is required to claim a task.");
      }
      assertNoLeaseConflict(state, task.id, expectedPaths, this.config.leases.serializedPatterns);

      task.expectedPaths = [...new Set(expectedPaths)];
      task.dependsOn = [...new Set(input.dependsOn ?? task.dependsOn)];
      task.priority = input.priority ?? task.priority;
      if (input.title) task.title = input.title;
      if (input.agent) task.agent = input.agent;
      if (input.worktree) task.worktree = path.resolve(input.worktree);
      task.status = "claimed";
      task.lease = {
        tokenHash: hashToken(token),
        holder: input.holder,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt,
      };
      task.updatedAt = timestamp;
      delete task.lastError;
      audit("task.claimed", { actor: input.holder, taskId: task.id, details: { expiresAt } });
      return { task: structuredClone(task), token };
    });
    if (input.storeToken === false) return claimed;
    // A token written outside the default location is the caller's to supply again later; the
    // automatic lookup only knows the default path.
    const target = input.tokenFile ? path.resolve(input.tokenFile) : this.store.tokenPath(claimed.task.id);
    const tokenPath = await this.store.writeToken(claimed.task.id, token, target);
    return { ...claimed, tokenPath };
  }

  async heartbeat(taskId: string, token: string): Promise<TaskRecord> {
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      verifyLease(task, token);
      const lease = task.lease;
      if (!lease) throw new BrokerError("LEASE_REQUIRED", `Task ${task.id} does not have an active lease.`);
      const timestamp = now();
      task.lease = {
        ...lease,
        heartbeatAt: timestamp,
        expiresAt: new Date(Date.now() + this.config.leases.ttlSeconds * 1_000).toISOString(),
      };
      task.updatedAt = timestamp;
      audit("task.heartbeat", { actor: task.lease.holder, taskId });
      return structuredClone(task);
    });
  }

  async extendTask(taskId: string, expectedPaths: string[], token: string): Promise<TaskRecord> {
    if (expectedPaths.length === 0) {
      throw new BrokerError("PATHS_REQUIRED", "At least one expected path pattern is required to extend a task.");
    }
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      verifyLease(task, token);
      // `failed` is included for the same reason `claim` accepts it: fixing what validation caught
      // often means touching a file the original scope did not cover, and refusing to widen scope
      // exactly when the worker needs it leaves rebuilding the task as the only way forward.
      if (task.status !== "claimed" && task.status !== "failed") {
        throw new BrokerError(
          "TASK_NOT_CLAIMABLE",
          `Task ${task.id} cannot be extended while ${task.status}. ${recoveryHint(task.status)}`,
        );
      }
      const nextPaths = [...new Set([...task.expectedPaths, ...expectedPaths])];
      assertNoLeaseConflict(state, task.id, nextPaths, this.config.leases.serializedPatterns);
      task.expectedPaths = nextPaths;
      task.updatedAt = now();
      audit("task.extended", {
        ...(task.lease?.holder ? { actor: task.lease.holder } : {}),
        taskId,
        details: { expectedPaths: nextPaths },
      });
      return structuredClone(task);
    });
  }

  async releaseTask(taskId: string, token?: string, options: { force?: boolean } = {}): Promise<TaskRecord> {
    const released = await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      // A lease token is shown once. When the holder is gone and its token with it, the integration
      // owner still needs a way to reclaim the scope, so a forced release skips verification and
      // records that it did.
      if (!options.force) {
        if (!token) throw new BrokerError("LEASE_TOKEN", `A lease token is required to release task ${taskId}.`);
        verifyLease(task, token);
      }
      const actor = task.lease?.holder;
      delete task.lease;
      if (task.status === "claimed" || task.status === "failed") task.status = "registered";
      task.updatedAt = now();
      audit("task.released", {
        ...(actor ? { actor } : {}),
        taskId,
        ...(options.force ? { details: { forced: true } } : {}),
      });
      return structuredClone(task);
    });
    await this.store.deleteToken(taskId);
    return released;
  }

  async cancelTask(taskId: string, token?: string, options: { force?: boolean } = {}): Promise<TaskRecord> {
    const cancelled = await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      if (task.lease && !options.force) {
        if (!token) throw new BrokerError("LEASE_TOKEN", `A lease token is required to cancel task ${taskId}.`);
        verifyLease(task, token);
      }
      if (["batched", "published", "merged"].includes(task.status)) {
        throw new BrokerError(
          "TASK_NOT_CANCELLABLE",
          `Task ${taskId} cannot be cancelled while ${task.status}. ${recoveryHint(task.status)}`,
        );
      }
      const revokedFrom = options.force && task.lease ? task.lease.holder : undefined;
      task.status = "cancelled";
      delete task.lease;
      task.updatedAt = now();
      audit("task.cancelled", {
        taskId,
        ...(revokedFrom ? { details: { forced: true, revokedLeaseFrom: revokedFrom } } : {}),
      });
      return structuredClone(task);
    });
    await this.store.deleteToken(taskId);
    return cancelled;
  }

  async retryTask(taskId: string, token?: string): Promise<TaskRecord> {
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      if (task.status !== "failed") {
        throw new BrokerError(
          "TASK_NOT_RETRYABLE",
          `Task ${taskId} cannot be retried while ${task.status}. ${
            task.status === "submitted"
              ? "It is already queued for integration."
              : recoveryHint(task.status)
          }`,
        );
      }
      if (task.lease && !leaseExpired(task)) {
        if (!token) throw new BrokerError("LEASE_TOKEN", `A lease token is required to retry task ${taskId}.`);
        verifyLease(task, token);
      }
      task.status = "submitted";
      delete task.batchId;
      delete task.lastError;
      // An explicit human retry restarts the automatic attempt budget.
      delete task.attempts;
      task.updatedAt = now();
      audit("task.retried", { taskId });
      return structuredClone(task);
    });
  }

  private async resolveTaskCommits(
    snapshot: TaskRecord,
    commits: string[],
    options: { sinceBase?: boolean } = {},
  ): Promise<{ commits: string[]; actualPaths: string[]; warnings: string[] }> {
    if (options.sinceBase) {
      const worktree = snapshot.worktree ?? this.repo.root;
      commits = await this.repo.commitsSinceBase(worktree, snapshot.baseSha);
      if (commits.length === 0) {
        throw new BrokerError(
          "COMMITS_REQUIRED",
          `Task ${snapshot.id} has no commits after its recorded base ${snapshot.baseSha} in ${worktree}.`,
          { worktree, baseSha: snapshot.baseSha },
        );
      }
    }
    if (commits.length === 0) throw new BrokerError("COMMITS_REQUIRED", "At least one commit is required.");
    if (this.config.policies.requireCleanWorktree && snapshot.worktree && !(await this.repo.isClean(snapshot.worktree))) {
      throw new BrokerError("DIRTY_WORKTREE", `Task worktree is not clean: ${snapshot.worktree}`);
    }
    const resolvedCommits: string[] = [];
    for (const commit of commits) resolvedCommits.push(await this.repo.resolveCommit(commit));
    if (new Set(resolvedCommits).size !== resolvedCommits.length) {
      throw new BrokerError("DUPLICATE_COMMIT", `Task ${snapshot.id} submitted the same commit more than once.`);
    }
    for (const commit of resolvedCommits) {
      if ((await this.repo.parentCount(commit)) > 1) {
        throw new BrokerError(
          "MERGE_COMMIT",
          `Task ${snapshot.id} submitted merge commit ${commit}. Submit focused linear commits instead.`,
        );
      }
      if ((await this.repo.changedFiles(commit)).length === 0) {
        throw new BrokerError("EMPTY_COMMIT", `Task ${snapshot.id} submitted empty commit ${commit}.`);
      }
    }
    const actualPaths = await this.repo.changedFilesForCommits(resolvedCommits);
    const outsideScope = unexpectedPaths(actualPaths, snapshot.expectedPaths);
    if (outsideScope.length > 0 && this.config.policies.unexpectedPaths === "error") {
      throw new BrokerError("UNEXPECTED_PATHS", `Task ${snapshot.id} changed files outside its declared scope.`, {
        unexpectedPaths: outsideScope,
      });
    }
    return {
      commits: resolvedCommits,
      actualPaths,
      warnings:
        outsideScope.length > 0 && this.config.policies.unexpectedPaths === "warn"
          ? [`Changed outside expected paths: ${outsideScope.join(", ")}`]
          : [],
    };
  }

  async submitTask(
    taskId: string,
    commits: string[],
    token: string,
    options: { sinceBase?: boolean } = {},
  ): Promise<{ task: TaskRecord; receiptPath: string }> {
    assertTaskId(taskId);
    const snapshot = requireTask(await this.store.read(), taskId);
    // Status before lease, and before any Git work. Batching ends the lease, so a worker resubmitting
    // after its batch was assembled would otherwise be told only that it holds no lease -- true, but
    // not the reason, and not something reacquiring a lease can fix. Status is already public through
    // `task show`, so answering with it first reveals nothing authorization was hiding.
    if (!SUBMITTABLE_STATUSES.has(snapshot.status)) {
      throw new BrokerError(
        "TASK_NOT_SUBMITTABLE",
        `Task ${taskId} cannot be submitted while ${snapshot.status}. ${recoveryHint(snapshot.status)}`,
      );
    }
    verifyLease(snapshot, token);
    const resolved = await this.resolveTaskCommits(snapshot, commits, options);
    const resolvedCommits = resolved.commits;
    const actualPaths = resolved.actualPaths;
    const timestamp = now();
    const task = await this.store.transaction((state, audit) => {
      const current = requireTask(state, taskId);
      // Checked before the lease deliberately. Batching ends the lease, so a worker resubmitting
      // after its batch was assembled would otherwise be told only that it holds no lease -- true,
      // but not the reason, and not something reacquiring a lease can fix. Status is already public
      // through `task show`, so answering with it first reveals nothing authorization was hiding.
      if (!SUBMITTABLE_STATUSES.has(current.status)) {
        throw new BrokerError(
          "TASK_NOT_SUBMITTABLE",
          `Task ${taskId} cannot be submitted while ${current.status}. ${recoveryHint(current.status)}`,
        );
      }
      verifyLease(current, token);
      // Resubmitting while `submitted` replaces the receipt. Nothing downstream has read it yet —
      // integration moves a task to `integrating` and batching to `batched`, neither of which is
      // accepted here — so the only thing a refusal protects is the worker's own earlier list of
      // commits. Refusing it made "I need one more commit" unrecoverable: the sole remaining lever
      // was `cancel`, which is terminal and drops the lease, so a one-commit follow-up cost a whole
      // new branch. A worker holding the lease may revise its own unread work.
      const resubmitted = current.status === "submitted";
      current.commits = resolvedCommits;
      current.actualPaths = actualPaths;
      current.warnings = resolved.warnings;
      if (current.dependsOn.includes(current.id)) {
        throw new BrokerError("DEPENDENCY_CYCLE", `Task ${current.id} cannot depend on itself.`);
      }
      if (this.config.policies.requireDependencies) {
        const unknownDependencies = current.dependsOn.filter((dependency) => !Object.hasOwn(state.tasks, dependency));
        if (unknownDependencies.length > 0) {
          throw new BrokerError(
            "UNKNOWN_DEPENDENCY",
            `Task ${current.id} has unknown dependencies: ${unknownDependencies.join(", ")}`,
          );
        }
      }
      current.status = "submitted";
      current.submittedAt = timestamp;
      current.updatedAt = timestamp;
      delete current.lastError;
      audit("task.submitted", {
        ...(current.lease?.holder ? { actor: current.lease.holder } : {}),
        taskId,
        details: { commits: resolvedCommits, actualPaths, warnings: current.warnings, ...(resubmitted ? { resubmitted: true } : {}) },
      });
      return structuredClone(current);
    });
    const receipt: CommitReceipt = {
      version: 1,
      taskId: task.id,
      ...(task.agent ? { agent: task.agent } : {}),
      baseSha: task.baseSha,
      commits: task.commits,
      expectedPaths: task.expectedPaths,
      actualPaths: task.actualPaths,
      dependsOn: task.dependsOn,
      ...(task.worktree ? { worktree: task.worktree } : {}),
      submittedAt: timestamp,
      warnings: task.warnings,
    };
    const receiptPath = await this.store.writeReceipt(receipt);
    return { task, receiptPath };
  }

  async state(): Promise<CurrentBrokerState> {
    return await this.store.read();
  }

  /**
   * Installs the config-independent trust root required for local-ref candidate adoption. Repeating
   * setup for the same locator is idempotent; changing it requires an explicit replacement.
   */
  async registerCandidateAuthority(
    options: RegisterCandidateAuthorityOptions = {},
  ): Promise<GateAuthorityRegistration> {
    // Setup is part of the Gate trust boundary too. Refuse ambient repository/config selectors
    // before deriving or persisting authority, rather than checking them only on later adoption.
    await this.repo.assertGateGitSupported();
    return await this.store.withGateAuthorityLock(async () => {
      const proposed = await deriveGateAuthorityRegistration(this.repo, this.config);
      return await new GateAuthorityStore(this.repo.commonGitDir).register(proposed, options);
    });
  }

  async candidateAuthority(): Promise<GateAuthorityRegistration | undefined> {
    return await new GateAuthorityStore(this.repo.commonGitDir).read();
  }

  /**
   * Adopt and validate one trusted repository-local Git ref without manufacturing Coordinate-mode
   * task, lease, receipt, or batch history. This first Gate slice intentionally stops before
   * approval, publication, and merge authority.
   */
  async adoptCandidate(input: AdoptCandidateInput): Promise<SubmissionRecord> {
    // Check before the fixed lock and remote-fingerprint lookup; the manager repeats the preflight
    // inside its integration transaction so recovery and direct manager use remain fail closed.
    await this.repo.assertGateGitSupported();
    return await this.store.withGateAuthorityLock(async () => {
      const authority = await new GateAuthorityStore(this.repo.commonGitDir).require();
      await assertGateAuthorityMatchesCurrentConfig(authority, this.config, this.repo);
      return await new LocalRefSubmissionManager(this.repo, this.store, authority).adopt(input.ref);
    });
  }

  async submission(id: string): Promise<SubmissionRecord> {
    const state = await this.store.read();
    const submission = Object.hasOwn(state.submissions, id) ? state.submissions[id] : undefined;
    if (!submission) throw new BrokerError("UNKNOWN_SUBMISSION", `Unknown candidate submission: ${id}`);
    return structuredClone(submission);
  }

  async task(taskId: string): Promise<TaskRecord> {
    return structuredClone(requireTask(await this.store.read(), taskId));
  }

  async plan(options: { taskIds?: string[]; maxTasks?: number } = {}): Promise<SchedulePlan> {
    if (options.maxTasks !== undefined && (!Number.isInteger(options.maxTasks) || options.maxTasks <= 0)) {
      throw new BrokerError("INVALID_LIMIT", "maxTasks must be a positive integer.");
    }
    return scheduleTasks(await this.store.read(), this.config, options);
  }

  /**
   * Run the configured validators against a working tree, before anything is submitted.
   *
   * Integration is the only thing that knew what "ready" meant, so every adopter rewrote a cheaper
   * approximation of it for workers to run first -- and an approximation is exactly the thing that
   * passes locally and fails at integration. This runs the same validators from the same
   * configuration, so there is one definition and the pre-flight answer is the real one.
   *
   * Reads state; never writes it. No lease is required, because checking your own work is not a
   * claim on anything.
   */
  async validateWorkingTree(
    options: {
      taskId?: string;
      scope?: "focused" | "authoritative" | "all";
      base?: string;
      files?: string[];
      cwd?: string;
    } = {},
  ): Promise<LocalValidationResult> {
    const scope = options.scope ?? "all";
    const cwd = options.cwd ? path.resolve(options.cwd) : this.repo.root;
    const baseRef = options.base ?? this.config.baseRef;
    const baseSha = await this.repo.resolveCommit(baseRef);
    const headSha = await this.repo.currentHead(cwd);
    const files =
      options.files && options.files.length > 0
        ? [...new Set(options.files)].sort()
        : await this.repo.changedFilesInWorkingTree(baseSha, cwd);

    const validations: ValidationResult[] = [];
    try {
      if (scope !== "authoritative") {
        validations.push(
          ...(await runValidators({
            validators: this.config.validation.focused,
            scope: "focused",
            cwd,
            ...(options.taskId ? { taskId: options.taskId } : {}),
            files,
            baseSha,
            headSha,
            batchId: LOCAL_VALIDATION_BATCH_ID,
            ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
          })),
        );
      }
      if (scope !== "focused") {
        validations.push(
          ...(await runValidators({
            validators: this.config.validation.authoritative,
            scope: "authoritative",
            cwd,
            files,
            baseSha,
            headSha,
            batchId: LOCAL_VALIDATION_BATCH_ID,
            ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
          })),
        );
      }
    } catch (error) {
      // Report the run rather than throwing it away: the worker needs the validator that failed and
      // its output, which is precisely what the exception is carrying.
      const completed = validationResultsFromError(error);
      const merged = [...validations, ...completed.filter((item) => !validations.includes(item))];
      return { ok: false, baseRef, baseSha, headSha, files, validations: merged, error: errorMessage(error) };
    }
    return { ok: true, baseRef, baseSha, headSha, files, validations };
  }

  /**
   * Validators are observers of an immutable candidate, not build steps. A validator that commits
   * or leaves tracked/untracked changes behind has tested a different tree from the one the broker
   * is about to retain and publish. Refuse that ambiguity even when the command exited successfully.
   */
  private async assertValidatorPreservedCandidate(
    worktree: string,
    expectedHead: string,
    validatorScope: "focused" | "authoritative",
  ): Promise<void> {
    const [actualHead, clean] = await Promise.all([
      this.repo.currentHead(worktree),
      this.repo.isClean(worktree),
    ]);
    if (actualHead !== expectedHead || !clean) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        `The ${validatorScope} validator changed the integration candidate. Validators must leave HEAD and the worktree unchanged.`,
        { expectedHead, actualHead, clean, validatorScope },
      );
    }
  }

  async integrate(options: IntegrationOptions = {}): Promise<IntegrationResult> {
    return await this.integrateForTarget(options);
  }

  private async integrateForTarget(
    options: IntegrationOptions = {},
    target?: {
      remote: string;
      baseBranch: string;
      baseSha: string;
      remoteUrlFingerprint?: string;
      forgeRepository?: string;
    },
  ): Promise<IntegrationResult> {
    const integrated = await this.store.withIntegrationLock(async () => {
      // A killed process can leave durable state at `running`/`integrating` after its lock is gone.
      // Owning the integration lock proves nobody else can still be advancing that transaction, so
      // recover it before planning. This also lets the recovered tasks participate immediately.
      await this.recoverAbandonedIntegrationsLocked();
      // Key problems are operator/configuration failures, not task failures. Resolve them before
      // tasks move to `integrating`, so a missing key cannot spend a worker's retry budget.
      const signingPrivateKey = await this.provenanceSigningPrivateKey();
      // One batch in flight at a time.
      //
      // A batch is cut from the base branch tip so it is born mergeable. Cutting a second one while
      // the first is still open makes that guarantee expire: whichever merges first leaves the other
      // behind the base, and a repository that requires branches to be up to date will then refuse
      // it. Serialized merge is the whole promise, and it has to hold across batches, not only
      // within one.
      //
      // The lock above does not cover this. It serializes the act of integrating, which finishes
      // long before the pull request merges.
      if (!options.dryRun && !options.force) {
        const outstanding = Object.values((await this.store.read()).batches).filter(
          (candidate) => candidate.status === "prepared" || candidate.status === "published",
        );
        if (outstanding.length > 0) {
          const names = outstanding.map((candidate) => candidate.id).join(", ");
          throw new BrokerError(
            "BATCH_OUTSTANDING",
            `Batch ${names} has not merged yet. Land it, or run \`batch sync\` if it already merged, before integrating another. Pass --force to cut anyway and accept that one of them will need updating.`,
            { outstanding: outstanding.map((candidate) => candidate.id) },
          );
        }
      }
      const plan = await this.plan({
        ...(options.taskIds ? { taskIds: options.taskIds } : {}),
        ...(options.maxTasks ? { maxTasks: options.maxTasks } : {}),
      });
      if (plan.selected.length === 0) {
        throw new BrokerError("EMPTY_BATCH", "No submitted, dependency-ready tasks are available to integrate.", {
          rejected: plan.rejected,
        });
      }
      const id = batchId();
      const remote = target?.remote ?? this.config.remote;
      let boundRemoteFingerprint = target?.remoteUrlFingerprint;
      let forgeRepository = isHostQualifiedForgeRepository(target?.forgeRepository)
        ? target.forgeRepository
        : undefined;
      let boundRemoteUrl: string | undefined;
      if (target || this.config.publish.mode !== "none" || !options.dryRun) {
        try {
          boundRemoteUrl = await this.repo.boundRemoteUrl(remote, boundRemoteFingerprint);
        } catch (error) {
          // Local-only mode remains useful before a remote exists. Such a batch is explicitly
          // unbound and must be re-cut if publication is enabled later.
          if (target || this.config.publish.mode !== "none") throw error;
        }
        if (boundRemoteUrl) {
          boundRemoteFingerprint ??= remoteUrlFingerprint(boundRemoteUrl);
        }
        if (boundRemoteUrl && !forgeRepository) {
          const configuredRepository = this.config.publish.repository;
          let derivedRepository: string | undefined;
          try {
            derivedRepository = this.repo.forgeRepositoryFromUrl(boundRemoteUrl);
          } catch (error) {
            if (this.config.publish.mode === "pull-request" && !configuredRepository) throw error;
          }
          if (
            configuredRepository &&
            derivedRepository &&
            configuredRepository !== derivedRepository
          ) {
            throw new BrokerError(
              "FORGE_TARGET_MISMATCH",
              `publish.repository names ${configuredRepository}, but remote ${remote} points at ${derivedRepository}.`,
              { remote, configuredRepository, derivedRepository },
            );
          }
          forgeRepository = configuredRepository ?? derivedRepository;
          if (this.config.publish.mode === "pull-request" && !forgeRepository) {
            throw new BrokerError(
              "REMOTE_REPOSITORY_UNKNOWN",
              `Could not bind a GitHub repository for remote ${remote}. Set publish.repository explicitly.`,
            );
          }
        }
      }
      // Cut from the same exact remote URL that was just bound into the batch. Resolving the named
      // remote only after validation would leave a same-SHA repository-switch race.
      const baseSha = target?.baseSha ?? await this.currentIntegrationBaseSha(
        this.config.publish.mode === "none" ? undefined : boundRemoteUrl,
      );
      const worktree = path.join(this.store.worktreesDirectory, id);
      const batch: BatchRecord = {
        id,
        status: "running",
        taskIds: plan.selected.map((task) => task.id),
        validationAuthority: this.config.validation.authority,
        remote,
        publicationMode: this.config.publish.mode,
        ...(boundRemoteFingerprint ? { remoteUrlFingerprint: boundRemoteFingerprint } : {}),
        ...(forgeRepository ? { forgeRepository } : {}),
        baseBranch: target?.baseBranch ?? this.config.baseBranch,
        baseSha,
        worktree,
        validations: [],
        createdAt: now(),
      };

      await this.store.transaction((state, audit) => {
        for (const selected of plan.selected) {
          const task = requireTask(state, selected.id);
          if (task.status !== "submitted" || !sameSubmittedReceipt(task, selected)) {
            throw new BrokerError(
              "TASK_CHANGED",
              `Task ${task.id} changed after planning; integrate again to use its latest receipt.`,
            );
          }
          task.status = "integrating";
          task.batchId = id;
          task.updatedAt = now();
        }
        state.batches[id] = batch;
        audit("batch.started", { batchId: id, details: { taskIds: batch.taskIds, baseSha } });
      });

      let worktreeAdded = false;
      let retainedBranchCreated = false;
      let keepWorktree = false;
      let validationCacheDirectory: string | undefined;
      // Set while work is attributable to a single task, so one bad commit fails that task instead
      // of the whole batch. Cleared before authoritative validation, which indicts the batch.
      let culpritTaskId: string | undefined;
      try {
        validationCacheDirectory = await createValidationCacheDirectory();
        await this.repo.addDetachedWorktree(worktree, baseSha);
        worktreeAdded = true;
        for (const task of plan.selected) {
          culpritTaskId = task.id;
          for (const commit of task.commits) {
            const picked = await this.repo.cherryPick(worktree, commit);
            if (picked.exitCode !== 0) {
              await this.repo.abortCherryPick(worktree);
              throw new BrokerError("CHERRY_PICK_CONFLICT", `Commit ${commit} from task ${task.id} did not apply cleanly.`, {
                taskId: task.id,
                commit,
                stdout: picked.stdout,
                stderr: picked.stderr,
              });
            }
          }
          const headSha = await this.repo.currentHead(worktree);
          const focused = await runValidators({
            validators: this.config.validation.focused,
            scope: "focused",
            cwd: worktree,
            taskId: task.id,
            files: task.actualPaths,
            baseSha,
            headSha,
            batchId: id,
            cacheDirectory: validationCacheDirectory,
            ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
          });
          batch.validations.push(...focused);
          await this.assertValidatorPreservedCandidate(worktree, headSha, "focused");
        }
        culpritTaskId = undefined;
        let headSha = await this.repo.currentHead(worktree);
        const allFiles = [...new Set(plan.selected.flatMap((task) => task.actualPaths))].sort();
        const authoritative = await runValidators({
          validators: this.config.validation.authoritative,
          scope: "authoritative",
          cwd: worktree,
          files: allFiles,
          baseSha,
          headSha,
          batchId: id,
          cacheDirectory: validationCacheDirectory,
          ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
        });
        batch.validations.push(...authoritative);
        await this.assertValidatorPreservedCandidate(worktree, headSha, "authoritative");
        if (this.config.integration.history === "squash") {
          headSha = await this.repo.squash(
            worktree,
            baseSha,
            `Integrate batch ${id}\n\n${plan.selected.map((task) => `Task: ${task.id}`).join("\n")}`,
          );
        }
        const provenance = this.config.integration.provenance;
        if (provenance?.enabled) {
          const integratedHeadSha = headSha;
          const integratedPaths = await this.repo.changedFilesBetween(
            baseSha,
            integratedHeadSha,
          );
          const relativePath = provenancePath(provenance.directory, id);
          let record = buildBatchProvenance({
            batch,
            tasks: plan.selected,
            integratedHeadSha,
            integratedPaths,
            history: this.config.integration.history,
          });
          if (signingPrivateKey && provenance.publicKey) {
            record = signBatchProvenance(record, signingPrivateKey, provenance.publicKey);
          } else if (provenance.requireSignature) {
            throw new BrokerError("SIGNING_KEY_REQUIRED", "Signed provenance is required for this batch.");
          }
          headSha = await this.repo.commitGeneratedFile(
            worktree,
            relativePath,
            `${JSON.stringify(record, null, 2)}\n`,
            `Record Merge Broker batch ${id}`,
          );
          batch.integratedHeadSha = integratedHeadSha;
          batch.provenancePath = relativePath;
        }
        batch.headSha = headSha;
        if (!options.dryRun && approvalPolicy(this.config).required) {
          batch.candidate = makeCandidate(this.config, headSha, baseSha, 1);
          batch.candidateHistory = [];
        }
        batch.finishedAt = now();

        if (options.dryRun) {
          batch.status = "verified";
          await this.store.transaction((state, audit) => {
            state.batches[id] = structuredClone(batch);
            for (const taskId of batch.taskIds) {
              const task = requireTask(state, taskId);
              task.status = "submitted";
              delete task.batchId;
              task.updatedAt = now();
            }
            audit("batch.verified", { batchId: id, details: { taskIds: batch.taskIds, headSha } });
          });
        } else {
          const branchName = cleanBranchFragment(`${this.config.integration.branchPrefix}${id}`);
          // Persist the exact cleanup identity before creating the ref. A process can stop between
          // `git branch` and the prepared-state transaction, and recovery must never reconstruct a
          // branch name from configuration that may have changed in the meantime.
          batch.branchName = branchName;
          await this.store.transaction((state, audit) => {
            const running = requireBatch(state, id);
            if (running.status !== "running") {
              throw new BrokerError("BATCH_CHANGED", `Batch ${id} changed before branch creation.`);
            }
            running.branchName = branchName;
            running.headSha = headSha;
            audit("batch.branch_creation_started", {
              batchId: id,
              details: { branchName, headSha },
            });
          });
          await this.repo.createBranch(branchName, headSha);
          retainedBranchCreated = true;
          batch.status = "prepared";
          await this.store.transaction((state, audit) => {
            state.batches[id] = structuredClone(batch);
            for (const taskId of batch.taskIds) {
              const task = requireTask(state, taskId);
              task.status = "batched";
              task.batchedAt = now();
              delete task.lease;
              task.validations = batch.validations.filter((result) => !result.taskId || result.taskId === taskId);
              task.updatedAt = now();
            }
            audit("batch.prepared", {
              batchId: id,
              details: {
                taskIds: batch.taskIds,
                branchName,
                headSha,
                validationAuthority: batch.validationAuthority,
                ...(batch.candidate
                  ? {
                      candidateRevision: batch.candidate.revision,
                      candidateState: batch.candidate.state,
                      policyRevision: batch.candidate.policyRevision,
                    }
                  : {}),
              },
            });
          });
          // Batching ends the lease, so any token held for it is now dead weight.
          for (const taskId of batch.taskIds) await this.store.deleteToken(taskId);
        }
        await this.store.writeBatchManifest(id, {
          batch,
          tasks: plan.selected.map((task) => ({
            id: task.id,
            commits: task.commits,
            actualPaths: task.actualPaths,
            dependsOn: task.dependsOn,
          })),
          rejected: plan.rejected,
        });
      } catch (error) {
        keepWorktree = this.config.integration.keepFailedWorktrees;
        if (retainedBranchCreated && batch.branchName) {
          await this.repo.deleteBranch(batch.branchName);
          delete batch.branchName;
        } else if (batch.status === "running") {
          // The intent may have been persisted even though Git refused to create the ref. Do not
          // claim or later delete a branch the broker did not actually create.
          delete batch.branchName;
        }
        const failureResults = validationResultsFromError(error);
        batch.validations.push(...failureResults.filter((item) => !batch.validations.includes(item)));
        batch.status = "failed";
        batch.error = errorMessage(error);
        batch.finishedAt = now();
        if (keepWorktree) batch.worktree = worktree;
        else delete batch.worktree;
        const requeued: string[] = [];
        await this.store.transaction((state, audit) => {
          state.batches[id] = structuredClone(batch);
          for (const taskId of batch.taskIds) {
            const task = requireTask(state, taskId);
            delete task.batchId;
            task.updatedAt = now();
            // A dry run reports; it does not decide. Leaving a task `failed` here would empty the
            // queue on a rehearsal, so the next real integrate finds nothing to do and says
            // EMPTY_BATCH — with no hint that a dry run consumed the work. The success path already
            // restores `submitted` for the same reason.
            if (options.dryRun) {
              task.status = "submitted";
              continue;
            }
            // Only the task that actually broke stays failed. Its batch-mates are returned to the
            // queue so a single conflicting commit cannot stall every other agent's work.
            if (culpritTaskId && taskId !== culpritTaskId && (task.attempts ?? 0) + 1 < this.config.integration.maxAttempts) {
              task.attempts = (task.attempts ?? 0) + 1;
              task.status = "submitted";
              requeued.push(taskId);
              continue;
            }
            task.status = "failed";
            if (batch.error) task.lastError = batch.error;
          }
          audit("batch.failed", {
            batchId: id,
            details: {
              error: batch.error,
              ...(culpritTaskId ? { culpritTaskId } : {}),
              requeued,
              ...(options.dryRun ? { dryRun: true } : {}),
            },
          });
        });
        await this.store.writeBatchManifest(id, { batch, error: batch.error });
        throw error;
      } finally {
        if (validationCacheDirectory) {
          await removeValidationCacheDirectory(validationCacheDirectory).catch(() => undefined);
        }
        if (worktreeAdded && !keepWorktree) await this.repo.removeWorktree(worktree);
      }

      const finalBatch = requireBatch(await this.store.read(), id);
      return {
        batch: structuredClone(finalBatch),
        selected: batch.taskIds,
        rejected: plan.rejected,
        dryRun: options.dryRun ?? false,
      };
    });
    // Publication has its own per-batch lock and may perform slow forge I/O. Releasing the global
    // integration lock first establishes one lock order and lets recovery/refresh avoid a cycle.
    if (!options.dryRun && options.publish) {
      const published = await this.publishBatch(integrated.batch.id);
      return { ...integrated, batch: published };
    }
    return integrated;
  }

  private async writeRevisionArtifacts(updated: RevisionResult): Promise<void> {
    await this.store.deleteToken(updated.task.id);
    const receipt: CommitReceipt = {
      version: 1,
      taskId: updated.task.id,
      ...(updated.task.agent ? { agent: updated.task.agent } : {}),
      baseSha: updated.task.baseSha,
      commits: updated.task.commits,
      expectedPaths: updated.task.expectedPaths,
      actualPaths: updated.task.actualPaths,
      dependsOn: updated.task.dependsOn,
      ...(updated.task.worktree ? { worktree: updated.task.worktree } : {}),
      submittedAt: updated.task.submittedAt ?? now(),
      warnings: updated.task.warnings,
    };
    await this.store.writeReceipt(receipt);
    const state = await this.store.read();
    await this.store.writeBatchManifest(updated.batch.id, {
      batch: updated.batch,
      tasks: updated.batch.taskIds.map((id) => {
        const task = requireTask(state, id);
        return {
          id: task.id,
          commits: task.commits,
          actualPaths: task.actualPaths,
          dependsOn: task.dependsOn,
        };
      }),
    });
  }

  private async recoverAbandonedIntegrationsLocked(): Promise<RecoveryResult> {
    const snapshot = await this.store.read();
    const candidateRevisionsRecovered: string[] = [];
    const candidateRevisionWarnings: string[] = [];
    for (const pending of Object.values(snapshot.batches).filter((batch) => batch.revisionIntent)) {
      const intent = pending.revisionIntent;
      if (!intent) continue;
      let branchHead: string | undefined;
      try {
        branchHead = pending.pullRequestUrl
          ? (await this.publisher.inspectPullRequest(this.repo.root, pending.pullRequestUrl)).headRefOid
          : await this.repo.resolveCommit(`refs/heads/${intent.branchName}`);
      } catch (error) {
        candidateRevisionWarnings.push(
          `Could not inspect candidate revision ${pending.id}: ${errorMessage(error)}`,
        );
        continue;
      }

      if (branchHead === intent.candidateSha) {
        try {
          await this.repo.replaceLocalBranch(intent.branchName, intent.candidateSha);
          const updated = await this.store.transaction((state, audit) =>
            finalizeCandidateRevision(state, audit, pending.id, intent),
          );
          candidateRevisionsRecovered.push(pending.id);
          try {
            await this.writeRevisionArtifacts(updated);
          } catch (error) {
            candidateRevisionWarnings.push(
              `Candidate revision ${pending.id} recovered, but sidecar refresh failed: ${errorMessage(error)}`,
            );
          }
        } catch (error) {
          candidateRevisionWarnings.push(
            `Could not finalize candidate revision ${pending.id}: ${errorMessage(error)}`,
          );
        }
      } else if (branchHead === intent.previousCandidateSha) {
        await this.store.transaction((state, audit) => {
          const batch = requireBatch(state, pending.id);
          if (batch.revisionIntent?.candidateSha !== intent.candidateSha) return;
          delete batch.revisionIntent;
          audit("batch.candidate_revision_rolled_back", {
            taskId: intent.taskId,
            batchId: pending.id,
            details: {
              previousCandidateSha: intent.previousCandidateSha,
              candidateSha: intent.candidateSha,
              reason: "branch update did not complete",
            },
          });
        });
      } else {
        candidateRevisionWarnings.push(
          `Candidate revision ${pending.id} points at unexpected branch head ${branchHead}; intent retained.`,
        );
      }
    }

    const running = Object.values(snapshot.batches).filter((batch) => batch.status === "running");
    if (running.length === 0) {
      return {
        batches: [],
        tasks: [],
        worktreesRemoved: [],
        branchesRemoved: [],
        cleanupWarnings: [],
        candidateRevisionsRecovered,
        candidateRevisionWarnings,
      };
    }

    const worktreesRemoved: string[] = [];
    const branchesRemoved: string[] = [];
    const cleanupWarnings: string[] = [];
    const worktreesCleared = new Set<string>();
    const cleanupWarningsByBatch = new Map<string, string[]>();
    const warn = (batchId: string, message: string): void => {
      cleanupWarnings.push(message);
      const warnings = cleanupWarningsByBatch.get(batchId) ?? [];
      warnings.push(message);
      cleanupWarningsByBatch.set(batchId, warnings);
    };
    const registeredWorktrees = new Set((await this.repo.listWorktrees()).map((worktree) => path.resolve(worktree.path)));
    const worktreeRoot = `${path.resolve(this.store.worktreesDirectory)}${path.sep}`;
    // Clean external Git artifacts while durable state is still `running`. If the process stops at
    // any point in this loop, the next recovery repeats the idempotent observations and cleanup.
    // Only the transaction below makes the recovery terminal.
    for (const candidate of running) {
      const batchId = candidate.id;
      const worktree = candidate?.worktree ? path.resolve(candidate.worktree) : undefined;
      if (worktree) {
        if (!worktree.startsWith(worktreeRoot)) {
          warn(batchId, `Refused to remove recovery worktree outside broker state: ${worktree}`);
        } else if (!registeredWorktrees.has(worktree)) {
          try {
            const exists = await lstat(worktree).then(
              () => true,
              (error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
              },
            );
            if (exists) {
              // `git worktree add` can stop after creating the directory but before registration.
              // This exact path is inside the broker-owned worktree root, so remove the partial
              // artifact rather than dropping its only durable pointer.
              await rm(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
              worktreesRemoved.push(worktree);
            }
            worktreesCleared.add(batchId);
          } catch (error) {
            warn(batchId, `Could not remove partial recovery worktree ${worktree}: ${errorMessage(error)}`);
          }
        } else {
          try {
            await this.repo.removeWorktree(worktree);
            worktreesRemoved.push(worktree);
            worktreesCleared.add(batchId);
          } catch (error) {
            warn(batchId, errorMessage(error));
          }
        }
      }

      const branchName = candidate?.branchName;
      const expectedHead = candidate?.headSha;
      if (branchName && expectedHead) {
        const refName = `refs/heads/${branchName}`;
        const exists = await this.repo.git(
          ["show-ref", "--verify", "--quiet", refName],
          this.repo.root,
          true,
        );
        if (exists.exitCode === 0) {
          const branch = await this.repo.git(["show-ref", "--verify", refName], this.repo.root, true);
          if (branch.exitCode !== 0) {
            warn(
              batchId,
              `Could not inspect recovery branch ${branchName}: ${branch.stderr.trim() || `git exited ${branch.exitCode}`}`,
            );
            continue;
          }
          const actualHead = branch.stdout.trim().split(/\s+/u)[0];
          if (actualHead !== expectedHead) {
            warn(
              batchId,
              `Refused to remove recovery branch ${branchName}: expected ${expectedHead}, found ${actualHead ?? "an unknown head"}.`,
            );
          } else {
            // Use porcelain deletion so Git still refuses a branch checked out in any worktree.
            // The immediately preceding head check prevents ordinary stale-state deletion; the
            // trusted-host model still requires operators not to race recovery deliberately.
            const deleted = await this.repo.git(["branch", "-D", "--", branchName], this.repo.root, true);
            if (deleted.exitCode === 0) branchesRemoved.push(branchName);
            else warn(batchId, `Could not remove recovery branch ${branchName}: ${deleted.stderr.trim()}`);
          }
        } else if (exists.exitCode !== 1) {
          warn(
            batchId,
            `Could not inspect recovery branch ${branchName}: ${exists.stderr.trim() || `git exited ${exists.exitCode}`}`,
          );
        }
      }
    }

    const recovered = await this.store.transaction((state, audit) => {
      const batches: string[] = [];
      const tasks: string[] = [];
      for (const candidate of running) {
        const batch = state.batches[candidate.id];
        if (!batch || batch.status !== "running") continue;
        batch.status = "failed";
        batch.error = "Integration process stopped before the transaction completed; tasks were recovered for retry.";
        batch.finishedAt = now();
        batches.push(batch.id);
        if (worktreesCleared.has(batch.id)) delete batch.worktree;
        const warnings = cleanupWarningsByBatch.get(batch.id) ?? [];
        if (warnings.length > 0) {
          batch.error = `${batch.error} Cleanup: ${warnings.join("; ")}`;
        }
        const requeued: string[] = [];
        for (const taskId of batch.taskIds) {
          const task = state.tasks[taskId];
          if (!task || task.status !== "integrating" || task.batchId !== batch.id) continue;
          task.status = "submitted";
          task.updatedAt = now();
          delete task.batchId;
          delete task.lastError;
          tasks.push(taskId);
          requeued.push(taskId);
        }
        audit("batch.recovered", {
          batchId: batch.id,
          details: { requeued, reason: "abandoned integration transaction", warnings },
        });
      }
      audit("integration.recovery_completed", {
        details: {
          batches,
          tasks,
          worktreesRemoved,
          branchesRemoved,
          cleanupWarnings,
          candidateRevisionsRecovered,
          candidateRevisionWarnings,
        },
      });
      return { batches, tasks };
    });

    return {
      ...recovered,
      worktreesRemoved,
      branchesRemoved,
      cleanupWarnings,
      candidateRevisionsRecovered,
      candidateRevisionWarnings,
    };
  }

  /**
   * Recovers durable `running` state left by a killed integration process. Acquiring the integration
   * lock is the proof that the former process is no longer allowed to make progress.
   */
  async recoverAbandonedIntegrations(): Promise<RecoveryResult> {
    const recovered = await this.store.withIntegrationLock(
      async () => await this.recoverAbandonedIntegrationsLocked(),
    );
    const submissions = await this.store.withGateAuthorityLock(async () => {
      const records = Object.values((await this.store.read()).submissions);
      const manifestWarnings: string[] = [];
      // Terminal state is authoritative and its manifest is only a private inspection sidecar.
      // Repair those sidecars before consulting Gate authority: the state already contains every
      // byte needed, and a missing/corrupt authority file must not prevent honest terminal output
      // from being regenerated after a crash.
      for (const submission of records
        .filter((item) => item.status !== "received" && item.status !== "validating")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        try {
          await this.store.writeSubmissionManifest(submission);
        } catch (error) {
          manifestWarnings.push(
            `Could not repair candidate submission manifest ${submission.id}: ${errorMessage(error)}`,
          );
        }
      }
      const pending = records
        .filter((submission) => submission.status === "received" || submission.status === "validating");
      let authority: GateAuthorityRegistration | undefined;
      try {
        authority = await new GateAuthorityStore(this.repo.commonGitDir).read();
      } catch (error) {
        return {
          recovered: [],
          warnings: [
            ...manifestWarnings,
            `Could not load Gate authority while recovering candidate submissions: ${errorMessage(error)}`,
          ],
        };
      }
      if (!authority) {
        return pending.length === 0
          ? { recovered: [], warnings: manifestWarnings }
          : {
            recovered: [],
            warnings: [
              ...manifestWarnings,
              "Candidate submissions remain pending because Gate authority is not registered. Restore the original authority registration before recovery.",
            ],
          };
      }
      if (authority.stateDirectory !== this.config.stateDirectory) {
        return {
          recovered: [],
          warnings: [
            ...manifestWarnings,
            `Gate authority uses state directory ${authority.stateDirectory}, but the mutable checkout selects ${this.config.stateDirectory}; refusing to recover through a different lock/state domain.`,
          ],
        };
      }
      let pendingRecovery: { recovered: string[]; warnings: string[] };
      try {
        pendingRecovery = await new LocalRefSubmissionManager(
          this.repo,
          this.store,
          authority,
        ).recoverPending();
      } catch (error) {
        return {
          recovered: [],
          warnings: [
            ...manifestWarnings,
            `Could not recover pending candidate submissions: ${errorMessage(error)}`,
          ],
        };
      }
      return {
        recovered: pendingRecovery.recovered,
        warnings: [...manifestWarnings, ...pendingRecovery.warnings],
      };
    });
    return {
      ...recovered,
      submissionsRecovered: submissions.recovered,
      submissionWarnings: submissions.warnings,
    };
  }

  async publishBatch(id: string): Promise<BatchRecord> {
    return await this.store.withBatchLock(id, async () => await this.publishBatchLocked(id));
  }

  private async publishBatchLocked(id: string): Promise<BatchRecord> {
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    assertNoPendingRevision(batch);
    // A recorded change request is a durable revocation command. It takes precedence over every
    // publication retry: after a crash the remote auto-merge queue may still be live even when the
    // last local enable result was not recorded. Never let this path re-enable that candidate.
    if (batch.changeRequestIntent) return await this.completeChangeRequestLocked(id);
    if (batch.status === "published" && batch.pullRequestUrl) {
      const reconciled = await this.syncBatchLocked(id);
      if (reconciled.status !== "published" || reconciled.refreshRequired) {
        if (reconciled.candidate && !approvalPolicy(this.config).required) {
          throw new BrokerError(
            "CANDIDATE_POLICY_STALE",
            "This batch was assembled under required approval; disabling that policy cannot authorize the existing candidate. Refresh the batch.",
          );
        }
        return reconciled;
      }
    }
    if (
      this.config.publish.mode !== "none" &&
      (!batch.remoteUrlFingerprint ||
        (this.config.publish.mode === "pull-request" &&
          !isHostQualifiedForgeRepository(batch.forgeRepository)))
    ) {
      const safeUnpublishedRecut = batch.status === "prepared" && batch.publicationMode === "none";
      await this.store.transaction((current, audit) => {
        const stored = requireBatch(current, id);
        if (safeUnpublishedRecut) stored.refreshRequired = true;
        stored.error = "This batch predates durable publication-target binding and must be re-cut before publication.";
        audit("batch.publication_target_unbound", { batchId: id });
      });
      throw new BrokerError(
        "BATCH_TARGET_UNBOUND",
        safeUnpublishedRecut
          ? `Batch ${id} has no durable publication target. Run batch refresh to re-cut it before publishing.`
          : `Batch ${id} has no durable target binding and may already have remote publication side effects. Reconcile or remove its original branch/PR explicitly before retrying the tasks; it cannot be rebound automatically.`,
      );
    }
    // `published` is accepted so publication can be retried. A batch whose pull request opened but
    // whose auto-merge did not is published and incomplete, and the way to finish it is to run this
    // again -- which now finds the existing pull request instead of opening a second one.
    if (batch.status !== "prepared" && batch.status !== "published") {
      throw new BrokerError("BATCH_NOT_PUBLISHABLE", `Batch ${id} cannot be published while ${batch.status}.`);
    }
    if (!batch.branchName || !batch.headSha) {
      throw new BrokerError("NO_CANDIDATE", `Batch ${id} has no immutable branch/head identity.`);
    }
    const tasks = batch.taskIds.map((taskId) => requireTask(state, taskId));
    let publication;
    try {
      await this.assertBatchBaseFresh(batch);
      publication = batch.status === "published" && batch.pullRequestUrl
        ? {
            mode: "pull-request" as const,
            branchName: batch.branchName,
            pullRequestUrl: batch.pullRequestUrl,
            reusedPullRequest: true,
          }
        : await this.publisher.publishBatch({ repo: this.repo, config: this.config, batch, tasks });
    } catch (error) {
      await this.store.transaction((current, audit) => {
        const stored = Object.hasOwn(current.batches, id) ? current.batches[id] : undefined;
        if (stored) {
          stored.error = errorMessage(error);
          if (error instanceof BrokerError && error.code === "BATCH_BASE_STALE") {
            stored.refreshRequired = true;
          }
        }
        audit("batch.publish_failed", { batchId: id, details: { error: errorMessage(error) } });
      });
      throw error;
    }

    // Recorded before auto-merge is attempted. The pull request exists from this point on, and a
    // state that does not say so is worse than one that does: `batch sync` only reconciles
    // `published` batches, so a batch left `prepared` holding a real pull request is invisible to
    // the one command built to notice it merged.
    const published = await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      const first = stored.status !== "published";
      stored.status = "published";
      stored.publishedAt = stored.publishedAt ?? now();
      delete stored.error;
      delete stored.refreshRequired;
      delete stored.refreshCloseIntent;
      delete stored.publishWarning;
      if (publication.pullRequestUrl) stored.pullRequestUrl = publication.pullRequestUrl;
      for (const taskId of stored.taskIds) {
        const task = requireTask(current, taskId);
        task.status = "published";
        task.publishedAt = stored.publishedAt;
        task.updatedAt = now();
      }
      if (first) {
        audit("batch.published", {
          batchId: id,
          details: {
            branchName: stored.branchName,
            pullRequestUrl: stored.pullRequestUrl,
            reusedPullRequest: publication.reusedPullRequest ?? false,
          },
        });
      }
      return structuredClone(stored);
    });

    if (!this.config.publish.autoMerge || !publication.pullRequestUrl || published.autoMergeEnabled) {
      return published;
    }
    // Publication and merge authorization are separate remote steps. Re-read the exact PR identity
    // between them so a moved head/base or an already terminal PR cannot be queued by a manual
    // retry that did not first run `batch sync`.
    const mergeReady = await this.syncBatchLocked(id);
    if (mergeReady.status !== "published" || mergeReady.refreshRequired || mergeReady.autoMergeEnabled) {
      return mergeReady;
    }
    const currentApprovalPolicy = approvalPolicy(this.config);
    if (mergeReady.candidate || currentApprovalPolicy.required) {
      const candidate = mergeReady.candidate;
      if (candidate && !currentApprovalPolicy.required) {
        throw new BrokerError(
          "CANDIDATE_POLICY_STALE",
          "This batch was assembled under required approval; disabling that policy cannot authorize the existing candidate. Refresh the batch.",
        );
      }
      if (candidate) assertCurrentApprovalPolicy(this.config, candidate);
      if (
        !candidate?.approval ||
        !candidate.approval.confirmedAt ||
        candidate.approval.revocationRequestedAt ||
        (candidate.state !== "approved" && candidate.state !== "merging")
      ) {
        return mergeReady;
      }
    }

    // Persist the intent before contacting the forge. If the process stops after GitHub accepts
    // auto-merge, revocation and reconciliation must know that the remote queue may be live even
    // though `autoMergeEnabled` was never written.
    await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.autoMergePending = true;
      stored.autoMergeEnabled = false;
      audit("batch.auto_merge_attempting", { batchId: id, details: { pullRequestUrl: stored.pullRequestUrl } });
    });

    // A separate step with its own outcome. Failing to queue auto-merge is a published batch that
    // needs a hand, not a publication that did not happen.
    let autoMergeEnabled = false;
    let warning: string | undefined;
    try {
      autoMergeEnabled = await this.publisher.enableAutoMerge(
        this.repo.root,
        publication.pullRequestUrl,
        this.config,
        mergeReady.candidate?.sha ?? mergeReady.headSha,
      );
    } catch (error) {
      warning = errorMessage(error);
    }
    return await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.autoMergeEnabled = autoMergeEnabled;
      if (autoMergeEnabled) {
        delete stored.autoMergePending;
        if (stored.candidate?.approval) stored.candidate.state = "merging";
      } else {
        stored.autoMergePending = true;
      }
      if (warning) stored.publishWarning = warning;
      else delete stored.publishWarning;
      audit(autoMergeEnabled ? "batch.auto_merge_enabled" : "batch.auto_merge_pending", {
        batchId: id,
        details: { pullRequestUrl: stored.pullRequestUrl, ...(warning ? { warning } : {}) },
      });
      return structuredClone(stored);
    });
  }

  async recordVerification(
    id: string,
    input: {
      name: string;
      status: "passed" | "failed";
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
      evidenceUrl?: string;
      notes?: string;
    },
  ): Promise<BatchRecord> {
    return await this.store.withBatchLock(id, async () => await this.recordVerificationLocked(id, input));
  }

  private async recordVerificationLocked(
    id: string,
    input: {
      name: string;
      status: "passed" | "failed";
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
      evidenceUrl?: string;
      notes?: string;
    },
  ): Promise<BatchRecord> {
    const policy = approvalPolicy(this.config);
    if (!policy.required) throw new BrokerError("APPROVAL_DISABLED", "SHA-bound approval is not enabled.");
    if (!policy.requiredVerifications.includes(input.name)) {
      throw new BrokerError(
        "VERIFICATION_NOT_REQUIRED",
        `Verification ${input.name} is not declared in approval.requiredVerifications.`,
      );
    }
    const snapshot = requireBatch(await this.store.read(), id);
    assertNoPendingRevision(snapshot);
    if (snapshot.status !== "published" || !snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_VERIFIABLE", `Batch ${id} must have an open pull request before evidence is recorded.`);
    }
    const candidate = requireCurrentCandidate(snapshot);
    assertCandidateBinding(candidate, input);
    assertCurrentApprovalPolicy(this.config, candidate);
    const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, snapshot.pullRequestUrl);
    if (pullRequest.state !== "OPEN" || pullRequest.headRefOid !== candidate.sha) {
      throw new BrokerError("CANDIDATE_MISMATCH", "The pull request no longer points at the candidate being verified.", {
        expectedHead: candidate.sha,
        actualHead: pullRequest.headRefOid,
        pullRequestState: pullRequest.state,
      });
    }
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      if (
        current.state === "approved" ||
        current.state === "merging" ||
        current.state === "superseded" ||
        current.state === "abandoned" ||
        current.state === "merged"
      ) {
        throw new BrokerError("CANDIDATE_FINAL", `Candidate ${current.sha} cannot accept evidence while ${current.state}.`);
      }
      const evidence: VerificationEvidence = {
        name: input.name,
        source: "manual",
        status: input.status,
        candidateSha: current.sha,
        baseSha: current.baseSha,
        policyRevision: current.policyRevision,
        actor: input.actor,
        recordedAt: now(),
        ...(input.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      };
      upsertEvidence(current, evidence);
      audit("batch.verification_recorded", {
        actor: input.actor,
        batchId: id,
        details: {
          name: input.name,
          status: input.status,
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
          ...(input.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
        },
      });
      return structuredClone(batch);
    });
  }

  async requestChanges(
    id: string,
    input: {
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
      reason: string;
    },
  ): Promise<BatchRecord> {
    return await this.store.withBatchLock(id, async () => await this.requestChangesLocked(id, input));
  }

  private async requestChangesLocked(
    id: string,
    input: {
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
      reason: string;
    },
  ): Promise<BatchRecord> {
    const snapshot = requireBatch(await this.store.read(), id);
    assertNoPendingRevision(snapshot);
    if (snapshot.changeRequestIntent) return await this.completeChangeRequestLocked(id);
    if (snapshot.refreshRequired || snapshot.refreshCloseIntent) {
      throw new BrokerError(
        "REFRESH_PENDING",
        `Batch ${id} is already being superseded and cannot accept a candidate revision request. Resume refresh first.`,
      );
    }
    const candidate = requireCurrentCandidate(snapshot);
    assertCandidateBinding(candidate, input);
    if (snapshot.status !== "published" || !snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_REVISABLE", `Batch ${id} is not a published candidate.`);
    }
    const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, snapshot.pullRequestUrl);
    if (pullRequest.state !== "OPEN" || pullRequest.headRefOid !== candidate.sha) {
      throw new BrokerError("CANDIDATE_MISMATCH", "The pull request head changed before changes could be requested.");
    }
    await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      batch.changeRequestIntent = { ...input, requestedAt: now() };
      audit("batch.changes_requesting", {
        actor: input.actor,
        batchId: id,
        details: {
          reason: input.reason,
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
        },
      });
    });
    return await this.completeChangeRequestLocked(id);
  }

  private async completeChangeRequestLocked(id: string): Promise<BatchRecord> {
    const snapshot = requireBatch(await this.store.read(), id);
    const intent = snapshot.changeRequestIntent;
    if (!intent) throw new BrokerError("NO_CHANGE_REQUEST", `Batch ${id} has no pending change request.`);
    const candidate = requireCurrentCandidate(snapshot);
    assertCandidateBinding(candidate, intent);
    if (!snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_REVISABLE", `Batch ${id} has no pull request to revoke.`);
    }
    const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, snapshot.pullRequestUrl);
    if (pullRequest.state === "CLOSED") {
      return await this.closeBatchLocked(
        id,
        `Pull request ${snapshot.pullRequestUrl} was closed while changes were requested.`,
        {
          allowChangeRequestIntent: true,
          allowApprovalRevocation: true,
          allowRefreshRequired: true,
          allowRefreshCloseIntent: true,
        },
      );
    }
    if (pullRequest.state === "OPEN" && pullRequest.headRefOid !== candidate.sha) {
      // GitHub may keep auto-merge queued across a force-push. Do not terminalize local state and
      // stop reconciliation while the unvalidated replacement head could still merge. The durable
      // change-request intent remains until the remote queue is observed disabled.
      const disabled = await this.publisher.disableAutoMerge(this.repo.root, snapshot.pullRequestUrl);
      if (!disabled) {
        throw new BrokerError(
          "CANDIDATE_FINAL",
          "The pull request merged while approval revocation was disabling auto-merge for a changed head. Sync again to record the invariant violation.",
        );
      }
    }
    if (pullRequest.state !== "OPEN" || pullRequest.headRefOid !== candidate.sha) {
      const reason = pullRequest.state === "MERGED"
        ? "The pull request merged after changes were requested but before revocation completed."
        : "The pull request head changed while approval revocation was in progress.";
      return await this.store.transaction((state, audit) => {
        const batch = requireBatch(state, id);
        const current = requireCurrentCandidate(batch);
        current.state = "blocked";
        current.reason = reason;
        delete current.approval;
        batch.status = "failed";
        batch.error = reason;
        batch.finishedAt = now();
        batch.autoMergeEnabled = false;
        delete batch.autoMergePending;
        delete batch.changeRequestIntent;
        for (const taskId of batch.taskIds) {
          const task = requireTask(state, taskId);
          task.status = "failed";
          task.lastError = reason;
          task.updatedAt = now();
        }
        audit("batch.merge_invariant_violated", {
          actor: intent.actor,
          batchId: id,
          details: { reason, requestedAt: intent.requestedAt, pullRequestState: pullRequest.state },
        });
        return structuredClone(batch);
      });
    }
    const disabled = await this.publisher.disableAutoMerge(this.repo.root, snapshot.pullRequestUrl);
    if (!disabled) {
      throw new BrokerError(
        "CANDIDATE_FINAL",
        "The pull request merged while approval revocation was in progress. Sync again to record the invariant violation.",
      );
    }
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const currentIntent = batch.changeRequestIntent;
      if (!currentIntent) throw new BrokerError("NO_CHANGE_REQUEST", `Batch ${id} has no pending change request.`);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, currentIntent);
      current.state = "changes_requested";
      current.reason = currentIntent.reason;
      delete current.approval;
      batch.autoMergeEnabled = false;
      delete batch.autoMergePending;
      delete batch.changeRequestIntent;
      delete batch.publishWarning;
      audit("batch.changes_requested", {
        actor: currentIntent.actor,
        batchId: id,
        details: {
          reason: currentIntent.reason,
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
          requestedAt: currentIntent.requestedAt,
        },
      });
      return structuredClone(batch);
    });
  }

  async approveBatch(
    id: string,
    input: {
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
    },
  ): Promise<BatchRecord> {
    const policy = approvalPolicy(this.config);
    if (!policy.required) throw new BrokerError("APPROVAL_DISABLED", "SHA-bound approval is not enabled.");
    if (policy.authorizedActors.length > 0 && !policy.authorizedActors.includes(input.actor)) {
      throw new BrokerError("APPROVAL_FORBIDDEN", `Actor ${input.actor} is not authorized to approve candidates.`);
    }
    // Reconcile first so a completed/closed PR is terminal before the approval operation acquires
    // its serialization lock. The locked implementation then rechecks all state and forge binding.
    await this.syncBatch(id);
    return await this.store.withBatchLock(id, async () => await this.approveBatchLocked(id, input));
  }

  private async approveBatchLocked(
    id: string,
    input: {
      candidateSha: string;
      baseSha: string;
      policyRevision?: string;
      actor: string;
    },
  ): Promise<BatchRecord> {
    const policy = approvalPolicy(this.config);
    if (!policy.required) throw new BrokerError("APPROVAL_DISABLED", "SHA-bound approval is not enabled.");
    if (policy.authorizedActors.length > 0 && !policy.authorizedActors.includes(input.actor)) {
      throw new BrokerError("APPROVAL_FORBIDDEN", `Actor ${input.actor} is not authorized to approve candidates.`);
    }
    const snapshot = requireBatch(await this.store.read(), id);
    assertNoPendingRevision(snapshot);
    if (snapshot.status !== "published" || !snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_APPROVABLE", `Batch ${id} must have an open pull request before approval.`);
    }
    if (
      this.config.publish.autoMerge &&
      (!snapshot.remoteUrlFingerprint || !isHostQualifiedForgeRepository(snapshot.forgeRepository))
    ) {
      await this.store.transaction((state, audit) => {
        const batch = requireBatch(state, id);
        batch.refreshRequired = true;
        batch.error = "This batch predates durable publication-target binding and must be re-cut before auto-merge.";
        audit("batch.publication_target_unbound", { batchId: id });
      });
      throw new BrokerError(
        "BATCH_TARGET_UNBOUND",
        `Batch ${id} has no durable publication target. Run batch refresh before approving it for auto-merge.`,
      );
    }
    const approvalState = await this.store.read();
    const invalidTasks = snapshot.taskIds.filter((taskId) => {
      const task = requireTask(approvalState, taskId);
      return task.status !== "published" || Boolean(task.lease && !leaseExpired(task));
    });
    if (invalidTasks.length > 0) {
      throw new BrokerError(
        "CANDIDATE_STATE_INVALID",
        "Every task must remain published and outside an editing lease at approval time.",
        { taskIds: invalidTasks },
      );
    }
    const candidate = requireCurrentCandidate(snapshot);
    assertCandidateBinding(candidate, input);
    assertCurrentApprovalPolicy(this.config, candidate);
    if (
      candidate.state !== "ready_for_approval" &&
      candidate.state !== "approved" &&
      candidate.state !== "merging"
    ) {
      const missing = candidate.requiredVerifications.filter(
        (name) => !candidate.verifications.some((item) => item.name === name && item.status === "passed"),
      );
      throw new BrokerError(
        "CANDIDATE_NOT_READY",
        `Candidate ${candidate.sha} is ${candidate.state}; every required verification must pass before approval.`,
        { missing },
      );
    }
    const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, snapshot.pullRequestUrl);
    if (
      pullRequest.state !== "OPEN" ||
      pullRequest.headRefOid !== candidate.sha ||
      pullRequest.baseRefName !== snapshot.baseBranch ||
      pullRequest.baseRefOid !== candidate.baseSha
    ) {
      throw new BrokerError("CANDIDATE_MISMATCH", "The PR head or target base changed before approval.", {
        candidateSha: candidate.sha,
        pullRequestHead: pullRequest.headRefOid,
        candidateBaseSha: candidate.baseSha,
        pullRequestBaseSha: pullRequest.baseRefOid,
      });
    }
    const missingLiveChecks = policy.requiredChecks.filter((checkName) => {
      const checks = pullRequest.checks.filter((check) => check.name === checkName);
      return checks.length === 0 || checks.some((check) => {
        const status = check.status.toUpperCase();
        const conclusion = check.conclusion?.toUpperCase();
        return !(
          status === "SUCCESS" ||
          (status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion ?? ""))
        );
      });
    });
    if (missingLiveChecks.length > 0) {
      throw new BrokerError(
        "CANDIDATE_NOT_READY",
        "Required GitHub checks changed or are incomplete at approval time.",
        { missing: missingLiveChecks },
      );
    }
    if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || pullRequest.mergeable === "CONFLICTING") {
      throw new BrokerError("CANDIDATE_BLOCKED", "The pull request has blocking review feedback or merge conflicts.");
    }

    await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      if (
        current.state !== "ready_for_approval" &&
        current.state !== "approved" &&
        current.state !== "merging"
      ) {
        throw new BrokerError("CANDIDATE_CHANGED", "Candidate state changed before approval could be recorded.");
      }
      const invalidTasks = batch.taskIds.filter((taskId) => {
        const task = requireTask(state, taskId);
        return task.status !== "published" || Boolean(task.lease && !leaseExpired(task));
      });
      if (invalidTasks.length > 0) {
        throw new BrokerError(
          "CANDIDATE_STATE_INVALID",
          "A task entered an editing state before approval could be recorded.",
          { taskIds: invalidTasks },
        );
      }
      const existingApproval = current.approval;
      const existingApprovalIsCurrent = Boolean(
        existingApproval &&
          !existingApproval.revocationRequestedAt &&
          existingApproval.candidateSha === current.sha &&
          existingApproval.baseSha === current.baseSha &&
          existingApproval.policyRevision === current.policyRevision &&
          (policy.authorizedActors.length === 0 || policy.authorizedActors.includes(existingApproval.actor)),
      );
      if (!existingApprovalIsCurrent) {
        current.approval = {
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
          actor: input.actor,
          approvedAt: now(),
        };
        current.state = "approved";
      }
      delete current.reason;
      audit("batch.approved", {
        actor: input.actor,
        batchId: id,
        details: {
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
          reused: existingApprovalIsCurrent,
        },
      });
      return structuredClone(batch);
    });

    // Approval was persisted before this second snapshot. If the forge changed after the first
    // inspection, reconciliation revokes/blocks it and this call must not queue the stale tuple.
    const mergeReady = await this.syncBatchLocked(id);
    const mergeReadyCandidate = mergeReady.candidate;
    if (
      mergeReady.status !== "published" ||
      !mergeReadyCandidate?.approval ||
      (mergeReadyCandidate.state !== "approved" && mergeReadyCandidate.state !== "merging")
    ) {
      throw new BrokerError(
        "CANDIDATE_CHANGED",
        "Candidate or forge state changed after approval was recorded; auto-merge was not enabled.",
      );
    }
    if (!this.config.publish.autoMerge || mergeReady.autoMergeEnabled) return mergeReady;
    await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      batch.autoMergePending = true;
      batch.autoMergeEnabled = false;
      audit("batch.auto_merge_attempting", {
        actor: input.actor,
        batchId: id,
        details: { candidateSha: current.sha, pullRequestUrl: batch.pullRequestUrl },
      });
    });
    let enabled = false;
    let warning: string | undefined;
    try {
      enabled = await this.publisher.enableAutoMerge(
        this.repo.root,
        mergeReady.pullRequestUrl ?? snapshot.pullRequestUrl,
        this.config,
        mergeReadyCandidate.sha,
      );
    } catch (error) {
      warning = errorMessage(error);
    }
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      batch.autoMergeEnabled = enabled;
      if (enabled) {
        current.state = "merging";
        delete batch.autoMergePending;
      } else {
        batch.autoMergePending = true;
      }
      if (warning) batch.publishWarning = warning;
      else delete batch.publishWarning;
      audit(enabled ? "batch.auto_merge_enabled" : "batch.auto_merge_pending", {
        actor: input.actor,
        batchId: id,
        details: { candidateSha: current.sha, ...(warning ? { warning } : {}) },
      });
      return structuredClone(batch);
    });
  }

  async reopenTaskForRevision(
    taskId: string,
    input: {
      holder: string;
      expectedPaths?: string[];
      worktree?: string;
      reason?: string;
      storeToken?: boolean;
      tokenFile?: string;
    },
  ): Promise<{ task: TaskRecord; batch: BatchRecord; token: string; tokenPath?: string }> {
    const snapshot = requireTask(await this.store.read(), taskId);
    if (!snapshot.batchId) throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} has no active batch.`);
    const expectedBatchId = snapshot.batchId;
    return await this.store.withBatchLock(
      expectedBatchId,
      async () => await this.reopenTaskForRevisionLocked(taskId, expectedBatchId, input),
    );
  }

  private async reopenTaskForRevisionLocked(
    taskId: string,
    expectedBatchId: string,
    input: {
      holder: string;
      expectedPaths?: string[];
      worktree?: string;
      reason?: string;
      storeToken?: boolean;
      tokenFile?: string;
    },
  ): Promise<{ task: TaskRecord; batch: BatchRecord; token: string; tokenPath?: string }> {
    const policy = approvalPolicy(this.config);
    if (!policy.required) throw new BrokerError("APPROVAL_DISABLED", "Candidate revision requires SHA-bound approval.");
    const token = createToken();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.config.leases.ttlSeconds * 1_000).toISOString();
    const reopened = await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      if (task.status !== "batched" && task.status !== "published") {
        throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} cannot be revised while ${task.status}.`);
      }
      if (!task.batchId) throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} has no active batch.`);
      if (task.batchId !== expectedBatchId) {
        throw new BrokerError("BATCH_CHANGED", `Task ${taskId} moved to another batch; retry the revision operation.`);
      }
      const batch = requireBatch(state, expectedBatchId);
      assertNoPendingRevision(batch);
      const candidate = requireCurrentCandidate(batch);
      if (
        candidate.state === "approved" ||
        candidate.state === "merging" ||
        batch.autoMergeEnabled ||
        batch.autoMergePending
      ) {
        throw new BrokerError(
          "APPROVAL_REVOCATION_REQUIRED",
          `Candidate ${candidate.sha} is approved. Request changes with its exact binding before reopening the task.`,
        );
      }
      if (task.lease && !leaseExpired(task)) {
        throw new BrokerError("LEASE_CONFLICT", `Task ${task.id} is already leased by ${task.lease.holder}.`);
      }
      const expectedPaths = input.expectedPaths ?? task.expectedPaths;
      if (expectedPaths.length === 0) {
        throw new BrokerError("PATHS_REQUIRED", "At least one expected path pattern is required to revise a task.");
      }
      assertNoLeaseConflict(state, task.id, expectedPaths, this.config.leases.serializedPatterns);
      task.expectedPaths = [...new Set(expectedPaths)];
      if (input.worktree) task.worktree = path.resolve(input.worktree);
      task.lease = {
        tokenHash: hashToken(token),
        holder: input.holder,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt,
      };
      task.updatedAt = timestamp;
      candidate.state = "changes_requested";
      candidate.reason = input.reason ?? `Revision opened by ${input.holder}.`;
      delete candidate.approval;
      audit("task.revision_opened", {
        actor: input.holder,
        taskId,
        batchId: batch.id,
        details: {
          expiresAt,
          candidateSha: candidate.sha,
          baseSha: candidate.baseSha,
          policyRevision: candidate.policyRevision,
        },
      });
      return { task: structuredClone(task), batch: structuredClone(batch), token };
    });
    if (input.storeToken === false) return reopened;
    const target = input.tokenFile ? path.resolve(input.tokenFile) : this.store.tokenPath(taskId);
    const tokenPath = await this.store.writeToken(taskId, token, target);
    return { ...reopened, tokenPath };
  }

  async reviseTask(
    taskId: string,
    commits: string[],
    token: string,
    options: { sinceBase?: boolean } = {},
  ): Promise<RevisionResult> {
    const snapshot = requireTask(await this.store.read(), taskId);
    if (!snapshot.batchId) throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} has no active batch.`);
    const expectedBatchId = snapshot.batchId;
    return await this.store.withBatchLock(
      expectedBatchId,
      async () => await this.reviseTaskLocked(taskId, expectedBatchId, commits, token, options),
    );
  }

  private async reviseTaskLocked(
    taskId: string,
    expectedBatchId: string,
    commits: string[],
    token: string,
    options: { sinceBase?: boolean } = {},
  ): Promise<RevisionResult> {
    return await this.store.withIntegrationLock(async () => {
      const state = await this.store.read();
      const snapshot = requireTask(state, taskId);
      if (snapshot.status !== "batched" && snapshot.status !== "published") {
        throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} cannot be revised while ${snapshot.status}.`);
      }
      verifyLease(snapshot, token);
      if (!snapshot.batchId) throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} has no active batch.`);
      if (snapshot.batchId !== expectedBatchId) {
        throw new BrokerError("BATCH_CHANGED", `Task ${taskId} moved to another batch; retry the revision operation.`);
      }
      const originalBatch = structuredClone(requireBatch(state, expectedBatchId));
      if (originalBatch.revisionIntent) {
        throw new BrokerError(
          "REVISION_IN_PROGRESS",
          `Batch ${originalBatch.id} already has a candidate revision awaiting recovery.`,
        );
      }
      const previousCandidate = structuredClone(requireCurrentCandidate(originalBatch));
      if (previousCandidate.state !== "changes_requested") {
        throw new BrokerError(
          "CHANGES_NOT_REQUESTED",
          `Candidate ${previousCandidate.sha} must be in changes_requested before it can be revised.`,
        );
      }
      if (!originalBatch.branchName) throw new BrokerError("NO_BRANCH", `Batch ${originalBatch.id} has no branch.`);
      if (originalBatch.pullRequestUrl) {
        if (
          !originalBatch.remoteUrlFingerprint ||
          !isHostQualifiedForgeRepository(originalBatch.forgeRepository)
        ) {
          throw new BrokerError(
            "BATCH_TARGET_UNBOUND",
            `Batch ${originalBatch.id} has no durable publication target and cannot safely replace its remote branch. Refresh it first.`,
          );
        }
        const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, originalBatch.pullRequestUrl);
        if (pullRequest.state !== "OPEN" || pullRequest.headRefOid !== previousCandidate.sha) {
          throw new BrokerError(
            "CANDIDATE_MISMATCH",
            "The pull request no longer points at the candidate being revised; no branch was changed.",
          );
        }
      }

      const resolved = await this.resolveTaskCommits(snapshot, commits, options);
      const revisedTask: TaskRecord = {
        ...structuredClone(snapshot),
        commits: resolved.commits,
        actualPaths: resolved.actualPaths,
        warnings: resolved.warnings,
      };
      const tasks = originalBatch.taskIds.map((id) =>
        id === taskId ? revisedTask : structuredClone(requireTask(state, id)),
      );
      const baseSha = await this.currentBatchTargetSha(originalBatch);
      const revision = previousCandidate.revision + 1;
      const worktree = path.join(this.store.worktreesDirectory, `${originalBatch.id}-revision-${revision}`);
      const nextBatch: BatchRecord = {
        ...structuredClone(originalBatch),
        baseSha,
        worktree,
        validations: [],
      };
      delete nextBatch.integratedHeadSha;
      delete nextBatch.provenancePath;
      delete nextBatch.autoMergeEnabled;
      delete nextBatch.autoMergePending;
      delete nextBatch.changeRequestIntent;
      delete nextBatch.publishWarning;
      delete nextBatch.refreshRequired;
      delete nextBatch.refreshCloseIntent;
      delete nextBatch.error;
      delete nextBatch.candidate;

      const signingPrivateKey = await this.provenanceSigningPrivateKey();
      let added = false;
      let validationCacheDirectory: string | undefined;
      try {
        validationCacheDirectory = await createValidationCacheDirectory();
        await this.repo.addDetachedWorktree(worktree, baseSha);
        added = true;
        for (const task of tasks) {
          for (const commit of task.commits) {
            const picked = await this.repo.cherryPick(worktree, commit);
            if (picked.exitCode !== 0) {
              await this.repo.abortCherryPick(worktree);
              throw new BrokerError(
                "CHERRY_PICK_CONFLICT",
                `Commit ${commit} from task ${task.id} did not apply cleanly while revising the candidate.`,
                { taskId: task.id, commit, stdout: picked.stdout, stderr: picked.stderr },
              );
            }
          }
          const focusedHead = await this.repo.currentHead(worktree);
          nextBatch.validations.push(
            ...(await runValidators({
              validators: this.config.validation.focused,
              scope: "focused",
              cwd: worktree,
              taskId: task.id,
              files: task.actualPaths,
              baseSha,
              headSha: focusedHead,
              batchId: nextBatch.id,
              cacheDirectory: validationCacheDirectory,
              ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
            })),
          );
          await this.assertValidatorPreservedCandidate(worktree, focusedHead, "focused");
        }
        let headSha = await this.repo.currentHead(worktree);
        const allFiles = [...new Set(tasks.flatMap((task) => task.actualPaths))].sort();
        nextBatch.validations.push(
          ...(await runValidators({
            validators: this.config.validation.authoritative,
            scope: "authoritative",
            cwd: worktree,
            files: allFiles,
            baseSha,
            headSha,
            batchId: nextBatch.id,
            cacheDirectory: validationCacheDirectory,
            ...(this.config.validation.shell ? { shell: this.config.validation.shell } : {}),
          })),
        );
        await this.assertValidatorPreservedCandidate(worktree, headSha, "authoritative");
        if (this.config.integration.history === "squash") {
          headSha = await this.repo.squash(
            worktree,
            baseSha,
            `Integrate batch ${nextBatch.id} revision ${revision}\n\n${tasks.map((task) => `Task: ${task.id}`).join("\n")}`,
          );
        }
        const provenance = this.config.integration.provenance;
        if (provenance?.enabled) {
          const integratedHeadSha = headSha;
          const integratedPaths = await this.repo.changedFilesBetween(baseSha, integratedHeadSha);
          const relativePath = provenancePath(provenance.directory, nextBatch.id);
          let record = buildBatchProvenance({
            batch: nextBatch,
            tasks,
            integratedHeadSha,
            integratedPaths,
            history: this.config.integration.history,
          });
          if (signingPrivateKey && provenance.publicKey) {
            record = signBatchProvenance(record, signingPrivateKey, provenance.publicKey);
          } else if (provenance.requireSignature) {
            throw new BrokerError("SIGNING_KEY_REQUIRED", "Signed provenance is required for this batch.");
          }
          headSha = await this.repo.commitGeneratedFile(
            worktree,
            relativePath,
            `${JSON.stringify(record, null, 2)}\n`,
            `Record Merge Broker batch ${nextBatch.id} revision ${revision}`,
          );
          nextBatch.integratedHeadSha = integratedHeadSha;
          nextBatch.provenancePath = relativePath;
        }
        nextBatch.headSha = headSha;
        nextBatch.finishedAt = now();
        nextBatch.candidate = makeCandidate(this.config, headSha, baseSha, revision);
      } finally {
        if (validationCacheDirectory) {
          await removeValidationCacheDirectory(validationCacheDirectory).catch(() => undefined);
        }
        if (added) await this.repo.removeWorktree(worktree);
      }
      delete nextBatch.worktree;

      const nextCandidate = requireCurrentCandidate(nextBatch);
      const intent = await this.store.transaction((current, audit) => {
        const task = requireTask(current, taskId);
        verifyLease(task, token);
        const storedBatch = requireBatch(current, originalBatch.id);
        const storedCandidate = requireCurrentCandidate(storedBatch);
        if (storedBatch.revisionIntent) {
          throw new BrokerError("REVISION_IN_PROGRESS", `Batch ${storedBatch.id} already has a revision intent.`);
        }
        if (storedCandidate.sha !== previousCandidate.sha || storedCandidate.state !== "changes_requested") {
          throw new BrokerError("CANDIDATE_CHANGED", "Candidate state changed while its revision was assembled.");
        }
        const prepared: CandidateRevisionIntent = {
          revision,
          taskId,
          previousCandidateSha: previousCandidate.sha,
          candidateSha: nextCandidate.sha,
          branchName: originalBatch.branchName ?? "",
          createdAt: now(),
          nextBatch: structuredClone(nextBatch),
          revisedTask: {
            commits: [...resolved.commits],
            actualPaths: [...resolved.actualPaths],
            warnings: [...resolved.warnings],
            submittedAt: now(),
          },
        };
        storedBatch.revisionIntent = prepared;
        audit("batch.candidate_revision_prepared", {
          ...(task.lease?.holder ? { actor: task.lease.holder } : {}),
          taskId,
          batchId: storedBatch.id,
          details: {
            previousCandidateSha: prepared.previousCandidateSha,
            candidateSha: prepared.candidateSha,
            revision,
          },
        });
        return structuredClone(prepared);
      });
      if (originalBatch.pullRequestUrl) {
        await this.repo.replaceRemoteBranch(
          await this.repo.boundRemoteUrl(
            originalBatch.remote ?? this.config.remote,
            originalBatch.remoteUrlFingerprint,
          ),
          intent.branchName,
          intent.candidateSha,
          intent.previousCandidateSha,
        );
      } else {
        await this.repo.replaceLocalBranch(intent.branchName, intent.candidateSha);
      }

      const updated = await this.store.transaction((current, audit) => {
        return finalizeCandidateRevision(current, audit, originalBatch.id, intent);
      });
      await this.writeRevisionArtifacts(updated);
      if (updated.batch.pullRequestUrl) {
        try {
          await this.publisher.updatePullRequestBody(
            this.repo.root,
            updated.batch.pullRequestUrl,
            updated.batch,
            tasks,
          );
        } catch (error) {
          const warning = errorMessage(error);
          const warned = await this.store.transaction((current, audit) => {
            const batch = requireBatch(current, updated.batch.id);
            batch.publishWarning = warning;
            audit("batch.pull_request_update_failed", {
              batchId: batch.id,
              details: { warning, candidateSha: batch.candidate?.sha },
            });
            return structuredClone(batch);
          });
          updated.batch = warned;
        }
      }
      return updated;
    });
  }

  async syncBatch(id: string): Promise<BatchRecord> {
    return await this.store.withBatchLock(id, async () => await this.syncBatchLocked(id));
  }

  private async syncBatchLocked(id: string): Promise<BatchRecord> {
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    assertNoPendingRevision(batch);
    if (batch.changeRequestIntent) return await this.completeChangeRequestLocked(id);
    if (batch.status === "merged") return structuredClone(batch);
    let mergedAt: string | undefined;
    let mergeCommitSha: string | undefined;
    if (batch.pullRequestUrl) {
      const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, batch.pullRequestUrl);
      const expectedHead = batch.candidate?.sha ?? batch.headSha;
      const exactHead = expectedHead !== undefined && pullRequest.headRefOid === expectedHead;
      const exactBaseBranch = pullRequest.baseRefName === batch.baseBranch;
      const policy = approvalPolicy(this.config);
      if (!expectedHead || !pullRequest.headRefOid || !pullRequest.baseRefName) {
        throw new BrokerError(
          "PULL_REQUEST_IDENTITY_UNKNOWN",
          `The forge did not return enough identity information to reconcile batch ${id}; no merge state was changed.`,
          {
            expectedHead,
            actualHead: pullRequest.headRefOid,
            expectedBaseBranch: batch.baseBranch,
            actualBaseBranch: pullRequest.baseRefName,
          },
        );
      }
      if (pullRequest.state === "OPEN" && !pullRequest.baseRefOid) {
        throw new BrokerError(
          "PULL_REQUEST_BASE_UNKNOWN",
          `The forge did not return the current base SHA for batch ${id}; auto-merge cannot be reconciled safely.`,
          { batchId: id, pullRequestUrl: batch.pullRequestUrl },
        );
      }
      if (pullRequest.state === "MERGED" && (batch.refreshRequired || batch.refreshCloseIntent)) {
        return await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          const reason = "The pull request merged after the broker had durably started superseding this batch.";
          const refreshStartedAt = stored.refreshCloseIntent?.startedAt;
          stored.status = "failed";
          stored.error = reason;
          stored.finishedAt = now();
          stored.autoMergeEnabled = false;
          delete stored.autoMergePending;
          delete stored.refreshRequired;
          delete stored.refreshCloseIntent;
          if (stored.candidate) {
            stored.candidate.state = "blocked";
            stored.candidate.reason = reason;
            delete stored.candidate.approval;
          }
          for (const taskId of stored.taskIds) {
            const task = requireTask(current, taskId);
            task.status = "failed";
            task.lastError = reason;
            task.updatedAt = now();
          }
          audit("batch.merge_invariant_violated", {
            batchId: id,
            details: {
              reason,
              pullRequestUrl: stored.pullRequestUrl,
              refreshStartedAt,
            },
          });
          return structuredClone(stored);
        });
      }
      if (
        pullRequest.state === "OPEN" &&
        !this.config.publish.autoMerge &&
        (batch.autoMergeEnabled || batch.autoMergePending || pullRequest.autoMergeEnabled !== false)
      ) {
        const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
        if (!disabled) {
          throw new BrokerError(
            "CANDIDATE_FINAL",
            "The pull request merged while the broker was disabling auto-merge. Sync again to record it.",
          );
        }
        return await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          stored.autoMergeEnabled = false;
          delete stored.autoMergePending;
          delete stored.publishWarning;
          if (stored.candidate?.approval && stored.candidate.state === "merging") {
            stored.candidate.state = "approved";
          }
          audit("batch.auto_merge_disabled", {
            batchId: id,
            details: { reason: "publish.autoMerge is disabled" },
          });
          return structuredClone(stored);
        });
      }

      // PR identity is an integration invariant, not an optional approval feature. Without this
      // guard a merged PR at an unrelated head/base can release every dependency in the batch.
      if ((!exactHead || !exactBaseBranch) && (!policy.required || pullRequest.state === "CLOSED")) {
        if (
          pullRequest.state === "OPEN" &&
          (batch.autoMergeEnabled || batch.autoMergePending || this.config.publish.autoMerge)
        ) {
          await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
        }
        return await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          const reason = !exactHead
            ? `Pull request head ${pullRequest.headRefOid ?? "unknown"} does not match validated head ${expectedHead ?? "unknown"}.`
            : `Pull request targets ${pullRequest.baseRefName ?? "unknown"}, not ${batch.baseBranch}.`;
          stored.status = "failed";
          stored.error = reason;
          stored.finishedAt = now();
          stored.autoMergeEnabled = false;
          delete stored.autoMergePending;
          delete stored.refreshRequired;
          delete stored.refreshCloseIntent;
          if (stored.candidate) {
            stored.candidate.state = "blocked";
            stored.candidate.reason = reason;
            delete stored.candidate.approval;
          }
          for (const taskId of stored.taskIds) {
            const task = requireTask(current, taskId);
            task.status = "failed";
            task.lastError = reason;
            task.updatedAt = now();
          }
          audit("batch.merge_invariant_violated", {
            batchId: id,
            details: {
              expectedHead,
              actualHead: pullRequest.headRefOid,
              expectedBaseBranch: batch.baseBranch,
              actualBaseBranch: pullRequest.baseRefName,
              pullRequestState: pullRequest.state,
            },
          });
          return structuredClone(stored);
        });
      }
      // A pull request closed without merging means the work was rejected, not completed. Leaving
      // the batch "published" strands every task in it forever and reads like success.
      if (pullRequest.state === "CLOSED") {
        // Refresh closes the stale PR before it can atomically requeue the tasks and record the old
        // batch as superseded. If the process stopped in that window, this durable intent
        // distinguishes the expected close from a reviewer rejecting the work. Leave it retryable;
        // `refreshBatch` uses an idempotent close and will finish the hand-off.
        if (batch.refreshCloseIntent?.pullRequestUrl === batch.pullRequestUrl) {
          return structuredClone(batch);
        }
        return await this.closeBatchLocked(
          id,
          `Pull request ${batch.pullRequestUrl} was closed without merging.`,
          { allowApprovalRevocation: true, allowRefreshRequired: true },
        );
      }
      if (
        pullRequest.state === "OPEN" &&
        batch.candidate &&
        !batch.candidate.approval &&
        (batch.autoMergeEnabled ||
          batch.autoMergePending ||
          pullRequest.autoMergeEnabled !== false)
      ) {
        // A merge queue is never authorized merely by having a candidate. Journal the uncertain
        // remote side effect before disabling it so a crash cannot turn a lost response into an
        // unapproved merge that the now-idle broker stops reconciling.
        await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          const currentCandidate = requireCurrentCandidate(stored);
          if (currentCandidate.approval) {
            throw new BrokerError("CANDIDATE_CHANGED", "Candidate approval changed before remote revocation.");
          }
          stored.autoMergeEnabled = false;
          stored.autoMergePending = true;
          audit("batch.unauthorized_auto_merge_detected", {
            batchId: id,
            details: { candidateSha: currentCandidate.sha, pullRequestUrl: stored.pullRequestUrl },
          });
        });
        const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
        if (!disabled) {
          throw new BrokerError(
            "CANDIDATE_FINAL",
            "The pull request merged while an unapproved auto-merge queue was being revoked. Sync again to record the invariant violation.",
          );
        }
        await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          const currentCandidate = requireCurrentCandidate(stored);
          stored.autoMergeEnabled = false;
          delete stored.autoMergePending;
          delete stored.publishWarning;
          currentCandidate.state = candidateState(currentCandidate);
          currentCandidate.reason = "An unauthorized remote auto-merge queue was disabled; exact approval is still required.";
          audit("batch.unauthorized_auto_merge_disabled", {
            batchId: id,
            details: { candidateSha: currentCandidate.sha, pullRequestUrl: stored.pullRequestUrl },
          });
        });
      }
      if (policy.required || batch.candidate) {
        if (!batch.candidate) {
          if (pullRequest.state === "MERGED") {
            return await this.store.transaction((current, audit) => {
              const stored = requireBatch(current, id);
              stored.status = "failed";
              stored.error = "GitHub merged an untracked pre-approval candidate after approval policy was enabled.";
              stored.finishedAt = now();
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
              for (const taskId of stored.taskIds) {
                const task = requireTask(current, taskId);
                task.status = "failed";
                task.lastError = stored.error;
                task.updatedAt = now();
              }
              audit("batch.merge_invariant_violated", {
                batchId: id,
                details: { actualHead: pullRequest.headRefOid, approvalPresent: false, legacyCandidate: true },
              });
              return structuredClone(stored);
            });
          }
          if (
            !batch.headSha ||
            pullRequest.headRefOid !== batch.headSha ||
            pullRequest.baseRefName !== batch.baseBranch ||
            pullRequest.baseRefOid !== batch.baseSha
          ) {
            if (
              batch.autoMergeEnabled ||
              batch.autoMergePending ||
              pullRequest.autoMergeEnabled !== false
            ) {
              await this.store.transaction((current, audit) => {
                const stored = requireBatch(current, id);
                stored.autoMergeEnabled = false;
                stored.autoMergePending = true;
                audit("batch.legacy_auto_merge_revocation_started", {
                  batchId: id,
                  details: { pullRequestUrl: stored.pullRequestUrl, reason: "pull request identity changed" },
                });
              });
              const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
              if (!disabled) {
                throw new BrokerError(
                  "CANDIDATE_FINAL",
                  "The legacy pull request merged while its mismatched auto-merge queue was being revoked.",
                );
              }
              await this.store.transaction((current, audit) => {
                const stored = requireBatch(current, id);
                stored.autoMergeEnabled = false;
                delete stored.autoMergePending;
                audit("batch.legacy_auto_merge_revoked", {
                  batchId: id,
                  details: { pullRequestUrl: stored.pullRequestUrl, reason: "pull request identity changed" },
                });
              });
            }
            throw new BrokerError(
              "CANDIDATE_MISMATCH",
              "Approval policy was enabled for a legacy batch whose PR head or base no longer matches broker state.",
              {
                expectedHead: batch.headSha,
                actualHead: pullRequest.headRefOid,
                expectedBase: batch.baseSha,
                actualBase: pullRequest.baseRefOid,
                expectedBaseBranch: batch.baseBranch,
                actualBaseBranch: pullRequest.baseRefName,
              },
            );
          }
          if (
            batch.autoMergeEnabled ||
            batch.autoMergePending ||
            pullRequest.autoMergeEnabled !== false
          ) {
            const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
            if (!disabled) {
              throw new BrokerError("CANDIDATE_FINAL", "The legacy pull request merged before auto-merge was disabled.");
            }
          }
          return await this.store.transaction((current, audit) => {
            const stored = requireBatch(current, id);
            if (!stored.headSha) throw new BrokerError("NO_CANDIDATE", `Batch ${id} has no head SHA.`);
            stored.candidate = makeCandidate(this.config, stored.headSha, stored.baseSha, 1);
            stored.candidateHistory ??= [];
            stored.autoMergeEnabled = false;
            delete stored.autoMergePending;
            audit("batch.candidate_adopted", {
              batchId: id,
              details: {
                candidateSha: stored.candidate.sha,
                baseSha: stored.candidate.baseSha,
                policyRevision: stored.candidate.policyRevision,
              },
            });
            return structuredClone(stored);
          });
        }
        const candidate = requireCurrentCandidate(batch);
        const exactBase = pullRequest.baseRefOid === candidate.baseSha;
        const requiredChecks = policy.requiredChecks;
        const currentRequiredEvidence = requiredEvidenceNames(this.config);
        const policyCurrent =
          policy.required &&
          candidate.policyRevision === policy.policyRevision &&
          candidate.requiredVerifications.length === currentRequiredEvidence.length &&
          candidate.requiredVerifications.every((name) => currentRequiredEvidence.includes(name));
        const approvalActorCurrent = Boolean(
          !candidate.approval ||
            policy.authorizedActors.length === 0 ||
            policy.authorizedActors.includes(candidate.approval.actor),
        );
        const githubCheckPassed = (check: (typeof pullRequest.checks)[number]): boolean => {
          const conclusion = check.conclusion?.toUpperCase();
          const status = check.status.toUpperCase();
          return (
            status === "SUCCESS" ||
            (status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion ?? ""))
          );
        };
        const githubCheckFailed = (check: (typeof pullRequest.checks)[number]): boolean => {
          const conclusion = check.conclusion?.toUpperCase();
          const status = check.status.toUpperCase();
          return (
            status === "ERROR" ||
            status === "FAILURE" ||
            (status === "COMPLETED" &&
              ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
                conclusion ?? "",
              ))
          );
        };
        const checkPassed = (checkName: string): boolean => {
          const checks = pullRequest.checks.filter((item) => item.name === checkName);
          return checks.length > 0 && checks.every(githubCheckPassed);
        };
        const approvalInvalidated = Boolean(
          candidate.approval &&
            (candidate.approval.revocationRequestedAt ||
              !policyCurrent ||
              !approvalActorCurrent ||
              !exactHead ||
              !exactBaseBranch ||
              !exactBase ||
              pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
              pullRequest.mergeable === "CONFLICTING" ||
              !requiredChecks.every(checkPassed)),
        );
        if (approvalInvalidated && pullRequest.state !== "MERGED") {
          const revocationReason = candidate.approval?.revocationReason ?? (
            !policyCurrent
              ? "Approval policy changed after this candidate was assembled."
              : !approvalActorCurrent
                ? `Approver ${candidate.approval?.actor ?? "unknown"} is no longer authorized by the current policy.`
              : !exactHead
                ? "Pull request head changed after approval."
                : !exactBaseBranch
                  ? "Pull request target branch changed after approval."
                  : !exactBase
                    ? "Pull request base moved after approval."
                    : pullRequest.reviewDecision === "CHANGES_REQUESTED"
                      ? "GitHub review requested changes after approval."
                      : pullRequest.mergeable === "CONFLICTING"
                        ? "GitHub reported merge conflicts after approval."
                        : "Required GitHub verification changed after approval."
          );
          await this.store.transaction((current, audit) => {
            const stored = requireBatch(current, id);
            const currentCandidate = requireCurrentCandidate(stored);
            if (currentCandidate.sha !== candidate.sha || !currentCandidate.approval) {
              throw new BrokerError("CANDIDATE_CHANGED", "Candidate approval changed before revocation was recorded.");
            }
            currentCandidate.approval.revocationRequestedAt ??= now();
            currentCandidate.approval.revocationReason ??= revocationReason;
            audit("batch.approval_revocation_started", {
              actor: "merge-broker",
              batchId: id,
              details: {
                candidateSha: currentCandidate.sha,
                reason: currentCandidate.approval.revocationReason,
              },
            });
          });
          const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
          if (!disabled) {
            throw new BrokerError(
              "CANDIDATE_FINAL",
              "The pull request merged before invalidated approval could be revoked. Sync again to record the result.",
            );
          }
        }

        if (pullRequest.state === "MERGED") {
          const approval = candidate.approval;
          const mergedCandidateProven = exactBase || await this.proveMergedCandidate(
            batch,
            candidate,
            pullRequest.mergeCommitSha,
          );
          if (
            !policyCurrent ||
            !approvalActorCurrent ||
            !exactHead ||
            !exactBaseBranch ||
            !mergedCandidateProven ||
            !approval ||
            !approval.confirmedAt ||
            approval.revocationRequestedAt ||
            approval.candidateSha !== candidate.sha ||
            approval.baseSha !== candidate.baseSha ||
            approval.policyRevision !== candidate.policyRevision ||
            pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
            pullRequest.mergeable === "CONFLICTING" ||
            !requiredChecks.every(checkPassed)
          ) {
            return await this.store.transaction((current, audit) => {
              const stored = requireBatch(current, id);
              const currentCandidate = requireCurrentCandidate(stored);
              currentCandidate.state = "blocked";
              currentCandidate.reason = "GitHub merged a pull request that did not satisfy the broker candidate, target, and approval invariant.";
              delete currentCandidate.approval;
              stored.status = "failed";
              stored.error = currentCandidate.reason;
              stored.finishedAt = now();
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
              delete stored.refreshRequired;
              delete stored.refreshCloseIntent;
              for (const taskId of stored.taskIds) {
                const task = requireTask(current, taskId);
                task.status = "failed";
                task.lastError = stored.error;
                task.updatedAt = now();
              }
              audit("batch.merge_invariant_violated", {
                batchId: id,
                details: {
                  expectedHead: currentCandidate.sha,
                  actualHead: pullRequest.headRefOid,
                  expectedBaseBranch: stored.baseBranch,
                  actualBaseBranch: pullRequest.baseRefName,
                  expectedBase: currentCandidate.baseSha,
                  actualBase: pullRequest.baseRefOid,
                  mergedCandidateProven,
                  approvalPresent: Boolean(approval),
                },
              });
              return structuredClone(stored);
            });
          }
        } else {
          return await this.store.transaction((current, audit) => {
            const stored = requireBatch(current, id);
            const currentCandidate = requireCurrentCandidate(stored);
            if (!policyCurrent) {
              currentCandidate.state = "blocked";
              currentCandidate.reason = "Approval policy changed after this candidate was assembled. Rebuild the candidate.";
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
              stored.refreshRequired = true;
            } else if (!exactHead || !exactBaseBranch || !exactBase) {
              currentCandidate.state = "blocked";
              currentCandidate.reason = !exactHead
                ? `Pull request head changed from ${currentCandidate.sha} to ${pullRequest.headRefOid ?? "unknown"}.`
                : !exactBaseBranch
                  ? `Pull request base branch changed from ${stored.baseBranch} to ${pullRequest.baseRefName}.`
                  : `Base moved from ${currentCandidate.baseSha} to ${pullRequest.baseRefOid}. Rebuild the candidate.`;
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
              if (exactHead && exactBaseBranch && !exactBase) stored.refreshRequired = true;
              else {
                delete stored.refreshRequired;
                delete stored.refreshCloseIntent;
              }
            } else if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
              currentCandidate.state = "changes_requested";
              currentCandidate.reason = "GitHub review requested changes.";
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
            } else if (pullRequest.mergeable === "CONFLICTING") {
              currentCandidate.state = "blocked";
              currentCandidate.reason = "GitHub reports merge conflicts.";
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
            } else {
              currentCandidate.verifications = currentCandidate.verifications.filter(
                (item) => !requiredChecks.includes(item.name.replace(/^github-check:/u, "")),
              );
              for (const checkName of requiredChecks) {
                const checks = pullRequest.checks.filter((item) => item.name === checkName);
                if (checks.length === 0) continue;
                const passed = checks.every(githubCheckPassed);
                const failed = checks.some(githubCheckFailed);
                if (!passed && !failed) continue;
                const detailsUrl = checks.find((check) => check.detailsUrl)?.detailsUrl;
                currentCandidate.verifications.push({
                  name: `github-check:${checkName}`,
                  source: "github-check",
                  status: passed ? "passed" : "failed",
                  candidateSha: currentCandidate.sha,
                  baseSha: currentCandidate.baseSha,
                  policyRevision: currentCandidate.policyRevision,
                  actor: "github",
                  recordedAt: now(),
                  ...(detailsUrl ? { evidenceUrl: detailsUrl } : {}),
                });
              }
              currentCandidate.state = candidateState(currentCandidate);
              const revocationReason = currentCandidate.approval?.revocationReason;
              const revocationRequested = Boolean(currentCandidate.approval?.revocationRequestedAt);
              if (
                currentCandidate.approval &&
                !currentCandidate.approval.revocationRequestedAt &&
                !currentCandidate.approval.confirmedAt
              ) {
                currentCandidate.approval.confirmedAt = now();
                audit("batch.approval_confirmed", {
                  actor: currentCandidate.approval.actor,
                  batchId: id,
                  details: {
                    candidateSha: currentCandidate.sha,
                    baseSha: currentCandidate.baseSha,
                    policyRevision: currentCandidate.policyRevision,
                  },
                });
              }
              if (
                currentCandidate.approval &&
                (revocationRequested ||
                  (currentCandidate.state !== "approved" && currentCandidate.state !== "merging"))
              ) {
                delete currentCandidate.approval;
                stored.autoMergeEnabled = false;
                delete stored.autoMergePending;
                currentCandidate.state = candidateState(currentCandidate);
                currentCandidate.reason = revocationReason
                  ?? "Required GitHub verification changed after approval; approval was revoked.";
              } else {
                delete currentCandidate.reason;
              }
              const queueAuthorized = Boolean(
                this.config.publish.autoMerge &&
                  currentCandidate.approval?.confirmedAt &&
                  !currentCandidate.approval.revocationRequestedAt &&
                  (currentCandidate.state === "approved" || currentCandidate.state === "merging"),
              );
              if (queueAuthorized && typeof pullRequest.autoMergeEnabled === "boolean") {
                stored.autoMergeEnabled = pullRequest.autoMergeEnabled;
                delete stored.autoMergePending;
                currentCandidate.state = pullRequest.autoMergeEnabled ? "merging" : "approved";
              } else if (pullRequest.autoMergeEnabled === false) {
                stored.autoMergeEnabled = false;
                delete stored.autoMergePending;
              }
            }
            audit("batch.candidate_synced", {
              batchId: id,
              details: {
                candidateSha: currentCandidate.sha,
                candidateState: currentCandidate.state,
                checks: pullRequest.checks.map((check) => ({ name: check.name, status: check.status })),
              },
            });
            return structuredClone(stored);
          });
        }
      }
      if (!policy.required && pullRequest.state === "OPEN" && pullRequest.baseRefOid !== batch.baseSha) {
        if (batch.autoMergeEnabled || batch.autoMergePending || this.config.publish.autoMerge) {
          const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
          if (!disabled) {
            return await this.store.transaction((current, audit) => {
              const stored = requireBatch(current, id);
              const reason = "The pull request merged while its base identity was no longer valid.";
              stored.status = "failed";
              stored.error = reason;
              stored.finishedAt = now();
              stored.autoMergeEnabled = false;
              delete stored.autoMergePending;
              delete stored.refreshRequired;
              delete stored.refreshCloseIntent;
              for (const taskId of stored.taskIds) {
                const task = requireTask(current, taskId);
                task.status = "failed";
                task.lastError = reason;
                task.updatedAt = now();
              }
              audit("batch.merge_invariant_violated", {
                batchId: id,
                details: { expectedBase: batch.baseSha, actualBase: pullRequest.baseRefOid },
              });
              return structuredClone(stored);
            });
          }
        }
        return await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          stored.autoMergeEnabled = false;
          delete stored.autoMergePending;
          stored.refreshRequired = true;
          stored.publishWarning = pullRequest.baseRefOid
            ? `Base moved from ${stored.baseSha} to ${pullRequest.baseRefOid}; refresh the batch before merging.`
            : "The forge did not report the pull request base SHA; auto-merge was disabled until identity can be verified.";
          audit("batch.base_stale", {
            batchId: id,
            details: { expectedBase: stored.baseSha, actualBase: pullRequest.baseRefOid },
          });
          return structuredClone(stored);
        });
      }
      if (
        !policy.required &&
        !batch.candidate &&
        pullRequest.state === "OPEN" &&
        typeof pullRequest.autoMergeEnabled === "boolean" &&
        (batch.autoMergeEnabled !== pullRequest.autoMergeEnabled || Boolean(batch.autoMergePending))
      ) {
        const observedAutoMergeEnabled = pullRequest.autoMergeEnabled;
        return await this.store.transaction((current, audit) => {
          const stored = requireBatch(current, id);
          stored.autoMergeEnabled = observedAutoMergeEnabled;
          delete stored.autoMergePending;
          audit("batch.auto_merge_reconciled", {
            batchId: id,
            details: {
              pullRequestUrl: stored.pullRequestUrl,
              autoMergeEnabled: observedAutoMergeEnabled,
            },
          });
          return structuredClone(stored);
        });
      }
      if (
        !policy.required &&
        !batch.candidate &&
        pullRequest.state === "MERGED" &&
        pullRequest.baseRefOid !== batch.baseSha
      ) {
        const mergedCandidateProven = await this.proveMergedCandidate(
          batch,
          { sha: expectedHead, baseSha: batch.baseSha },
          pullRequest.mergeCommitSha,
        );
        if (!mergedCandidateProven) {
          return await this.store.transaction((current, audit) => {
            const stored = requireBatch(current, id);
            const reason = "The merged pull request could not be proven to contain the validated candidate on its recorded base.";
            stored.status = "failed";
            stored.error = reason;
            stored.finishedAt = now();
            stored.autoMergeEnabled = false;
            delete stored.autoMergePending;
            delete stored.refreshRequired;
            delete stored.refreshCloseIntent;
            for (const taskId of stored.taskIds) {
              const task = requireTask(current, taskId);
              task.status = "failed";
              task.lastError = reason;
              task.updatedAt = now();
            }
            audit("batch.merge_invariant_violated", {
              batchId: id,
              details: {
                expectedHead,
                expectedBase: stored.baseSha,
                actualBase: pullRequest.baseRefOid,
                mergeCommitSha: pullRequest.mergeCommitSha,
              },
            });
            return structuredClone(stored);
          });
        }
      }
      if (pullRequest.state !== "MERGED") return structuredClone(batch);
      mergedAt = pullRequest.mergedAt ?? now();
      mergeCommitSha = pullRequest.mergeCommitSha;
    } else if (batch.headSha) {
      if (!batch.remoteUrlFingerprint) {
        throw new BrokerError(
          "BATCH_TARGET_UNBOUND",
          `Branch batch ${id} predates durable remote binding and cannot be reconciled against a mutable remote name.`,
        );
      }
      const remoteName = batch.remote ?? this.config.remote;
      const remote = await this.repo.boundRemoteUrl(remoteName, batch.remoteUrlFingerprint);
      const targetSha = await this.repo.fetchBranchHead(remote, batch.baseBranch);
      if (!targetSha) {
        throw new BrokerError(
          "BASE_REFRESH_FAILED",
          `Could not refresh ${remoteName}/${batch.baseBranch} while reconciling batch ${id}.`,
        );
      }
      const check = await this.repo.git(
        ["merge-base", "--is-ancestor", batch.headSha, targetSha],
        this.repo.root,
        true,
      );
      if (check.exitCode !== 0) return structuredClone(batch);
      mergedAt = now();
      mergeCommitSha = batch.headSha;
    } else {
      throw new BrokerError("BATCH_NOT_SYNCABLE", `Batch ${id} has no PR URL or head commit.`);
    }
    return await this.markBatchMergedLocked(id, mergedAt, mergeCommitSha);
  }

  async syncPublishedBatches(): Promise<{
    synced: BatchRecord[];
    closed: BatchRecord[];
    unchanged: BatchRecord[];
    errors: Array<{ batchId: string; error: string }>;
  }> {
    const state = await this.store.read();
    const published = Object.values(state.batches).filter((batch) => batch.status === "published");
    const synced: BatchRecord[] = [];
    const closed: BatchRecord[] = [];
    const unchanged: BatchRecord[] = [];
    const errors: Array<{ batchId: string; error: string }> = [];
    for (const batch of published) {
      try {
        const result = await this.syncBatch(batch.id);
        if (result.status === "merged") synced.push(result);
        else if (result.status === "closed") closed.push(result);
        else unchanged.push(result);
      } catch (error) {
        errors.push({ batchId: batch.id, error: errorMessage(error) });
      }
    }
    return { synced, closed, unchanged, errors };
  }

  /**
   * Records that a published batch will never merge and pauses its tasks for revision.
   *
   * A closed pull request is an explicit rejection signal. Re-queueing the unchanged receipts made
   * an eager broker publish the same rejected work again before its worker could attach a fix. Base
   * movement has its own `refreshBatch` path, and retrying an unchanged receipt remains available as
   * an explicit operator action through `task retry`.
   */
  async closeBatch(id: string, reason: string): Promise<BatchRecord> {
    return await this.store.withBatchLock(id, async () => {
      const batch = requireBatch(await this.store.read(), id);
      // Intent guards deliberately run before forge reconciliation. A caller must not use this
      // low-level state transition to bypass a durable remote revocation or refresh operation.
      if (
        batch.changeRequestIntent ||
        batch.candidate?.approval?.revocationRequestedAt ||
        batch.refreshRequired ||
        batch.refreshCloseIntent
      ) {
        return await this.closeBatchLocked(id, reason);
      }
      if (batch.pullRequestUrl) {
        // `closeBatch` records an observed terminal forge state; it is not permission to orphan a
        // still-live pull request or auto-merge queue. Reuse the full identity/approval reconciler
        // and then make the decision from a fresh forge observation. Local status may already be
        // `closed` even though a reviewer subsequently reopened the pull request.
        const reconciled = await this.syncBatchLocked(id);
        const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, batch.pullRequestUrl);
        if (pullRequest.state === "MERGED") {
          // The PR may have merged after the first reconciliation. Re-enter the full merge proof
          // instead of returning a stale local `closed` snapshot and losing the terminal event.
          return await this.syncBatchLocked(id);
        }
        if (pullRequest.state !== "CLOSED" && pullRequest.state !== "MERGED") {
          throw new BrokerError(
            "PULL_REQUEST_STILL_OPEN",
            `Pull request ${batch.pullRequestUrl} is ${pullRequest.state || "not terminal"}. Close it at the forge or request changes before closing batch ${id}.`,
          );
        }
        return reconciled;
      }
      if (batch.autoMergeEnabled || batch.autoMergePending) {
        throw new BrokerError(
          "AUTO_MERGE_STATE_UNKNOWN",
          `Batch ${id} records a possibly-live auto-merge queue but no pull request URL to reconcile.`,
        );
      }
      return await this.closeBatchLocked(id, reason);
    });
  }

  private async closeBatchLocked(
    id: string,
    reason: string,
    options: {
      allowChangeRequestIntent?: boolean;
      allowApprovalRevocation?: boolean;
      allowRefreshRequired?: boolean;
      allowRefreshCloseIntent?: boolean;
    } = {},
  ): Promise<BatchRecord> {
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      assertNoPendingRevision(batch);
      if (batch.changeRequestIntent && !options.allowChangeRequestIntent) {
        throw new BrokerError(
          "CHANGE_REQUEST_PENDING",
          `Batch ${id} has a durable approval revocation that must be reconciled before it can be closed.`,
        );
      }
      if (batch.candidate?.approval?.revocationRequestedAt && !options.allowApprovalRevocation) {
        throw new BrokerError(
          "APPROVAL_REVOCATION_REQUIRED",
          `Batch ${id} has a durable automatic approval revocation that must be reconciled before it can be closed.`,
        );
      }
      if (batch.refreshRequired && !options.allowRefreshRequired) {
        throw new BrokerError(
          "REFRESH_PENDING",
          `Batch ${id} has a durable refresh transition that must finish before it can be closed manually.`,
        );
      }
      if (batch.refreshCloseIntent && !options.allowRefreshCloseIntent) {
        throw new BrokerError(
          "REFRESH_PENDING",
          `Batch ${id} has already started closing its pull request for refresh and must finish that transition.`,
        );
      }
      const reassignedTasks = batch.taskIds.filter((taskId) => {
        const task = requireTask(state, taskId);
        return task.batchId !== undefined && task.batchId !== id;
      });
      if (reassignedTasks.length > 0) {
        throw new BrokerError(
          "BATCH_SUPERSEDED",
          `Batch ${id} cannot be closed because its tasks now belong to a replacement batch.`,
          { taskIds: reassignedTasks },
        );
      }
      if (batch.status === "closed") return structuredClone(batch);
      if (batch.status !== "prepared" && batch.status !== "published") {
        throw new BrokerError("BATCH_NOT_CLOSABLE", `Batch ${id} cannot be closed while ${batch.status}.`);
      }
      batch.status = "closed";
      batch.error = reason;
      batch.closedAt = now();
      batch.finishedAt = batch.closedAt;
      batch.autoMergeEnabled = false;
      delete batch.autoMergePending;
      delete batch.changeRequestIntent;
      delete batch.refreshRequired;
      delete batch.refreshCloseIntent;
      if (batch.candidate) {
        batch.candidate.state = "abandoned";
        batch.candidate.reason = reason;
        delete batch.candidate.approval;
      }
      const paused: string[] = [];
      for (const taskId of batch.taskIds) {
        const task = requireTask(state, taskId);
        if (task.status === "merged") continue;
        delete task.batchId;
        delete task.publishedAt;
        task.lastError = reason;
        task.updatedAt = now();
        task.status = "failed";
        paused.push(taskId);
      }
      audit("batch.closed", { batchId: id, details: { reason, paused } });
      return structuredClone(batch);
    });
  }

  /**
   * Replaces a batch that can no longer merge because the base branch moved under it.
   *
   * A batch is cut from the base tip so it is born mergeable. When something else lands first, a
   * base that requires branches to be up to date will refuse it, and there was previously no way
   * back: the operator closed the pull request by hand, reconciled state by hand, and integrated
   * again. This re-cuts the same tasks from the current tip and re-validates them, which is the
   * point — a stale batch was only ever checked against a base nobody is merging into any more.
   *
   * Re-cutting rather than merging the base into the branch keeps every batch an immutable artifact
   * whose manifest describes exactly the base it was assembled on.
   *
   * Attempts are deliberately not incremented. Nothing about the work failed; the world moved.
   * Charging it against `maxAttempts` would eventually retire a task for being unlucky.
   */
  async refreshBatch(
    id: string,
    options: { publish?: boolean } = {},
  ): Promise<RefreshResult> {
    return await this.store.withBatchLock(id, async () => await this.refreshBatchLocked(id, options));
  }

  private async refreshBatchLocked(
    id: string,
    options: { publish?: boolean } = {},
  ): Promise<RefreshResult> {
    let batch = requireBatch(await this.store.read(), id);
    assertNoPendingRevision(batch);
    if (batch.changeRequestIntent) {
      throw new BrokerError(
        "CHANGE_REQUEST_PENDING",
        `Batch ${id} has a durable approval revocation. Run batch sync before refreshing it.`,
      );
    }
    if (batch.status !== "prepared" && batch.status !== "published") {
      throw new BrokerError(
        "BATCH_NOT_REFRESHABLE",
        `Batch ${id} cannot be refreshed while ${batch.status}. Only a batch still waiting to merge can be re-cut.`,
      );
    }

    // A public refresh can race a normal merge if callers have not synced first. Reconcile the PR
    // while holding the same batch lock before recording any supersession marker, so a merge that
    // already happened is completed normally instead of being misclassified as post-revocation.
    if (batch.status === "published" && batch.pullRequestUrl) {
      const reconciled = await this.syncBatchLocked(id);
      if (reconciled.status !== "published") {
        return {
          refreshed: false,
          reason: "already_terminal",
          baseSha: reconciled.baseSha,
          closed: reconciled,
        };
      }
      batch = reconciled;
    }

    if (
      (!batch.remoteUrlFingerprint ||
        (this.config.publish.mode === "pull-request" &&
          !isHostQualifiedForgeRepository(batch.forgeRepository))) &&
      !(batch.status === "prepared" && batch.publicationMode === "none")
    ) {
      throw new BrokerError(
        "BATCH_TARGET_UNBOUND",
        `Batch ${id} has no durable target binding and may already have a remote branch or PR. It cannot be refreshed onto a possibly different repository automatically.`,
      );
    }

    const currentBase = await this.currentBatchTargetSha(batch);
    // An earlier attempt may already have closed the PR. That external side effect must be
    // finalized even if the target was force-reset to the old SHA while this process was down;
    // reusing the now-closed PR would turn an interrupted refresh into a rejected batch.
    const targetBindingComplete = Boolean(
      batch.remoteUrlFingerprint &&
        (this.config.publish.mode !== "pull-request" ||
          isHostQualifiedForgeRepository(batch.forgeRepository)),
    );
    if (
      currentBase === batch.baseSha &&
      !batch.refreshRequired &&
      !batch.refreshCloseIntent &&
      targetBindingComplete
    ) {
      return {
        refreshed: false,
        reason: "already_current",
        baseSha: currentBase,
        closed: structuredClone(batch),
      };
    }

    // The next side effect closes a real pull request. Record why before touching the forge so a
    // restart can distinguish our expected close from a human rejection and resume the re-cut.
    const refreshIntent = await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.refreshRequired = true;
      if (stored.pullRequestUrl) {
        const existing = stored.refreshCloseIntent?.pullRequestUrl === stored.pullRequestUrl
          ? stored.refreshCloseIntent
          : undefined;
        stored.refreshCloseIntent = {
          pullRequestUrl: stored.pullRequestUrl,
          targetBaseSha: currentBase,
          startedAt: existing?.startedAt ?? now(),
          nonce: existing?.nonce ?? createToken(),
        };
      }
      audit("batch.refresh_started", {
        batchId: id,
        details: {
          fromBase: stored.baseSha,
          toBase: currentBase,
          reason: stored.baseSha === currentBase ? "candidate policy changed" : "base moved",
        },
      });
      return stored.refreshCloseIntent ? structuredClone(stored.refreshCloseIntent) : undefined;
    });

    // A direct API/CLI refresh is allowed without a preceding sync. Stop any remotely queued merge
    // before closing or rebuilding the candidate; otherwise GitHub can land the stale head in the
    // interval between recording refresh intent and closing the pull request. The durable intent
    // above makes a lost response retryable, while disableAutoMerge recognizes an already-disabled
    // queue as success.
    if (
      batch.pullRequestUrl &&
      (batch.autoMergeEnabled !== false || Boolean(batch.autoMergePending))
    ) {
      const disabled = await this.publisher.disableAutoMerge(this.repo.root, batch.pullRequestUrl);
      if (!disabled) {
        throw new BrokerError(
          "CANDIDATE_FINAL",
          "The pull request merged while the broker was disabling auto-merge for refresh. Sync it before retrying refresh.",
          { batchId: id, pullRequestUrl: batch.pullRequestUrl },
        );
      }
      await this.store.transaction((current, audit) => {
        const stored = requireBatch(current, id);
        if (
          stored.refreshCloseIntent?.pullRequestUrl !== refreshIntent?.pullRequestUrl ||
          stored.refreshCloseIntent?.nonce !== refreshIntent?.nonce
        ) {
          throw new BrokerError("REFRESH_CHANGED", `Batch ${id} refresh intent changed before auto-merge was disabled.`);
        }
        stored.autoMergeEnabled = false;
        delete stored.autoMergePending;
        delete stored.publishWarning;
        if (stored.candidate?.state === "merging") stored.candidate.state = "approved";
        audit("batch.auto_merge_disabled", {
          batchId: id,
          details: { reason: "batch refresh", pullRequestUrl: stored.pullRequestUrl },
        });
      });
    }

    // Closed before the tasks are requeued: a superseded pull request left open is one a human can
    // still merge, which would land the batch this call is replacing.
    let pullRequestClosed: boolean | undefined;
    if (batch.pullRequestUrl) {
      const closeMarker = refreshIntent?.nonce
        ? `<!-- merge-broker-refresh:${refreshIntent.nonce} -->`
        : "";
      const closeReason = currentBase === batch.baseSha
        ? "Superseded: candidate policy changed, so this batch was re-cut and re-validated."
        : `Superseded: the base branch moved to ${currentBase.slice(0, 7)}, so this batch was re-cut from the current tip.`;
      try {
        pullRequestClosed = await this.publisher.closePullRequest(
          this.repo.root,
          batch.pullRequestUrl,
          `${closeReason}${
            closeMarker ? `\n\n${closeMarker}` : ""
          }`,
        );
      } catch (error) {
        if (!(error instanceof BrokerError) || error.code !== "PULL_REQUEST_ALREADY_CLOSED") throw error;
        const closed = await this.closeBatchLocked(
          id,
          `Pull request ${batch.pullRequestUrl} was closed without merging before the broker could refresh it.`,
          {
            allowApprovalRevocation: true,
            allowRefreshRequired: true,
            allowRefreshCloseIntent: true,
          },
        );
        return {
          refreshed: false,
          reason: "pull_request_closed",
          baseSha: currentBase,
          closed,
          pullRequestClosed: false,
        };
      }
      if (!pullRequestClosed) {
        throw new BrokerError(
          "PULL_REQUEST_CLOSE_FAILED",
          `Could not close superseded pull request ${batch.pullRequestUrl}. The existing batch and its tasks were left unchanged so two mergeable copies cannot exist. Retry when the forge responds.`,
          { batchId: id, pullRequestUrl: batch.pullRequestUrl },
        );
      }
    }
    if (batch.branchName) await this.repo.deleteBranch(batch.branchName);

    const closed = await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.status = "closed";
      stored.closedAt = now();
      stored.finishedAt = stored.closedAt;
      stored.error = stored.baseSha === currentBase
        ? "Superseded: candidate policy changed and required a new validation/approval context."
        : `Superseded: base moved from ${stored.baseSha.slice(0, 7)} to ${currentBase.slice(0, 7)}.`;
      stored.autoMergeEnabled = false;
      delete stored.autoMergePending;
      delete stored.changeRequestIntent;
      delete stored.refreshRequired;
      delete stored.refreshCloseIntent;
      if (stored.candidate) {
        stored.candidate.state = "superseded";
        stored.candidate.reason = stored.error;
        delete stored.candidate.approval;
      }
      delete stored.branchName;
      const requeued: string[] = [];
      for (const taskId of stored.taskIds) {
        const task = requireTask(current, taskId);
        if (task.status === "merged") continue;
        delete task.batchId;
        delete task.publishedAt;
        delete task.lastError;
        task.status = "submitted";
        task.updatedAt = now();
        requeued.push(taskId);
      }
      audit("batch.refreshed", {
        batchId: id,
        details: { fromBase: stored.baseSha, toBase: currentBase, requeued, pullRequestClosed },
      });
      return structuredClone(stored);
    });

    const integration = await this.integrateForTarget(
      {
        taskIds: closed.taskIds,
        publish: options.publish ?? false,
      },
      {
        remote: batch.remote ?? this.config.remote,
        ...(batch.remoteUrlFingerprint ? { remoteUrlFingerprint: batch.remoteUrlFingerprint } : {}),
        ...(batch.forgeRepository ? { forgeRepository: batch.forgeRepository } : {}),
        baseBranch: batch.baseBranch,
        baseSha: currentBase,
      },
    );
    return {
      refreshed: true,
      baseSha: currentBase,
      closed,
      integration,
      ...(pullRequestClosed === undefined ? {} : { pullRequestClosed }),
    };
  }

  async markBatchMerged(id: string, mergedAt = now(), mergeCommitSha?: string): Promise<BatchRecord> {
    return await this.store.withBatchLock(
      id,
      async () => await this.markBatchMergedLocked(id, mergedAt, mergeCommitSha),
    );
  }

  private async markBatchMergedLocked(id: string, mergedAt = now(), mergeCommitSha?: string): Promise<BatchRecord> {
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      assertNoPendingRevision(batch);
      if (batch.changeRequestIntent) {
        throw new BrokerError(
          "CHANGE_REQUEST_PENDING",
          `Batch ${id} has a durable approval revocation that must finish before it can be completed. Run batch sync.`,
        );
      }
      if (batch.refreshRequired || batch.refreshCloseIntent) {
        throw new BrokerError(
          "REFRESH_PENDING",
          `Batch ${id} is being superseded from a stale base and cannot be completed. Resume batch refresh first.`,
        );
      }
      // "closed" is included so a pull request that was reopened and merged can still be reconciled
      // with "batch complete".
      if (!new Set<BatchRecord["status"]>(["prepared", "published", "closed", "merged"]).has(batch.status)) {
        throw new BrokerError("BATCH_NOT_MERGED", `Batch ${id} cannot be completed while ${batch.status}.`);
      }
      const reassignedTasks = batch.taskIds.filter((taskId) => {
        const task = requireTask(state, taskId);
        return task.batchId !== undefined && task.batchId !== id;
      });
      if (reassignedTasks.length > 0) {
        throw new BrokerError(
          "BATCH_SUPERSEDED",
          `Batch ${id} cannot be completed because its tasks now belong to a replacement batch.`,
          { taskIds: reassignedTasks },
        );
      }
      const currentApprovalPolicy = approvalPolicy(this.config);
      if (batch.candidate || currentApprovalPolicy.required) {
        const candidate = requireCurrentCandidate(batch);
        if (!currentApprovalPolicy.required) {
          throw new BrokerError(
            "CANDIDATE_POLICY_STALE",
            "This batch was assembled under required approval and cannot be completed after that policy is disabled.",
          );
        }
        assertCurrentApprovalPolicy(this.config, candidate);
        const approval = candidate.approval;
        if (
          !approval ||
          !approval.confirmedAt ||
          approval.revocationRequestedAt ||
          approval.candidateSha !== candidate.sha ||
          approval.baseSha !== candidate.baseSha ||
          approval.policyRevision !== candidate.policyRevision
        ) {
          throw new BrokerError(
            "CANDIDATE_NOT_APPROVED",
            `Batch ${id} cannot be completed without approval for its exact candidate/base/policy tuple.`,
          );
        }
      }
      batch.status = "merged";
      batch.finishedAt = mergedAt;
      batch.autoMergeEnabled = false;
      delete batch.autoMergePending;
      delete batch.changeRequestIntent;
      delete batch.refreshRequired;
      delete batch.refreshCloseIntent;
      if (batch.candidate) {
        batch.candidate.state = "merged";
        delete batch.candidate.reason;
      }
      for (const taskId of batch.taskIds) {
        const task = requireTask(state, taskId);
        task.status = "merged";
        task.mergedAt = mergedAt;
        task.updatedAt = now();
      }
      audit("batch.merged", { batchId: id, details: { mergedAt, mergeCommitSha } });
      return structuredClone(batch);
    });
  }

  async auditWorktrees(): Promise<{
    worktrees: Array<{
      path: string;
      branch?: string;
      registeredTaskIds: string[];
      registeredSubmissionIds: string[];
      clean: boolean;
    }>;
    staleLeases: string[];
    unregisteredWorktrees: string[];
  }> {
    const [state, worktrees] = await Promise.all([this.store.read(), this.repo.listWorktrees()]);
    const staleLeases = Object.values(state.tasks)
      .filter((task) => task.lease && leaseExpired(task))
      .map((task) => task.id);
    const registeredPaths = new Map<string, string[]>();
    for (const task of Object.values(state.tasks)) {
      if (!task.worktree) continue;
      const resolved = path.resolve(task.worktree);
      registeredPaths.set(resolved, [...(registeredPaths.get(resolved) ?? []), task.id]);
    }
    const registeredSubmissionPaths = new Map<string, string[]>();
    for (const submission of Object.values(state.submissions)) {
      if (!submission.worktree) continue;
      const resolved = path.resolve(submission.worktree);
      registeredSubmissionPaths.set(
        resolved,
        [...(registeredSubmissionPaths.get(resolved) ?? []), submission.id],
      );
    }
    const details = await Promise.all(
      worktrees.map(async (worktree) => ({
        path: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        registeredTaskIds: registeredPaths.get(path.resolve(worktree.path)) ?? [],
        registeredSubmissionIds: registeredSubmissionPaths.get(path.resolve(worktree.path)) ?? [],
        clean: await this.repo.isClean(worktree.path),
      })),
    );
    const primaryWorktree = worktrees[0]?.path ? path.resolve(worktrees[0].path) : undefined;
    return {
      worktrees: details,
      staleLeases,
      unregisteredWorktrees: details
        .filter(
          (item) =>
            path.resolve(item.path) !== this.repo.root &&
            path.resolve(item.path) !== primaryWorktree &&
            item.registeredTaskIds.length === 0 &&
            item.registeredSubmissionIds.length === 0,
        )
        .map((item) => item.path),
    };
  }

  /**
   * Retires completed records so `state.json` stops growing without bound. The file is rewritten in
   * full on every transaction, including heartbeats, so an unbounded history makes routine
   * operations progressively slower.
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const days = options.olderThanDays ?? 30;
    if (!Number.isFinite(days) || days < 0) {
      throw new BrokerError("INVALID_LIMIT", "olderThanDays must be a non-negative number.");
    }
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1_000;
    const cutoff = new Date(cutoffMs).toISOString();
    if (options.dryRun) {
      const selection = selectPrunable(await this.store.read(), cutoffMs);
      return { ...selection, cutoff, dryRun: true };
    }
    const pruned = await this.store.transaction(async (state, audit) => {
      const selection = selectPrunable(state, cutoffMs);
      if (selection.tasks.length === 0 && selection.batches.length === 0) {
        return { ...selection, cutoff, dryRun: false };
      }
      const archivePath = await this.store.archive("state", {
        archivedAt: now(),
        cutoff,
        tasks: Object.fromEntries(selection.tasks.map((id) => [id, state.tasks[id]])),
        batches: Object.fromEntries(selection.batches.map((id) => [id, state.batches[id]])),
      });
      for (const id of selection.tasks) delete state.tasks[id];
      for (const id of selection.batches) delete state.batches[id];
      audit("state.pruned", {
        details: {
          cutoff,
          tasks: selection.tasks,
          batches: selection.batches,
          archivePath,
        },
      });
      return { ...selection, cutoff, archivePath, dryRun: false };
    });
    for (const taskId of pruned.tasks) await this.store.deleteToken(taskId);
    return pruned;
  }

  async installHooks(options: { force?: boolean; uninstall?: boolean } = {}): Promise<HookInstallation> {
    if (options.uninstall) return await uninstallHooks(this.repo);
    return await installHooks({
      repo: this.repo,
      branchPrefix: this.config.integration.branchPrefix,
      force: options.force ?? false,
    });
  }

  /**
   * Installs the integration loop as a per-user service.
   *
   * Without it `serve` only runs while a terminal is open, so a submitted task
   * waits for a human to notice — indistinguishable, to the agent that
   * submitted it, from the broker rejecting the work.
   */
  async installService(options: {
    uninstall?: boolean;
    intervalSeconds?: number;
    eager?: boolean;
    nodePath?: string;
    cliPath?: string;
    pathEntries?: string[];
    logFile?: string;
  } = {}): Promise<ServiceInstallation | { name: string; file: string; removed: boolean }> {
    if (options.uninstall) return await uninstallService(this.repo.root);
    if (this.config.publish.mode === "none") {
      throw new BrokerError(
        "SERVICE_PUBLISH_DISABLED",
        "The background service publishes completed batches, but publish.mode is none. Configure branch or pull-request publication before installing it.",
      );
    }
    const nodePath = options.nodePath ?? process.execPath;
    const cliPath = options.cliPath ?? process.argv[1] ?? "";
    if (!path.isAbsolute(cliPath)) {
      throw new BrokerError(
        "SERVICE_CLI_PATH",
        "Could not determine an absolute path to the broker CLI. Pass --cli-path.",
      );
    }
    return await installService({
      repositoryRoot: this.repo.root,
      nodePath,
      cliPath,
      intervalSeconds: options.intervalSeconds ?? 15,
      eager: options.eager ?? true,
      // node's own directory is included because a version-managed node is not
      // on the default PATH a login-less agent receives.
      pathEntries: options.pathEntries ?? [
        path.dirname(nodePath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ],
      // `.git` is a file in linked worktrees. Runtime state already resolves Git's common directory,
      // which is the one log location every checkout can safely create and inspect.
      logFile: options.logFile ?? path.join(this.store.directory, "serve.log"),
    });
  }

  async inspectLocks(): Promise<LockStatus[]> {
    const state = await this.store.read();
    const fixed = await Promise.all([
      ...["state", "integration"].map(async (name) => await this.store.inspectLock(name)),
      this.store.inspectGateAuthorityLock(),
    ]);
    const batches = await Promise.all(
      Object.keys(state.batches).map(async (batchId) => {
        const lock = await this.store.inspectBatchLock(batchId);
        return { ...lock, name: `batch:${batchId}` };
      }),
    );
    return [...fixed, ...batches.filter((lock) => lock.held)];
  }

  async releaseLock(name: string, options: { force?: boolean } = {}): Promise<LockStatus> {
    let released: LockStatus;
    if (name.startsWith("batch:")) {
      const batchId = name.slice("batch:".length);
      if (!batchId) throw new BrokerError("UNKNOWN_LOCK", "A batch lock needs a batch ID after 'batch:'.");
      released = { ...(await this.store.releaseBatchLock(batchId, options)), name };
    } else if (name === "gate-authority") {
      released = await this.store.releaseGateAuthorityLock(options);
    } else if (name === "state" || name === "integration") {
      released = await this.store.releaseLock(name, options);
    } else {
      throw new BrokerError(
        "UNKNOWN_LOCK",
        `Unknown lock: ${name}. Expected "state", "integration", "gate-authority", or "batch:<batch-id>".`,
      );
    }
    await this.store.transaction((_state, audit) => {
      audit("lock.released", { details: { lock: name, forced: options.force ?? false, previous: released.owner } });
    });
    return released;
  }

  async metrics(): Promise<Record<string, unknown>> {
    const [state, archived] = await Promise.all([this.store.read(), this.store.readArchivedState()]);
    const activeTasks = Object.values(state.tasks);
    const activeBatches = Object.values(state.batches);
    const archivedTasks = archived.flatMap((slice) => Object.values(slice.tasks));
    const archivedBatches = archived.flatMap((slice) => Object.values(slice.batches));
    const tasks = [...archivedTasks, ...activeTasks];
    const batches = [...archivedBatches, ...activeBatches];
    const statusCounts = Object.fromEntries(
      [...new Set(tasks.map((task) => task.status))]
        .sort()
        .map((status) => [status, tasks.filter((task) => task.status === status).length]),
    );
    const mergedLeadTimes = tasks
      .filter((task) => task.submittedAt && task.mergedAt)
      .map((task) => Date.parse(task.mergedAt ?? "") - Date.parse(task.submittedAt ?? ""))
      .filter((duration) => Number.isFinite(duration) && duration >= 0);
    const validations = batches.flatMap((batch) => batch.validations);
    return {
      generatedAt: now(),
      records: {
        activeTasks: activeTasks.length,
        archivedTasks: archivedTasks.length,
        activeBatches: activeBatches.length,
        archivedBatches: archivedBatches.length,
      },
      tasks: {
        total: tasks.length,
        byStatus: statusCounts,
        merged: tasks.filter((task) => task.status === "merged").length,
        averageSubmitToMergeMs:
          mergedLeadTimes.length > 0
            ? Math.round(mergedLeadTimes.reduce((sum, duration) => sum + duration, 0) / mergedLeadTimes.length)
            : null,
      },
      batches: {
        total: batches.length,
        merged: batches.filter((batch) => batch.status === "merged").length,
        closed: batches.filter((batch) => batch.status === "closed").length,
        failed: batches.filter((batch) => batch.status === "failed").length,
        averageTaskCount:
          batches.length > 0
            ? Number((batches.reduce((sum, batch) => sum + batch.taskIds.length, 0) / batches.length).toFixed(2))
            : 0,
      },
      validation: {
        runs: validations.length,
        failures: validations.filter((validation) => validation.exitCode !== 0).length,
        durationMs: validations.reduce((sum, validation) => sum + validation.durationMs, 0),
      },
    };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const [
      baseResolution,
      clean,
      worktrees,
      locks,
      state,
      gitVersionResult,
      remoteUrlResult,
      trackedConfig,
      cleanConfig,
      trackedAgentContract,
      cleanAgentContract,
      hooksPath,
    ] =
      await Promise.all([
        this.repo.resolveCommit(this.config.baseRef).then(
          (sha) => ({ sha }),
          (error: unknown) => ({ error: errorMessage(error) }),
        ),
        this.repo.isClean(),
        this.repo.listWorktrees(),
        this.inspectLocks(),
        this.store.read(),
        this.repo.git(["--version"], this.repo.root, true),
        this.repo.git(["remote", "get-url", this.config.remote], this.repo.root, true),
        this.repo.git(
          ["ls-files", "--error-unmatch", ".merge-broker/config.json"],
          this.repo.root,
          true,
        ),
        this.repo.git(["diff", "--quiet", "HEAD", "--", ".merge-broker/config.json"], this.repo.root, true),
        this.repo.git(["ls-files", "--error-unmatch", "AGENTS.md"], this.repo.root, true),
        this.repo.git(["diff", "--quiet", "HEAD", "--", "AGENTS.md"], this.repo.root, true),
        this.repo.git(["config", "--get", "core.hooksPath"], this.repo.root, true),
      ]);
    const warnings: string[] = [];
    let ok = true;
    const nodeVersion = process.versions.node;
    const nodeSupported = versionAtLeast(nodeVersion, [20, 12]);
    if (!nodeSupported) {
      ok = false;
      warnings.push(`Node ${nodeVersion} is unsupported; Agent Merge Broker requires Node 20.12 or newer.`);
    }
    const gitVersion = /git version\s+([^\s]+)/u.exec(gitVersionResult.stdout)?.[1] ?? "unknown";
    const gitSupported = versionAtLeast(gitVersion, [2, 31]);
    if (!gitSupported) {
      ok = false;
      warnings.push(`Git ${gitVersion} is unsupported; use Git 2.31 or newer.`);
    }
    const baseSha = "sha" in baseResolution ? baseResolution.sha : undefined;
    if (!baseSha) {
      ok = false;
      warnings.push(
        `The configured base ref cannot be resolved: ${"error" in baseResolution ? baseResolution.error : "unknown error"}`,
      );
    }

    const remoteUrl = remoteUrlResult.exitCode === 0 ? remoteUrlResult.stdout.trim() : undefined;
    let remoteReachable = false;
    let remoteBaseSha: string | undefined;
    if (remoteUrl) {
      const remoteHead = await runCommand(
        "git",
        ["ls-remote", "--exit-code", this.config.remote, `refs/heads/${this.config.baseBranch}`],
        {
          cwd: this.repo.root,
          allowFailure: true,
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1_024,
          killProcessTree: true,
        },
      );
      remoteReachable = remoteHead.exitCode === 0;
      remoteBaseSha = remoteHead.stdout.trim().split(/\s+/u)[0] || undefined;
    }
    const remoteRequired = this.config.publish.mode !== "none" || this.config.baseRef.startsWith(`${this.config.remote}/`);
    if (!remoteReachable) {
      warnings.push(`Remote ${this.config.remote} or branch ${this.config.baseBranch} is not reachable.`);
      if (remoteRequired) ok = false;
    }
    const baseFresh = Boolean(baseSha && remoteBaseSha && baseSha === remoteBaseSha);
    if (baseSha && remoteBaseSha && !baseFresh) {
      warnings.push(
        `Configured base ${this.config.baseRef} is at ${baseSha.slice(0, 12)}, while ${this.config.remote}/${this.config.baseBranch} is at ${remoteBaseSha.slice(0, 12)}.`,
      );
      if (!this.config.integration.refreshBase) ok = false;
    }

    const configCommitted = trackedConfig.exitCode === 0 && cleanConfig.exitCode === 0;
    if (!configCommitted) {
      warnings.push(".merge-broker/config.json is not committed, so collaborators and remote verification cannot share its policy.");
      if (this.config.publish.mode === "pull-request" || this.config.validation.authority === "required-ci") ok = false;
    }

    const forgeRequired = this.config.publish.mode === "pull-request";
    let forgeRepository: string | undefined;
    let ghAvailable = false;
    let ghAuthenticated: boolean | undefined;
    if (forgeRequired) {
      try {
        let derivedRepository: string | undefined;
        try {
          derivedRepository = await this.repo.forgeRepository(this.config.remote);
        } catch (error) {
          if (!this.config.publish.repository) throw error;
        }
        if (
          this.config.publish.repository &&
          derivedRepository &&
          this.config.publish.repository !== derivedRepository
        ) {
          throw new BrokerError(
            "FORGE_TARGET_MISMATCH",
            `publish.repository names ${this.config.publish.repository}, but remote ${this.config.remote} points at ${derivedRepository}.`,
          );
        }
        forgeRepository = this.config.publish.repository ?? derivedRepository;
      } catch (error) {
        ok = false;
        warnings.push(
          `${errorMessage(error)} Set publish.repository to the exact [HOST/]OWNER/REPO when the Git remote is a local mirror or proxy.`,
        );
      }
      const ghVersion = await runCommand("gh", ["--version"], {
        cwd: this.repo.root,
        allowFailure: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1_024,
        killProcessTree: true,
      }).catch(() => undefined);
      ghAvailable = ghVersion?.exitCode === 0;
      if (ghAvailable) {
        const auth = await runCommand("gh", ["auth", "status"], {
          cwd: this.repo.root,
          allowFailure: true,
          timeoutMs: 5_000,
          maxOutputBytes: 16 * 1_024,
          killProcessTree: true,
        });
        ghAuthenticated = auth.exitCode === 0;
      }
      if (!ghAvailable || !ghAuthenticated) {
        ok = false;
        warnings.push(
          ghAvailable
            ? "GitHub CLI is installed but not authenticated for pull-request publication."
            : "GitHub CLI is required for pull-request publication but was not found.",
        );
      }
    }

    const provenance = this.config.integration.provenance;
    let signingKeyId: string | undefined;
    if (provenance?.enabled && provenance.requireSignature) {
      try {
        await this.provenanceSigningPrivateKey();
        if (provenance.publicKey) signingKeyId = provenanceKeyId(provenance.publicKey);
      } catch (error) {
        ok = false;
        warnings.push(errorMessage(error));
      }
    } else if (provenance?.enabled) {
      warnings.push(
        "Provenance signatures are not required, so remote verification can confirm structure but cannot authenticate which broker created it. Run `merge-broker provenance setup-signing`.",
      );
    }
    const validationReady = this.config.validation.authority === "required-ci"
      || this.config.validation.authoritative.length > 0;
    if (!validationReady) {
      warnings.push(
        "validation.authority is broker, but no authoritative validators are configured. Add validation.authoritative commands or explicitly delegate the complete decision to required CI.",
      );
    }
    const runningBatches = Object.values(state.batches)
      .filter((batch) => batch.status === "running")
      .map((batch) => batch.id);
    if (runningBatches.length > 0) {
      ok = false;
      warnings.push(
        `Integration state is incomplete for ${runningBatches.join(", ")}. Run \`merge-broker recover\` after confirming no broker process is active.`,
      );
    }
    const pendingCandidateRevisions = Object.values(state.batches)
      .filter((batch) => batch.revisionIntent)
      .map((batch) => batch.id);
    if (pendingCandidateRevisions.length > 0) {
      ok = false;
      warnings.push(
        `Candidate revisions await reconciliation for ${pendingCandidateRevisions.join(", ")}. Run \`merge-broker recover\`.`,
      );
    }
    for (const lock of locks) {
      if (!lock.held) continue;
      warnings.push(
        `The ${lock.name} lock is held${lock.owner?.host ? ` by ${lock.owner.host}` : ""} and is ${Math.round(
          (lock.ageMs ?? 0) / 1_000,
        )}s old${lock.abandoned ? `; its owning process is gone, so "merge-broker unlock ${lock.name}" can clear it` : ""}.`,
      );
    }

    const configuredHooksPath = hooksPath.exitCode === 0 ? hooksPath.stdout.trim() : undefined;
    const hookFile = path.join(this.repo.root, ".githooks", "pre-push");
    const hookOwned = await readFile(hookFile, "utf8").then(
      (contents) => contents.includes("Installed by Agent Merge Broker"),
      () => false,
    );
    const hooksInstalled = configuredHooksPath === ".githooks" && hookOwned;
    const agentContractInstalled = await hasAgentContract(this.repo.root);
    const agentContractCommitted = trackedAgentContract.exitCode === 0 && cleanAgentContract.exitCode === 0;
    if (!agentContractInstalled) {
      warnings.push(
        "The root AGENTS.md does not contain the Merge Broker contract, so coding agents may bypass the broker. Re-run `merge-broker init`.",
      );
    } else if (!agentContractCommitted) {
      warnings.push("The root AGENTS.md contract is not committed, so other agents will not receive it.");
    }
    let service: { supported: boolean; installed: boolean; owned: boolean; file?: string } = {
      supported: false,
      installed: false,
      owned: false,
    };
    try {
      const servicePlatform = currentServicePlatform();
      const file = serviceFilePath(servicePlatform, serviceName(this.repo.root));
      const serviceContents = await readFile(file, "utf8").catch(() => undefined);
      service = {
        supported: true,
        installed: serviceContents !== undefined,
        owned: serviceContents?.includes(SERVICE_MARKER) ?? false,
        file,
      };
      if (service.installed && !service.owned) {
        ok = false;
        warnings.push(`The repository's computed service file exists but is not broker-owned: ${file}`);
      }
      if (service.installed && service.owned && this.config.publish.mode === "none") {
        ok = false;
        warnings.push(
          "The installed background service uses publication, but publish.mode is none. Configure publication or remove it with `merge-broker install-service --uninstall`.",
        );
      }
    } catch (error) {
      if (!(error instanceof BrokerError && error.code === "UNSUPPORTED_PLATFORM")) throw error;
    }
    const provenanceReady = Boolean(
      !provenance?.enabled || (provenance.requireSignature && signingKeyId),
    );
    const operational = ok
      && validationReady
      && provenanceReady
      && configCommitted
      && agentContractInstalled
      && agentContractCommitted;
    return {
      ok,
      operational,
      warnings,
      locks,
      repository: this.repo.root,
      gitDirectory: this.repo.commonGitDir,
      stateDirectory: this.store.directory,
      config: path.join(this.repo.root, ".merge-broker", "config.json"),
      baseBranch: this.config.baseBranch,
      baseRef: this.config.baseRef,
      baseSha,
      remote: {
        name: this.config.remote,
        url: remoteUrl,
        reachable: remoteReachable,
        baseSha: remoteBaseSha,
        baseFresh,
      },
      tools: {
        node: {
          version: nodeVersion,
          supported: nodeSupported,
          processArchitecture: process.arch,
          nativeArchitecture: nativeArchitecture(),
        },
        git: { version: gitVersion, supported: gitSupported },
        githubCli: {
          required: forgeRequired,
          available: ghAvailable,
          authenticated: ghAuthenticated,
          repository: forgeRepository,
        },
      },
      worktreeClean: clean,
      worktreeCount: worktrees.length,
      publishMode: this.config.publish.mode,
      validationAuthority: this.config.validation.authority,
      validationReady,
      focusedValidators: this.config.validation.focused.map((validator) => validator.name),
      authoritativeValidators: this.config.validation.authoritative.map((validator) => validator.name),
      provenanceAuthenticated: Boolean(provenance?.enabled && provenance.requireSignature && signingKeyId),
      provenanceKeyId: signingKeyId,
      runningBatches,
      pendingCandidateRevisions,
      policy: { configCommitted },
      agentContract: {
        installed: agentContractInstalled,
        committed: agentContractCommitted,
        file: path.join(this.repo.root, "AGENTS.md"),
      },
      hooks: { installed: hooksInstalled, configuredPath: configuredHooksPath, file: hookFile },
      service,
    };
  }
}
