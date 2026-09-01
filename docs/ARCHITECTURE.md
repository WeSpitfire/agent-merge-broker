# Architecture

## Product boundary

Agent Merge Broker sits between code-producing workers and the repository's protected integration workflow. Workers own implementation and focused commits. The broker owns ordering, batching, validation, and publication. GitHub or another forge remains the review, policy, and deployment boundary.

The core depends on Git rather than a particular agent SDK. CLI JSON output and the exported Node API are the initial adapter surfaces.

## Invariants

1. A worker submits immutable commit IDs, never an uncommitted filesystem snapshot.
2. Broker operations never merge into or rewrite the configured base branch.
3. Integration happens in a dedicated disposable worktree based on a resolved base SHA.
4. The retained branch is created only after every configured broker-side validator succeeds. When
   `validation.authority` is `required-ci`, protected pull-request checks make the complete decision.
5. A task is `merged` only after reconciliation or an explicit operator completion.
6. State changes are atomic and serialized across linked Git worktrees.
7. Broker state persists only a lease-token digest; the optional local token vault is a separate
   owner-readable convenience store and is never committed.
8. When signature policy is enabled, every retained provenance manifest is signed by the repository
   Ed25519 identity whose public key is committed on the protected base.
9. The provenance commit is the immutable integration-branch head; stale batches are re-cut, never
   updated with a merge commit after validation.
10. When exact approval is required, the code tested, reviewed, approved, and handed to GitHub's
    merge operation is the same candidate SHA on the same recorded base and policy revision.
11. Any candidate SHA or base change creates a new revision and invalidates all earlier evidence and
    approval. A GitHub head mutation outside the broker blocks the candidate.

## Portable and runtime state

Portable repository policy is committed under `.merge-broker/`.

Runtime state is stored at:

```text
$(git rev-parse --git-common-dir)/merge-broker/
├── state.json
├── audit.jsonl
├── receipts/<task-id>.json
├── batches/<batch-id>.json
├── tokens/<task-id>.token
├── provenance-signing-key.pem
├── provenance-keys/<key-id>.pem
├── state.lock/
├── integration.lock/
├── archive/
└── worktrees/<batch-id>/
```

JSON state writes use a temporary sibling followed by an atomic rename. Lock acquisition uses atomic directory creation. Short state mutations and long integration transactions use separate locks so status reads and heartbeats do not need to hold the integration lock.

## Retention

Active state is a working set, not a historical record. Because `state.json` is rewritten in full on every transaction, an unbounded history makes every heartbeat progressively more expensive. `prune` moves completed tasks and batches into `archive/`, and the audit stream rotates into the same directory once the active file grows large. Archived material is never deleted.

Two records are deliberately not prunable. A completed task that a retained task still declares as a dependency stays, because `dependencyReady` cannot distinguish a pruned dependency from one that has never merged and would block the dependent forever. A batch stays while any of its tasks does, so a retained task never points at a batch that no longer exists.

Audit reads are tolerant by design: they scan a bounded tail and skip records that fail to parse. A crash between writing and flushing leaves a truncated line, which is exactly the moment the audit trail matters most.

## Lock recovery

A lock owner records its process ID, hostname, and creation time. A holder on this machine whose process is gone is provably abandoned and is reclaimed after a short grace period. A holder on another machine cannot be probed — the state directory is shared, process IDs are not — so it waits out the full stale window rather than risking two integrations at once. `unlock` exposes that same decision to an operator, and `--force` is the deliberate override for a holder that cannot be proven dead.

The lock is not the transaction record. If a process stops after tasks move to `integrating`, the
next process that safely acquires the integration lock marks the incomplete batch failed, returns its
tasks to `submitted` without charging an attempt, and removes only broker-owned worktree and branch
artifacts. `serve`, `integrate`, and the explicit `recover` command all use the same recovery path.

Candidate revision uses a second durable hand-off. Before moving the integration branch, the broker
records a revision intent containing the old candidate, replacement candidate, and replacement task
receipt. After a restart, recovery inspects the real branch or pull-request head: it finalizes when
the new SHA is present, rolls the intent back when the old SHA is still present, and retains the
intent for operator inspection when neither is true. State never claims a receipt that the branch
does not contain.

## Task lifecycle

```text
happy path:     registered → claimed → submitted → integrating → batched → published → merged
revision path:                         failure or rejected PR → failed → claimed → submitted
explicit retry:                                                failed ──────────→ submitted
safe refresh:                                                        published → submitted
```

- `registered`: metadata exists but no active worker lease is required.
- `claimed`: an agent holds an expiring lease.
- `submitted`: immutable commits and their actual changed paths were recorded.
- `integrating`: selected by the process holding the integration lock.
- `batched`: broker-side preflight passed and a local integration branch exists.
- `published`: the remote branch or PR was created.
- `merged`: the result reached the base workflow and dependencies may proceed.

Cancellation is allowed only before batching. After correction, `task submit` can replace the receipt or `task retry` can requeue the existing receipt.

A failed attempt is attributed as narrowly as the evidence allows. A cherry-pick conflict or a focused validation failure is attributable to one task: that task moves to `failed` with error evidence and its batch-mates return to `submitted`, so an unrelated agent's work is not held hostage. An authoritative validation failure indicts the entire batch and moves every selected task to `failed`, which prevents a polling broker from repeating the same broken batch.

A published batch whose pull request is closed without merging becomes `closed` rather than remaining `published`. Its tasks move to `failed`, because a closed pull request is an explicit rejection signal and republishing the same immutable receipts would simply repeat the rejected attempt. This failed state is durable across eager-loop iterations and service restarts. A worker can reclaim the task and submit corrected commits; an operator can use `task retry` when retrying the unchanged receipt is deliberately intended.

## Candidate lifecycle

Task receipts are inputs to a batch. The mergeable candidate exists only after the broker has
assembled those receipts, so approval is a batch-level fact rather than a claim about an individual
worker commit.

```text
verifying → ready_for_approval → approved → merging → merged
    │                 │
    ├→ verification_failed
    ├→ changes_requested → superseded (new revision begins at verifying)
    ├→ blocked
    └→ abandoned
```

The immutable authorization key is `(candidate SHA, base SHA, policy revision)`. Each verification
record repeats that key together with its name, source, result, actor, timestamp, and optional
evidence URL. The approval record repeats the same key and names the approving actor. This
duplication is deliberate: a record remains intelligible in an audit archive without relying on
mutable surrounding state.

Configured GitHub checks are collected by `batch sync` only when the PR head exactly matches the
candidate. Manual evidence is accepted only through a command that supplies the exact key. Approval
re-reads the PR, rejects a moved base, conflicts, requested changes, missing evidence, unauthorized
actors, and any task that has returned to an editing lease. The final GitHub merge command carries a
head-SHA guard.

An editing lease proves authority to create or revise task commits. It intentionally ends when the
candidate is assembled instead of remaining alive throughout an unbounded CI or review interval.
`task reopen` creates a new editing lease and marks the current candidate `changes_requested`;
`task revise` rebuilds the complete batch, updates the existing broker branch with
`--force-with-lease`, keeps the PR, archives the previous candidate as `superseded`, and starts the
new candidate with empty evidence.

`integration.maxAttempts` applies to automatic re-queueing of unaffected batch-mates after an attributable integration failure. It is not a license to retry closed pull requests.

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
5. Runs applicable focused validators after each task, in a fixed non-login shell.
6. Runs all broker-authoritative validators over the complete batch. With `required-ci` authority,
   this list is deliberately empty and the complete suite runs as protected pull-request checks.
7. Optionally squashes the batch while preserving task IDs in the message.
8. Optionally builds a provenance manifest, signs it when protected-base policy requires it, and
   commits it with the integrated task head as its parent.
9. Creates a uniquely named local branch at the resulting head.
10. Removes the disposable worktree.
11. Optionally pushes the branch and opens one GitHub PR.
12. When approval policy is enabled, records that exact head as candidate revision 1 and waits for
    SHA-bound evidence and approval before enabling auto-merge.

A failed cherry-pick is aborted. No retained branch is created after a broker-side validation
failure. Configurable failed-worktree retention exists for diagnosis, but defaults off because
worktrees can contain build products and secrets. A `required-ci` batch is not eligible to merge
until the forge's protected checks pass.

## Publication and reconciliation

Publication supports three modes:

- `none`: retain a local branch only.
- `branch`: push one branch.
- `pull-request`: push and invoke `gh pr create`.

When provenance is enabled, the final generated commit records the base SHA, integrated parent,
task receipts, paths, and completed broker validators. New repositories also require its Ed25519
signature, verified against the public key in protected-base configuration. The signature
authenticates which broker identity created the record; it does not make the recorded validations
semantically sufficient. Protected-base configuration explicitly chooses broker authority or a
required remote CI suite.

PR reconciliation queries GitHub for merged state. Branch reconciliation fetches the configured base and checks that the batch head is an ancestor. Squash and rebase workflows may require the explicit `batch complete` escape hatch because the local batch head can disappear from final ancestry.

With exact approval enabled, reconciliation also imports configured GitHub check results and checks
the live head/base binding. A PR merged without a matching non-revoked approval is recorded as a
merge-invariant violation rather than silently reported as successful.

## Remote verification

`verify-provenance` is the read-only inverse of integration: given a branch, its head, and the base,
it re-derives what the broker must have done and rejects anything else. It uses only Git, so it runs
on any forge, in any language ecosystem, before dependencies are installed — which is what makes it
cheap enough to require on every pull request.

No commit may be added after the provenance commit. A former path-only allowance for forge
base-update merges could not authenticate conflict-resolution contents in a path also changed by the
base. A stale batch is instead closed, re-cut from the current base, revalidated, and re-signed with
`batch refresh`.

Squashed batches cannot be traced commit by commit, because squashing discards the cherry-pick
trail. The manifest records which mode produced it so a verifier knows which guarantees apply.

## Failure isolation

The first failing cherry-pick identifies a commit and task. Focused validation identifies a task-scoped failure. An authoritative failure identifies the complete batch but may represent an interaction between otherwise valid tasks. Version 0.1 deliberately stops and marks the bounded batch failed rather than automatically guessing a resolution. Operators can requeue the unchanged receipt explicitly. Automatic delta debugging can be layered on without weakening the transaction invariant.

## Future adapters

Adapters should translate their native task system into the protocol rather than receive Git administration privileges. Natural additions are MCP, GitHub Actions, Codex, Claude Code, and generic webhook adapters. The core state machine must remain usable without them.

Forge publication is an explicit exported boundary. `MergeBroker.open` accepts a `ForgePublisher`;
the GitHub CLI implementation is the default. An alternative forge adapter owns pull-request
creation, inspection, body updates, and merge controls while Git and the broker state machine retain
branch assembly, validation, receipts, and recovery authority.
