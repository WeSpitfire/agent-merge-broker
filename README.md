# Agent Merge Broker

**Crash-recoverable repository transactions for code-producing agents and humans.**

Agent Merge Broker coordinates committed work, validates exact Git artifacts, and keeps publication
and optional approval bound to the recorded candidate and target. It runs locally with Git; the
forge remains the final authority over the protected branch.

Choose the entry route that matches how work reaches your repository:

- **Coordinate:** workers claim scope and submit commit receipts; the broker batches, validates,
  publishes, and reconciles their work.
- **Gate:** another trusted producer already has a branch; the broker retains its exact commit and
  tree and validates them against policy from a separately registered protected base.

It does not spawn agents, resolve conflicts with AI, or replace your validators, reviewers, branch
protection, or forge merge queue.

## Release status

Version **0.15.0** includes the complete Coordinate workflow and trusted local-ref Gate validation,
with Gate diagnostics, abandonment and archival, detached signed validation evidence, offline
verification, stricter state diagnostics, leaner packaging, storage maintenance, and release safeguards.
The documentation tracks source;
check the [npm version history](https://www.npmjs.com/package/agent-merge-broker?activeTab=versions)
for published availability.

The `v0.14.0` and `v0.14.1` GitHub tags remain available, but neither version was published to npm.
The companion core package is published separately; confirm its version in
[npm's core package history](https://www.npmjs.com/package/agent-merge-broker-core?activeTab=versions).

Version 0.15.0 requires **Node.js 22 or newer**; version 0.13.0 supported Node.js 20.12 or newer.
Git 2.31+ is required for Coordinate; Gate requires Git 2.46+. Linux, macOS, and Windows are
supported. GitHub CLI is required only for GitHub pull-request publication.

See [Compatibility](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/COMPATIBILITY.md),
[Changelog](https://github.com/WeSpitfire/agent-merge-broker/blob/main/CHANGELOG.md), and
[Roadmap](https://github.com/WeSpitfire/agent-merge-broker/blob/main/ROADMAP.md) for the exact boundaries. Gate approval, publication, and merge authorization
remain planned.

## Try both routes locally

These examples create and clean up temporary repositories and do not contact a forge:

```bash
git clone https://github.com/WeSpitfire/agent-merge-broker.git
cd agent-merge-broker
npm install
npm run build
npm run example
npm run example:gate
```

The Coordinate example combines four commits from two workers and rejects an overlapping claim.
The Gate example validates one candidate, rejects another, signs the accepted result, verifies it
offline, and previews archival.

## Install once, use across projects

Keep the tool outside your project's dependencies with a version-pinned global installation:

```bash
npm install --global agent-merge-broker@0.15.0
# From the repository you want to coordinate:
merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker AGENTS.md
git commit -m 'Configure Agent Merge Broker'
merge-broker doctor
```

This does not add the broker to your project's `package.json` or `node_modules`. Prefer a
project-local, lockfile-pinned dev dependency when a team or CI needs to reproduce the entire
dependency tree. For pinned execution through npm's cache, or local installation instructions, see
[Getting started](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/GETTING_STARTED.md#2-install-and-initialize).

`agent-merge-broker-core` offers the same Coordinate/Gate CLI and core Node API
without the MCP server or SDK dependency. Keep `agent-merge-broker` for MCP support and existing
imports. Choose one package per installation because they share CLI aliases, and confirm the
desired version is published for that package. Version 0.15.0 tarballs omit debug maps and long guides/examples while keeping
runtime code, TypeScript definitions, schemas, templates, README, and license. Full source and
guides remain on GitHub.

Initialization detects validation commands the repository already declares. Review
`.merge-broker/config.json` before using it: configuration is executable policy, and validators run
with the broker user's permissions. The public signing key belongs in committed policy; the private
key, runtime state, leases, and disposable worktrees live under Git's common directory.

Coordinate operations read configuration from the controlled local checkout. Gate adoption and
protected-branch provenance verification load their applicable policy from the exact protected base.

## Route 1: coordinate participating workers

In each worker's linked worktree:

```bash
merge-broker task claim SEARCH-1 --holder worker/search --path 'src/search/**'
# Edit and commit the change.
merge-broker task candidate SEARCH-1 --since-base
```

The integration owner then runs:

```bash
merge-broker plan
merge-broker integrate --dry-run
merge-broker integrate
merge-broker status
```

Expiring leases reduce predictable collisions; commit receipts identify immutable work. The broker
schedules compatible receipts, cherry-picks them in a disposable worktree, runs configured
validation, and retains one candidate. Publication is explicitly configurable as local-only, remote
branch, or GitHub pull request. Optional approval binds evidence and permission to the exact
candidate, base, and policy revision. Durable intents allow interrupted publication and merge
decisions to be reconciled.

Use [Getting started](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/GETTING_STARTED.md) for validation, publication, approval, service, and
recovery recipes. The [worker protocol](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/PROTOCOL.md) documents CLI/JSON, Node, and permission-
separated stdio MCP integration.

## Route 2: validate a trusted existing branch

From a reviewed checkout whose protected base contains the committed broker policy:

```bash
merge-broker candidate authority setup
merge-broker candidate adopt --ref refs/heads/producer/candidate
merge-broker candidate show <submission-id>
```

The candidate must already exist locally and be a nonempty linear descendant of the registered
base. Gate derives its history and paths, materializes its raw Git bytes, and runs the base's
broker-authoritative validators. A `SubmissionRecord` reports `validated`, `rejected`, or `failed`
without inventing tasks or leases. A rejected candidate exits nonzero.

Version 0.15.0 includes these operational commands:

```bash
merge-broker doctor --gate
merge-broker candidate show <submission-id> --logs
merge-broker candidate attest <submission-id> --output candidate.dsse.json
merge-broker candidate archive <submission-id>             # preview
merge-broker candidate archive <submission-id> --apply     # retains its Git ref
merge-broker candidate list --all
```

Detached attestations use Ed25519 DSSE and a versioned in-toto validation statement. Offline
verification requires an independently trusted key and expected commit, tree, base, policy digest,
and authority digest. A valid signature can describe a rejection; validation evidence never grants
merge authorization. [Protocol](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/PROTOCOL.md) includes the full verifier command, abandonment,
retention options, and immutable [schema identities](https://github.com/WeSpitfire/agent-merge-broker/blob/main/schemas/identities.json).

Gate accepts trusted local code. A disposable worktree is not an execution sandbox. Read the
[security model](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/SECURITY.md) before choosing the broker host and credentials.

## Operate and contribute

`status` supplies next actions; `doctor`, `events`, and `metrics` help diagnose them. `recover`
replays local interrupted operations. Coordinate publication uses `batch publish`, `batch sync`,
and `batch refresh` to observe the forge before proceeding. Gate archival preserves audit records,
and releasing a retained Git ref requires an explicit option.

`storage show` reports broker-managed file sizes without reading file contents.
`storage compact --older-than 30` previews lossless compression of closed audit-log rotations;
add `--apply` to perform it. It does not prune evidence, recovery state, keys, worktrees, or Git refs.
Upgrade all audit readers first: versions before 0.15.0 cannot read compressed rotations.
See the [storage recipe](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/GETTING_STARTED.md#inspect-and-compact-storage).

For protected-branch enforcement of Coordinate provenance, pin the composite action to the matching
release tag: `WeSpitfire/agent-merge-broker/verify@v0.15.0`. Configuration examples are in
[Getting started](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/GETTING_STARTED.md) and the [release guide](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/RELEASING.md).

Source verification includes the full test suite, both examples, and installation of the actual npm
tarball. Publication waits for the same immutable commit to pass Linux, macOS, and Windows checks
and publishes the tested tarball through npm trusted publishing.

See [Architecture](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/ARCHITECTURE.md),
[Vision](https://github.com/WeSpitfire/agent-merge-broker/blob/main/VISION.md),
[Contributing](https://github.com/WeSpitfire/agent-merge-broker/blob/main/CONTRIBUTING.md), and
[Support](https://github.com/WeSpitfire/agent-merge-broker/blob/main/SUPPORT.md). The project is licensed under [Apache-2.0](LICENSE). Pre-1.0 persisted formats
are versioned, but compatibility changes may still require a documented migration.
