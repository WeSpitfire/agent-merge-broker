# Agent Merge Broker

Agent Merge Broker is a transaction coordinator for parallel code-producing agents and humans. Workers submit immutable Git commits; the broker decides what can integrate together, applies the commits in an isolated worktree, runs repository-defined validation, and produces one bounded integration branch or pull request.

It is deliberately not an agent framework and not a replacement for protected branches. Codex, Claude, Cursor, custom agents, CI jobs, and humans all use the same small commit-receipt protocol.

## Why it exists

Parallel coding slows down when every worker also acts as a Git administrator. Overlapping edits, lockfiles, stale branches, repeated pushes, and one CI run per agent create coordination work that grows faster than the number of agents.

The broker establishes a single integration authority while keeping implementation distributed:

- Expiring, cross-worktree leases prevent predictable collisions before editing.
- Commit receipts separate implementation from integration authority.
- A deterministic conflict/dependency scheduler forms bounded batches.
- Every batch is tested through real cherry-picks in a disposable worktree.
- Focused checks run after each task and authoritative checks run over the batch.
- Successful work becomes one local branch, remote branch, or GitHub pull request.
- Tasks are dependency-complete only after their batch is actually merged.
- An append-only audit stream records lifecycle decisions and validation results.

## Status

The `0.1.x` line contains the complete local broker core and GitHub CLI publishing adapter. The on-disk state and receipt formats are versioned, but compatibility is not guaranteed until `1.0.0`.

## Requirements

- Node.js 20.12 or newer
- Git 2.31 or newer with worktree support
- GitHub CLI only when `publish.mode` is `pull-request`

## Install

Until the first npm release, clone this repository and link the CLI:

```bash
npm install
npm run build
npm link
```

After publication, applications will be able to install it as a development tool:

```bash
npm install --save-dev agent-merge-broker
npx merge-broker init --base main
```

`init` writes two portable files into the application:

- `.merge-broker/config.json` — repository policy and commands
- `.merge-broker/agent-instructions.md` — a reusable worker contract

Runtime state, receipt records, manifests, locks, and integration worktrees live under Git's common directory. Every linked worktree therefore sees the same broker state, while runtime artifacts do not pollute commits.

## Quick start

Initialize an existing Git repository and edit its generated configuration:

```bash
merge-broker init --base main --remote origin
merge-broker doctor
```

An orchestrator or worker claims a narrowly scoped task:

```bash
merge-broker task claim CRM-142 \
  --holder codex/customer-page \
  --path 'src/customers/**' \
  --path 'test/customers/**'
```

The token is shown once. Store it in the worker process, not in source control:

```bash
export MERGE_BROKER_TOKEN='<returned-token>'
merge-broker task heartbeat CRM-142
```

The worker commits its change and submits a receipt. It does not merge or push:

```bash
git commit -m 'Add customer search filters'
merge-broker task submit CRM-142 --commit HEAD
```

The integration owner can inspect and verify the next batch before retaining anything:

```bash
merge-broker plan
merge-broker integrate --dry-run
merge-broker integrate
```

With publishing enabled in the configuration:

```bash
merge-broker integrate --publish
merge-broker batch sync <batch-id>
```

`batch sync` checks the GitHub PR when available. For branch-only publication it fetches the configured base and verifies ancestry. `batch complete` exists as an explicit manual escape hatch for squash/rebase workflows that cannot be reconciled automatically.

## Configuration

The generated `.merge-broker/config.json` is intentionally explicit and reviewable:

```json
{
  "version": 1,
  "baseBranch": "main",
  "remote": "origin",
  "stateDirectory": "merge-broker",
  "leases": {
    "ttlSeconds": 1800,
    "lockTimeoutSeconds": 15,
    "serializedPatterns": ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
  },
  "policies": {
    "unexpectedPaths": "error",
    "requireCleanWorktree": false,
    "requireDependencies": true
  },
  "scheduling": {
    "maxTasks": 6,
    "maxCommits": 12,
    "maxWaitSeconds": 600,
    "allowPathOverlap": false
  },
  "integration": {
    "branchPrefix": "merge-broker/",
    "history": "preserve",
    "keepFailedWorktrees": false
  },
  "validation": {
    "focused": [
      {
        "name": "related tests",
        "paths": ["src/**", "test/**"],
        "command": "npm test -- {files}",
        "timeoutSeconds": 900
      }
    ],
    "authoritative": [
      { "name": "test", "command": "npm test", "timeoutSeconds": 1800 },
      { "name": "build", "command": "npm run build", "timeoutSeconds": 1800 }
    ]
  },
  "publish": {
    "mode": "pull-request",
    "draft": true,
    "labels": ["integration-batch"],
    "titleTemplate": "Integration batch {batchId}"
  }
}
```

Validator commands run inside the isolated integration worktree. They receive these environment variables:

- `MERGE_BROKER_TASK_ID`
- `MERGE_BROKER_FILES`, newline-separated
- `MERGE_BROKER_BASE_SHA`
- `MERGE_BROKER_HEAD_SHA`
- `MERGE_BROKER_BATCH_ID`

Commands may also use the shell-safe placeholders `{taskId}` and `{files}`. Validator output retained in state is capped to prevent unbounded growth.

The JSON schemas in [`schemas/`](schemas/) can be used by editors, adapters, and independent receipt producers.

## Command surface

```text
merge-broker init
merge-broker doctor
merge-broker task register|claim|heartbeat|submit|retry|release|cancel|show
merge-broker status
merge-broker plan
merge-broker integrate [--dry-run] [--publish]
merge-broker batch list|show|publish|sync|complete
merge-broker audit
merge-broker metrics
merge-broker events
merge-broker serve [--publish] [--eager]
```

Every command accepts `--json` for adapters and `-C <directory>` for explicit repository discovery. Lease-aware commands also accept `MERGE_BROKER_TOKEN`.

## Guarantees and limits

Path overlap is a conservative coordination signal, not proof of semantic compatibility. Non-overlapping tasks can still break contracts. For this reason, the disposable worktree and authoritative validation—not the scheduler—are the final integration decision.

The scheduler uses a deterministic weighted greedy heuristic. It does not claim to solve the NP-hard maximum independent set problem optimally. Batches are deliberately capped because very large batches reduce CI traffic but increase failure blast radius.

Configuration is trusted repository code: validator commands can execute arbitrary shell commands. Review configuration changes with the same care as CI workflows. See [`docs/SECURITY.md`](docs/SECURITY.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — invariants, state model, scheduling, and transactions
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — lifecycle and adapter contract
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries and hardening
- [`docs/RELEASING.md`](docs/RELEASING.md) — registry and release procedure
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and pull requests

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
