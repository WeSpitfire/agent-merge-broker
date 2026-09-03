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
- Optional exact-candidate policy separates nomination, verification, approval, and mechanical merge.
- Published branches can carry a committed provenance manifest for fast remote policy checks.
- Tasks are dependency-complete only after their batch is actually merged.
- An append-only audit stream records lifecycle decisions and validation results.

It is deliberately **not** an agent framework and **not** a replacement for protected branches. Codex, Claude, Cursor, custom agents, CI jobs, and humans all speak the same small commit-receipt protocol, and your forge keeps the final say on what merges.

## Status

`0.3.0` was the first public release: the local broker core, the GitHub CLI publishing adapter with auto-merge, and the remote provenance verifier.

`0.10.0` is the current release. Installation detects declared repository validation, installs the agent
contract, provisions authenticated provenance, and remains idempotent on repeat runs. Native
architecture execution and isolated transaction caches prevent cross-architecture Swift build
contamination without rerunning the same complete gate.

The development line adds actionable status and sanitized support bundles, archive-aware metrics,
broader JavaScript/Swift/Go/Rust/Python bootstrap detection, composable hooks, permission-separated
MCP servers, and first-class Windows support.

The on-disk state, receipt, and provenance formats are versioned, but compatibility is not guaranteed until `1.0.0`. Expect format migrations before then.

## Requirements

- Node.js 20.12 or newer
- Git 2.31 or newer with worktree support
- GitHub CLI only when `publish.mode` is `pull-request`

Windows, macOS, and Linux are supported and release-gating in CI. Windows validation defaults to
non-profile PowerShell; background operation uses a per-user Windows Scheduled Task.

See [Compatibility and current limits](docs/COMPATIBILITY.md) for the exact platform matrix,
Windows service behavior, built-in integrations, and functionality the project does not provide.

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

`init` writes three portable files into the application:

- `.merge-broker/config.json` — repository policy and commands
- `.merge-broker/agent-instructions.md` — a reusable worker contract
- `AGENTS.md` — a managed pointer that makes repository agents use that contract

Initialization deterministically selects existing `verify`, `ci`, `check`, `lint`, `typecheck`,
`test`, and `build` scripts from JavaScript package manifests, plus declared SwiftPM, Go, Rust, and
Python checks. Nested packages run from their own repository-relative working directory. It never
creates commands, Xcode schemes, destinations, or project policy that the repository did not declare.
Anything it cannot prove is printed as an explicit configuration item. Re-running `init` repairs
missing generated integration files and old unsigned defaults, but preserves configured validators
and owner-written `AGENTS.md` content. Use `--no-detect` or `--no-agent-contract` only when an
installer or repository template owns those concerns itself.

It also creates an Ed25519 provenance private key, mode `0600`, under Git's common runtime directory.
Only its public key is written to the committed configuration. Runtime state, receipt records,
manifests, keys, locks, and integration worktrees therefore stay outside commits while every linked
worktree sees the same broker authority.

## Quick start

For a guided rollout—including validator, publication, service, recovery, and protected-branch
recipes—start with [Getting started](docs/GETTING_STARTED.md).

Initialize an existing Git repository, review the detected policy, and commit the installation:

```bash
merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker AGENTS.md && git commit -m 'Configure authenticated merge brokerage'
merge-broker doctor
```

`merge-broker status` now includes the safe next command for each active task and batch. For a bug
report, `merge-broker doctor --support-bundle` emits diagnostics and recent audit events with paths,
URLs, and secret-bearing fields redacted; review the JSON before sharing it.

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

The worker commits its change and nominates a candidate receipt. It does not merge or push:

```bash
git commit -m 'Add customer search filters'
merge-broker task candidate CRM-142 --since-base
```

Nominating again before the batch is assembled replaces the receipt, which is how a follow-up commit
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
npm run example
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

The installer reuses a repository-local `core.hooksPath` such as `.husky` when its `pre-push` slot
is free, or installs beside existing default Git hooks without disabling them. If another tool owns
`pre-push`, `merge-broker install-hooks --print` emits the guard for explicit composition.
`MERGE_BROKER_ALLOW_DIRECT_PUSH=1` is the deliberate emergency bypass.

### Publishing without a terminal

`serve` polls for verified batches and publishes them, but only while somebody keeps it running in a
terminal. When nobody does, a submitted task sits in `submitted` indefinitely — and to the agent
that submitted it, waiting forever is indistinguishable from being rejected. Install the loop as a
per-user service instead:

```bash
merge-broker install-service
```

This writes a launchd agent on macOS, a systemd user unit on Linux, or a per-user Scheduled Task on
Windows, one per repository, and starts it. It is deliberately a *user* service: a system daemon would need root and would
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
- uses: WeSpitfire/agent-merge-broker/verify@v0.10.0
```

The check verifies the Ed25519 signature, branch and batch identity, real base history, one-file
manifest commit, integrated diff, submitted commit trail, and recorded validation results. The
provenance commit must remain the branch head. Even a normal base-update merge can carry arbitrary
conflict resolution, so any post-assembly merge is rejected; re-cut a stale batch with `batch
refresh` instead.

### MCP clients

The package includes a stdio server for agents that speak Model Context Protocol:

```json
{
  "mcpServers": {
    "merge-broker": {
      "command": "npx",
      "args": ["--no-install", "merge-broker-mcp", "-C", "/absolute/repository/path", "--profile", "worker"]
    }
  }
}
```

Use `npx.cmd` when a Windows MCP host does not resolve command shims automatically. The default
`worker` profile can claim, validate, nominate, and revise leased work but cannot integrate,
publish, record evidence, or approve. Start a separate `--profile operator` server only in a trusted
control-plane client that should receive those tools. Lease tokens stay in the broker's local token
vault and are never returned in MCP results.

Verification policy is read from the configuration committed on the *base* branch, never from the
change under review. Repositories initialized before `0.6.0` must run `merge-broker provenance
setup-signing`, commit the resulting public-key policy, and keep the private key outside the working
tree. Until then verification reports structural-only rather than authenticated provenance.

## Exact-candidate approval and automatic merging

`publish.autoMerge` is the mechanical last step, not merge authorization. When `approval.required`
is enabled, publication opens the pull request and stops. The broker binds a candidate to its exact
integrated SHA, base SHA, and `policyRevision`; it will not enable auto-merge until every configured
GitHub check and manual verification has passed on that tuple and an authorized actor explicitly
approves it.

```text
working → candidate → verifying → ready_for_approval → approved → merging → merged
                          ↘ verification_failed
                          ↘ changes_requested → revised candidate
```

Sync GitHub checks, attach manual evidence, and approve with values copied from `batch show`:

```bash
merge-broker batch sync <batch-id>
merge-broker batch verify <batch-id> --name browser --status passed \
  --candidate <sha> --base <sha> --policy-revision release-v1 --actor browser-agent
merge-broker batch verify <batch-id> --name responsive --status passed \
  --candidate <sha> --base <sha> --policy-revision release-v1 --actor responsive-agent
merge-broker batch approve <batch-id> \
  --candidate <sha> --base <sha> --policy-revision release-v1 --actor release-manager
```

Every binding is explicit on purpose. A stale command fails instead of approving whatever happens
to be current. Approval also rechecks the open PR head, target base, task state, reviews, conflicts,
and configured GitHub checks. The final `gh pr merge` uses GitHub's head-SHA guard.

If verification finds a problem, keep the task and PR:

```bash
merge-broker batch request-changes <batch-id> \
  --candidate <sha> --base <sha> --actor reviewer --reason 'Responsive layout fails at 390px'
merge-broker task reopen <task-id> --holder agent --reason 'Fix responsive layout'
# edit and commit under the new lease
merge-broker task revise <task-id> --since-base
```

The broker force-updates only its own integration branch with `--force-with-lease`. The PR remains
the same, the old candidate becomes `superseded`, and the new SHA starts with no evidence or
approval. Editing leases end when a candidate is assembled; they are not kept alive during long CI
runs. Approval instead requires every task to remain in the published, non-editing state.

Without `approval.required`, auto-merge retains its pre-0.8 behavior for compatibility. The broker
never pushes to the base branch itself, so branch protection remains an independent final defense.

Two configuration combinations cannot work and are rejected at load time rather than stalling silently:

- `autoMerge` with `draft`, because GitHub refuses to merge a draft pull request
- `autoMerge` with `publish.mode` set to `branch`, because there is no pull request to merge

Auto-merge requires the setting to be enabled on the GitHub repository. Configurations written before this feature existed default to `autoMerge: false`, so upgrading never starts landing work on its own.

Running `merge-broker serve --publish` reconciles checks, integrates the next batch, and publishes it.
With exact approval enabled it deliberately stops at `ready_for_approval`; only `batch approve`
grants merge permission.

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

Candidate revisions also carry a durable intent before the broker moves their branch. If a process
stops after the branch update but before state finalization, `recover` compares the real PR/local
head with the old and new candidate SHAs and safely finishes or rolls back the transition. An
unexpected third SHA is never guessed at and remains visible in `doctor`.

## Housekeeping

`state.json` is rewritten in full on every transaction, including heartbeats, so completed work should not accumulate in it forever:

```bash
merge-broker prune --older-than 30 --dry-run
merge-broker prune --older-than 30
```

Retired tasks and batches move to `<state>/archive/`, and the audit stream rotates into the same place once the active file grows large. Nothing is deleted. `events` and `metrics` include archived segments, so housekeeping no longer erases operational history. A completed task is kept in active state for as long as any retained task still declares it as a dependency, because the scheduler cannot distinguish a pruned dependency from one that has never merged.

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
  "approval": {
    "required": true,
    "policyRevision": "release-v1",
    "requiredVerifications": ["browser", "responsive"],
    "requiredChecks": ["Verify release"],
    "authorizedActors": ["release-manager"]
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

Validator commands run inside the isolated integration worktree, under `/bin/sh` on macOS/Linux or
non-profile PowerShell on Windows unless `validation.shell` names another interpreter. The shell is
deliberately fixed and is never a login shell: an integration decision must not depend on whose machine assembled the batch. The environment
is inherited from the process that invoked the broker, minus `MERGE_BROKER_TOKEN`,
`MERGE_BROKER_SIGNING_KEY`, and `MERGE_BROKER_SIGNING_KEY_FILE`, so PATH and toolchain managers work
while broker credentials stay out of repository-defined commands.

Validators receive these environment variables:

- `MERGE_BROKER_TASK_ID`
- `MERGE_BROKER_FILES`, newline-separated
- `MERGE_BROKER_BASE_SHA`
- `MERGE_BROKER_HEAD_SHA`
- `MERGE_BROKER_BATCH_ID`
- `MERGE_BROKER_CACHE_DIR`, an isolated cache shared by validators in one integration transaction

Commands may also use the shell-safe placeholders `{taskId}`, `{files}`, and
`{validatorCacheDir}` (a stable validator-specific directory inside the transaction cache). `workingDirectory` can
place a validator in a repository-relative package directory; file placeholders and environment
paths are then relative to that directory. Validator output is captured with a fixed memory bound
and retained in state with that cap. A timeout terminates the validator process tree.

`merge-broker validate` runs these same broker-side validators against a working tree, so a worker
can get the local integration answer before submitting rather than a weaker approximation of it. It reports
`MERGE_BROKER_BATCH_ID=local`, which a validator can branch on if it needs to behave differently
outside a batch.

A validator may set `"executionArchitecture": "native"` to run under the hardware architecture on
macOS when Node itself is translated by Rosetta. Detected SwiftPM validators use this mode and put
their scratch build under `{validatorCacheDir}`, preventing Intel and Apple Silicon artifacts
from contaminating each other without rebuilding between the focused and authoritative stages of
the same integration transaction.

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
merge-broker doctor [--support-bundle]
merge-broker provenance setup-signing [--private-key <path>] [--rotate]
merge-broker install-hooks [--force] [--uninstall] [--print]
merge-broker install-service [--uninstall] [--interval <seconds>] [--no-eager]
merge-broker verify-provenance --branch <ref> --head <sha> --base <sha>
merge-broker validate [--task <id>] [--scope focused|authoritative|all] [--base <ref>] [--cwd <path>]
merge-broker task register|claim|extend|heartbeat|candidate|submit|reopen|revise|retry|release|cancel|abandon|show
merge-broker status
merge-broker plan
merge-broker integrate [--dry-run] [--publish] [--force]
merge-broker batch list|show|publish|verify|approve|request-changes|refresh|sync|complete
merge-broker audit
merge-broker metrics
merge-broker events
merge-broker prune [--older-than <days>] [--dry-run]
merge-broker unlock [state|integration] [--force]
merge-broker recover
merge-broker serve [--publish] [--eager] [--log-file <path>]
merge-broker-mcp -C <directory> [--profile worker|operator]
```

Every command accepts `--json` for adapters and `-C <directory>` for explicit repository discovery. Lease-aware commands also accept `MERGE_BROKER_TOKEN`.

## Guarantees and limits

Path overlap is a conservative coordination signal, not proof of semantic compatibility.
Non-overlapping tasks can still break contracts. For this reason, the disposable worktree plus the
configured authority—broker-side validation or protected required CI—not the scheduler, makes the
final integration decision.

The scheduler uses a deterministic weighted greedy heuristic. It does not claim to solve the NP-hard maximum independent set problem optimally. Batches are deliberately capped because very large batches reduce CI traffic but increase failure blast radius.

Configuration is trusted repository code: validator commands can execute arbitrary shell commands. Review configuration changes with the same care as CI workflows. See [`docs/SECURITY.md`](docs/SECURITY.md).

The broker is intentionally a single-authority, filesystem-backed coordinator. Independent clones
do not automatically share leases or state; the bundled MCP transport is local stdio; GitHub is the
only built-in pull-request adapter; and the project does not start agents, host a dashboard, or
resolve conflicts automatically. The complete supported/unsupported boundary is documented in
[Compatibility and current limits](docs/COMPATIBILITY.md).

## Documentation

- [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — installation and production rollout
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — platform matrix, Windows notes, and current limits
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — invariants, state model, scheduling, and transactions
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — lifecycle and adapter contract
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries and hardening
- [`docs/RELEASING.md`](docs/RELEASING.md) — registry and release procedure
- [`SUPPORT.md`](SUPPORT.md) — safe diagnostics and support channels
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and pull requests

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
