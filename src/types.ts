export const STATE_VERSION = 1 as const;
export const CONFIG_VERSION = 1 as const;

export type UnexpectedPathPolicy = "error" | "warn" | "allow";
export type PublishMode = "none" | "branch" | "pull-request";
export type HistoryMode = "preserve" | "squash";
export type MergeMethod = "squash" | "merge" | "rebase";
export type TaskStatus =
  | "registered"
  | "claimed"
  | "submitted"
  | "integrating"
  | "batched"
  | "published"
  | "merged"
  | "failed"
  | "cancelled";
export type BatchStatus = "running" | "verified" | "prepared" | "published" | "merged" | "closed" | "failed";

export interface ValidatorConfig {
  name: string;
  command: string;
  paths?: string[];
  timeoutSeconds?: number;
  env?: Record<string, string>;
}

export interface BrokerConfig {
  version: typeof CONFIG_VERSION;
  baseBranch: string;
  baseRef: string;
  remote: string;
  stateDirectory: string;
  leases: {
    ttlSeconds: number;
    lockTimeoutSeconds: number;
    serializedPatterns: string[];
  };
  policies: {
    unexpectedPaths: UnexpectedPathPolicy;
    requireCleanWorktree: boolean;
    requireDependencies: boolean;
  };
  scheduling: {
    maxTasks: number;
    maxCommits: number;
    maxWaitSeconds: number;
    allowPathOverlap: boolean;
  };
  integration: {
    branchPrefix: string;
    history: HistoryMode;
    keepFailedWorktrees: boolean;
    refreshBase: boolean;
    maxAttempts: number;
    provenance?: {
      enabled: boolean;
      directory: string;
    };
  };
  validation: {
    shell?: string;
    focused: ValidatorConfig[];
    authoritative: ValidatorConfig[];
  };
  publish: {
    mode: PublishMode;
    draft: boolean;
    autoMerge: boolean;
    mergeMethod: MergeMethod;
    labels: string[];
    titleTemplate: string;
  };
}

export interface LeaseRecord {
  tokenHash: string;
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface ValidationResult {
  name: string;
  command: string;
  scope: "focused" | "authoritative";
  taskId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TaskRecord {
  id: string;
  title?: string;
  agent?: string;
  status: TaskStatus;
  priority: number;
  baseSha: string;
  expectedPaths: string[];
  actualPaths: string[];
  dependsOn: string[];
  commits: string[];
  worktree?: string;
  lease?: LeaseRecord;
  warnings: string[];
  validations: ValidationResult[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  batchedAt?: string;
  publishedAt?: string;
  mergedAt?: string;
  batchId?: string;
  lastError?: string;
  attempts?: number;
}

export interface BatchRecord {
  id: string;
  status: BatchStatus;
  taskIds: string[];
  baseBranch: string;
  baseSha: string;
  branchName?: string;
  headSha?: string;
  integratedHeadSha?: string;
  provenancePath?: string;
  worktree?: string;
  validations: ValidationResult[];
  createdAt: string;
  finishedAt?: string;
  publishedAt?: string;
  pullRequestUrl?: string;
  autoMergeEnabled?: boolean;
  closedAt?: string;
  error?: string;
}

export interface BatchProvenance {
  version: 1;
  generator: "agent-merge-broker";
  batchId: string;
  baseBranch: string;
  /**
   * How the batch was assembled. Squashing replaces the cherry-pick trail, so a verifier cannot
   * look for submitted commits in the integrated history. Absent on manifests written before this
   * field existed, which were always assembled with preserved history.
   */
  history?: HistoryMode;
  baseSha: string;
  integratedHeadSha: string;
  taskIds: string[];
  tasks: Array<{
    id: string;
    commits: string[];
    actualPaths: string[];
    dependsOn: string[];
  }>;
  validations: Array<{
    name: string;
    scope: "focused" | "authoritative";
    taskId?: string;
    exitCode: number;
    durationMs: number;
  }>;
  createdAt: string;
}

export interface AuditEvent {
  sequence: number;
  at: string;
  event: string;
  actor?: string;
  taskId?: string;
  batchId?: string;
  details?: Record<string, unknown>;
}

export interface BrokerState {
  version: typeof STATE_VERSION;
  sequence: number;
  tasks: Record<string, TaskRecord>;
  batches: Record<string, BatchRecord>;
}

export interface CommitReceipt {
  version: 1;
  taskId: string;
  agent?: string;
  baseSha: string;
  commits: string[];
  expectedPaths: string[];
  actualPaths: string[];
  dependsOn: string[];
  worktree?: string;
  submittedAt: string;
  warnings: string[];
}

export interface ScheduleRejection {
  taskId: string;
  reason: string;
  conflictsWith?: string;
}

export interface SchedulePlan {
  selected: TaskRecord[];
  rejected: ScheduleRejection[];
  totalCommits: number;
}

export interface IntegrationOptions {
  dryRun?: boolean;
  publish?: boolean;
  taskIds?: string[];
  maxTasks?: number;
}

export interface IntegrationResult {
  batch: BatchRecord;
  selected: string[];
  rejected: ScheduleRejection[];
  dryRun: boolean;
}

export interface PruneOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface PruneResult {
  tasks: string[];
  batches: string[];
  /** Completed tasks kept because a retained task still declares them as a dependency. */
  retainedForDependencies: string[];
  cutoff: string;
  archivePath?: string;
  dryRun: boolean;
}
