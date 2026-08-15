# Architecture

## Product boundary

Agent Merge Broker sits between code-producing workers and the repository's protected integration workflow. Workers own implementation and focused commits. The broker owns ordering, batching, validation, and publication. GitHub or another forge remains the review, policy, and deployment boundary.

The core depends on Git rather than a particular agent SDK. CLI JSON output and the exported Node API are the initial adapter surfaces.

## Invariants

1. A worker submits immutable commit IDs, never an uncommitted filesystem snapshot.
2. Broker operations never merge into or rewrite the configured base branch.
3. Integration happens in a dedicated disposable worktree based on a resolved base SHA.
4. The retained branch is created only after every configured validator succeeds.
5. A task is `merged` only after reconciliation or an explicit operator completion.
6. State changes are atomic and serialized across linked Git worktrees.
7. The lease token itself is never persisted; only its SHA-256 digest is stored.

## Portable and runtime state

Portable repository policy is committed under `.merge-broker/`.

Runtime state is stored at:

```text
$(git rev-parse --git-common-dir)/merge-broker/
├── state.json
├── audit.jsonl
├── receipts/<task-id>.json
├── batches/<batch-id>.json
├── state.lock/
├── integration.lock/
└── worktrees/<batch-id>/
```

JSON state writes use a temporary sibling followed by an atomic rename. Lock acquisition uses atomic directory creation. Short state mutations and long integration transactions use separate locks so status reads and heartbeats do not need to hold the integration lock.

## Task lifecycle

```text
registered → claimed → submitted → integrating → batched → published → merged
                 ↑          ↑ │          │                     │
                 │          │ │          │                     │ pull request closed
                 │          └─┼──────────┴─────────────────────┘ or batch-mate failed
                 └──── retry ←┴─ failed
```

- `registered`: metadata exists but no active worker lease is required.
- `claimed`: an agent holds an expiring lease.
- `submitted`: immutable commits and their actual changed paths were recorded.
- `integrating`: selected by the process holding the integration lock.
- `batched`: validation passed and a local integration branch exists.
- `published`: the remote branch or PR was created.
- `merged`: the result reached the base workflow and dependencies may proceed.

Cancellation is allowed only before batching. After correction, `task submit` can replace the receipt or `task retry` can requeue the existing receipt.

A failed attempt is attributed as narrowly as the evidence allows. A cherry-pick conflict or a focused validation failure is attributable to one task: that task moves to `failed` with error evidence and its batch-mates return to `submitted`, so an unrelated agent's work is not held hostage. An authoritative validation failure indicts the entire batch and moves every selected task to `failed`, which prevents a polling broker from repeating the same broken batch.

A published batch whose pull request is closed without merging becomes `closed` rather than remaining `published`. Its tasks return to `submitted`, because a closed pull request means the work was rejected, not completed. `integration.maxAttempts` bounds how many times a task may be re-queued automatically before it is left `failed` for a human.

## Scheduling

Submitted tasks are sorted by:

1. descending priority;
2. ascending submission time;
3. lexical task ID.

The scheduler walks this list repeatedly so a parent selected in the current batch can unblock a child on the next pass. It rejects or defers candidates that exceed batch limits, conflict on an actual file, share a configured serialized resource, or depend on work that is neither in the batch nor `merged`.

This is a deterministic weighted greedy independent-set heuristic. Finding an optimal maximum non-conflicting set is not a project guarantee.

Expected path globs coordinate editing leases. Actual paths are derived from Git commits and drive integration batching. Expected scopes are conservative because two arbitrary glob languages cannot always be proven disjoint cheaply.

## Transaction

For a selected batch the broker:

1. Resolves the configured integration `baseRef` to a specific SHA while retaining `baseBranch` as the forge target.
2. Marks selected tasks `integrating` under the state lock.
3. Adds a detached Git worktree at that SHA.
4. Cherry-picks each receipt commit with `-x` in dependency order.
5. Runs applicable focused validators after each task.
6. Runs all authoritative validators over the complete batch.
7. Optionally squashes the batch while preserving task IDs in the message.
8. Creates a uniquely named local branch at the verified head.
9. Removes the disposable worktree.
10. Optionally pushes the branch and opens one GitHub PR.

A failed cherry-pick is aborted. No retained branch is created after a validation failure. Configurable failed-worktree retention exists for diagnosis, but defaults off because worktrees can contain build products and secrets.

## Publication and reconciliation

Publication supports three modes:

- `none`: retain a local branch only.
- `branch`: push one branch.
- `pull-request`: push and invoke `gh pr create`.

PR reconciliation queries GitHub for merged state. Branch reconciliation fetches the configured base and checks that the batch head is an ancestor. Squash and rebase workflows may require the explicit `batch complete` escape hatch because the local batch head can disappear from final ancestry.

## Failure isolation

The first failing cherry-pick identifies a commit and task. Focused validation identifies a task-scoped failure. An authoritative failure identifies the complete batch but may represent an interaction between otherwise valid tasks. Version 0.1 deliberately stops and marks the bounded batch failed rather than automatically guessing a resolution. Operators can requeue the unchanged receipt explicitly. Automatic delta debugging can be layered on without weakening the transaction invariant.

## Future adapters

Adapters should translate their native task system into the protocol rather than receive Git administration privileges. Natural additions are MCP, GitHub Actions, Codex, Claude Code, and generic webhook adapters. The core state machine must remain usable without them.
