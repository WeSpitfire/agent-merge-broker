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
- Published branches can carry a committed provenance manifest for fast remote policy checks.
- Tasks are dependency-complete only after their batch is actually merged.
- An append-only audit stream records lifecycle decisions and validation results.

## Status

`0.3.0` is the first public release. It contains the local broker core, the GitHub CLI publishing adapter with auto-merge, and the remote provenance verifier.

The on-disk state, receipt, and provenance formats are versioned, but compatibility is not guaranteed until `1.0.0`. Expect format migrations before then.

## Requirements

- Node.js 20.12 or newer
- Git 2.31 or newer with worktree support
- GitHub CLI only when `publish.mode` is `pull-request`

Linux and macOS are the supported platforms and are covered by CI. Windows runs as an informational
CI job: shell selection and command quoting differ there and are not yet supported.

## Install

Install it as a development tool:

```bash
npm install --save-dev agent-merge-broker
npx merge-broker init --base main --base-ref origin/main
```

To work on the broker itself, clone this repository and link the CLI:

```bash
npm install
npm run build
npm link
```

`init` writes two portable files into the application:

- `.merge-broker/config.json` — repository policy and commands
- `.merge-broker/agent-instructions.md` — a reusable worker contract

Runtime state, receipt records, manifests, locks, and integration worktrees live under Git's common directory. Every linked worktree therefore sees the same broker state, while runtime artifacts do not pollute commits.

## Quick start

Initialize an existing Git repository and edit its generated configuration:

```bash
merge-broker init --base main --base-ref origin/main --remote origin
merge-broker doctor
```

An orchestrator or worker claims a narrowly scoped task:

```bash
merge-broker task claim CRM-142 \
  --holder codex/customer-page \
  --path 'src/customers/**' \
  --path 'test/customers/**'
```

The broker keeps the lease token beside its own state, readable only by the user who claimed the
task, so nothing in the worker has to carry a credential:

```bash
merge-broker task heartbeat CRM-142
```

Pass `--token`, `--token-file`, or `MERGE_BROKER_TOKEN` when the worker runs somewhere else, or
claim with `--no-store-token` to handle custody yourself.

The worker commits its change and submits a receipt. It does not merge or push:

```bash
git commit -m 'Add customer search filters'
merge-broker task submit CRM-142 --since-base
```

`--since-base` submits the linear commits made after the base the broker handed out, skipping any
whose change is already upstream. Pass explicit `--commit` revisions instead when a worker wants to
hand over only part of its branch.

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

## See it work

```bash
npm run build
sh examples/two-agents/run.sh
```

[`examples/two-agents`](examples/two-agents/) builds a throwaway repository, runs two workers in
parallel worktrees, refuses a third worker that tries to claim an area already leased, and assembles
four commits into one validated branch. No forge, no network, no credentials.

## Enforcing the broker

Nothing above prevents a worker from pushing its own branch and opening a pull request. Two optional
guards close that gap.

A local guard refuses direct pushes of implementation branches:

```bash
merge-broker install-hooks
```

This sets `core.hooksPath`, so it refuses to run when the repository already has hooks that would
stop working, and `--uninstall` puts everything back. `MERGE_BROKER_ALLOW_DIRECT_PUSH=1` is the
deliberate emergency bypass.

A remote gate proves a pull request really is an unaltered broker batch. It reads only Git, so it
can run before any dependency is installed and reject bypassed work for almost nothing:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    fetch-depth: 0
- uses: WeSpitfire/agent-merge-broker/verify@v1
```

The check confirms that the branch is a broker integration branch, that its manifest was assembled
on real base history, that the final commit changes nothing but that manifest, that the integrated
diff matches exactly the paths the receipts account for, that every submitted commit is present, and
that all recorded validations passed. It accepts the "update branch" merges a protected base
produces, and rejects a merge that brings in anything the base does not already contain.

Verification policy is read from the configuration committed on the *base* branch, never from the
change under review.

## Automatic merging

With `publish.mode` set to `pull-request` and `publish.autoMerge` enabled, the broker enables GitHub auto-merge on each published batch. GitHub lands the pull request once required status checks pass and updates the branch when the base branch requires it. The broker never pushes to the base branch itself, so branch protection remains the authority on what may merge.

Two configuration combinations cannot work and are rejected at load time rather than stalling silently:

- `autoMerge` with `draft`, because GitHub refuses to merge a draft pull request
- `autoMerge` with `publish.mode` set to `branch`, because there is no pull request to merge

Auto-merge requires the setting to be enabled on the GitHub repository. Configurations written before this feature existed default to `autoMerge: false`, so upgrading never starts landing work on its own.

Running `merge-broker serve --publish` closes the loop: each cycle reconciles published batches, integrates the next batch, and publishes it for auto-merge.

## Failure recovery

Integration failures are attributed as narrowly as the evidence allows:

- A cherry-pick conflict or focused validation failure fails only the responsible task. Its batch-mates return to the queue and are re-planned, so one bad commit cannot stall unrelated agents.
- An authoritative validation failure indicts the whole batch, because no single task can be blamed. Those tasks stay `failed` until `task retry`.
- A pull request closed without merging moves the batch to `closed` and returns its tasks to the queue. Leaving such a batch `published` strands the work and reads like success.

`integration.maxAttempts` bounds automatic re-queueing so a task that never integrates eventually stops consuming CI capacity and waits for a human. `task retry` resets that budget.

A process that dies mid-integration leaves its lock behind. A holder on this machine is reclaimed automatically once its process is gone, but a holder on another machine cannot be probed at all and would otherwise block integration for the full stale window. `merge-broker unlock` reports lock state and releases a lock whose owner is provably gone; `--force` overrides that check and should follow confirming that no integration is running.

## Housekeeping

`state.json` is rewritten in full on every transaction, including heartbeats, so completed work should not accumulate in it forever:

```bash
merge-broker prune --older-than 30 --dry-run
merge-broker prune --older-than 30
```

Retired tasks and batches move to `<state>/archive/`, and the audit stream rotates into the same place once the active file grows large. Nothing is deleted. A completed task is kept in active state for as long as any retained task still declares it as a dependency, because the scheduler cannot distinguish a pruned dependency from one that has never merged.

## Configuration

The generated `.merge-broker/config.json` is intentionally explicit and reviewable. `baseBranch` is the forge/PR target, while `baseRef` is the Git revision used to construct a batch; repositories that keep a passive local `main` should use `origin/main`:

```json
{
  "version": 1,
  "baseBranch": "main",
  "baseRef": "origin/main",
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
    "keepFailedWorktrees": false,
    "refreshBase": true,
    "maxAttempts": 3,
    "provenance": {
      "enabled": true,
      "directory": ".merge-broker/attestations"
    }
  },
  "validation": {
    "shell": "/bin/sh",
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
    "draft": false,
    "autoMerge": true,
    "mergeMethod": "squash",
    "labels": ["integration-batch"],
    "titleTemplate": "Integration batch {batchId}"
  }
}
```

Validator commands run inside the isolated integration worktree, under `/bin/sh` unless
`validation.shell` names another interpreter. The shell is deliberately fixed and is never a login
shell: an integration decision must not depend on whose machine assembled the batch. The environment
is inherited from the process that invoked the broker, minus `MERGE_BROKER_TOKEN`, so PATH and
toolchain managers work while worker credentials stay out of repository-defined commands.

Validators receive these environment variables:

- `MERGE_BROKER_TASK_ID`
- `MERGE_BROKER_FILES`, newline-separated
- `MERGE_BROKER_BASE_SHA`
- `MERGE_BROKER_HEAD_SHA`
- `MERGE_BROKER_BATCH_ID`

Commands may also use the shell-safe placeholders `{taskId}` and `{files}`. Validator output retained in state is capped to prevent unbounded growth.

The JSON schemas in [`schemas/`](schemas/) can be used by editors, adapters, and independent receipt producers.

### One authoritative CI pass

Repositories that make GitHub the authoritative validator can leave broker
authoritative validators empty, keep provenance enabled, and reject any PR
without a valid broker manifest before installing dependencies. The full lint,
type, test, and build suite then runs exactly once on the assembled broker PR.
Task worktrees retain only fast changed-scope feedback, while deployment builds
the already-checked revision without repeating the whole suite.

## Command surface

```text
merge-broker init
merge-broker doctor
merge-broker install-hooks [--force] [--uninstall]
merge-broker verify-provenance --branch <ref> --head <sha> --base <sha>
merge-broker task register|claim|extend|heartbeat|submit|retry|release|cancel|show
merge-broker status
merge-broker plan
merge-broker integrate [--dry-run] [--publish]
merge-broker batch list|show|publish|sync|complete
merge-broker audit
merge-broker metrics
merge-broker events
merge-broker prune [--older-than <days>] [--dry-run]
merge-broker unlock [state|integration] [--force]
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
