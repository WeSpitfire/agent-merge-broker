export const STATE_VERSION = 1 as const;
export const CONFIG_VERSION = 1 as const;

export type UnexpectedPathPolicy = "error" | "warn" | "allow";
export type PublishMode = "none" | "branch" | "pull-request";
export type ValidationAuthority = "broker" | "required-ci";
export type HistoryMode = "preserve" | "squash";
export type MergeMethod = "squash" | "merge" | "rebase";
export type CandidateState =
  | "verifying"
  | "ready_for_approval"
  | "approved"
  | "merging"
  | "changes_requested"
  | "verification_failed"
  | "superseded"
  | "blocked"
  | "abandoned"
  | "merged";
export type VerificationStatus = "passed" | "failed";
export type VerificationSource = "manual" | "github-check";
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
      /** Require every retained batch manifest to carry a valid Ed25519 signature. */
      requireSignature?: boolean;
      /** Ed25519 public key trusted by remote verification. The private key never enters Git. */
      publicKey?: string;
    };
  };
  validation: {
    shell?: string;
    /**
     * Where the complete integration decision is made. `broker` runs the authoritative commands
     * locally; `required-ci` publishes after focused preflight and relies on protected PR checks.
     */
    authority: ValidationAuthority;
    focused: ValidatorConfig[];
    authoritative: ValidatorConfig[];
  };
  /**
   * Optional for configuration-file compatibility. `validateConfig` fills the defaults at runtime.
   * When required, no broker merge operation is allowed before exact candidate approval.
   */
  approval?: {
    required: boolean;
    policyRevision: string;
    requiredVerifications: string[];
    requiredChecks: string[];
    authorizedActors: string[];
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

export interface VerificationEvidence {
  name: string;
  source: VerificationSource;
  status: VerificationStatus;
  candidateSha: string;
  baseSha: string;
  policyRevision: string;
  actor: string;
  recordedAt: string;
  evidenceUrl?: string;
  notes?: string;
}

export interface ApprovalRecord {
  candidateSha: string;
  baseSha: string;
  policyRevision: string;
  actor: string;
  approvedAt: string;
}

export interface CandidateRecord {
  revision: number;
  sha: string;
  baseSha: string;
  policyRevision: string;
  state: CandidateState;
  requiredVerifications: string[];
  verifications: VerificationEvidence[];
  createdAt: string;
  approval?: ApprovalRecord;
  reason?: string;
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
  /** Absent only on batches written before validation authority became explicit. */
  validationAuthority?: ValidationAuthority;
  baseBranch: string;
  baseSha: string;
  branchName?: string;
  headSha?: string;
  /** Exact integrated artifact whose evidence and approval control merge authorization. */
  candidate?: CandidateRecord;
  /** Earlier immutable candidates retained for audit after a revision changes the SHA or base. */
  candidateHistory?: CandidateRecord[];
  integratedHeadSha?: string;
  provenancePath?: string;
  worktree?: string;
  validations: ValidationResult[];
  createdAt: string;
  finishedAt?: string;
  publishedAt?: string;
  pullRequestUrl?: string;
  autoMergeEnabled?: boolean;
  /**
   * Something after the pull request went wrong -- auto-merge, usually. The batch is published and
   * real; this says what still needs a hand. Distinct from `error`, which means the batch failed.
   */
  publishWarning?: string;
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
  signature?: {
    algorithm: "ed25519";
    keyId: string;
    value: string;
  };
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
  /** Integrate even though an earlier batch is still unmerged. See `integrate`. */
  force?: boolean;
}

export interface IntegrationResult {
  batch: BatchRecord;
  selected: string[];
  rejected: ScheduleRejection[];
  dryRun: boolean;
}

/**
 * The outcome of running configured validators against a working tree. `ok` is the whole answer a
 * worker needs; the rest is what to read when it is false.
 */
export interface LocalValidationResult {
  ok: boolean;
  baseRef: string;
  baseSha: string;
  headSha: string;
  files: string[];
  validations: ValidationResult[];
  error?: string;
}

/**
 * The outcome of re-cutting a batch the base branch moved out from under. `refreshed: false` with
 * `reason: "already_current"` means the batch was never stale and nothing was touched.
 */
export interface RefreshResult {
  refreshed: boolean;
  reason?: "already_current";
  baseSha: string;
  closed: BatchRecord;
  integration?: IntegrationResult;
  /** False when the superseded pull request could not be closed and is still open. */
  pullRequestClosed?: boolean;
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

export interface RecoveryResult {
  /** Running batches marked failed because no integration process still owned them. */
  batches: string[];
  /** Tasks returned to the submitted queue without spending their attempt budget. */
  tasks: string[];
  worktreesRemoved: string[];
  branchesRemoved: string[];
  cleanupWarnings: string[];
}

export interface RevisionResult {
  batch: BatchRecord;
  task: TaskRecord;
  previousCandidate: CandidateRecord;
}
