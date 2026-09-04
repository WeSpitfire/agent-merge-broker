# Worker and adapter protocol

## Contract

A worker needs only five capabilities:

1. Claim an ID and expected path scope.
2. Maintain an expiring lease while editing.
3. Create one or more focused Git commits.
4. Nominate those commit IDs with the lease token.
5. Stop performing Git administration after nomination.

Finite operational CLI commands support `--json`: success writes one JSON value to stdout and exits
zero, while usage and action errors write
`{ "error": { "code": "...", "message": "...", "details": {} } }` to stderr and exit nonzero.
The `details` field is omitted when no diagnostic details exist. Continuous `serve --json` is
intentionally a newline-delimited stream of event objects until the process stops;
`serve --once --json` returns one summary document containing recovery, events, and operation
results. `candidate adopt` has one deliberate terminal-result exception: when it returns a durable
non-`validated` `SubmissionRecord` (`rejected` or `failed`), it writes that record to stdout but exits
nonzero. An exception that prevents a terminal record from being returned uses the normal stderr
error envelope; because durable state may already exist, inspect `candidate list` and run `recover`
before blindly retrying. `--help` and `--version` remain human-readable text. The error code is the
machine-readable branching surface. Messages and details are diagnostic context and may become more
specific without changing the code.

The package also supplies `merge-broker-mcp`, a stdio MCP adapter. Its default `worker` profile
registers only task/status/validation capabilities and keeps lease tokens in the local vault. The
`operator` profile additionally registers planning, integration, publication, synchronization,
verification, approval, audit, metrics, and recovery. Profiles are chosen when the server starts,
not by tool input, so a worker cannot request promotion.

## Retain and validate a trusted local candidate

Gate intake is an operator/API capability in `0.13.0`. It is not registered by either bundled MCP
profile. Gate requires Git 2.46 or newer. The
source must be a trusted Git revision whose complete, repository-owned object graph is already
addressable in the broker repository:

```bash
merge-broker --json candidate authority setup
merge-broker --json candidate authority show
merge-broker --json candidate adopt --ref refs/heads/external-candidate
merge-broker --json candidate list
merge-broker --json candidate show <submission-id>
```

Run `candidate authority setup` only from a reviewed protected checkout. It atomically creates a
versioned registration at `<git-common-dir>/merge-broker-gate-authority.json`; the record conforms to
[`../schemas/gate-authority.schema.json`](../schemas/gate-authority.schema.json). It binds `baseRef`,
`baseBranch`, `remote`, `integration.refreshBase`, `stateDirectory`, and, when present, the SHA-256
fingerprint of Git's canonical **fetch** URL. It never stores the URL or credentials. Repeating setup
for the same identity is idempotent. A different identity requires `candidate authority setup
--replace`, and one config-independent common-directory lock prevents setup/replacement from racing
adoption or recovery. The fetch binding is deliberately distinct from a batch's publication/push URL
binding: a legal `remote.<name>.pushurl` cannot choose Gate's protected base.
`stateDirectory` uses a conservative portable ASCII grammar, excludes Git-admin and broker-authority
names, and is created one physical directory at a time beneath the physical Git common directory;
symlink or junction redirection is rejected.

When `integration.refreshBase` is true and `baseRef` names the configured base branch—whether as
`main`, `origin/main`, or `refs/remotes/origin/main`—setup requires the configured remote to have a
canonical fetch URL and records its fingerprint. It does not silently fall back to a possibly stale
local ref. An intentionally offline/local authority must set `integration.refreshBase` to false before
setup.

`adopt` accepts no caller-supplied base or paths. The mutable checkout must still match the registered
target, but the registration—not that file—is the base-selection authority. The broker also loads
`.merge-broker/config.json` from the exact selected base and requires its target, refresh, and state
fields to match the registration before using its policy. The committed policy currently requires
`validation.authority: "broker"`, and the policy blob must not exceed Gate's 1 MiB safety ceiling.
Before resolving the candidate or base, Gate rejects nonempty ambient Git repository, worktree,
index, namespace, object, graft, shallow, quarantine, replacement-ref, and Git
configuration-injection or transport-command overrides. The match is case-insensitive and includes
`GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_PROXY_COMMAND`, and indexed
`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs. Proxy variables, `GIT_HTTP_*`, `GIT_SSL_*`, and
ambient curl/OpenSSL CA overrides are refused too. Configured `core.sshCommand`, `core.gitProxy`,
`url.*.insteadOf`/`pushInsteadOf`, and HTTP proxy/TLS/routing overrides are also refused before exact
transport. The one TLS-setting exception is Git for Windows' standard unscoped
`http.sslBackend=schannel`; URL-scoped or alternate backend settings remain refused. HTTP
authorization headers remain supported, but `Host`/`:authority` overrides do not. An exact locator
must not collide with an effective local/global/system `remote.*` subsection or Git's legacy remote
shorthands. Gate policy validators cannot declare the environment keys in `env`; internal Git and
validator child environments have inherited values removed defensively.

The artifact must be a nonempty, merge-free linear descendant of the base and contain no more than
the smaller of `scheduling.maxCommits` and Gate's 1,000-commit hard ceiling. The broker resolves the
mutable source ref once, retains the exact commit under
`refs/merge-broker/adopted/<submission-id>`, and thereafter uses
the recorded authority digest, commit, tree, base, policy identity, commit sequence, and derived path
set as authority. It independently recomputes every retained commit, tree, and blob object ID,
parses Git-recognized parent headers byte-for-byte, and rejects a graph whose stored bytes do not
match those IDs.

The returned record conforms to
[`../schemas/submission.schema.json`](../schemas/submission.schema.json). Its statuses are:

| Status | Meaning |
| --- | --- |
| `received` | Durable artifact, base, policy, history, and path identity recorded; retention/validation may still need replay |
| `validating` | The retained identity is being rechecked and evaluated in its disposable worktree |
| `validated` | Every matching focused validator and every authoritative validator passed without changing `HEAD` or the worktree |
| `rejected` | Repository validation failed, or a validator changed the candidate worktree |
| `failed` | Policy loading, Git inspection, cleanup, restored retention loss, or another managed infrastructure operation failed while the final immutable identity remained provable |

`recover` retries `received` and `validating` records under both the fixed authority lock and the
integration lock. Each submission binds the authority digest present when it was received. If an
operator replaces authority while a submission is pending, recovery retains the pending record and
reports a warning rather than replaying it under the new trust root. Terminal records remain
inspectable through `candidate show`, `candidate list`, `state().submissions`, and the private
`submissions/` runtime-manifest directory. A submission is deliberately not a task, receipt, batch,
approval candidate, provenance predicate, publication, or merge authorization; no batch command
accepts its ID. A process stop or cleanup interruption may leave `validating` durable rather than
guessing a terminal result.

No validator runs until `retentionEstablishedAt` durably records that the create-only retained ref
was proven. A missing ref before that marker is the replayable initial pin step; a missing ref after
it is a compromise, never an ambiguous first attempt. Before repairing that later loss, the broker
durably sets `retentionCompromisedAt`, so a crash after repair cannot forget the violation or turn a
later passing retry into `validated`.

No terminal status is written until the broker again proves the complete local object closure,
recorded history/tree/path identity, and direct retained ref. A wrong or symbolic retained ref, or an
irreproducible object identity, therefore leaves the record `validating`; `recover` reports a warning
until an operator restores the exact identity. If any check discovers that an established ref was
removed, it restores the ref with create-only compare-and-swap: a passing run becomes `failed` with
`SUBMISSION_REF_CHANGED`, while an already-failing validator can retain its truthful `rejected`
result. A nonempty nonignored
untracked-path listing, including one that overflows its 4 KiB capture bound, is a bounded
`VALIDATOR_MUTATED_WORKTREE` rejection. The same code covers a changed `.git` marker: Gate binds its
regular gitfile, linked-worktree registry entry, backlink, common repository, and physical top level
before `HEAD` or index reads. Cleanup/recovery repairs only an exact backlink-proven marker and never
uses it as authority to remove a sibling entry. Terminal state is committed before the derived
private manifest. If manifest writing then fails, the command reports
`SUBMISSION_MANIFEST_WRITE_FAILED`, and
`recover` regenerates terminal sidecars from authoritative state before consulting Gate authority,
so a missing or corrupt authority registration does not hide an already-terminal result.

## Claim

```bash
merge-broker --json task claim TASK-123 \
  --holder adapter/session-456 \
  --agent codex \
  --base main \
  --path 'src/billing/**' \
  --depends-on TASK-100 \
  --priority 20
```

The response contains a lease `token`. The state record contains only its digest. By default the
broker keeps a separate mode-0600 copy in its runtime token vault so local adapters do not invent a
working-tree credential store; `--no-store-token` leaves custody entirely to the adapter.

## Heartbeat

Heartbeat before the lease expiry shown in the claim response:

```bash
MERGE_BROKER_TOKEN=... merge-broker --json task heartbeat TASK-123
```

An expired lease can be claimed by another worker. A former holder must not continue editing after losing the lease.

## Extend scope

When a discovered dependency expands the task, extend the active lease with
the same token before editing the additional path:

```bash
MERGE_BROKER_TOKEN=... merge-broker --json task extend TASK-123 \
  --path 'src/shared/contract.ts'
```

The broker rechecks active and serialized-resource conflicts before accepting
the larger scope.

## Nominate a candidate receipt

```bash
MERGE_BROKER_TOKEN=... merge-broker --json task candidate TASK-123 \
  --commit a1b2c3d \
  --commit d4e5f6a
```

Commit order is significant. The broker resolves every revision to a full immutable commit ID and computes actual paths from Git rather than trusting the caller.

The receipt written under Git's common directory conforms to [`../schemas/receipt.schema.json`](../schemas/receipt.schema.json). It contains no lease credential.

`task submit` remains a compatibility alias. Neither command authorizes a merge. Individual task
commits become a merge candidate only after the broker assembles the complete batch.

## Verify and approve an exact candidate

When `approval.required` is true, the candidate written into batch state conforms to
[`../schemas/candidate.schema.json`](../schemas/candidate.schema.json). Its identity is the tuple
`(candidateSha, baseSha, policyRevision)`. Adapters must carry all three values from `batch show` or
JSON state into subsequent commands; they must not substitute a freshly read `HEAD`.

`batch sync` attaches configured GitHub checks to the exact current candidate. Manual verification
uses a named result:

```bash
merge-broker --json batch verify BATCH \
  --name browser --status passed \
  --candidate "$CANDIDATE_SHA" --base "$BASE_SHA" \
  --policy-revision release-v1 --actor browser-agent \
  --evidence-url https://ci.example/run/123
```

Approval is a separate capability:

```bash
merge-broker --json batch approve BATCH \
  --candidate "$CANDIDATE_SHA" --base "$BASE_SHA" \
  --policy-revision release-v1 --actor release-manager
```

The command fails unless all required evidence passed, the actor is authorized, every task remains
published outside an editing lease, and the forge still reports the exact head SHA, target branch,
and base SHA without conflicts or requested changes.

Approval is deliberately a two-phase local/remote transition:

1. The broker observes the open pull request and validates its head, base, reviews, checks, task
   state, and current policy.
2. It durably writes the approval tuple and `approvedAt`. This record alone is not yet merge
   authority.
3. `batch sync` observes the pull request again after that write. Only an unchanged, still-open pull
   request causes the broker to add `confirmedAt` to the approval.
4. If auto-merge is configured, the broker records `autoMergePending` before sending an
   exact-head-guarded enable request. A successful or safely retried request moves the candidate to
   `merging` and clears the pending marker.

When exact approval is required, every merge-authorizing path, including `batch complete`, requires
a current approval with `confirmedAt` and without `revocationRequestedAt`. A batch that already
carries a candidate remains subject to that rule even if configuration is later downgraded.
Repeating `batch approve` for the same current tuple reuses its `approvedAt` and `confirmedAt`; it
does not create a second authorization, and an already-observed queue is not enabled again. Without
`approval.required`, newly assembled batches retain the compatibility behavior and do not create a
`CandidateRecord`.

## Request and submit a revision

```bash
merge-broker --json batch request-changes BATCH \
  --candidate "$CANDIDATE_SHA" --base "$BASE_SHA" \
  --actor reviewer --reason "Responsive verification failed"
merge-broker --json task reopen TASK-123 --holder adapter/session-456
# edit and commit under the new lease
merge-broker --json task revise TASK-123 --since-base
```

The broker reassembles and validates every task in the batch, updates the existing integration
branch with a force-with-lease guard, and keeps the existing pull request. The former candidate is
retained as `superseded`; the replacement has no inherited verification or approval.

### Durable revocation

Revocation is recorded before a possibly live remote queue is changed:

- An explicit `batch request-changes` writes `changeRequestIntent` with the exact candidate and base,
  the supplied policy revision when present, actor, reason, and request time. The broker resolves an
  omitted policy revision to the candidate's current value when checking the binding. That intent
  takes precedence over publication and sync retries, so a restart cannot re-enable the candidate
  before revocation finishes.
- Reconciliation that detects policy drift, a no-longer-authorized approver, a changed head or base,
  requested changes, conflicts, or regressed checks sets `approval.revocationRequestedAt` and
  `approval.revocationReason` before disabling auto-merge.

These fields are durable in-progress tombstones, not evidence that the remote operation already
succeeded. They remain blocking while the disable result is unknown. Once the forge confirms that
the queue is disabled or that the pull request is closed, the broker removes the approval and clears
the in-progress marker; the audit event retains the history. If the pull request merged first, the
broker records a merge-invariant failure instead of treating revocation as successful.

## Publication and recovery protocol

### Immutable target and candidate binding

A publishable batch records the publication target when it is assembled:

- `remote` and `remoteUrlFingerprint` bind the named remote to the exact canonical Git push URL;
- for pull-request publication, `forgeRepository` binds forge operations to a host-qualified
  `HOST/OWNER/REPO` selector;
- `baseBranch` and `baseSha` identify the intended target branch and the exact base validated; and
- `branchName` and `headSha` identify the broker branch and exact retained candidate.

The raw push URL is not stored in batch state. Its SHA-256 fingerprint is compared with the current
canonical URL before later pushes, fetches, refreshes, and merge proofs. Local filesystem remotes are
resolved to their physical path before hashing. Publication pushes `headSha`, never the mutable
local branch tip, with a create-only force-with-lease guard: the same-SHA retry succeeds, while any
different remote branch value is preserved and causes failure.

For an open pull request, reconciliation requires the observed `headRefOid` and `baseRefName` to
match the batch and requires an exact `baseRefOid`. Approval binds the stricter
`(candidateSha, baseSha, policyRevision)` tuple. A missing or ambiguous identity is not interpreted
as a match.

### Publication is a resumable second phase

`prepared` means integration and validation completed but publication may not have started or
finished. A publication retry first pushes the same immutable SHA, then searches **all** pull-request
states for the unique branch/base pair. It creates a pull request only after the adapter proves that
none exists; a lookup failure stops rather than risking a duplicate. This recovers a process that
opened a pull request but stopped before recording its URL.

The broker changes the batch to `published` and stores the pull-request URL before attempting
auto-merge. Consequently, `published` means the branch or pull request exists; it does not mean that
approval exists, auto-merge is enabled, or the work merged. Auto-merge is a separate retryable step:

- `autoMergePending: true` means a remote queue may be live and its state has not been durably
  settled; normally an enable request is in flight or its response was lost, but revocation also
  uses this conservative marker while disabling an unauthorized or legacy queue;
- `autoMergeEnabled: true` means enablement was accepted or observed; and
- `publishWarning` reports a non-fatal publication follow-up problem without undoing successful
  publication. It may describe an auto-merge hand-off or an informational PR-body update after
  candidate revision.

`batch publish` resumes either phase explicitly. `serve --publish` first reconciles published
batches, then resumes stale-base refresh, prepared publication, and eligible pending auto-merge
work before integrating another batch. It does not retry publication for a published batch whose
forge inspection just failed, because it cannot yet distinguish an existing terminal pull request
from an absent one.

### Stale-base refresh result

`MergeBroker.refreshBatch` and JSON `batch refresh` return `RefreshResult`:

| Result | Meaning |
| --- | --- |
| `refreshed: true` | The old batch was closed as superseded, its tasks were requeued without spending their attempt budget, and `integration` contains the replacement batch cut from `baseSha`. `pullRequestClosed` is `true` when the broker closed an old PR and is absent when there was no PR. |
| `refreshed: false`, `reason: "already_current"` | The recorded base is still current and no refresh transition was needed. `closed` is the unchanged batch despite the compatibility field name. |
| `refreshed: false`, `reason: "already_terminal"` | Initial reconciliation found the batch already merged, closed, or failed. `closed` contains that terminal record. |
| `refreshed: false`, `reason: "pull_request_closed"` | The PR was already closed without the broker's durable refresh marker. The old batch is closed, no replacement is created, and `pullRequestClosed` is `false` because this refresh call did not perform the close. |

Before closing a stale pull request, refresh writes `refreshCloseIntent`, disables any possibly live
queue, and includes a unique marker in its close comment. A restart accepts an already-closed PR as
its own completed side effect only when that marker is present. An unconfirmed close throws
`PULL_REQUEST_CLOSE_FAILED`; it is not returned as a successful `RefreshResult`.

### Merge topology proof

The broker never releases dependent tasks merely because a forge says `MERGED`. The PR must retain
the exact candidate head and target branch. If the merged observation still reports the recorded
base SHA, that exact binding is sufficient. When the forge instead reports the target's newer tip,
the broker fetches the durably bound target and requires the reported merge commit to be on it, to
descend from the recorded base, and to have the same final tree as the validated candidate. It then
accepts only one of these shapes:

- fast-forward: the merge commit is the candidate;
- squash: the merge commit has exactly the recorded base as its only parent;
- two-parent merge: the recorded base is first parent and the candidate is second parent; or
- linear rebase: the single-parent commit sequence from the recorded base has the same length and
  the same tree at every step as the candidate's first-parent sequence.

A graph or tree mismatch is a durable merge-invariant failure. Failure to fetch the bound target is
`MERGE_PROOF_UNAVAILABLE` and remains retryable. Branch-only reconciliation is narrower: the broker
marks the batch merged only when its exact `headSha` is an ancestor of the bound target branch.

## Published batch provenance

With `integration.provenance.enabled`, the broker's final integration commit
adds one JSON manifest under the configured repository-relative directory. Its
parent is the assembled task head. The record binds the branch to its base,
task IDs, submitted commits, changed paths, dependencies, and any broker-side
validators. It conforms to
[`../schemas/provenance.schema.json`](../schemas/provenance.schema.json).

When the broker's configured policy requires signatures, the manifest carries an Ed25519 signature
over a canonical representation of every other manifest field. The trusted public key comes from
the base configuration; the private key remains in broker runtime state or an operator secret
channel. The signing payload is UTF-8 JSON with object keys sorted lexically at every depth, array
order retained, no insignificant whitespace, and the root `signature` field omitted.

Remote policy should verify the branch prefix, manifest path, batch ID, base
SHA, final-commit parent, one-file provenance commit, and protected-base signature before spending
time on dependency installation or authoritative CI. The provenance commit must be the branch head;
post-assembly update merges are not part of the protocol.

Protected-base configuration also declares `validation.authority`. `broker` means the manifest
records the locally completed authoritative commands. `required-ci` means the signed batch was
published after focused preflight and the forge's protected status checks must make the complete
decision. Adapters must treat an absent field as `broker` for compatibility.

## Path semantics

Paths are repository-relative and use forward slashes. Globs use picomatch semantics. Prefer the smallest scope that covers expected work:

```text
src/billing/**
test/billing/**
prisma/schema.prisma
```

Avoid `**/*` unless the task genuinely owns the repository. A committed file outside the expected scope is rejected by default.

### Validator path transport

For every invoked validator, the broker writes the validator-relative path list as a UTF-8 JSON array
and sets `MERGE_BROKER_FILES_FILE` to that owner-readable file plus
`MERGE_BROKER_FILES_FILE_FORMAT=json`. The shell-safe `{filesFile}` placeholder expands to the same
path.

Omitted `filesInput` means `inline`. Inline mode supplies both the `MERGE_BROKER_FILES` newline list
and `{files}` shell-quoted argument expansion only when both serialized forms fit within 4 KiB. If
either form is larger, the broker rejects the validator before execution with `VALIDATION_FAILED`,
whether or not its command uses `{files}`; it does not silently replace a nonempty list with an empty
environment value. `filesInput: "json"` is the explicit portable mode for potentially large path
sets. It leaves `MERGE_BROKER_FILES` empty, and a command that still contains `{files}` is rejected;
the validator must read `{filesFile}` or `MERGE_BROKER_FILES_FILE` as JSON data.

## Dependencies

Dependencies refer to broker task IDs. With `requireDependencies` enabled, every referenced task must exist before submission. A dependency is schedulable when it is selected earlier in the same batch or has reached `merged` status.

Repository adapters should distinguish `baseRef`, the Git revision used to build transactions, from `baseBranch`, the forge target. For repositories with a passive local checkout, use `baseRef: "origin/main"` and `baseBranch: "main"`.

Published or prepared work is not treated as merged. This prevents a child from being integrated against a base that does not contain its parent.

## Stable error categories

Adapters should branch on `BrokerError.code` (or a returned terminal `SubmissionRecord.errorCode`),
not message text. These are the currently emitted categories and the normal response to each family:

- Setup, input, and lookup — `NOT_INITIALIZED`, `INVALID_CONFIG`, `INVALID_ARGUMENTS`,
  `INVALID_INTERVAL`, `INVALID_LIMIT`, `INVALID_MCP_PROFILE`, `INVALID_AGENT_CONTRACT`,
  `INVALID_PULL_REQUEST_URL`, `INVALID_SIGNING_KEY`, `INVALID_TASK`, `PATHS_REQUIRED`, `UNSAFE_PATH`,
  `TASK_EXISTS`, `UNKNOWN_TASK`, `UNKNOWN_BATCH`, `UNKNOWN_COMMIT`, `UNKNOWN_DEPENDENCY`, and
  `UNKNOWN_LOCK`. Correct the request or configuration; do not retry it unchanged.
- Lease and task lifecycle — `LEASE_REQUIRED`, `LEASE_CONFLICT`, `LEASE_EXPIRED`, `LEASE_TOKEN`,
  `TASK_CHANGED`, `TASK_NOT_CLAIMABLE`, `TASK_NOT_SUBMITTABLE`, `TASK_NOT_CANCELLABLE`,
  `TASK_NOT_RETRYABLE`, and `TASK_NOT_REVISABLE`. Re-read the task and obtain the current lease or
  perform the lifecycle action named by the error.
- Receipt, scheduling, and integration — `COMMITS_REQUIRED`, `DUPLICATE_COMMIT`, `EMPTY_COMMIT`,
  `MERGE_COMMIT`, `DIRTY_WORKTREE`, `UNEXPECTED_PATHS`, `DEPENDENCY_CYCLE`, `EMPTY_BATCH`,
  `BATCH_OUTSTANDING`, `CHERRY_PICK_CONFLICT`, `VALIDATION_FAILED`, and
  `VALIDATOR_MUTATED_WORKTREE`. These normally require corrected work, explicit retry, or operator
  review rather than an automatic loop.
- Trusted local-ref intake — `INVALID_SUBMISSION_REF`, `UNKNOWN_SUBMISSION`, `EMPTY_SUBMISSION`,
  `BASE_NOT_ANCESTOR`, `NON_LINEAR_HISTORY`, `HISTORY_INSPECTION_FAILED`, `SUBMISSION_TOO_LARGE`,
  `SUBMISSION_GIT_UNSUPPORTED`, `SUBMISSION_OBJECT_STORE_UNSUPPORTED`, `GIT_OBJECT_READ_FAILED`,
  `SUBMISSION_VALIDATION_UNAVAILABLE`, `SUBMISSION_POLICY_UNAVAILABLE`,
  `SUBMISSION_POLICY_INVALID`, `SUBMISSION_POLICY_CHANGED`, `SUBMISSION_IDENTITY_CHANGED`,
  `SUBMISSION_REF_CHANGED`, `SUBMISSION_CHANGED`, `SUBMISSION_EXISTS`, `SUBMISSION_FAILED`,
  `SUBMISSION_MANIFEST_WRITE_FAILED`, `VALIDATION_CACHE_CLEANUP_FAILED`, `PINNED_REF_EXISTS`,
  `PIN_REF_FAILED`, `TEMPORARY_REF_CONFLICT`, `FETCH_REF_INVALID`,
  `TEMPORARY_REF_CLEANUP_FAILED`, `GIT_HOOK_ISOLATION_FAILED`, `WORKTREE_IDENTITY_UNAVAILABLE`,
  `GATE_AUTHORITY_REQUIRED`, `GATE_AUTHORITY_EXISTS`, `GATE_AUTHORITY_CORRUPT`,
  `GATE_AUTHORITY_VERSION`, `GATE_AUTHORITY_MISMATCH`, and `GATE_AUTHORITY_CHANGED`. Register or
  restore the reviewed authority and correct an input/policy
  precondition before adopting again. `GATE_AUTHORITY_EXISTS` requires deliberate `--replace`; never
  automate replacement. For a durable `received` or `validating` record, run `recover`; do not edit
  its identity or move its broker-owned ref. An authority-change warning requires restoring the
  original registration; `0.13.0` does not migrate a pending submission between authorities.
- Locks and state — `LOCK_HELD`, `LOCK_TIMEOUT`, `STATE_CORRUPT`, and `STATE_VERSION`. A timeout may
  be retried after the holder finishes. Corrupt or unsupported state requires operator recovery; an
  adapter must not initialize over it. `unlock` and `doctor` include the fixed-root `gate-authority`
  lock; force-release it only after independently proving no setup, adoption, or recovery process can
  still progress.
- Signing and proof — `SIGNING_KEY_REQUIRED`, `SIGNING_KEY_MISMATCH`, `SIGNING_KEY_EXISTS`, and
  `PROVENANCE_INVALID`. Restore or deliberately rotate the configured identity; never downgrade a
  required signature automatically.
- Target and publication — `REMOTE_URL_UNKNOWN`, `REMOTE_REPOSITORY_UNKNOWN`,
  `REMOTE_TARGET_CHANGED`, `FORGE_TARGET_MISMATCH`, `BATCH_TARGET_UNBOUND`, `BASE_REFRESH_FAILED`,
  `BATCH_BASE_STALE`, `NO_BRANCH`, `NO_CANDIDATE`, `BRANCH_EXISTS`, `BRANCH_DELETE_FAILED`,
  `WORKTREE_REMOVE_FAILED`, `PUBLISH_DISABLED`, `PUBLISH_FAILED`, `BATCH_NOT_PUBLISHABLE`,
  `PULL_REQUEST_LOOKUP_FAILED`, and `PULL_REQUEST_UPDATE_FAILED`. In particular, target mismatch or
  missing binding requires a safe re-cut or explicit cleanup; it must never be repaired by copying
  the current remote into old state.
- Forge observation and merge control — `PULL_REQUEST_REF_LOOKUP_FAILED`,
  `PULL_REQUEST_IDENTITY_UNKNOWN`, `PULL_REQUEST_BASE_UNKNOWN`,
  `PULL_REQUEST_CHANGED_DURING_INSPECTION`, `PULL_REQUEST_STILL_OPEN`,
  `PULL_REQUEST_ALREADY_CLOSED`, `PULL_REQUEST_CLOSE_FAILED`, `AUTO_MERGE_FAILED`,
  `AUTO_MERGE_DISABLE_FAILED`, `AUTO_MERGE_STATE_UNKNOWN`, `MERGE_PROOF_UNAVAILABLE`,
  `BATCH_NOT_SYNCABLE`, and `BATCH_NOT_MERGED`. Unknown remote outcome is not failure proof or
  success proof: preserve the durable intent and retry observation or `batch sync`.
- Approval, revision, and refresh — `APPROVAL_DISABLED`, `APPROVAL_FORBIDDEN`,
  `VERIFICATION_NOT_REQUIRED`, `BATCH_NOT_VERIFIABLE`, `BATCH_NOT_APPROVABLE`,
  `CANDIDATE_MISMATCH`, `CANDIDATE_NOT_READY`, `CANDIDATE_BLOCKED`, `CANDIDATE_STATE_INVALID`,
  `CANDIDATE_CHANGED`, `CANDIDATE_FINAL`, `CANDIDATE_NOT_APPROVED`, `CANDIDATE_POLICY_STALE`,
  `APPROVAL_REVOCATION_REQUIRED`, `CHANGE_REQUEST_PENDING`, `NO_CHANGE_REQUEST`,
  `CHANGES_NOT_REQUESTED`, `BATCH_NOT_REVISABLE`, `REVISION_IN_PROGRESS`,
  `REVISION_INTENT_CHANGED`, `REFRESH_PENDING`, `REFRESH_CHANGED`, `BATCH_NOT_REFRESHABLE`,
  `BATCH_CHANGED`, `BATCH_SUPERSEDED`, and `BATCH_NOT_CLOSABLE`. Re-read state first. Pending
  revocation is resumed with `batch sync`, pending refresh with `batch refresh`, and a retained
  revision intent with `recover`; do not bypass one transition with another.
- Service, hook, platform, and subprocess — `HOOKS_PATH_CONFLICT`, `INVALID_SERVICE_PATH`,
  `INVALID_SERVICE_USER`, `SERVICE_CLI_PATH`, `SERVICE_FILE_CONFLICT`, `SERVICE_PUBLISH_DISABLED`,
  `SERVICE_USER_ID`, `UNSUPPORTED_PLATFORM`, and `COMMAND_FAILED`. Surface the diagnostic details to
  an operator.
- Adapter wrapper fallbacks — the JSON CLI uses `UNEXPECTED` and MCP tools use `INTERNAL_ERROR` when
  a non-`BrokerError` escapes. Treat either as an unknown internal failure, preserve diagnostics,
  and fail closed.

Additional codes may be introduced. Adapters must display unknown errors and fail closed rather than
treating them as success. Concurrency codes such as `TASK_CHANGED`, `BATCH_CHANGED`,
`CANDIDATE_CHANGED`, `REFRESH_CHANGED`, and `REVISION_INTENT_CHANGED` require a fresh read before
deciding whether the original action is still valid.

## Programmatic use

The package exports `MergeBroker`, repository/configuration types, state types, and error classes:

```ts
import { MergeBroker } from "agent-merge-broker";

const broker = await MergeBroker.open("/path/to/worktree");
const plan = await broker.plan();
const result = await broker.integrate({ dryRun: true });

const authority = await broker.registerCandidateAuthority();
const submission = await broker.adoptCandidate({ ref: "refs/heads/external-candidate" });
const sameSubmission = await broker.submission(submission.id);
```

Programmatic callers share the same filesystem locks and state machine as CLI callers. The
additive `state().submissions` collection is normalized to an empty object when reading a state file
written before trusted local-ref intake.
