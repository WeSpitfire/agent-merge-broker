# Changelog

## 0.5.0 — 2026-08-17

Surviving a bad afternoon at the forge. A GitHub outage interrupted a publication midway, and the
broker turned a transient 503 into a batch that could not be landed at all.

### Added

- `merge-broker batch refresh <id>` re-cuts a batch the base branch moved past, so it can merge
  again. Previously there was no way back: the operator closed the pull request by hand, reconciled
  state by hand, and integrated again. It re-cuts the same tasks from the current tip and
  re-validates them, which is the point — a stale batch was only ever checked against a base nobody
  merges into any more. Re-cutting rather than merging the base into the branch keeps every batch an
  immutable artifact whose manifest describes exactly the base it was assembled on. The superseded
  pull request is closed first, so nobody can still merge the batch being replaced. Attempts are not
  incremented: nothing about the work failed, the world moved, and charging it against
  `maxAttempts` would eventually retire a task for being unlucky about merge order. A batch that is
  already current is a no-op.

### Fixed

- **Publication records the pull request before attempting auto-merge.** It used to create the pull
  request and enable auto-merge as one step, so a failure at the second threw away the first: the
  batch stayed `prepared` while its pull request existed on the forge. `batch sync` only reconciles
  `published` batches, so the one command built to notice the merge could not see it. Auto-merge is
  now its own step, and failing it leaves a published batch carrying `publishWarning` — something
  that needs a hand, not a publication that did not happen.
- **Publication is idempotent.** It looks for the branch's open pull request before opening one, so
  retrying after a partial failure finishes the job instead of opening a duplicate. A lookup that
  *fails* is not treated as "there is none" — publication stops with `PULL_REQUEST_LOOKUP_FAILED`,
  because the response to none is to create one, and that is how retrying during an outage produces
  duplicates. `batch publish` accepts an already-`published` batch so it can be used to retry.
- **One batch in flight at a time.** `integrate` cut a new batch whenever tasks were queued, even
  with an earlier batch still open. A batch is cut from the base tip so it is born mergeable;
  cutting another while the first is unmerged makes that expire, and whichever merges first strands
  the other behind a base that requires branches to be up to date. Integration now refuses with
  `BATCH_OUTSTANDING` and names the batch to land first. `--force` overrides, and `--dry-run` is
  unaffected — a rehearsal retains nothing, so it can strand nothing.

## 0.4.1 — 2026-08-17

Toolchain maintenance. No behaviour changes.

### Fixed

- Named the node types explicitly in `tsconfig.json`. TypeScript 7 stopped inferring ambient node
  types from `NodeNext` module resolution alone, so every `node:` import failed to resolve and the
  compiler read the specifiers as bare names. The build would have broken on the compiler upgrade
  whether or not the dependency bump arrived with it.

### Changed

- Moved to TypeScript 7.0.2 and `@types/node` 26, the current stable line.
- Updated `commander` to 15. This is the one runtime dependency, so consumers resolving it
  transitively will see the major change.

## 0.4.0 — 2026-08-15

Recovery. Everything here came out of one repository's week of fighting the lifecycle rather than the
merge: the broker was strict in places where strictness protected nothing, and the way out of an
ordinary mistake was to rebuild the task.

### Added

- `merge-broker validate` runs the configured validators against a working tree, before anything is
  submitted. Integration was previously the only thing that knew what "ready" meant, so adopters
  wrote a cheaper approximation for workers to run first — and an approximation is exactly the thing
  that passes locally and fails at integration. This runs the same validators from the same
  configuration, covers uncommitted and untracked files, writes no state, requires no lease, and
  exits non-zero on failure so a worker script can gate on it. Validators see
  `MERGE_BROKER_BATCH_ID=local`.

### Fixed

- `integrate --dry-run` no longer marks tasks `failed` when validation fails. A rehearsal consumed
  the queue: the next integrate found nothing to do and reported `EMPTY_BATCH`, with no indication
  that the dry run had emptied it. The success path already restored `submitted` for this reason;
  the failure path did not.
- A task may be submitted again while `submitted`, replacing its receipt, until its batch is
  assembled. Nothing downstream has read it yet, so the refusal protected only the worker's own
  earlier list of commits — while making "I need one more commit" unrecoverable, since the sole
  remaining lever was `cancel`, which is final and ends the lease.
- `task extend` accepts a `failed` task, as `task claim` already did. Fixing what validation caught
  routinely means touching a file the original scope did not cover, and refusing to widen scope at
  exactly that moment left rebuilding the task as the only way forward.
- Lifecycle refusals name the command that moves the task instead of only reporting its status. The
  state machine is invisible from outside, so `cannot be submitted while batched` was a riddle.
  Submission checks status before the lease for the same reason: batching ends the lease, so the
  honest answer was "its batch is assembled", not "you hold no lease".

## 0.3.0 — 2026-08-15

First public release. The versions below are development history and were never published to npm.


The adoption layer. Everything here already existed as bespoke glue around the broker in the
repository that pilots it; this release moves the generic parts into the tool so a new adopter does
not have to rebuild them.

### Added

- `merge-broker verify-provenance --branch <ref> --head <sha> --base <sha>` proves that a pull
  request head is an unaltered broker batch: assembled on real base history, changing exactly the
  paths its receipts account for, carrying every submitted commit, and validated. It reads only Git,
  so it runs on any forge and before any dependency is installed. It accepts the "update branch"
  merges a protected base produces, and rejects a merge that brings in anything the base does not
  already contain. Verification policy is read from the configuration committed on the base branch,
  never from the change under review.
- A composite GitHub Action at `verify/action.yml`, so requiring the gate is two lines:
  `uses: WeSpitfire/agent-merge-broker/verify@v1`.
- `merge-broker task submit --since-base` submits the linear commits made after the base the broker
  handed out. Commits whose change is already upstream are skipped by patch identity, so a rebased
  branch does not resubmit landed work.
- The broker now holds the lease token for the worker, mode 0600, beside the state it authorizes.
  Lease-aware commands find it automatically; `--token`, `--token-file`, and `MERGE_BROKER_TOKEN`
  still work, and `task claim --no-store-token` opts out. Previously the token was shown once and
  every adopter had to build a credential store, with the obvious implementation putting a live
  token in the working tree where `git add` and validator commands can reach it.
- `merge-broker install-hooks` installs a pre-push guard that refuses direct pushes of
  implementation branches, with `MERGE_BROKER_ALLOW_DIRECT_PUSH=1` as the deliberate bypass. It
  refuses to run when the repository already has hooks that moving `core.hooksPath` would silently
  disable, and `--uninstall` reverses it.
- `examples/two-agents` is a runnable demonstration: two workers in parallel worktrees, one refused
  overlapping claim, four commits, one validated branch. It runs in CI as an acceptance test.
- Batch provenance manifests record the `history` mode used to assemble them, so a verifier knows
  whether submitted commits are traceable in the integrated history. Manifests written before this
  field are treated as `preserve`, which is what they were.

## 0.2.0 — Unreleased

Correctness pass ahead of the first public release. Everything below was found by reviewing the
package as an outside adopter would receive it, rather than as it is used in its home repository.

### Changed

- **Validators no longer run under the operator's login shell.** They previously ran under
  `$SHELL -lc`, which made every integration decision depend on whose machine assembled the batch:
  a non-POSIX `$SHELL` such as fish or nushell broke validation outright, and personal login
  profiles could silently reshape the result. Validators now run under `/bin/sh -c`
  (`%ComSpec% /d /s /c` on Windows), configurable with `validation.shell`. The environment still
  comes from the calling process, so PATH and toolchain managers keep working; a validator that
  needs more should set its own `env`.
- Auto-merge no longer decides by pattern-matching the GitHub CLI's prose. It queries
  `mergeStateStatus` and merges directly only when GitHub reports `CLEAN`. The previous English
  regular expression turned a clean pull request into a hard failure under a different `gh` version
  or locale.

### Added

- `merge-broker prune [--older-than <days>] [--dry-run]` retires completed tasks and batches into
  `<state>/archive/`. `state.json` is rewritten in full on every transaction, including heartbeats,
  so an unbounded history made routine operations progressively slower. A completed task that a
  retained task still depends on is never pruned: the scheduler cannot tell a pruned dependency from
  one that has never merged, and the dependent would wait forever.
- `merge-broker unlock [state|integration] [--force]` releases a lock left by a crashed process.
  A holder on another machine cannot be probed, so integration could previously stall for the full
  24-hour stale window with no recourse. Without `--force` the lock is released only when its owner
  is provably gone.
- `doctor` now reports lock state and warns when no validators are configured, which otherwise
  assembles batches without checking anything and says nothing about it.
- `validation.shell` configuration field and JSON-schema entry.

### Fixed

- One truncated line no longer makes the entire audit trail unreadable. `events` skips malformed
  records and reads a bounded tail instead of loading the whole file, and the active audit file is
  rotated into `<state>/archive/` once it grows large. Rotated segments are never deleted.
- The lease token is no longer passed to validator commands. Repository configuration is trusted to
  run commands, but no validator needs a worker credential that can submit or cancel on its behalf.
- A task with more commits than `scheduling.maxCommits` now reports that it can never be scheduled
  instead of repeating the same transient-looking deferral on every planning pass.

### Platform support

- CI now covers Ubuntu and macOS on Node 20 and 22. Windows runs as an informational job:
  the shell selection and command quoting differ there and are not yet a supported platform.

## 0.1.6 — Unreleased

- Added `--force` to `task cancel` and `task release`, so an integration owner can reclaim a lease
  whose one-time token was lost with its worker. Previously such a scope stayed locked until its TTL
  expired. Forced revocation is recorded in the audit stream with the holder it was taken from.

- Merged a published pull request directly when GitHub refuses to queue auto-merge because the pull
  request is already mergeable. A "clean" status means the required checks have passed, so the batch
  no longer stalls when checks finish before publication returns.
- Fixed cross-machine lock recovery. Liveness was probed with a process ID, but the state directory
  is shared across machines while process IDs are not, so one machine could reclaim a lock that
  another machine was actively holding. Owner records now carry a hostname: a crashed holder on this
  machine is reclaimed after a short grace period, and a holder elsewhere waits out the full stale
  timeout. Records written without a hostname keep the previous behaviour.

## 0.1.5 — Unreleased

- Added `publish.autoMerge` and `publish.mergeMethod`. The broker now asks GitHub to merge a
  published batch once required checks pass, so integration completes without a human step.
- Rejected the `publish.autoMerge` + `publish.draft` combination during configuration validation.
  GitHub can never merge a draft pull request, so the previous default silently stalled every batch.
- Changed the generated default to `publish.draft: false` with `publish.autoMerge: true`.
  Configurations written before this release keep auto-merge off until they opt in.
- Added `integration.refreshBase`, which fetches the remote base branch before a batch is cut.
  Batches were previously born behind the base branch and became unmergeable under
  "require branches to be up to date" protection.
- Reconciled pull requests that are closed without merging. The batch becomes `closed` and its tasks
  return to the queue instead of remaining `published` forever, which silently discarded the work.
- Limited failure blast radius: a cherry-pick or focused-validation failure now fails only the task
  responsible and returns its batch-mates to the queue. Authoritative failures still fail the batch.
- Added `integration.maxAttempts` to bound automatic re-queueing.
- Added committed batch-provenance manifests that bind a published integration
  branch to its base SHA, integrated parent, task receipts, and broker validators.
- Made provenance opt-in compatible for existing version-one configurations and
  enabled it by default for new installations.
- Added token-authenticated active-lease scope extension for coordinator adapters.

## 0.1.1 — Unreleased

- Separated the integration `baseRef` from the forge target `baseBranch` so passive local main branches cannot produce stale batches.

## 0.1.0 — Unreleased

- Added versioned repository configuration and generated agent instructions.
- Added atomic cross-worktree state, expiring leases, heartbeats, and audit events.
- Added immutable commit receipts with expected/actual path enforcement.
- Added dependency-aware, conflict-aware bounded batch scheduling.
- Added transactional Git worktree integration with cherry-pick provenance.
- Added focused and authoritative repository-defined validation.
- Added local branch, remote branch, and GitHub pull-request publication.
- Added explicit merge reconciliation and a polling broker service.
- Added local throughput, batch, and validation metrics.
- Added JSON CLI and exported Node API for adapters.
