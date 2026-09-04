# Vision

Agent Merge Broker exists to make repository changes recoverable, inspectable, and bound to the
artifact that was actually validated. Agents, orchestrators, bots, CI jobs, and humans may all
produce code. The repository still needs one contract for deciding what is eligible to approach its
protected branch.

**Many producers. One repository contract.**

This document describes product direction, not a list of features already shipped. The current
capability boundary is documented in [Compatibility and current limits](docs/COMPATIBILITY.md), and the
sequence for expanding it is in [Roadmap](ROADMAP.md).

## The boundary

The responsibilities are deliberately separate:

- Producers decide how code is created.
- Agent Merge Broker coordinates participating producers, derives the candidate it will validate,
  and applies repository-owned transaction policy.
- Validation and review systems provide evidence about an exact candidate.
- An authorized operator or policy grants merge authority when approval is required.
- The forge remains the final branch authority and decides when the protected branch moves.

Agent Merge Broker is not an agent conductor, an AI policy judge, or a replacement for CI, code
review, branch protection, or a native forge merge queue.

## Product principles

### Bind decisions to immutable artifacts

Evidence and approval are meaningful only when they identify the exact candidate SHA, base SHA, and
policy revision they evaluated. A changed candidate or base requires a new decision. Friendly names
are useful for operators; immutable identifiers are the authority.

### Derive security-relevant facts

Workers nominate revisions, but the broker resolves them to full immutable commit IDs and derives
changed paths from Git rather than trusting producer metadata. It binds publication to the recorded
Git remote and forge target. Future intake paths must preserve that rule: import first, resolve
immutable objects, then evaluate them.

### Read policy from the repository's protected side

Code under review must not be able to relax the policy that judges it. Verification policy comes
from a snapshot selected on the protected side, and repository owners remain responsible
for protecting that base and restricting bypass permission. Today the read-only provenance verifier
loads its applicable policy from the exact protected-base commit. The trusted local-ref intake in
`0.13.0` additionally binds a reviewed protected-target registration outside candidate
commits before loading policy from its exact base. Coordinate-mode operations still load
configuration from the controlled local checkout; expanding base-policy identity to later Gate
publication must preserve this separation.

### Keep capabilities separate

Producing, validating, recording evidence, approving, publishing, and merging are different
authorities. The current worker and operator MCP profiles establish that boundary locally. Future
remote interfaces must derive identity and capability from authenticated context rather than trust
a caller-supplied actor name.

### Treat uncertain side effects as durable state

A remote request and a local filesystem transaction cannot be atomic. The broker records enough
intent and identity to retry or reconcile publication, auto-merge, revocation, refresh, and
candidate revision after a crash or lost response. Unknown remote state must fail closed until it
can be observed safely.

### Prove completion from repository history

"Merged" must mean the approved work is represented in the accepted Git history, not merely that a
forge object reached a terminal state. Dependent tasks are released only after the broker can prove
an accepted merge topology.

### Stay local-first without making local-only the protocol

The filesystem-backed authority is a useful default: it is inspectable, self-hosted, and requires no
service. Interfaces should be extracted as real alternative implementations arrive, without
turning the project prematurely into a hosted control plane or distributed database.

### Minimize sensitive producer data

Artifact identity, authenticated producer identity, policy, evidence, and authorization are durable
facts. Prompts and full agent transcripts are vendor-specific, sensitive, and not required for the
repository transaction contract.

## Product modes

### Coordinate mode — available today

Workers claim path scope, maintain leases, commit focused work, and nominate receipts containing
immutable commit IDs. The broker schedules compatible work, assembles it in a disposable worktree,
runs the configured validation authority, retains one candidate, and can publish it as a branch or
GitHub pull request. Optional policy binds evidence and approval to the exact candidate before
auto-merge.

This mode serves linked worktrees, independent local sessions, and mixed agent/human teams that
participate in the receipt protocol.

### Gate mode — validation intake available in 0.13.0

A producer that has already coordinated its own work can present a trusted Git ref already available
to the broker without first acquiring a path lease. An operator first registers the
reviewed protected-target locator outside candidate commits. The broker resolves and retains the
exact commit, independently resolves that registered base through its fetch binding when refresh
applies, derives raw
linear history and every path touched, loads matching committed policy from the base, and validates
filter-free retained bytes in a disposable worktree. It records a separate validation submission
rather than inventing Coordinate-mode tasks, leases, receipts, or batches. This is not an
untrusted-code sandbox.

This first slice stops at validation. It does not create an approval candidate, provenance,
publication, reconciliation, or merge authority. Connecting validated submissions to those later
Gate stages—and adding pull-request intake, bundles, or authenticated remote submission—remains
planned.

### Verify mode — planned

A lightweight verifier should eventually let a protected workflow check standardized Agent Merge
Broker policy and attestation claims for work assembled elsewhere. The current
`verify-provenance` command is narrower: it verifies provenance produced by today's broker workflow;
it is not yet a general admission check for arbitrary external candidates.

## Non-goals

The project will not make these its product identity:

- spawning or orchestrating coding agents;
- AI-decided authorization;
- automatic conflict resolution as a security boundary;
- reimplementing a forge's deep merge queue;
- requiring prompts or private model transcripts;
- a multi-tenant hosted service before workload isolation and authenticated identity exist; or
- a family of packages and abstractions without a second implementation that needs them.

## What stability should mean

A `1.0` release should represent a compatibility promise, not simply a feature count. It requires
documented migrations, immutable schema identifiers, conformance fixtures, stable adapter contracts,
and a clearly versioned distinction between the software release, repository protocol, and any
attestation predicate. Until then, pre-`1.0` formats may evolve as the gate boundary is proven.
