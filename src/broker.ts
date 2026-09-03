import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BrokerError, CommandError, ValidationError } from "./errors.js";
import { GitRepository } from "./git.js";
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
  IntegrationOptions,
  IntegrationResult,
  LocalValidationResult,
  RefreshResult,
  RevisionResult,
  RecoveryResult,
  PruneOptions,
  PruneResult,
  SchedulePlan,
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
  if (
    candidate.policyRevision !== policy.policyRevision ||
    candidate.requiredVerifications.length !== required.length ||
    candidate.requiredVerifications.some((name) => !required.includes(name))
  ) {
    throw new BrokerError(
      "CANDIDATE_POLICY_STALE",
      "The approval policy changed after this candidate was assembled. Rebuild it before verification or approval.",
      {
        candidatePolicyRevision: candidate.policyRevision,
        currentPolicyRevision: policy.policyRevision,
        candidateRequiredVerifications: candidate.requiredVerifications,
        currentRequiredVerifications: required,
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

  async state(): Promise<BrokerState> {
    return await this.store.read();
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

  async integrate(options: IntegrationOptions = {}): Promise<IntegrationResult> {
    return await this.store.withIntegrationLock(async () => {
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
      // Cut the batch from the current remote tip. Without this the branch is born behind the base
      // branch as soon as anything else lands, which "require branches to be up to date" protection
      // treats as unmergeable.
      if (this.config.integration.refreshBase) {
        await this.repo.fetchBranch(this.config.remote, this.config.baseBranch);
      }
      const baseSha = await this.repo.resolveCommit(this.config.baseRef);
      const worktree = path.join(this.store.worktreesDirectory, id);
      const batch: BatchRecord = {
        id,
        status: "running",
        taskIds: plan.selected.map((task) => task.id),
        validationAuthority: this.config.validation.authority,
        baseBranch: this.config.baseBranch,
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
          await this.repo.createBranch(branchName, headSha);
          batch.branchName = branchName;
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
        if (batch.branchName) {
          await this.repo.deleteBranch(batch.branchName);
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

      if (!options.dryRun && options.publish) {
        await this.publishBatch(id);
      }
      const finalBatch = requireBatch(await this.store.read(), id);
      return {
        batch: structuredClone(finalBatch),
        selected: batch.taskIds,
        rejected: plan.rejected,
        dryRun: options.dryRun ?? false,
      };
    });
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
          details: { requeued, reason: "abandoned integration transaction" },
        });
      }
      return { batches, tasks };
    });

    const worktreesRemoved: string[] = [];
    const branchesRemoved: string[] = [];
    const cleanupWarnings: string[] = [];
    const registeredWorktrees = new Set((await this.repo.listWorktrees()).map((worktree) => path.resolve(worktree.path)));
    const worktreeRoot = `${path.resolve(this.store.worktreesDirectory)}${path.sep}`;
    for (const batchId of recovered.batches) {
      const candidate = running.find((batch) => batch.id === batchId);
      const worktree = candidate?.worktree ? path.resolve(candidate.worktree) : undefined;
      if (worktree && registeredWorktrees.has(worktree)) {
        if (!worktree.startsWith(worktreeRoot)) {
          cleanupWarnings.push(`Refused to remove recovery worktree outside broker state: ${worktree}`);
        } else {
          try {
            await this.repo.removeWorktree(worktree);
            worktreesRemoved.push(worktree);
          } catch (error) {
            cleanupWarnings.push(errorMessage(error));
          }
        }
      }

      const branchName = cleanBranchFragment(`${this.config.integration.branchPrefix}${batchId}`);
      const branch = await this.repo.git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], this.repo.root, true);
      if (branch.exitCode === 0) {
        const deleted = await this.repo.git(["branch", "-D", "--", branchName], this.repo.root, true);
        if (deleted.exitCode === 0) branchesRemoved.push(branchName);
        else cleanupWarnings.push(`Could not remove recovery branch ${branchName}: ${deleted.stderr.trim()}`);
      }
    }

    await this.store.transaction((state, audit) => {
      for (const batchId of recovered.batches) {
        const batch = state.batches[batchId];
        if (!batch) continue;
        if (worktreesRemoved.includes(path.resolve(batch.worktree ?? ""))) delete batch.worktree;
        if (cleanupWarnings.length > 0) {
          batch.error = `${batch.error ?? "Integration was recovered."} Cleanup: ${cleanupWarnings.join("; ")}`;
        }
      }
      audit("integration.recovery_completed", {
        details: {
          ...recovered,
          worktreesRemoved,
          branchesRemoved,
          cleanupWarnings,
          candidateRevisionsRecovered,
          candidateRevisionWarnings,
        },
      });
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
    return await this.store.withIntegrationLock(async () => await this.recoverAbandonedIntegrationsLocked());
  }

  async publishBatch(id: string): Promise<BatchRecord> {
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    // `published` is accepted so publication can be retried. A batch whose pull request opened but
    // whose auto-merge did not is published and incomplete, and the way to finish it is to run this
    // again -- which now finds the existing pull request instead of opening a second one.
    if (batch.status !== "prepared" && batch.status !== "published") {
      throw new BrokerError("BATCH_NOT_PUBLISHABLE", `Batch ${id} cannot be published while ${batch.status}.`);
    }
    const tasks = batch.taskIds.map((taskId) => requireTask(state, taskId));
    let publication;
    try {
      publication = await this.publisher.publishBatch({ repo: this.repo, config: this.config, batch, tasks });
    } catch (error) {
      await this.store.transaction((current, audit) => {
        const stored = Object.hasOwn(current.batches, id) ? current.batches[id] : undefined;
        if (stored) stored.error = errorMessage(error);
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

    if (!this.config.publish.autoMerge || !publication.pullRequestUrl) return published;
    if (approvalPolicy(this.config).required && published.candidate?.state !== "approved") {
      return published;
    }

    // A separate step with its own outcome. Failing to queue auto-merge is a published batch that
    // needs a hand, not a publication that did not happen.
    let autoMergeEnabled = false;
    let warning: string | undefined;
    try {
      autoMergeEnabled = await this.publisher.enableAutoMerge(
        this.repo.root,
        publication.pullRequestUrl,
        this.config,
        published.candidate?.sha ?? published.headSha,
      );
    } catch (error) {
      warning = errorMessage(error);
    }
    return await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.autoMergeEnabled = autoMergeEnabled;
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
    const policy = approvalPolicy(this.config);
    if (!policy.required) throw new BrokerError("APPROVAL_DISABLED", "SHA-bound approval is not enabled.");
    if (!policy.requiredVerifications.includes(input.name)) {
      throw new BrokerError(
        "VERIFICATION_NOT_REQUIRED",
        `Verification ${input.name} is not declared in approval.requiredVerifications.`,
      );
    }
    const snapshot = requireBatch(await this.store.read(), id);
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
    const snapshot = requireBatch(await this.store.read(), id);
    const candidate = requireCurrentCandidate(snapshot);
    assertCandidateBinding(candidate, input);
    if (snapshot.status !== "published" || !snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_REVISABLE", `Batch ${id} is not a published candidate.`);
    }
    const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, snapshot.pullRequestUrl);
    if (pullRequest.state !== "OPEN" || pullRequest.headRefOid !== candidate.sha) {
      throw new BrokerError("CANDIDATE_MISMATCH", "The pull request head changed before changes could be requested.");
    }
    if (snapshot.autoMergeEnabled) {
      const disabled = await this.publisher.disableAutoMerge(this.repo.root, snapshot.pullRequestUrl);
      if (!disabled) throw new BrokerError("CANDIDATE_FINAL", "The pull request merged before approval could be revoked.");
    }
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      current.state = "changes_requested";
      current.reason = input.reason;
      delete current.approval;
      batch.autoMergeEnabled = false;
      delete batch.publishWarning;
      audit("batch.changes_requested", {
        actor: input.actor,
        batchId: id,
        details: {
          reason: input.reason,
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
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
    await this.syncBatch(id);
    const snapshot = requireBatch(await this.store.read(), id);
    if (snapshot.status !== "published" || !snapshot.pullRequestUrl) {
      throw new BrokerError("BATCH_NOT_APPROVABLE", `Batch ${id} must have an open pull request before approval.`);
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
      (pullRequest.baseRefName && pullRequest.baseRefName !== snapshot.baseBranch) ||
      (pullRequest.baseRefOid && pullRequest.baseRefOid !== candidate.baseSha)
    ) {
      throw new BrokerError("CANDIDATE_MISMATCH", "The PR head or target base changed before approval.", {
        candidateSha: candidate.sha,
        pullRequestHead: pullRequest.headRefOid,
        candidateBaseSha: candidate.baseSha,
        pullRequestBaseSha: pullRequest.baseRefOid,
      });
    }
    if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || pullRequest.mergeable === "CONFLICTING") {
      throw new BrokerError("CANDIDATE_BLOCKED", "The pull request has blocking review feedback or merge conflicts.");
    }

    const approved = await this.store.transaction((state, audit) => {
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
      current.approval = {
        candidateSha: current.sha,
        baseSha: current.baseSha,
        policyRevision: current.policyRevision,
        actor: input.actor,
        approvedAt: now(),
      };
      current.state = "approved";
      delete current.reason;
      audit("batch.approved", {
        actor: input.actor,
        batchId: id,
        details: {
          candidateSha: current.sha,
          baseSha: current.baseSha,
          policyRevision: current.policyRevision,
        },
      });
      return structuredClone(batch);
    });

    if (!this.config.publish.autoMerge) return approved;
    let enabled = false;
    let warning: string | undefined;
    try {
      enabled = await this.publisher.enableAutoMerge(
        this.repo.root,
        snapshot.pullRequestUrl,
        this.config,
        candidate.sha,
      );
    } catch (error) {
      warning = errorMessage(error);
    }
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      const current = requireCurrentCandidate(batch);
      assertCandidateBinding(current, input);
      batch.autoMergeEnabled = enabled;
      if (enabled) current.state = "merging";
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
      const batch = requireBatch(state, task.batchId);
      const candidate = requireCurrentCandidate(batch);
      if (candidate.state === "approved" || candidate.state === "merging" || batch.autoMergeEnabled) {
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
    return await this.store.withIntegrationLock(async () => {
      const state = await this.store.read();
      const snapshot = requireTask(state, taskId);
      if (snapshot.status !== "batched" && snapshot.status !== "published") {
        throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} cannot be revised while ${snapshot.status}.`);
      }
      verifyLease(snapshot, token);
      if (!snapshot.batchId) throw new BrokerError("TASK_NOT_REVISABLE", `Task ${taskId} has no active batch.`);
      const originalBatch = structuredClone(requireBatch(state, snapshot.batchId));
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
      if (this.config.integration.refreshBase) {
        await this.repo.fetchBranch(this.config.remote, this.config.baseBranch);
      }
      const baseSha = await this.repo.resolveCommit(this.config.baseRef);
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
      delete nextBatch.publishWarning;
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
          this.config.remote,
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
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    if (batch.status === "merged") return structuredClone(batch);
    let mergedAt: string | undefined;
    let mergeCommitSha: string | undefined;
    if (batch.pullRequestUrl) {
      const pullRequest = await this.publisher.inspectPullRequest(this.repo.root, batch.pullRequestUrl);
      // A pull request closed without merging means the work was rejected, not completed. Leaving
      // the batch "published" strands every task in it forever and reads like success.
      if (pullRequest.state === "CLOSED") {
        return await this.closeBatch(id, `Pull request ${batch.pullRequestUrl} was closed without merging.`);
      }
      if (approvalPolicy(this.config).required) {
        if (!batch.candidate) {
          if (pullRequest.state === "MERGED") {
            return await this.store.transaction((current, audit) => {
              const stored = requireBatch(current, id);
              stored.status = "failed";
              stored.error = "GitHub merged an untracked pre-approval candidate after approval policy was enabled.";
              stored.finishedAt = now();
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
          if (!batch.headSha || pullRequest.headRefOid !== batch.headSha) {
            throw new BrokerError(
              "CANDIDATE_MISMATCH",
              "Approval policy was enabled for a legacy batch whose PR head no longer matches broker state.",
              { expectedHead: batch.headSha, actualHead: pullRequest.headRefOid },
            );
          }
          if (batch.autoMergeEnabled) {
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
        const exactHead = pullRequest.headRefOid === candidate.sha;
        const exactBaseBranch = pullRequest.baseRefName === undefined || pullRequest.baseRefName === batch.baseBranch;
        const exactBase = pullRequest.baseRefOid === undefined || pullRequest.baseRefOid === candidate.baseSha;
        const requiredChecks = approvalPolicy(this.config).requiredChecks;
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
            (!exactHead ||
              !exactBaseBranch ||
              !exactBase ||
              pullRequest.reviewDecision === "CHANGES_REQUESTED" ||
              pullRequest.mergeable === "CONFLICTING" ||
              !requiredChecks.every(checkPassed)),
        );
        if (approvalInvalidated && batch.autoMergeEnabled) {
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
          if (
            !exactHead ||
            !approval ||
            approval.candidateSha !== candidate.sha ||
            approval.baseSha !== candidate.baseSha ||
            approval.policyRevision !== candidate.policyRevision
          ) {
            return await this.store.transaction((current, audit) => {
              const stored = requireBatch(current, id);
              const currentCandidate = requireCurrentCandidate(stored);
              currentCandidate.state = "blocked";
              currentCandidate.reason = "GitHub merged a SHA that did not satisfy the broker approval invariant.";
              stored.status = "failed";
              stored.error = currentCandidate.reason;
              stored.finishedAt = now();
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
            if (!exactHead || !exactBaseBranch || !exactBase) {
              currentCandidate.state = "blocked";
              currentCandidate.reason = !exactHead
                ? `Pull request head changed from ${currentCandidate.sha} to ${pullRequest.headRefOid ?? "unknown"}.`
                : !exactBaseBranch
                  ? `Pull request base branch changed from ${stored.baseBranch} to ${pullRequest.baseRefName}.`
                  : `Base moved from ${currentCandidate.baseSha} to ${pullRequest.baseRefOid}. Rebuild the candidate.`;
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
            } else if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
              currentCandidate.state = "changes_requested";
              currentCandidate.reason = "GitHub review requested changes.";
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
            } else if (pullRequest.mergeable === "CONFLICTING") {
              currentCandidate.state = "blocked";
              currentCandidate.reason = "GitHub reports merge conflicts.";
              delete currentCandidate.approval;
              stored.autoMergeEnabled = false;
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
              if (
                currentCandidate.approval &&
                currentCandidate.state !== "approved" &&
                currentCandidate.state !== "merging"
              ) {
                delete currentCandidate.approval;
                stored.autoMergeEnabled = false;
                currentCandidate.state = candidateState(currentCandidate);
                currentCandidate.reason = "Required GitHub verification changed after approval; approval was revoked.";
              } else {
                delete currentCandidate.reason;
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
      if (pullRequest.state !== "MERGED") return structuredClone(batch);
      mergedAt = pullRequest.mergedAt ?? now();
      mergeCommitSha = pullRequest.mergeCommitSha;
    } else if (batch.headSha) {
      await this.repo.git(["fetch", this.config.remote, this.config.baseBranch]);
      const check = await this.repo.git(
        ["merge-base", "--is-ancestor", batch.headSha, `${this.config.remote}/${this.config.baseBranch}`],
        this.repo.root,
        true,
      );
      if (check.exitCode !== 0) return structuredClone(batch);
      mergedAt = now();
      mergeCommitSha = batch.headSha;
    } else {
      throw new BrokerError("BATCH_NOT_SYNCABLE", `Batch ${id} has no PR URL or head commit.`);
    }
    return await this.markBatchMerged(id, mergedAt, mergeCommitSha);
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
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      batch.status = "closed";
      batch.error = reason;
      batch.closedAt = now();
      batch.finishedAt = batch.closedAt;
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
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    if (batch.status !== "prepared" && batch.status !== "published") {
      throw new BrokerError(
        "BATCH_NOT_REFRESHABLE",
        `Batch ${id} cannot be refreshed while ${batch.status}. Only a batch still waiting to merge can be re-cut.`,
      );
    }

    if (this.config.integration.refreshBase) {
      await this.repo.fetchBranch(this.config.remote, this.config.baseBranch);
    }
    const currentBase = await this.repo.resolveCommit(this.config.baseRef);
    if (currentBase === batch.baseSha) {
      return {
        refreshed: false,
        reason: "already_current",
        baseSha: currentBase,
        closed: structuredClone(batch),
      };
    }

    // Closed before the tasks are requeued: a superseded pull request left open is one a human can
    // still merge, which would land the batch this call is replacing.
    let pullRequestClosed: boolean | undefined;
    if (batch.pullRequestUrl) {
      pullRequestClosed = await this.publisher.closePullRequest(
        this.repo.root,
        batch.pullRequestUrl,
        `Superseded: the base branch moved to ${currentBase.slice(0, 7)}, so this batch was re-cut from the current tip.`,
      );
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
      stored.error = `Superseded: base moved from ${stored.baseSha.slice(0, 7)} to ${currentBase.slice(0, 7)}.`;
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

    const integration = await this.integrate({
      taskIds: closed.taskIds,
      publish: options.publish ?? false,
    });
    return {
      refreshed: true,
      baseSha: currentBase,
      closed,
      integration,
      ...(pullRequestClosed === undefined ? {} : { pullRequestClosed }),
    };
  }

  async markBatchMerged(id: string, mergedAt = now(), mergeCommitSha?: string): Promise<BatchRecord> {
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      // "closed" is included so a pull request that was reopened and merged can still be reconciled
      // with "batch complete".
      if (!new Set<BatchRecord["status"]>(["prepared", "published", "closed", "merged"]).has(batch.status)) {
        throw new BrokerError("BATCH_NOT_MERGED", `Batch ${id} cannot be completed while ${batch.status}.`);
      }
      if (approvalPolicy(this.config).required) {
        const candidate = requireCurrentCandidate(batch);
        const approval = candidate.approval;
        if (
          !approval ||
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
    worktrees: Array<{ path: string; branch?: string; registeredTaskIds: string[]; clean: boolean }>;
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
    const details = await Promise.all(
      worktrees.map(async (worktree) => ({
        path: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        registeredTaskIds: registeredPaths.get(path.resolve(worktree.path)) ?? [],
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
            item.registeredTaskIds.length === 0,
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
    return await Promise.all(["state", "integration"].map(async (name) => await this.store.inspectLock(name)));
  }

  async releaseLock(name: string, options: { force?: boolean } = {}): Promise<LockStatus> {
    if (name !== "state" && name !== "integration") {
      throw new BrokerError("UNKNOWN_LOCK", `Unknown lock: ${name}. Expected "state" or "integration".`);
    }
    const released = await this.store.releaseLock(name, options);
    await this.store.transaction((_state, audit) => {
      audit("lock.released", { details: { lock: name, forced: options.force ?? false, previous: released.owner } });
    });
    return released;
  }

  async metrics(): Promise<Record<string, unknown>> {
    const state = await this.store.read();
    const tasks = Object.values(state.tasks);
    const batches = Object.values(state.batches);
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
    let ghAvailable = false;
    let ghAuthenticated: boolean | undefined;
    if (forgeRequired) {
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
        )}s old${lock.abandoned ? "; its owning process is gone, so \"merge-broker unlock\" can clear it" : ""}.`,
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
        githubCli: { required: forgeRequired, available: ghAvailable, authenticated: ghAuthenticated },
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
