# Compatibility and current limits

This page states where Agent Merge Broker runs, which integrations are built in, and what the
project does not provide today. The distinction matters because the broker coordinates an
integration authority; it is not a hosted agent platform or a distributed merge queue.

The documentation site tracks the `main` branch. Features listed under **Unreleased** in the
[changelog](https://github.com/WeSpitfire/agent-merge-broker/blob/main/CHANGELOG.md) are present in a
source checkout but are not part of the latest npm package until the next release is published.

## Platform matrix

| Host | Default validator shell | Per-user background runner | Release-gating CI |
| --- | --- | --- | --- |
| Windows | non-profile Windows PowerShell | Task Scheduler | Windows, Node.js 24 |
| macOS | `/bin/sh` | launchd agent | macOS, Node.js 24 |
| Linux | `/bin/sh` | systemd user service | Ubuntu, Node.js 20, 22, 24, and 26 |

Every host requires Node.js 20.12 or newer and Git 2.31 or newer. GitHub pull-request publication
also requires an authenticated GitHub CLI (`gh`) for the same user that runs the broker.

The CLI, exported Node API, JSON output, stdio MCP server, repository discovery, filesystem locks,
and disposable integration worktrees are supported on all three operating-system families.
Repository validators are still commands for the selected host shell. Prefer package scripts or
other cross-platform entry points when one checked-in policy must run everywhere, or set
`validation.shell` explicitly when a repository intentionally standardizes on another shell.

## Windows behavior

Windows uses the built-in `powershell.exe` with `-NoProfile` and `-NonInteractive` for validators.
Placeholder values are quoted as PowerShell literals, validator timeouts terminate descendant
processes with `taskkill`, and repository-relative configuration rejects drive-qualified, UNC, and
escaping paths before execution.

`merge-broker install-service` creates a least-privilege Scheduled Task bound to the installing
user's SID. It starts immediately and at that user's logon, restarts after failure, and writes to
the broker log reported by the installer. It uses the user's interactive token: it is not a
machine service, does not run before that user logs on, and should not be installed under an account
that lacks access to the repository, Git credentials, or GitHub CLI authentication. Run
`merge-broker doctor` from that account before relying on unattended publication.

The scheduled action records absolute paths to Node, the broker CLI, the repository, and its log.
Commands invoked later by the broker—such as `git`, `gh`, and repository validators—must still be
available to the scheduled user's environment. Windows MCP clients that do not resolve npm command
shims automatically should configure `npx.cmd` instead of `npx`.

## Project detection

Initialization conservatively detects declared validation entry points for:

- JavaScript and TypeScript package manifests and lockfiles;
- Swift Package Manager;
- Go modules;
- Rust workspaces and crates; and
- Python projects that declare pytest, tox, nox, Ruff, or mypy configuration.

Nested projects receive a repository-relative `workingDirectory`. Detection selects commands the
repository already declares; it does not invent test scripts, Xcode schemes, simulator
destinations, container services, credentials, or organization policy. Any executable available to
the integration host can still be configured manually as a validator, so this list limits automatic
bootstrap—not the validation engine.

## Built-in interfaces and integrations

The package provides:

- a human CLI plus stable JSON output;
- an exported Node API;
- a stdio MCP server with capability-separated `worker` and `operator` profiles;
- local-only integration, Git branch publication, and GitHub pull-request publication through
  `gh`; and
- a read-only GitHub Actions provenance verifier.

`MergeBroker.open` accepts an injected `ForgePublisher`, so another forge can be integrated without
changing the scheduler or transaction model. The repository does not currently ship first-party
GitLab, Bitbucket, Azure DevOps, Gerrit, or other forge adapters. MCP is local stdio only; there is no
built-in HTTP transport, remote MCP authentication layer, or multi-user MCP service.

A custom `ForgePublisher` is part of the merge-safety boundary. `inspectPullRequest` must bind one
forge observation to the exact `headRefOid`, `baseRefOid`, and `baseRefName`, and must return
`autoMergeEnabled: true` only when the queue is observed enabled, `false` only when it is observed
disabled, or `undefined` when the forge cannot determine the queue state. Unknown state must never be
coerced to `false`. Publication, enable, disable, inspection, body update, and close operations must
be safe to retry after a lost response. In particular, `disableAutoMerge` returns `true` only after
the queue is confirmed disabled (or the PR is confirmed closed), returns `false` only when the PR is
confirmed merged, and throws when the outcome is ambiguous. `closePullRequest` returns `true` only
when this broker close is confirmed, returns `false` for a retryable non-close, and must distinguish
an unrelated reviewer close from replay of its own durable close marker. An adapter that cannot
provide these identities and terminal outcomes must fail closed rather than guess.

## State and deployment model

Linked Git worktrees are the supported parallel-work model. They share one Git common directory,
and therefore one set of tasks, leases, tokens, locks, audit events, signing keys, and integration
worktrees. Multiple local processes can safely use that state because broker mutations are locked.

Independent clones do not automatically share broker state. There is no database-backed or
multi-host consensus layer, high-availability leader election, hosted control plane, webhook
receiver, or web dashboard. If workers run on separate machines, an external orchestrator must
route their task and lease operations to the one authoritative broker state and make the submitted
Git commit objects available to its integration repository deliberately.

The broker also does not start coding agents, write their prompts, create their implementation
worktrees, sandbox their tools, or provide agent-to-agent messaging. It begins at the coordination
boundary: claim scope, receive committed work, assemble a batch, validate it, and publish it.

## Enforcement and workflow limits

- Path leases are conservative syntactic coordination. They cannot prove that two non-overlapping
  changes are semantically compatible; validation remains authoritative.
- The pre-push hook is a local guard and can be bypassed. Protected branches plus signed provenance
  verification are the enforceable remote boundary.
- Configuration is trusted executable policy. The broker does not sandbox validator commands.
- The scheduler is a deterministic weighted greedy heuristic, not an optimal global solver.
- One prepared or published batch is allowed by default so candidates do not immediately become
  stale. `integrate --force` is an explicit operator escape hatch, not a general deep merge queue.
- Conflicts are attributed and isolated, but never resolved automatically. A worker or human must
  submit corrected commits.
- Manual evidence collection is exposed through CLI, JSON, Node, and operator MCP calls; the project
  does not include browser-testing agents or an approval user interface.
- State, configuration, receipt, and provenance formats are versioned, but pre-`1.0.0` releases may
  require migrations.

## Not included today

In short, the current project does **not** include:

- built-in non-GitHub pull-request adapters;
- distributed or highly available broker state;
- a hosted dashboard, remote API, or HTTP MCP server;
- an agent runner, worktree farm, prompt manager, or execution sandbox;
- semantic conflict prediction or automatic conflict resolution;
- a Windows machine service that runs before user logon; or
- automatic invention of undeclared repository validation policy.

These are explicit product boundaries, not implied roadmap commitments. For an adapter or feature
proposal, open a feature request and describe which authority, credential, and recovery boundary it
would introduce. See [Architecture](ARCHITECTURE.md) for the state model and [Security](SECURITY.md)
for the trust boundary.
