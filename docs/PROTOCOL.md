# Worker and adapter protocol

## Contract

A worker needs only five capabilities:

1. Claim an ID and expected path scope.
2. Maintain an expiring lease while editing.
3. Create one or more focused Git commits.
4. Nominate those commit IDs with the lease token.
5. Stop performing Git administration after nomination.

All CLI commands support `--json`. Successful commands write one JSON value to stdout and exit zero. Errors write a stable code, message, and optional details to stderr and exit nonzero.

The package also supplies `merge-broker-mcp`, a stdio MCP adapter. Its default `worker` profile
registers only task/status/validation capabilities and keeps lease tokens in the local vault. The
`operator` profile additionally registers planning, integration, publication, synchronization,
verification, approval, audit, metrics, and recovery. Profiles are chosen when the server starts,
not by tool input, so a worker cannot request promotion.

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
published outside an editing lease, and GitHub still reports the exact head/base without conflicts
or requested changes. If auto-merge is configured, only this successful command enables it.

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

## Published batch provenance

With `integration.provenance.enabled`, the broker's final integration commit
adds one JSON manifest under the configured repository-relative directory. Its
parent is the assembled task head. The record binds the branch to its base,
task IDs, submitted commits, changed paths, dependencies, and any broker-side
validators. It conforms to
[`../schemas/provenance.schema.json`](../schemas/provenance.schema.json).

When protected-base policy requires signatures, the manifest carries an Ed25519 signature over a
canonical representation of every other manifest field. The trusted public key comes from the base
configuration; the private key remains in broker runtime state or an operator secret channel. The
signing payload is UTF-8 JSON with object keys sorted lexically at every depth, array order retained,
no insignificant whitespace, and the root `signature` field omitted.

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

## Dependencies

Dependencies refer to broker task IDs. With `requireDependencies` enabled, every referenced task must exist before submission. A dependency is schedulable when it is selected earlier in the same batch or has reached `merged` status.

Repository adapters should distinguish `baseRef`, the Git revision used to build transactions, from `baseBranch`, the forge target. For repositories with a passive local checkout, use `baseRef: "origin/main"` and `baseBranch: "main"`.

Published or prepared work is not treated as merged. This prevents a child from being integrated against a base that does not contain its parent.

## Stable error categories

Adapters should primarily branch on these codes:

- `LEASE_CONFLICT`, `LEASE_EXPIRED`, `LEASE_TOKEN`
- `UNEXPECTED_PATHS`
- `INVALID_TASK`, `UNKNOWN_TASK`, `UNKNOWN_DEPENDENCY`
- `UNKNOWN_COMMIT`, `DUPLICATE_COMMIT`, `EMPTY_COMMIT`, `MERGE_COMMIT`
- `CHERRY_PICK_CONFLICT`
- `VALIDATION_FAILED`
- `EMPTY_BATCH`
- `LOCK_TIMEOUT`, `LOCK_HELD`
- `SIGNING_KEY_REQUIRED`, `SIGNING_KEY_MISMATCH`, `SIGNING_KEY_EXISTS`
- `PUBLISH_DISABLED`, `PUBLISH_FAILED`, `AUTO_MERGE_FAILED`, `PULL_REQUEST_CLOSE_FAILED`
- `APPROVAL_DISABLED`, `APPROVAL_FORBIDDEN`, `CANDIDATE_MISMATCH`, `CANDIDATE_NOT_READY`
- `CANDIDATE_BLOCKED`, `CANDIDATE_STATE_INVALID`, `TASK_NOT_REVISABLE`
- `PROVENANCE_INVALID`
- `HOOKS_PATH_CONFLICT`

Additional codes may be introduced. Adapters must display unknown errors rather than treating them as success.

## Programmatic use

The package exports `MergeBroker`, repository/configuration types, state types, and error classes:

```ts
import { MergeBroker } from "agent-merge-broker";

const broker = await MergeBroker.open("/path/to/worktree");
const plan = await broker.plan();
const result = await broker.integrate({ dryRun: true });
```

Programmatic callers share the same filesystem locks and state machine as CLI callers.
