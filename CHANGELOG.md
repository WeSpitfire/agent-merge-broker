# Changelog

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
