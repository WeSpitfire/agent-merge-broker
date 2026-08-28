# Agent Merge Broker

**Four agents just finished at the same time. Who merges first?**

Agent Merge Broker answers that so your agents never have to. Workers commit their work and stop. The broker decides what can safely go together, cherry-picks it into a disposable worktree, runs your test suite against the combination, and lands one validated branch or pull request.

No agent pushes. No agent rebases. No agent quietly clobbers another agent's `package-lock.json`.

## The problem

Put four coding agents on one repository and the bottleneck stops being code. It becomes Git.

Two agents edit the same file and find out at merge time. A third rebases onto a branch that moved twenty minutes ago. Everyone regenerates the lockfile. CI runs four times to test four things that were never once tested *together*. And the pull request that has been sitting there since lunch is now so far behind `main` that nothing can merge it at all.

The work is parallel. Integration is not. Every worker doing its own integration turns a coordination problem into a coordination disaster.

## Try it in one minute

```bash
git clone https://github.com/WeSpitfire/agent-merge-broker
cd agent-merge-broker && npm install && npm run build && npm run example
```

Two workers race on a throwaway repository, a third gets turned away for claiming ground someone else already leased, and four commits land as one validated branch. No forge, no network, no credentials.

It is also this project's acceptance test in CI — so if the demo ever stops telling the truth, the build goes red.

## How it works

One integration authority; implementation stays distributed:

- Expiring, cross-worktree leases prevent predictable collisions before editing.
- Commit receipts separate implementation from integration authority.
- A deterministic conflict/dependency scheduler forms bounded batches.
- Every batch is tested through real cherry-picks in a disposable worktree.
- Focused checks run after each task; the complete gate runs either in the broker or as required CI.
- Successful work becomes one local branch, remote branch, or GitHub pull request.
- Published branches can carry a committed provenance manifest for fast remote policy checks.
- Tasks are dependency-complete only after their batch is actually merged.
- An append-only audit stream records lifecycle decisions and validation results.

It is deliberately **not** an agent framework and **not** a replacement for protected branches. Codex, Claude, Cursor, custom agents, CI jobs, and humans all speak the same small commit-receipt protocol, and your forge keeps the final say on what merges.

## Status

`0.3.0` was the first public release: the local broker core, the GitHub CLI publishing adapter with auto-merge, and the remote provenance verifier.

`0.7.0` is current. Repositories can explicitly delegate the complete integration decision to
protected required CI after focused broker preflight, avoiding a duplicate serial full-suite run.
The default remains broker-authoritative validation for backward compatibility.

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

It also creates an Ed25519 provenance private key, mode `0600`, under Git's common runtime directory.
Only its public key is written to the committed configuration. Runtime state, receipt records,
manifests, keys, locks, and integration worktrees therefore stay outside commits while every linked
worktree sees the same broker authority.

## Quick start

Initialize an existing Git repository and edit its generated configuration:

```bash
merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker && git commit -m 'Configure authenticated merge brokerage'
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

Before handing anything over, the worker can check its own work against the same validators
integration will run:

```bash
merge-broker validate
```

This is the answer integration would give, not an approximation of it, because it reads the same
`validation` configuration. It includes uncommitted and untracked files, writes no state, needs no
lease, and exits non-zero when a validator fails — so a worker script can gate on it.

The worker commits its change and submits a receipt. It does not merge or push:

```bash
git commit -m 'Add customer search filters'
merge-broker task submit CRM-142 --since-base
```

Submitting again before the batch is assembled replaces the receipt, which is how a follow-up commit
from review reaches integration without rebuilding the task.

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

### Publishing without a terminal

`serve` polls for verified batches and publishes them, but only while somebody keeps it running in a
terminal. When nobody does, a submitted task sits in `submitted` indefinitely — and to the agent
that submitted it, waiting forever is indistinguishable from being rejected. Install the loop as a
per-user service instead:

```bash
merge-broker install-service
```

This writes a launchd agent on macOS or a systemd user unit on Linux, one per repository, and starts
it. It is deliberately a *user* service on both platforms: a system daemon would need root and would
run as the wrong user for the repository's SSH and forge credentials. `--uninstall` removes it, and
the service writes to `$(git rev-parse --git-common-dir)/merge-broker/serve.log`, including when it
was installed from a linked worktree whose `.git` is a file.

A remote gate authenticates a pull request as an immutable broker batch. It reads the trusted public
key from the protected base branch, so it can reject unsigned, forged, or post-assembly work before
installing dependencies:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    fetch-depth: 0
- uses: WeSpitfire/agent-merge-broker/verify@v0.7.0
```

The check verifies the Ed25519 signature, branch and batch identity, real base history, one-file
manifest commit, integrated diff, submitted commit trail, and recorded validation results. The
provenance commit must remain the branch head. Even a normal base-update merge can carry arbitrary
conflict resolution, so any post-assembly merge is rejected; re-cut a stale batch with `batch
refresh` instead.

Verification policy is read from the configuration committed on the *base* branch, never from the
change under review. Repositories initialized before `0.6.0` must run `merge-broker provenance
setup-signing`, commit the resulting public-key policy, and keep the private key outside the working
tree. Until then verification reports structural-only rather than authenticated provenance.

## Automatic merging

With `publish.mode` set to `pull-request` and `publish.autoMerge` enabled, the broker enables GitHub auto-merge on each published batch. GitHub lands the pull request once required status checks pass. The broker never pushes to the base branch itself, so branch protection remains the authority on what may merge. If the base moves first, re-cut the batch; do not use GitHub's update-branch merge because immutable provenance deliberately rejects it.

Two configuration combinations cannot work and are rejected at load time rather than stalling silently:

- `autoMerge` with `draft`, because GitHub refuses to merge a draft pull request
- `autoMerge` with `publish.mode` set to `branch`, because there is no pull request to merge

Auto-merge requires the setting to be enabled on the GitHub repository. Configurations written before this feature existed default to `autoMerge: false`, so upgrading never starts landing work on its own.

Running `merge-broker serve --publish` closes the loop: each cycle reconciles published batches, integrates the next batch, and publishes it for auto-merge.

## Failure recovery

Integration failures are attributed as narrowly as the evidence allows:

- A cherry-pick conflict or focused validation failure fails only the responsible task. Its batch-mates return to the queue and are re-planned, so one bad commit cannot stall unrelated agents.
- An authoritative validation failure indicts the whole batch, because no single task can be blamed. Those tasks stay `failed` until `task retry`.
- A pull request closed without merging moves the batch to `closed` and pauses its tasks as `failed`. A closed PR is an explicit rejection signal, so the broker never republishes the same receipts automatically.

`integration.maxAttempts` bounds automatic re-queueing of unaffected batch-mates after an attributable integration failure. Closed pull requests do not consume that retry loop. `task retry` is the explicit escape hatch when an operator has determined that retrying the unchanged receipt is safe.

A `failed` task is still the worker's to fix in place: `task extend` can widen its scope, since
fixing what validation caught often means touching a file the original claim did not cover, and
`task submit` replaces its commits. Rebuilding the task is not required, and `task cancel` — which is
final and ends the lease — is not the way back.

After a pull request closes, reclaim the failed task and submit its corrected commits. The eager
service will remain idle until that explicit revision arrives. If the pull request was closed only
because of a transient forge problem and the immutable receipt is still correct, use `task retry`
deliberately instead.

`integrate --dry-run` is a rehearsal in both directions: it retains no branch when it succeeds, and
returns every task to the queue when it fails, so verifying costs nothing.

Only one batch is in flight at a time. A batch is cut from the base branch tip so it is born
mergeable, and cutting a second while the first is still open makes that expire — whichever merges
first leaves the other behind a base that requires branches to be up to date. `integrate` refuses
with `BATCH_OUTSTANDING` and names the batch to land first; `--force` overrides it.

When a batch does end up behind — something landed on the base by another route, or `--force` was
used — re-cut it:

```bash
merge-broker batch refresh <batch-id>
```

That closes the superseded pull request, returns the tasks to the queue without spending their retry
budget, and integrates them again from the current tip, re-validating against the base that is
actually being merged into. A batch already cut from the current tip is left alone.

Publication is safe to retry. The pull request is recorded before auto-merge is attempted, so a
forge that fails halfway leaves a published batch carrying a `publishWarning` rather than a batch
whose pull request exists but whose state does not admit it. Running `batch publish` again finds the
existing pull request and retries what is left.

A process that dies mid-integration can leave both a lock and durable `running` state. A holder on
this machine is reclaimed automatically once its process is gone; a holder on another machine cannot
be probed and waits out the stale window. Once the integration lock is safely acquired, `serve` and
`integrate` automatically mark the abandoned batch failed, clean its broker-owned worktree and
branch, and return its tasks to `submitted` without spending their attempt budget. `merge-broker
recover` performs that reconciliation explicitly. `unlock --force` remains only for an owner that
cannot be proven gone and must follow confirming no integration is active.

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
      "directory": ".merge-broker/attestations",
      "requireSignature": true,
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
    }
  },
  "validation": {
    "authority": "broker",
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
is inherited from the process that invoked the broker, minus `MERGE_BROKER_TOKEN`,
`MERGE_BROKER_SIGNING_KEY`, and `MERGE_BROKER_SIGNING_KEY_FILE`, so PATH and toolchain managers work
while broker credentials stay out of repository-defined commands.

Validators receive these environment variables:

- `MERGE_BROKER_TASK_ID`
- `MERGE_BROKER_FILES`, newline-separated
- `MERGE_BROKER_BASE_SHA`
- `MERGE_BROKER_HEAD_SHA`
- `MERGE_BROKER_BATCH_ID`

Commands may also use the shell-safe placeholders `{taskId}` and `{files}`. Validator output retained in state is capped to prevent unbounded growth.

`merge-broker validate` runs these same broker-side validators against a working tree, so a worker
can get the local integration answer before submitting rather than a weaker approximation of it. It reports
`MERGE_BROKER_BATCH_ID=local`, which a validator can branch on if it needs to behave differently
outside a batch.

The JSON schemas in [`schemas/`](schemas/) can be used by editors, adapters, and independent receipt producers.

### One authoritative CI pass

Repositories that make required pull-request checks the authoritative validator can opt in explicitly:

```json
{
  "validation": {
    "authority": "required-ci",
    "focused": [
      {
        "name": "changed-scope preflight",
        "paths": ["src/**", "test/**"],
        "command": "npm test -- {files}",
        "timeoutSeconds": 300
      }
    ],
    "authoritative": []
  }
}
```

`required-ci` is accepted only with pull-request publication and authenticated signed provenance.
The broker still checks leases, submitted paths, cherry-pick compatibility, and every matching
focused validator before retaining the batch. It then publishes the immutable signed revision, and
the protected branch's required CI checks run the full lint, type, test, and build suite exactly
once. The broker cannot inspect every forge's branch-protection policy, so configuring
`required-ci` is an operator assertion that the complete suite really is required before merge.

The default is `broker`, including for configurations created before this field existed. In that
mode the broker runs every `validation.authoritative` command over the assembled batch before it
retains a branch, preserving the original behavior.

## Command surface

```text
merge-broker init
merge-broker doctor
merge-broker provenance setup-signing [--private-key <path>] [--rotate]
merge-broker install-hooks [--force] [--uninstall]
merge-broker install-service [--uninstall] [--interval <seconds>] [--no-eager]
merge-broker verify-provenance --branch <ref> --head <sha> --base <sha>
merge-broker validate [--task <id>] [--scope focused|authoritative|all] [--base <ref>] [--cwd <path>]
merge-broker task register|claim|extend|heartbeat|submit|retry|release|cancel|show
merge-broker status
merge-broker plan
merge-broker integrate [--dry-run] [--publish] [--force]
merge-broker batch list|show|publish|refresh|sync|complete
merge-broker audit
merge-broker metrics
merge-broker events
merge-broker prune [--older-than <days>] [--dry-run]
merge-broker unlock [state|integration] [--force]
merge-broker recover
merge-broker serve [--publish] [--eager]
```

Every command accepts `--json` for adapters and `-C <directory>` for explicit repository discovery. Lease-aware commands also accept `MERGE_BROKER_TOKEN`.

## Guarantees and limits

Path overlap is a conservative coordination signal, not proof of semantic compatibility.
Non-overlapping tasks can still break contracts. For this reason, the disposable worktree plus the
configured authority—broker-side validation or protected required CI—not the scheduler, makes the
final integration decision.

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
