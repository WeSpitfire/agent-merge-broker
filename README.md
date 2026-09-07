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

Version **0.14.2** includes the complete Coordinate workflow and trusted local-ref Gate validation,
with Gate diagnostics, abandonment and archival, detached signed validation evidence, offline
verification, stricter state diagnostics, and release safeguards. The documentation tracks source;
check the [npm version history](https://www.npmjs.com/package/agent-merge-broker?activeTab=versions)
for published availability.

The `v0.14.0` and `v0.14.1` GitHub tags remain available, but neither version was published to npm.
Version 0.14.2 is the corrected npm release target for these features; the registry confirms when it
is available.

Version 0.14.2 requires **Node.js 22 or newer**; version 0.13.0 supported Node.js 20.12 or newer.
Git 2.31+ is required for Coordinate; Gate requires Git 2.46+. Linux, macOS, and Windows are
supported. GitHub CLI is required only for GitHub pull-request publication.

See [Compatibility](docs/COMPATIBILITY.md), [Changelog](CHANGELOG.md), and
[Roadmap](ROADMAP.md) for the exact boundaries. Gate approval, publication, and merge authorization
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

## Install and review repository policy

```bash
npm install --save-dev agent-merge-broker
npx merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker AGENTS.md
git commit -m 'Configure Agent Merge Broker'
npx merge-broker doctor
```

Initialization detects validation commands the repository already declares. Review
`.merge-broker/config.json` before using it: configuration is executable policy, and validators run
with the broker user's permissions. The public signing key belongs in committed policy; the private
key, runtime state, leases, and disposable worktrees live under Git's common directory.

Coordinate operations read configuration from the controlled local checkout. Gate adoption and
protected-branch provenance verification load their applicable policy from the exact protected base.

## Route 1: coordinate participating workers

In each worker's linked worktree:

```bash
npx merge-broker task claim SEARCH-1 --holder worker/search --path 'src/search/**'
# Edit and commit the change.
npx merge-broker task candidate SEARCH-1 --since-base
```

The integration owner then runs:

```bash
npx merge-broker plan
npx merge-broker integrate --dry-run
npx merge-broker integrate
npx merge-broker status
```

Expiring leases reduce predictable collisions; commit receipts identify immutable work. The broker
schedules compatible receipts, cherry-picks them in a disposable worktree, runs configured
validation, and retains one candidate. Publication is explicitly configurable as local-only, remote
branch, or GitHub pull request. Optional approval binds evidence and permission to the exact
candidate, base, and policy revision. Durable intents allow interrupted publication and merge
decisions to be reconciled.

Use [Getting started](docs/GETTING_STARTED.md) for validation, publication, approval, service, and
recovery recipes. The [worker protocol](docs/PROTOCOL.md) documents CLI/JSON, Node, and permission-
separated stdio MCP integration.

## Route 2: validate a trusted existing branch

From a reviewed checkout whose protected base contains the committed broker policy:

```bash
npx merge-broker candidate authority setup
npx merge-broker candidate adopt --ref refs/heads/producer/candidate
npx merge-broker candidate show <submission-id>
```

The candidate must already exist locally and be a nonempty linear descendant of the registered
base. Gate derives its history and paths, materializes its raw Git bytes, and runs the base's
broker-authoritative validators. A `SubmissionRecord` reports `validated`, `rejected`, or `failed`
without inventing tasks or leases. A rejected candidate exits nonzero.

Version 0.14.2 includes these operational commands:

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
merge authorization. [Protocol](docs/PROTOCOL.md) includes the full verifier command, abandonment,
retention options, and immutable [schema identities](schemas/identities.json).

Gate accepts trusted local code. A disposable worktree is not an execution sandbox. Read the
[security model](docs/SECURITY.md) before choosing the broker host and credentials.

## Operate and contribute

`status` supplies next actions; `doctor`, `events`, and `metrics` help diagnose them. `recover`
replays local interrupted operations. Coordinate publication uses `batch publish`, `batch sync`,
and `batch refresh` to observe the forge before proceeding. Gate archival preserves audit records,
and releasing a retained Git ref requires an explicit option.

For protected-branch enforcement of Coordinate provenance, pin the composite action to the matching
release tag: `WeSpitfire/agent-merge-broker/verify@v0.14.2`. Configuration examples are in
[Getting started](docs/GETTING_STARTED.md) and the [release guide](docs/RELEASING.md).

Source verification includes the full test suite, both examples, and installation of the actual npm
tarball. Publication waits for the same immutable commit to pass Linux, macOS, and Windows checks
and publishes the tested tarball through npm trusted publishing.

See [Architecture](docs/ARCHITECTURE.md), [Vision](VISION.md), [Contributing](CONTRIBUTING.md), and
[Support](SUPPORT.md). The project is licensed under [Apache-2.0](LICENSE). Pre-1.0 persisted formats
are versioned, but compatibility changes may still require a documented migration.
