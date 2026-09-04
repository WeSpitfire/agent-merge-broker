# Compatibility and current limits

This page states where Agent Merge Broker runs, which integrations are built in, and what the
project does not provide today. The distinction matters because the broker coordinates an
integration authority; it is not a hosted agent platform or a distributed merge queue.

The documentation site tracks the `main` branch and may be ahead of npm. Compare the package version
with the topmost entry in the
[changelog](https://github.com/WeSpitfire/agent-merge-broker/blob/main/CHANGELOG.md); if that current
entry is **Unreleased**, it is source-checkout behavior until the next release is published.

## Platform matrix

| Host | Default validator shell | Per-user background runner | Release-gating CI |
| --- | --- | --- | --- |
| Windows | non-profile Windows PowerShell | Task Scheduler | Windows, Node.js 24 |
| macOS | `/bin/sh` | launchd agent | macOS, Node.js 24 |
| Linux | `/bin/sh` | systemd user service | Ubuntu, Node.js 20, 22, 24, and 26 |

Every host requires Node.js 20.12 or newer and Git 2.31 or newer. GitHub pull-request publication
also requires an authenticated GitHub CLI (`gh`) for the same user that runs the broker. The
trusted local-ref Gate intake specifically requires Git 2.46 or newer so
`GIT_NO_LAZY_FETCH` is honored for object reads.

The CLI, exported Node API, JSON output, stdio MCP server, repository discovery, filesystem locks,
and disposable integration worktrees are supported on all three operating-system families.
Repository validators are still commands for the selected host shell. Prefer package scripts or
other cross-platform entry points when one checked-in policy must run everywhere, or set
`validation.shell` explicitly when a repository intentionally standardizes on another shell.

On every host, `MERGE_BROKER_FILES_FILE` and the shell-safe `{filesFile}` placeholder identify a
UTF-8 JSON array of validator-relative paths; `MERGE_BROKER_FILES_FILE_FORMAT` is `json`. Validators
default to `filesInput: "inline"`, which supplies both newline `MERGE_BROKER_FILES` and shell-quoted
`{files}` only when both representations fit within 4 KiB. Larger input fails with
`VALIDATION_FAILED` before launch on every host. For potentially large path sets, shared policies
must explicitly select `filesInput: "json"` and parse the file; JSON mode leaves the inline variable
empty and rejects `{files}`.

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

Version `0.13.0` additionally contains validation-only adoption of trusted repository-local Git refs
through the CLI and Node API.

`MergeBroker.open` accepts an injected `ForgePublisher`, so another forge can be integrated without
changing the scheduler or transaction model. The repository does not currently ship first-party
GitLab, Bitbucket, Azure DevOps, Gerrit, or other forge adapters. MCP is local stdio only; there is no
built-in HTTP transport, remote MCP authentication layer, or multi-user MCP service.

### Exact `ForgePublisher` contract

A custom `ForgePublisher` is part of the merge-safety boundary. Its methods may be repeated after a
process stops or a response is lost, so every operation must be idempotent or become safe through
remote observation. The batch's recorded target and immutable SHA are authoritative; a custom
adapter must not replace them with its process directory, current branch, current configuration
remote, or a forge client's ambient default repository.

| Method | Required behavior |
| --- | --- |
| `publishBatch` | Publish exactly `batch.headSha` as `batch.branchName` to the remote whose canonical URL matches `batch.remoteUrlFingerprint`. Initial branch creation must accept a same-SHA retry but must not overwrite any different remote value. For pull-request mode, use `batch.forgeRepository` and `batch.baseBranch`; search open, closed, and merged requests for the unique branch/base pair before creating one. If absence cannot be proved, throw rather than create a possible duplicate. Return the actual mode and branch, a PR URL for pull-request mode, and `reusedPullRequest: true` when a prior request was recovered. |
| `inspectPullRequest` | Return one coherent observation. Normalize state to literal `OPEN`, `CLOSED`, or `MERGED`; preserve the broker-significant `CHANGES_REQUESTED` review decision and `CONFLICTING` mergeability values. `headRefOid` and `baseRefName` are always required; `baseRefOid` is required while the request is open and may be absent for a terminal request. A merged observation needs `mergeCommitSha` whenever the reported base OID is absent or differs from the recorded base so topology can be proved. Return check names and states needed by policy. If multiple forge reads are necessary, detect a head change between them and fail closed. Do not use empty or guessed identities. |
| `enableAutoMerge` | Honor `expectedHeadSha` when supplied so another head cannot be queued or merged. Return `true` only when the request was accepted, the exact head is already queued, or it is already merged. Return `false` only for a definite, safe-to-retry non-enablement. Throw when the remote outcome is unknown; the broker retains `autoMergePending` and retries by observation. |
| `disableAutoMerge` | Return `true` only when the queue is confirmed disabled or the PR is confirmed closed. Return `false` only when the PR is confirmed merged. An already-disabled queue is an idempotent success. Throw when the command or observation cannot establish one of those outcomes; never turn unknown into disabled. |
| `closePullRequest` | Return `true` only when this broker close is confirmed. Refresh comments contain a durable unique marker; replay against an already-closed PR is success only if that marker is observed. An unrelated reviewer close must remain distinguishable (the built-in adapter throws `PULL_REQUEST_ALREADY_CLOSED`). Return `false` for a retryable, unconfirmed non-close and throw for other ambiguous or terminal conflicts. |
| `updatePullRequestBody` | Replace the informational body for the supplied batch and tasks and be safe to repeat. A failure must be reported rather than presented as an update; the broker retains the revised candidate and records a publication warning. |

`PullRequestState.autoMergeEnabled` is explicitly tri-state: `true` only when the queue is observed
enabled, `false` only when it is observed disabled, and `undefined` when the forge cannot determine
the queue state. The property must still be present when its value is `undefined`. Unknown queue
state is treated as possibly live for revocation and is never coerced to `false`. Likewise, a network
or permissions failure during PR discovery is not proof that no pull request exists.

An adapter that cannot provide exact identities, an exact-head merge guard, and the terminal outcomes
above is not compatible with broker auto-merge. It must fail closed or limit itself to publication
without merge control.

### GitHub Enterprise addressing limits

Automatic forge-repository derivation supports `github.com` and GitHub Enterprise Server targets
whose forge API identity is a DNS hostname on the default endpoint. The broker and built-in `gh`
adapter use a `HOST/OWNER/REPO` selector, which cannot represent a non-default forge API port or an
IPv6 literal.

Git transport is separate. Branch mode can use a fingerprinted explicit-port or IPv6 remote, and
pull-request mode can use such a Git transport when an explicit `publish.repository` maps it to a
supported DNS, host-qualified forge target—for example a local mirror or proxy. That mapping does
not make `gh` address a forge API itself exposed only through a non-default port or IPv6 literal; a
future target type and adapter contract would be needed for that endpoint.

Exact protected-base fetches and broker publication pushes scrub the documented transport-selection,
proxy, and TLS environment, use an isolated empty hooks directory, reject configured URL/transport/
proxy/TLS/routing rewrites (including `Host`/`:authority` headers), and
refuse a locator that Git could reinterpret through any effective or legacy remote definition. Local
paths are bound to their physical target with filesystem-order component resolution. Ambient proxy,
`GIT_HTTP_*`, `GIT_SSL_*`, curl/OpenSSL CA settings, and equivalent Git HTTP configuration must be
removed for exact transport; ordinary HTTP authorization headers remain supported. Ambiguous
Windows drive-relative locators are unsupported. For `file://` remotes, raw control/backslash bytes,
pipe bytes, explicit authorities, edge spaces, query/fragment suffixes, and literal or encoded dot segments are rejected because Git
and web-URL normalization can otherwise select different repositories; use an unambiguous absolute
local path or percent-encoded ordinary pathname bytes instead. Git's case-sensitive helper syntax
means only lowercase `file://` selects the built-in local transport.

## State and deployment model

Linked Git worktrees are the supported parallel-work model. They share one Git common directory,
and therefore one set of tasks, leases, submissions, tokens, locks, audit events, signing keys, and
disposable worktrees. Multiple local processes can safely use that state because broker mutations
are locked.

Independent clones do not automatically share broker state. There is no database-backed or
multi-host consensus layer, high-availability leader election, hosted control plane, webhook
receiver, or web dashboard. If workers run on separate machines, an external orchestrator must
route their task and lease operations to the one authoritative broker state and make the submitted
Git commit objects available to its integration repository deliberately.

The broker also does not start coding agents, write their prompts, create their implementation
worktrees, sandbox their tools, or provide agent-to-agent messaging. It begins at the coordination
boundary: claim scope, receive committed work, assemble a batch, validate it, and publish it.

## Trusted local-ref intake limits

In `0.13.0`, `candidate adopt --ref` and
`MergeBroker.adoptCandidate({ ref })` are supported on Windows, macOS, and Linux with Git 2.46 or
newer for trusted source refs whose complete object graph is already present in the broker's own
object store. Before any candidate or base lookup, Gate rejects nonempty ambient Git repository,
worktree, index, namespace, object, quarantine, graft, shallow, replacement-ref, and Git
configuration-injection or transport-command overrides. Matching is case-insensitive and covers
`GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_PROXY_COMMAND`, and indexed
`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pairs. Configured `core.sshCommand`, `core.gitProxy`, and
`url.*.insteadOf`/`pushInsteadOf` are refused too, as are proxy variables, `GIT_HTTP_*`, `GIT_SSL_*`,
curl/OpenSSL CA overrides, and effective HTTP proxy/TLS/routing configuration. Exact transport locators also cannot collide with
effective local/global/system or legacy remote definitions. A protected-base Gate validator cannot declare
the environment keys in `validator.env`; Gate scrubs them from internal Git and validator child
environments. It disables Git promisor lazy fetching, so a missing object fails instead of silently
importing candidate content.

Before adoption, `candidate authority setup` or `registerCandidateAuthority()` must create the
versioned, digested protected-target registration at the fixed Git-common-directory path. The
registration binds the base ref, base branch, remote name, refresh behavior, state directory, and,
when available, a canonical fetch-URL fingerprint without storing a raw URL. The mutable checkout and
protected-base configuration must match it. A different registration requires explicit `--replace`,
serialized by a common-directory authority lock; `doctor`, `unlock`, and
`unlock gate-authority --force` expose recovery for a crashed holder. A pending submission records
its authority digest and is not replayed under a replacement. The state locator follows a
conservative portable ASCII grammar and excludes Git administrative and fixed broker-authority
names; every directory component is physically proved beneath Git's common directory before use.

For a refreshable configured base (`main`, `origin/main`, or `refs/remotes/origin/main`) with
`integration.refreshBase: true`, setup requires and fingerprints the remote's canonical fetch URL.
There is no stale-local fallback; an intentionally offline/local Gate target must set refresh to
false before registration.

Protected-base refresh uses the fingerprinted fetch URL even when the remote declares a different
`pushurl`. Candidate tree materialization reads raw blobs and does not run checkout hooks,
clean/smudge/process filters, `ident`, EOL conversion, or submodule helpers. Validation then compares
the worktree's raw tracked bytes, modes, links, index, `HEAD`, and untracked paths with the retained
tree. Gate recomputes the Git object ID of every retained commit, explicit tree, and blob, parses the
contiguous Git parent block byte-for-byte, and does not scan unrelated unreachable objects. Before
Git reads `HEAD` or the index, Gate verifies the regular `.git` gitfile, exact
linked-worktree administration directory, backlink, common repository, and physical top level. A
swap is `VALIDATOR_MUTATED_WORKTREE`; cleanup/recovery repairs only a marker whose exact registry
backlink is independently provable and otherwise leaves the operation pending rather than removing
a sibling worktree. Any nonignored untracked-path output is `VALIDATOR_MUTATED_WORKTREE`; its captured
NUL-delimited listing is capped at 4 KiB, and overflow produces the same bounded rejection.

The first slice accepts one Git revision only. It does not accept a URL, pull-request number, bundle,
archive, patch, alternate object store, caller-supplied base, or caller-supplied path list. The
candidate must be a nonempty, merge-free linear descendant of the registered base and must fit the
smaller of `scheduling.maxCommits` and Gate's 1,000-commit hard ceiling. The base must contain valid
committed `.merge-broker/config.json` with
`validation.authority: "broker"`; required-CI authority is unavailable because this intake does not
publish a change for CI to judge.

Gate also has fixed fail-closed resource and portability ceilings independent of repository policy:

- the protected-base `.merge-broker/config.json` blob is at most 1 MiB;
- each commit object is at most 1 MiB, and each raw tree or changed-path listing is at most 32 MiB;
- a snapshot and the complete touched-path union each contain at most 100,000 paths; each full path
  is between 1 byte and 16 KiB of valid UTF-8, while every component must be at most 255 bytes and
  satisfy the portable printable-ASCII, reserved-name, and case-collision rules; one path has at
  most 256 components and one snapshot visits at most 1,000,000 components;
- each blob is at most 64 MiB and the final tracked tree materializes at most 256 MiB;
- the recursive owned object-store scan accepts at most 500,000 entries, each of which must be a
  readable, physically contained regular file or directory rather than a link or special node; and
- the retained base-plus-history closure accepts at most 1,000,000 aggregate tree entries, 128 MiB
  of aggregate path bytes, 1,000,000 component visits, 200,000 unique blobs, 10,000 unique trees,
  192 MiB of raw tree bytes, and 200,000 parent prefixes totaling 64 MiB. Touched-path derivation
  separately caps unique tree-pair diff output at 128 MiB and 1,000,000 records and memoizes repeated
  pairs.

Crossing a candidate/object ceiling fails with `SUBMISSION_TOO_LARGE`, `GIT_OBJECT_READ_FAILED`, or
`SUBMISSION_OBJECT_STORE_UNSUPPORTED` rather than attempting an unbounded validation.

Adoption runs matching focused validators once over the union of paths touched by the candidate's
commits, then runs every authoritative validator. It records `validated`, `rejected`, or `failed`
evidence in a separate `SubmissionRecord`. It does not create or enter a task, lease, receipt, batch,
approval, provenance, branch publication, pull request, merge queue, merge reconciliation, or
dependency lifecycle. Neither MCP profile exposes adoption in `0.13.0`. Terminal submission
records and their broker-owned refs are retained indefinitely; `prune` does not yet retire them. If
the final object/ref identity cannot be reproduced, the record remains `validating` for fail-closed
operator recovery rather than claiming a terminal outcome. Recovery repairs missing or stale
manifests for already-terminal records before it loads Gate authority, so an absent or corrupt
registration cannot hide terminal state; pending validation still requires its original authority.

## Upgrade handling for batches without v0.12 target binding

Version 0.12 records the selected `remote`, `publicationMode`, a SHA-256
`remoteUrlFingerprint`, and, for pull-request publication, a host-qualified `forgeRepository` when
a publishable batch is assembled. Older state can lack one or all of those fields. The broker does
not fill them from current configuration: a
remote name may have been retargeted, and a prepared record from an older process cannot prove that
no branch or pull request was already created before the process stopped.

- A `prepared` batch that explicitly records `publicationMode: "none"` is known to have had no
  publication phase. If it already has every binding required by the newly selected mode, `batch
  publish` can publish the unchanged validated candidate. Otherwise it marks the record for refresh
  and returns `BATCH_TARGET_UNBOUND`; `batch refresh` may safely re-cut it against the current target
  reached through its recorded remote name and base branch.
- A `prepared` batch with no `publicationMode` cannot prove that it is side-effect free. Publication
  and refresh both fail with `BATCH_TARGET_UNBOUND`; inspect and remove or reconcile any original
  branch/PR before deliberately retrying its tasks.
- A previously `published` pull-request batch can still use its stored PR URL for conservative
  observation, but it is not automatically rebound. It cannot be safely refreshed, approved for
  auto-merge without the required target fields, or use changed-base topology proof. A legacy
  branch-only batch without `remoteUrlFingerprint` cannot be reconciled against a mutable remote
  name.

Do not repair these records by hand or copy the current remote into the missing fields. Resolve any
possible old remote side effect first, then re-cut from task receipts or reclaim/retry the affected
tasks as directed by state.

There is a separate compatibility path for a published PR created before `CandidateRecord` existed:
after approval policy is enabled, `batch sync` disables any observed or possibly live auto-merge,
requires the stored head SHA, base SHA, and target branch to match the open PR, and only then creates
candidate revision 1 with no inherited evidence or approval. A mismatch fails closed, and a PR that
already merged is recorded as an invariant violation. That legacy candidate-record creation is
unrelated to `candidate adopt`; it does not synthesize missing target fingerprints or make an
otherwise unbound batch safe for auto-merge.

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
- State, configuration, receipt, submission, candidate, and provenance formats are versioned, but
  pre-`1.0.0` releases may require migrations.

## Not included today

In short, the current project does **not** include:

- built-in non-GitHub pull-request adapters;
- distributed or highly available broker state;
- a hosted dashboard, remote API, or HTTP MCP server;
- an agent runner, worktree farm, prompt manager, or execution sandbox;
- Gate approval, provenance, publication, merge authorization, pull-request intake, bundle intake,
  or remote candidate submission;
- semantic conflict prediction or automatic conflict resolution;
- a Windows machine service that runs before user logon; or
- automatic invention of undeclared repository validation policy.

These are explicit product boundaries, not implied roadmap commitments. For an adapter or feature
proposal, open a feature request and describe which authority, credential, and recovery boundary it
would introduce. See [Architecture](ARCHITECTURE.md) for the state model and [Security](SECURITY.md)
for the trust boundary.
