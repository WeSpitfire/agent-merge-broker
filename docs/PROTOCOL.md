# Worker and adapter protocol

## Contract

A worker needs only five capabilities:

1. Claim an ID and expected path scope.
2. Maintain an expiring lease while editing.
3. Create one or more focused Git commits.
4. Submit those commit IDs with the lease token.
5. Stop performing Git administration after submission.

All CLI commands support `--json`. Successful commands write one JSON value to stdout and exit zero. Errors write a stable code, message, and optional details to stderr and exit nonzero.

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

## Submit

```bash
MERGE_BROKER_TOKEN=... merge-broker --json task submit TASK-123 \
  --commit a1b2c3d \
  --commit d4e5f6a
```

Commit order is significant. The broker resolves every revision to a full immutable commit ID and computes actual paths from Git rather than trusting the caller.

The receipt written under Git's common directory conforms to [`../schemas/receipt.schema.json`](../schemas/receipt.schema.json). It contains no lease credential.

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
