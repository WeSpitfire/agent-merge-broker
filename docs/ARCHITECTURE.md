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
6. State writes are atomic. The integration lock serializes batch construction, the state lock
   serializes short mutations, and a per-batch lock serializes normal side-effecting commands for
   one retained batch.
7. Broker state persists only a lease-token digest; the optional local token vault is a separate
   owner-readable convenience store and is never committed.
8. When the broker's configured signature policy is enabled, every retained provenance manifest is
   signed by the repository Ed25519 identity whose public key is committed for protected-base
   verification.
9. The provenance commit is the immutable integration-branch head; stale batches are re-cut, never
   updated with a merge commit after validation.
10. When exact approval is required, the code tested, reviewed, approved, and handed to GitHub's
    merge operation is the same candidate SHA on the same recorded base and policy revision.
11. Any candidate SHA or base change creates a new revision and invalidates all earlier evidence and
    approval. A GitHub head mutation outside the broker blocks the candidate.
12. A successful validator may not change `HEAD` or leave the integration worktree dirty. The broker
    checks both conditions before retaining the result.
13. A remotely publishable batch records the selected remote and a fingerprint of its canonical
    push URL. A pull-request batch also records a host-qualified forge repository. Configuration
    drift cannot silently retarget either kind of batch.
14. An authorization-relevant remote side effect is never inferred from a missing response. The
    broker records enough intent first, observes the external system on retry, and fails closed while
    the outcome is unknown. Informational PR text is not used as authority.

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
├── batch-<safe-batch-id>.lock/
├── archive/
└── worktrees/<batch-id>/
```

JSON state writes use a temporary sibling followed by an atomic rename. A lock contender first
builds an owner directory containing its process ID, hostname, creation time, and random nonce, then
atomically renames that complete directory into the active lock path. The nonce is a fencing identity:
an old holder can neither release nor reclaim a successor's lock.

The state lock protects short state and audit mutations. The integration lock protects planning,
worktree construction, validation, and recovery of an abandoned `running` batch. Per-batch locks
serialize publication, synchronization, approval, change requests, revision, refresh, completion,
and closure for the same batch without blocking unrelated batch reconciliation. Status reads and
heartbeats therefore do not hold the long integration lock.

Candidate revision takes its batch lock before the integration lock. Normal integration releases
the integration lock before entering batch-locked publication, so those paths do not acquire the
same pair in opposite order. `recover` holds the integration lock while resolving a durable
`revisionIntent`; a live revision already holds that lock, and other batch commands reject the
pending intent instead of advancing around it.

## Retention

Active state is a working set, not a historical record. Because `state.json` is rewritten in full on every transaction, an unbounded history makes every heartbeat progressively more expensive. `prune` moves completed tasks and batches into `archive/`, and the audit stream rotates into the same directory once the active file grows large. Archived material is never deleted.

Two records are deliberately not prunable. A completed task that a retained task still declares as a dependency stays, because `dependencyReady` cannot distinguish a pruned dependency from one that has never merged and would block the dependent forever. A batch stays while any of its tasks does, so a retained task never points at a batch that no longer exists.

Audit reads are tolerant by design: they scan a bounded tail and skip records that fail to parse. A crash between writing and flushing leaves a truncated line, which is exactly the moment the audit trail matters most.

## Lock recovery

A holder on this machine whose process is gone is provably abandoned and can be reclaimed after a
short grace period. Age alone is never proof: a live same-host lock, a foreign-host lock, and a lock
with unreadable ownership are not stolen, no matter how old they are. A waiting command instead
fails after `leases.lockTimeoutSeconds`. After confirming that no broker process can still make
progress, an operator can inspect locks with `doctor` and release `state`, `integration`, or
`batch:<batch-id>` with `unlock`; `--force` is required when the owner cannot be proven dead.

Release and reclaim first rename the exact nonce-bearing owner directory to a nonce-specific
tombstone. A delayed holder or reclaimer can therefore remove only the lock it observed, never a
replacement created in the meantime. These locks coordinate processes sharing one Git common
directory; they are not a multi-host consensus or distributed fencing service.

The lock is not the transaction record. If a process stops after tasks move to `integrating`, the
next process that safely acquires the integration lock removes only broker-owned worktree and branch
artifacts, marks the incomplete batch failed, and returns its tasks to `submitted` without charging
an attempt. The exact branch name and expected head are persisted before branch creation. Cleanup
runs while the batch is still durably `running`, so another stop before terminal state simply replays
idempotent observation and cleanup; a changed or checked-out branch is retained with a warning.
`serve`, `integrate`, and the explicit `recover` command all use the same recovery path.

Candidate revision uses a second durable hand-off. Before moving the integration branch, the broker
records a revision intent containing the old candidate, replacement candidate, and replacement task
receipt. After a restart, recovery inspects the real branch or pull-request head: it finalizes when
the new SHA is present, rolls the intent back when the old SHA is still present, and retains the
intent for operator inspection when neither is true. State never claims a receipt that the branch
does not contain.

## Durable operations and recovery

The filesystem state and a forge cannot commit one atomic transaction. The broker consequently
persists the operation or uncertainty before the external side effect, then finalizes it only after
an exact observation. The following records are state-machine fields, not suggestions that an
operation succeeded:

| Local durable state | External side effect | Observation that permits finalization | Resume path |
| --- | --- | --- | --- |
| Batch `running`; tasks `integrating` | Disposable worktree and local branch construction | A new process holds the integration lock, proving the old transaction cannot progress | `recover`; also run automatically by `serve` and `integrate` |
| Batch `prepared` with branch, head SHA, base, and target binding | Exact-SHA branch push and PR creation | Bound branch is at the recorded SHA; an existing PR for the unique head/base is found across all PR states | `batch publish` or `serve --publish` |
| `autoMergePending` | Usually enable auto-merge with the expected-head guard, or perform the same guarded merge when the forge already reports `CLEAN`; it also marks an unauthorized or legacy queue as possibly live while the broker disables it | Forge reports whether the queue is enabled, disabled, or the exact PR is terminal | Reconcile with `batch sync`; complete or retry an authorized hand-off with `batch publish` or `serve --publish` |
| Approval with `approvedAt` but no `confirmedAt` | None yet; this is the causal gap before merge authorization | A post-write observation sees the exact PR still `OPEN` at the candidate head, base branch, and base SHA | Run `batch sync` or repeat `batch approve` with the exact tuple; either performs the post-write observation |
| `changeRequestIntent` | Disable a possibly live queue | Queue is observed disabled, or the PR is terminal and reconciled | `batch sync` or repeat `batch request-changes` |
| Approval `revocationRequestedAt` | Disable a queue after policy, evidence, actor, review, head, or base drift | While open, the queue is observed disabled; a terminal PR follows merge/close reconciliation before approval is removed | `batch sync` |
| `revisionIntent` | Replace the local broker branch, or its published remote branch with an exact-old-SHA force lease | Branch/PR head is exactly the old or proposed SHA | `recover`; unexpected third SHAs remain for operator inspection |
| `refreshRequired` and, for a PR, `refreshCloseIntent` with a nonce | Disable auto-merge, close the stale PR with the nonce marker, then re-cut | Queue disabled and the PR closure carries this refresh marker; a reviewer close is rejection, not successful refresh | `batch refresh` or `serve --publish` |

The broker's remote mutations are limited to the initial branch push, PR creation, auto-merge enable
or guarded direct merge, auto-merge disable, refresh close with its comment, candidate-revision
branch replacement, and the informational PR-body edit described below. The table covers every
authorization-relevant mutation. `MergeBroker.closeBatch` observes a forge close but will not close
a live PR when one exists; `batch complete` changes local state only and makes the operator
responsible for proving that the result landed.

`autoMergePending` is therefore an uncertainty marker, not evidence that a queue is enabled. The
more specific `changeRequestIntent`, approval revocation fields, and refresh fields additionally
record why a possibly live queue must be disabled before the local transition can finish.

Initial branch publication uses a create-only lease and pushes the recorded SHA rather than the
mutable local branch. A lost PR-creation response is resolved by searching all PR states before any
second create. Failure to inspect the forge is uncertainty, so the broker stops instead of assuming
that no PR exists. Candidate revision is the sole remote force update and uses
`--force-with-lease` against the exact previous candidate.

The PR body update after a successful revision is informational. If its result is unsuccessful or
uncertain, the revised candidate and branch remain authoritative and `publishWarning` exposes the
description warning; PR text is never merge authorization.

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
actors, and any task that has returned to an editing lease. It then writes `approvedAt` and performs
a second forge inspection. Only that post-write observation of the exact open PR writes
`confirmedAt`; an approval that has not crossed this causal boundary cannot authorize auto-merge.
The final GitHub merge command carries a head-SHA guard.

Reconciliation continuously re-evaluates the current approval configuration, authorized actor,
required checks, review decision, mergeability, PR head, target branch, and base SHA. If one changes
after approval, the broker records revocation before attempting to disable a possibly live queue.
While the PR remains open, approval is removed only after the queue is observed disabled; terminal
PRs follow their separate reconciliation path. Disabling `approval.required` cannot retroactively
authorize a candidate assembled under that policy; the candidate must be refreshed. Enabling it for
an existing open PR does not grandfather a queue either: reconciliation first disables any possibly
live queue, verifies the recorded head and base, and adopts that exact SHA as an unapproved candidate.
If the untracked candidate merged first, the batch becomes a merge-invariant failure.

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

1. Resolves the configured `baseRef` to a specific SHA. For remote publication it first resolves the
   selected remote's canonical push target and records the remote name, URL fingerprint, and base
   branch; a pull-request target also records its host-qualified forge repository. When `baseRef`
   denotes that target branch and `integration.refreshBase` is enabled, it is refreshed from this
   exact bound remote URL.
2. Marks selected tasks `integrating` under the state lock.
3. Adds a detached Git worktree at that SHA.
4. Cherry-picks each receipt commit with `-x` in dependency order.
5. Runs applicable focused validators after each task, in a fixed non-login shell, then verifies
   that `HEAD` is unchanged and the worktree is clean.
6. Runs all broker-authoritative validators over the complete batch. With `required-ci` authority,
   this list is deliberately empty and the complete suite runs as protected pull-request checks.
   The same unchanged-`HEAD` and clean-worktree postcondition applies.
7. Optionally squashes the batch while preserving task IDs in the message.
8. Optionally builds a provenance manifest, signs it when configured signature policy requires it,
   and commits it with the integrated task head as its parent.
9. Creates a uniquely named local branch at the resulting head.
10. Removes the disposable worktree.
11. Optionally pushes that recorded head SHA with a create-only lease and opens or rediscovers one
    GitHub PR on the recorded target.
12. When approval policy is enabled, records that exact head as candidate revision 1 and waits for
    SHA-bound evidence plus a causally confirmed approval before enabling auto-merge.

A failed cherry-pick is aborted. No retained branch is created after a broker-side validation
failure. Configurable failed-worktree retention exists for diagnosis, but defaults off because
worktrees can contain build products and secrets. A `required-ci` batch is not eligible to merge
until the forge's protected checks pass.

## Publication and reconciliation

Publication supports three modes:

- `none`: retain a local branch only.
- `branch`: push one branch.
- `pull-request`: push and either rediscover the batch's existing PR or invoke `gh pr create`.

Configuration selects a target for a new batch, not for every later operation. For a remotely
publishable batch, assembly canonicalizes the push URL and records only its SHA-256 fingerprint. A
pull-request batch also records the host-qualified forge repository. Every later push and base fetch
resolves the recorded remote name again and compares its fingerprint; every repository-ambiguous
GitHub CLI operation receives the recorded `--repo` value. Changing `remote`, `baseBranch`,
`publish.repository`, or the GitHub CLI default cannot retarget an existing batch.

The current `publish.mode` still chooses whether a prepared candidate is retained, pushed, or used
to open a PR, but it can use only the target identity already recorded for that operation. If the
needed binding is absent, the operation fails closed rather than deriving one from the new
configuration.

When provenance is enabled, the final generated commit records the base SHA, integrated parent,
task receipts, paths, and completed broker validators. New repositories also require its Ed25519
signature, verified against the public key in protected-base configuration. The signature
authenticates which broker identity created the record; it does not make the recorded validations
semantically sufficient. Protected-base configuration explicitly chooses broker authority or a
required remote CI suite.

PR reconciliation requires the forge to identify the exact head SHA and target branch, plus the
current base SHA while the PR is open. It also observes the PR state, auto-merge queue, merge commit,
checks, reviews, and conflict status. A closed PR is rejection unless a durable refresh marker proves
that the broker closed it while superseding the batch. A reopened PR is inspected again rather than
trusted from stale local `closed` state. Turning `publish.autoMerge` off causes reconciliation to
disable an observed or possibly live queue, including one left by a pre-upgrade attempt.

If a merged observation still reports the exact recorded base SHA, the forge's exact head, target,
and base binding is sufficient. When the forge instead reports the target's newer tip,
reconciliation fetches the recorded target and proves that the reported merge commit is on it,
descends from the recorded base, and has the candidate's exact final tree. It accepts only these
shapes:

- fast-forward: the merge commit is the candidate;
- squash: one parent, exactly the recorded base, and the candidate tree;
- merge commit: exactly two parents, the recorded base first and candidate second, with the candidate
  tree; or
- linear rebase: the same number of single-parent commits as the candidate first-parent sequence,
  with the same tree at every step in the same order.

An unrelated history with only the same final tree is not enough. Inability to fetch the bound target
is `MERGE_PROOF_UNAVAILABLE` and remains retryable. Once that fetch succeeds, a missing or invalid
object, graph mismatch, or tree mismatch is a merge-invariant violation. With exact approval enabled,
a merged PR must additionally have a causally confirmed, current, non-revoked approval from a
still-authorized actor and all current required checks. Only then do tasks become `merged` and release
their dependents.

Branch-only reconciliation fetches the recorded, fingerprint-bound target and requires the batch
head to be an ancestor. `batch complete` remains an explicit operator assertion for a workflow that
cannot expose sufficient automatic proof; it is not the normal path for GitHub squash, merge, or
linear-rebase PRs.

### Batches created before target binding

Batches written before `0.12.0` do not contain the selected `remote`, `remoteUrlFingerprint`,
`forgeRepository`, or `publicationMode`. The broker cannot reconstruct those facts from current
configuration without risking publication or reconciliation against another repository. Such a
batch therefore cannot be safely published, refreshed onto a target, used to replace an
already-published remote branch, or, when changed-base proof is needed, automatically completed.

Drain prepared and published batches before upgrading from an earlier release. If one is already in
flight after upgrade, restore and inspect the original remote and PR rather than editing state to
fabricate a binding. Reconcile an exact existing PR where the broker can do so; otherwise finish or
close the original remote work under explicit operator control before retrying its tasks. A batch
created by `0.12.0` in `publish.mode: "none"` is different: its recorded `publicationMode` proves
that it had no broker publication side effect, so `batch refresh` can safely re-cut it after
publication is enabled.

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

The first failing cherry-pick identifies a commit and task. Focused validation identifies a task-scoped failure. An authoritative failure identifies the complete batch but may represent an interaction between otherwise valid tasks. The broker deliberately stops and marks the bounded batch failed rather than automatically guessing a resolution. Operators can requeue the unchanged receipt explicitly. Automatic delta debugging can be layered on without weakening the transaction invariant.

## Adapters

Adapters translate their native task system into the protocol rather than receive unnecessary Git
administration privileges. The bundled MCP stdio adapter has distinct worker and operator profiles;
the worker server does not register integration, publication, evidence, or approval tools. GitHub
Actions, other agent clients, and webhook systems can use the JSON CLI or exported Node API. The
core state machine remains usable without any adapter.

Forge publication is an explicit exported boundary. `MergeBroker.open` accepts a `ForgePublisher`;
the GitHub CLI implementation is the default. An alternative forge adapter owns pull-request
creation, inspection, body updates, and merge controls while Git and the broker state machine retain
branch assembly, validation, receipts, and recovery authority.
