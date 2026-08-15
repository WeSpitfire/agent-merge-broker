import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BrokerError, CommandError, ValidationError } from "./errors.js";
import { GitRepository } from "./git.js";
import { initializeConfig, loadConfig } from "./config.js";
import { patternSetsMayOverlap, unexpectedPaths } from "./patterns.js";
import { scheduleTasks } from "./scheduler.js";
import { StateStore } from "./store.js";
import { runValidators } from "./validation.js";
import { inspectPullRequest, publishBatch as publishPreparedBatch } from "./publisher.js";
import type {
  BatchRecord,
  BrokerConfig,
  BrokerState,
  CommitReceipt,
  IntegrationOptions,
  IntegrationResult,
  SchedulePlan,
  TaskRecord,
  ValidationResult,
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
}

export class MergeBroker {
  readonly repo: GitRepository;
  readonly config: BrokerConfig;
  readonly store: StateStore;

  private constructor(repo: GitRepository, config: BrokerConfig, store: StateStore) {
    this.repo = repo;
    this.config = config;
    this.store = store;
  }

  static async open(cwd = process.cwd()): Promise<MergeBroker> {
    const repo = await GitRepository.discover(cwd);
    const config = await loadConfig(repo.root);
    const store = new StateStore(repo.commonGitDir, config.stateDirectory, config.leases.lockTimeoutSeconds);
    await store.initialize();
    return new MergeBroker(repo, config, store);
  }

  static async initialize(
    cwd = process.cwd(),
    options: { baseBranch?: string; baseRef?: string; remote?: string; force?: boolean } = {},
  ): Promise<{ repoRoot: string; configPath: string; created: boolean }> {
    const repo = await GitRepository.discover(cwd);
    const initialized = await initializeConfig(repo.root, options);
    const store = new StateStore(
      repo.commonGitDir,
      initialized.config.stateDirectory,
      initialized.config.leases.lockTimeoutSeconds,
    );
    await store.initialize();
    return { repoRoot: repo.root, configPath: initialized.path, created: initialized.created };
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

  async claimTask(input: ClaimTaskInput): Promise<{ task: TaskRecord; token: string }> {
    assertTaskId(input.id);
    if (input.priority !== undefined && !Number.isInteger(input.priority)) {
      throw new BrokerError("INVALID_TASK", "Task priority must be an integer.");
    }
    const token = createToken();
    const timestamp = now();
    const expiresAt = new Date(Date.now() + this.config.leases.ttlSeconds * 1_000).toISOString();
    const defaultBase = await this.repo.resolveCommit(input.base ?? this.config.baseRef);
    return await this.store.transaction((state, audit) => {
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
        throw new BrokerError("TASK_NOT_CLAIMABLE", `Task ${task.id} cannot be claimed while ${task.status}.`);
      }
      if (task.lease && !leaseExpired(task)) {
        throw new BrokerError("LEASE_CONFLICT", `Task ${task.id} is already leased by ${task.lease.holder}.`);
      }

      const expectedPaths = input.expectedPaths ?? task.expectedPaths;
      if (expectedPaths.length === 0) {
        throw new BrokerError("PATHS_REQUIRED", "At least one expected path pattern is required to claim a task.");
      }
      for (const existing of Object.values(state.tasks)) {
        if (existing.id === task.id || !existing.lease || leaseExpired(existing)) continue;
        if (patternSetsMayOverlap(expectedPaths, existing.expectedPaths)) {
          throw new BrokerError(
            "LEASE_CONFLICT",
            `Expected paths overlap active task ${existing.id}, leased by ${existing.lease.holder}.`,
            { conflictingTask: existing.id },
          );
        }
        const resources = this.config.leases.serializedPatterns.filter((resource) =>
          patternSetsMayOverlap(expectedPaths, [resource]),
        );
        const existingResources = this.config.leases.serializedPatterns.filter((resource) =>
          patternSetsMayOverlap(existing.expectedPaths, [resource]),
        );
        const sharedResource = resources.find((resource) => existingResources.includes(resource));
        if (sharedResource) {
          throw new BrokerError(
            "LEASE_CONFLICT",
            `Serialized resource ${sharedResource} is leased by task ${existing.id}.`,
            { conflictingTask: existing.id, resource: sharedResource },
          );
        }
      }

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

  async releaseTask(taskId: string, token: string): Promise<TaskRecord> {
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      verifyLease(task, token);
      const actor = task.lease?.holder;
      delete task.lease;
      if (task.status === "claimed" || task.status === "failed") task.status = "registered";
      task.updatedAt = now();
      audit("task.released", { ...(actor ? { actor } : {}), taskId });
      return structuredClone(task);
    });
  }

  async cancelTask(taskId: string, token?: string): Promise<TaskRecord> {
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      if (task.lease) {
        if (!token) throw new BrokerError("LEASE_TOKEN", `A lease token is required to cancel task ${taskId}.`);
        verifyLease(task, token);
      }
      if (["batched", "published", "merged"].includes(task.status)) {
        throw new BrokerError("TASK_NOT_CANCELLABLE", `Task ${taskId} cannot be cancelled while ${task.status}.`);
      }
      task.status = "cancelled";
      delete task.lease;
      task.updatedAt = now();
      audit("task.cancelled", { taskId });
      return structuredClone(task);
    });
  }

  async retryTask(taskId: string, token?: string): Promise<TaskRecord> {
    return await this.store.transaction((state, audit) => {
      const task = requireTask(state, taskId);
      if (task.status !== "failed") {
        throw new BrokerError("TASK_NOT_RETRYABLE", `Task ${taskId} cannot be retried while ${task.status}.`);
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

  async submitTask(taskId: string, commits: string[], token: string): Promise<{ task: TaskRecord; receiptPath: string }> {
    assertTaskId(taskId);
    if (commits.length === 0) throw new BrokerError("COMMITS_REQUIRED", "At least one commit is required.");
    const snapshot = requireTask(await this.store.read(), taskId);
    verifyLease(snapshot, token);
    if (this.config.policies.requireCleanWorktree && snapshot.worktree) {
      if (!(await this.repo.isClean(snapshot.worktree))) {
        throw new BrokerError("DIRTY_WORKTREE", `Task worktree is not clean: ${snapshot.worktree}`);
      }
    }
    const resolvedCommits: string[] = [];
    for (const commit of commits) resolvedCommits.push(await this.repo.resolveCommit(commit));
    if (new Set(resolvedCommits).size !== resolvedCommits.length) {
      throw new BrokerError("DUPLICATE_COMMIT", `Task ${taskId} submitted the same commit more than once.`);
    }
    for (const commit of resolvedCommits) {
      if ((await this.repo.parentCount(commit)) > 1) {
        throw new BrokerError(
          "MERGE_COMMIT",
          `Task ${taskId} submitted merge commit ${commit}. Submit focused linear commits instead.`,
        );
      }
      if ((await this.repo.changedFiles(commit)).length === 0) {
        throw new BrokerError("EMPTY_COMMIT", `Task ${taskId} submitted empty commit ${commit}.`);
      }
    }
    const actualPaths = await this.repo.changedFilesForCommits(resolvedCommits);
    const outsideScope = unexpectedPaths(actualPaths, snapshot.expectedPaths);
    if (outsideScope.length > 0 && this.config.policies.unexpectedPaths === "error") {
      throw new BrokerError("UNEXPECTED_PATHS", `Task ${taskId} changed files outside its declared scope.`, {
        unexpectedPaths: outsideScope,
      });
    }
    const timestamp = now();
    const task = await this.store.transaction((state, audit) => {
      const current = requireTask(state, taskId);
      verifyLease(current, token);
      if (current.status !== "claimed" && current.status !== "failed") {
        throw new BrokerError("TASK_NOT_SUBMITTABLE", `Task ${taskId} cannot be submitted while ${current.status}.`);
      }
      current.commits = resolvedCommits;
      current.actualPaths = actualPaths;
      current.warnings =
        outsideScope.length > 0 && this.config.policies.unexpectedPaths === "warn"
          ? [`Changed outside expected paths: ${outsideScope.join(", ")}`]
          : [];
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
        details: { commits: resolvedCommits, actualPaths, warnings: current.warnings },
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

  async integrate(options: IntegrationOptions = {}): Promise<IntegrationResult> {
    return await this.store.withIntegrationLock(async () => {
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
        baseBranch: this.config.baseBranch,
        baseSha,
        worktree,
        validations: [],
        createdAt: now(),
      };

      await this.store.transaction((state, audit) => {
        for (const selected of plan.selected) {
          const task = requireTask(state, selected.id);
          if (task.status !== "submitted") {
            throw new BrokerError("TASK_CHANGED", `Task ${task.id} changed status before integration.`);
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
      // Set while work is attributable to a single task, so one bad commit fails that task instead
      // of the whole batch. Cleared before authoritative validation, which indicts the batch.
      let culpritTaskId: string | undefined;
      try {
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
        });
        batch.validations.push(...authoritative);
        if (this.config.integration.history === "squash") {
          headSha = await this.repo.squash(
            worktree,
            baseSha,
            `Integrate batch ${id}\n\n${plan.selected.map((task) => `Task: ${task.id}`).join("\n")}`,
          );
        }
        batch.headSha = headSha;
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
              details: { taskIds: batch.taskIds, branchName, headSha },
            });
          });
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
            details: { error: batch.error, ...(culpritTaskId ? { culpritTaskId } : {}), requeued },
          });
        });
        await this.store.writeBatchManifest(id, { batch, error: batch.error });
        throw error;
      } finally {
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

  async publishBatch(id: string): Promise<BatchRecord> {
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    if (batch.status !== "prepared") {
      throw new BrokerError("BATCH_NOT_PUBLISHABLE", `Batch ${id} cannot be published while ${batch.status}.`);
    }
    const tasks = batch.taskIds.map((taskId) => requireTask(state, taskId));
    let publication;
    try {
      publication = await publishPreparedBatch({ repo: this.repo, config: this.config, batch, tasks });
    } catch (error) {
      await this.store.transaction((current, audit) => {
        const stored = Object.hasOwn(current.batches, id) ? current.batches[id] : undefined;
        if (stored) stored.error = errorMessage(error);
        audit("batch.publish_failed", { batchId: id, details: { error: errorMessage(error) } });
      });
      throw error;
    }
    return await this.store.transaction((current, audit) => {
      const stored = requireBatch(current, id);
      stored.status = "published";
      stored.publishedAt = now();
      delete stored.error;
      if (publication.pullRequestUrl) stored.pullRequestUrl = publication.pullRequestUrl;
      if (publication.autoMergeEnabled !== undefined) stored.autoMergeEnabled = publication.autoMergeEnabled;
      for (const taskId of stored.taskIds) {
        const task = requireTask(current, taskId);
        task.status = "published";
        task.publishedAt = stored.publishedAt;
        task.updatedAt = now();
      }
      audit("batch.published", {
        batchId: id,
        details: {
          branchName: stored.branchName,
          pullRequestUrl: stored.pullRequestUrl,
          autoMergeEnabled: stored.autoMergeEnabled,
        },
      });
      return structuredClone(stored);
    });
  }

  async syncBatch(id: string): Promise<BatchRecord> {
    const state = await this.store.read();
    const batch = requireBatch(state, id);
    if (batch.status === "merged") return structuredClone(batch);
    let mergedAt: string | undefined;
    let mergeCommitSha: string | undefined;
    if (batch.pullRequestUrl) {
      const pullRequest = await inspectPullRequest(this.repo.root, batch.pullRequestUrl);
      // A pull request closed without merging means the work was rejected, not completed. Leaving
      // the batch "published" strands every task in it forever and reads like success.
      if (pullRequest.state === "CLOSED") {
        return await this.closeBatch(id, `Pull request ${batch.pullRequestUrl} was closed without merging.`);
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
   * Records that a published batch will never merge and returns its tasks to the queue, so the work
   * is re-planned against a fresh base instead of being silently lost.
   */
  async closeBatch(id: string, reason: string): Promise<BatchRecord> {
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      batch.status = "closed";
      batch.error = reason;
      batch.closedAt = now();
      batch.finishedAt = batch.closedAt;
      const requeued: string[] = [];
      const exhausted: string[] = [];
      for (const taskId of batch.taskIds) {
        const task = requireTask(state, taskId);
        if (task.status === "merged") continue;
        delete task.batchId;
        delete task.publishedAt;
        task.lastError = reason;
        task.attempts = (task.attempts ?? 0) + 1;
        task.updatedAt = now();
        if (task.attempts < this.config.integration.maxAttempts && task.commits.length > 0) {
          task.status = "submitted";
          requeued.push(taskId);
        } else {
          task.status = "failed";
          exhausted.push(taskId);
        }
      }
      audit("batch.closed", { batchId: id, details: { reason, requeued, exhausted } });
      return structuredClone(batch);
    });
  }

  async markBatchMerged(id: string, mergedAt = now(), mergeCommitSha?: string): Promise<BatchRecord> {
    return await this.store.transaction((state, audit) => {
      const batch = requireBatch(state, id);
      // "closed" is included so a pull request that was reopened and merged can still be reconciled
      // with "batch complete".
      if (!new Set<BatchRecord["status"]>(["prepared", "published", "closed", "merged"]).has(batch.status)) {
        throw new BrokerError("BATCH_NOT_MERGED", `Batch ${id} cannot be completed while ${batch.status}.`);
      }
      batch.status = "merged";
      batch.finishedAt = mergedAt;
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
    const [baseSha, clean, worktrees] = await Promise.all([
      this.repo.resolveCommit(this.config.baseRef),
      this.repo.isClean(),
      this.repo.listWorktrees(),
    ]);
    return {
      ok: true,
      repository: this.repo.root,
      gitDirectory: this.repo.commonGitDir,
      stateDirectory: this.store.directory,
      config: path.join(this.repo.root, ".merge-broker", "config.json"),
      baseBranch: this.config.baseBranch,
      baseRef: this.config.baseRef,
      baseSha,
      worktreeClean: clean,
      worktreeCount: worktrees.length,
      publishMode: this.config.publish.mode,
      focusedValidators: this.config.validation.focused.map((validator) => validator.name),
      authoritativeValidators: this.config.validation.authoritative.map((validator) => validator.name),
    };
  }
}
