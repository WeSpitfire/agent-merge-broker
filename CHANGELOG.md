# Changelog

## 0.1.2 — Unreleased

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
