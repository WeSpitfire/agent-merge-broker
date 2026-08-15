# Changelog

## 0.1.4 — Unreleased

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
- Fixed integration lock staleness, which collapsed the 24-hour timeout to 2 seconds and allowed a
  long-running integration to have its lock taken.
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
