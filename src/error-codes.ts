/**
 * Every stable `BrokerError` code and its documented category. `BrokerError` accepts only these codes,
 * so a new code cannot be thrown without being registered here, and a test keeps docs/PROTOCOL.md in
 * sync. Removing or renaming a code is a breaking change; adding one is a minor change.
 */
export type BrokerErrorCategory =
  | "input"
  | "lease"
  | "integration"
  | "gate"
  | "state"
  | "storage"
  | "signing"
  | "publication"
  | "forge"
  | "approval"
  | "host"
  | "internal";

export const BROKER_ERROR_CATEGORIES: Readonly<Record<BrokerErrorCategory, string>> = {
  input: "Setup, input, and lookup",
  lease: "Lease and task lifecycle",
  integration: "Receipt, scheduling, and integration",
  gate: "Trusted local-ref intake",
  state: "Locks and state",
  storage: "Storage maintenance",
  signing: "Signing and proof",
  publication: "Target and publication",
  forge: "Forge observation and merge control",
  approval: "Approval, revision, and refresh",
  host: "Service, hook, platform, and subprocess",
  internal: "Internal failure",
};

export const BROKER_ERROR_CODES = {
  // Setup, input, and lookup
  NOT_INITIALIZED: "input",
  INVALID_CONFIG: "input",
  INVALID_ARGUMENTS: "input",
  OUTPUT_EXISTS: "input",
  ACTOR_REQUIRED: "input",
  INVALID_INTERVAL: "input",
  INVALID_LIMIT: "input",
  INVALID_MCP_PROFILE: "input",
  INVALID_AGENT_CONTRACT: "input",
  INVALID_PULL_REQUEST_URL: "input",
  INVALID_SIGNING_KEY: "input",
  INVALID_TASK: "input",
  PATHS_REQUIRED: "input",
  UNSAFE_PATH: "input",
  TASK_EXISTS: "input",
  UNKNOWN_TASK: "input",
  UNKNOWN_BATCH: "input",
  UNKNOWN_COMMIT: "input",
  UNKNOWN_DEPENDENCY: "input",
  UNKNOWN_LOCK: "input",
  // Lease and task lifecycle
  LEASE_REQUIRED: "lease",
  LEASE_CONFLICT: "lease",
  LEASE_EXPIRED: "lease",
  LEASE_TOKEN: "lease",
  LEASE_NOT_OWNED: "lease",
  TASK_CHANGED: "lease",
  TASK_NOT_CLAIMABLE: "lease",
  TASK_NOT_SUBMITTABLE: "lease",
  TASK_NOT_CANCELLABLE: "lease",
  TASK_NOT_RETRYABLE: "lease",
  TASK_NOT_REVISABLE: "lease",
  // Receipt, scheduling, and integration
  COMMITS_REQUIRED: "integration",
  DUPLICATE_COMMIT: "integration",
  EMPTY_COMMIT: "integration",
  MERGE_COMMIT: "integration",
  DIRTY_WORKTREE: "integration",
  UNEXPECTED_PATHS: "integration",
  DEPENDENCY_CYCLE: "integration",
  EMPTY_BATCH: "integration",
  BATCH_OUTSTANDING: "integration",
  CHERRY_PICK_CONFLICT: "integration",
  VALIDATION_FAILED: "integration",
  VALIDATOR_MUTATED_WORKTREE: "integration",
  // Trusted local-ref intake
  INVALID_SUBMISSION_REF: "gate",
  UNKNOWN_SUBMISSION: "gate",
  EMPTY_SUBMISSION: "gate",
  BASE_NOT_ANCESTOR: "gate",
  NON_LINEAR_HISTORY: "gate",
  HISTORY_INSPECTION_FAILED: "gate",
  SUBMISSION_TOO_LARGE: "gate",
  SUBMISSION_GIT_UNSUPPORTED: "gate",
  SUBMISSION_OBJECT_STORE_UNSUPPORTED: "gate",
  GIT_OBJECT_READ_FAILED: "gate",
  SUBMISSION_VALIDATION_UNAVAILABLE: "gate",
  SUBMISSION_POLICY_UNAVAILABLE: "gate",
  SUBMISSION_POLICY_INVALID: "gate",
  SUBMISSION_POLICY_CHANGED: "gate",
  SUBMISSION_IDENTITY_CHANGED: "gate",
  SUBMISSION_REF_CHANGED: "gate",
  SUBMISSION_CHANGED: "gate",
  SUBMISSION_EXISTS: "gate",
  SUBMISSION_FAILED: "gate",
  SUBMISSION_MANIFEST_WRITE_FAILED: "gate",
  VALIDATION_CACHE_CLEANUP_FAILED: "gate",
  PINNED_REF_EXISTS: "gate",
  PIN_REF_FAILED: "gate",
  TEMPORARY_REF_CONFLICT: "gate",
  FETCH_REF_INVALID: "gate",
  TEMPORARY_REF_CLEANUP_FAILED: "gate",
  GIT_HOOK_ISOLATION_FAILED: "gate",
  WORKTREE_IDENTITY_UNAVAILABLE: "gate",
  GATE_AUTHORITY_REQUIRED: "gate",
  GATE_AUTHORITY_EXISTS: "gate",
  GATE_AUTHORITY_CORRUPT: "gate",
  GATE_AUTHORITY_VERSION: "gate",
  GATE_AUTHORITY_MISMATCH: "gate",
  GATE_AUTHORITY_CHANGED: "gate",
  SUBMISSION_NOT_PENDING: "gate",
  SUBMISSION_NOT_TERMINAL: "gate",
  SUBMISSION_ARCHIVE_PENDING: "gate",
  INVALID_SUBMISSION_ARCHIVE: "gate",
  SUBMISSION_REF_RELEASE_FAILED: "gate",
  SUBMISSION_ABANDONED: "gate",
  // Locks and state
  LOCK_HELD: "state",
  LOCK_TIMEOUT: "state",
  STATE_CORRUPT: "state",
  STATE_VERSION: "state",
  AUDIT_ARCHIVE_TOO_LARGE: "state",
  MIGRATION_BLOCKED: "state",
  // Storage maintenance
  STORAGE_CHANGED: "storage",
  STORAGE_VERIFICATION_FAILED: "storage",
  // Signing and proof
  SIGNING_KEY_REQUIRED: "signing",
  SIGNING_KEY_MISMATCH: "signing",
  SIGNING_KEY_EXISTS: "signing",
  PROVENANCE_INVALID: "signing",
  PROVENANCE_KEY_MISSING: "signing",
  SUBMISSION_NOT_ATTESTABLE: "signing",
  SUBMISSION_ATTESTATION_INELIGIBLE: "signing",
  SUBMISSION_ATTESTATION_INVALID: "signing",
  SUBMISSION_ATTESTATION_SIGNATURE_INVALID: "signing",
  SUBMISSION_ATTESTATION_IDENTITY_MISMATCH: "signing",
  // Target and publication
  REMOTE_URL_UNKNOWN: "publication",
  REMOTE_REPOSITORY_UNKNOWN: "publication",
  REMOTE_TARGET_CHANGED: "publication",
  FORGE_TARGET_MISMATCH: "publication",
  BATCH_TARGET_UNBOUND: "publication",
  BASE_REFRESH_FAILED: "publication",
  BATCH_BASE_STALE: "publication",
  NO_BRANCH: "publication",
  NO_CANDIDATE: "publication",
  BRANCH_EXISTS: "publication",
  BRANCH_DELETE_FAILED: "publication",
  WORKTREE_REMOVE_FAILED: "publication",
  PUBLISH_DISABLED: "publication",
  PUBLISH_FAILED: "publication",
  BATCH_NOT_PUBLISHABLE: "publication",
  PULL_REQUEST_LOOKUP_FAILED: "publication",
  PULL_REQUEST_UPDATE_FAILED: "publication",
  // Forge observation and merge control
  PULL_REQUEST_REF_LOOKUP_FAILED: "forge",
  PULL_REQUEST_IDENTITY_UNKNOWN: "forge",
  PULL_REQUEST_BASE_UNKNOWN: "forge",
  PULL_REQUEST_CHANGED_DURING_INSPECTION: "forge",
  PULL_REQUEST_STILL_OPEN: "forge",
  PULL_REQUEST_ALREADY_CLOSED: "forge",
  PULL_REQUEST_CLOSE_FAILED: "forge",
  AUTO_MERGE_FAILED: "forge",
  AUTO_MERGE_DISABLE_FAILED: "forge",
  AUTO_MERGE_STATE_UNKNOWN: "forge",
  MERGE_PROOF_UNAVAILABLE: "forge",
  BATCH_NOT_SYNCABLE: "forge",
  BATCH_NOT_MERGED: "forge",
  // Approval, revision, and refresh
  APPROVAL_DISABLED: "approval",
  APPROVAL_FORBIDDEN: "approval",
  VERIFICATION_NOT_REQUIRED: "approval",
  BATCH_NOT_VERIFIABLE: "approval",
  BATCH_NOT_APPROVABLE: "approval",
  CANDIDATE_MISMATCH: "approval",
  CANDIDATE_NOT_READY: "approval",
  CANDIDATE_BLOCKED: "approval",
  CANDIDATE_STATE_INVALID: "approval",
  CANDIDATE_CHANGED: "approval",
  CANDIDATE_FINAL: "approval",
  CANDIDATE_NOT_APPROVED: "approval",
  CANDIDATE_POLICY_STALE: "approval",
  APPROVAL_REVOCATION_REQUIRED: "approval",
  CHANGE_REQUEST_PENDING: "approval",
  NO_CHANGE_REQUEST: "approval",
  CHANGES_NOT_REQUESTED: "approval",
  BATCH_NOT_REVISABLE: "approval",
  REVISION_IN_PROGRESS: "approval",
  REVISION_INTENT_CHANGED: "approval",
  REFRESH_PENDING: "approval",
  REFRESH_CHANGED: "approval",
  BATCH_NOT_REFRESHABLE: "approval",
  BATCH_CHANGED: "approval",
  BATCH_SUPERSEDED: "approval",
  BATCH_NOT_CLOSABLE: "approval",
  // Service, hook, platform, and subprocess
  HOOKS_PATH_CONFLICT: "host",
  INVALID_SERVICE_PATH: "host",
  INVALID_SERVICE_USER: "host",
  SERVICE_CLI_PATH: "host",
  SERVICE_FILE_CONFLICT: "host",
  SERVICE_PUBLISH_DISABLED: "host",
  SERVICE_USER_ID: "host",
  UNSUPPORTED_PLATFORM: "host",
  COMMAND_FAILED: "host",
  // Internal failure
  INTERNAL_ERROR: "internal",
} as const satisfies Record<string, BrokerErrorCategory>;

export type BrokerErrorCode = keyof typeof BROKER_ERROR_CODES;

export function isBrokerErrorCode(value: string): value is BrokerErrorCode {
  return Object.hasOwn(BROKER_ERROR_CODES, value);
}

/**
 * CLI exit statuses, documented in docs/PROTOCOL.md. Scripts may rely on these values; JSON callers
 * should still branch on the error code for detail.
 */
export const CLI_EXIT_CODES = {
  /** The command succeeded. */
  success: 0,
  /** The command ran and its answer is a rejection: failed validation or failed verification. */
  rejected: 1,
  /** The invocation, input, lookup, or configuration is invalid; retrying unchanged will not help. */
  usage: 2,
  /** The broker refused or could not complete the operation (state, lease, Git, forge, host). */
  failed: 3,
  /** An unexpected internal failure; report it as a defect. */
  internal: 4,
} as const;

/** Codes whose meaning is a verdict about the work or evidence under examination. */
const REJECTION_CODES: ReadonlySet<BrokerErrorCode> = new Set<BrokerErrorCode>([
  "VALIDATION_FAILED",
  "VALIDATOR_MUTATED_WORKTREE",
  "CHERRY_PICK_CONFLICT",
  "PROVENANCE_INVALID",
  "SUBMISSION_ATTESTATION_INVALID",
  "SUBMISSION_ATTESTATION_SIGNATURE_INVALID",
  "SUBMISSION_ATTESTATION_IDENTITY_MISMATCH",
]);

export function cliExitCodeForError(code: BrokerErrorCode): number {
  if (REJECTION_CODES.has(code)) return CLI_EXIT_CODES.rejected;
  const category = BROKER_ERROR_CODES[code];
  if (category === "input") return CLI_EXIT_CODES.usage;
  if (category === "internal") return CLI_EXIT_CODES.internal;
  return CLI_EXIT_CODES.failed;
}
