# Roadmap

This roadmap is organized by capability rather than promised release numbers or dates. Items marked
**planned** are not available in the current npm package. See
[Compatibility and current limits](docs/COMPATIBILITY.md) for the exact shipped boundary.

## Now — consolidate the recoverable transaction core

Version `0.16.0` is the current baseline. It includes Coordinate mode: leases and commit receipts,
deterministic batching, disposable-worktree validation, optional exact-candidate approval, signed
provenance support, bound Git/GitHub publication, and recovery for interrupted publication,
auto-merge, revocation, revision, and stale-base refresh. It also ships the trusted local-ref Gate
validation increment below.

Version `0.15.0` includes:

- Gate readiness diagnostics, saved validator logs, terminal abandonment, journaled archival,
  explicit retained-ref release, and submission metrics;
- detached Ed25519 DSSE validation statements and offline verification with independent key,
  artifact, base, policy, and authority expectations;
- packaged immutable schema identities, strict saved-state diagnostics, focused lifecycle/Git
  modules, and an accepted/rejected Gate example;
- a mandatory Linux/macOS/Windows release matrix, portable forge fixtures, subprocess crash/restart
  tests, and installation/publication of the actual tested npm tarball; and
- lean full/core packaging, install-once guidance, bounded storage reporting, and preview-first
  lossless audit-log compaction. The companion core package has a separate npm publication.

Version `0.15.0` requires Node.js 22; `0.13.0` supported Node.js 20.12. The documentation tracks
source; check npm's version history for published availability.

This phase does not add a remote service or claim that arbitrary pull requests can already enter the
candidate lifecycle.

## Shipped in 0.13.0 — retain and validate one immutable Git ref

The first Gate-mode increment requires an explicit authority registration before
adoption:

```bash
amb candidate authority setup
amb candidate adopt --ref <git-ref>
```

The setup ceremony records a versioned protected-target locator at a config-independent path in
Git's common directory. It binds the base ref, branch, remote, refresh behavior, state directory, and
canonical fetch target when available without storing the remote URL. Adoption resolves a
repository-local ref to a full commit, retains it under a broker-owned ref, resolves the registered
base independently, requires a nonempty linear descendant within the smaller of
`scheduling.maxCommits` and Gate's 1,000-commit hard ceiling, derives raw paths and history,
loads matching committed policy from the exact base, and runs broker-authoritative validation on
filter-free materialized bytes. The durable `SubmissionRecord` is separate from tasks and batches,
and `recover` replays an interrupted `received` or `validating` submission only under its recorded
authority digest.

The broker selects the protected target and policy; a producer-supplied base or path list never
chooses the authority that evaluates it. The source ref must already be available locally, and this
trusted-host increment requires `validation.authority: "broker"`.

## Later Gate increment — outside the 1.0 scope

Validation is not merge authorization. The next Gate slice is **planned** and must deliberately
connect the retained submission to the exact-candidate lifecycle while preserving its separate
origin. It is complete only when the broker can:

1. create an exact candidate identity without inventing a path lease, task receipt, or synthetic
   Coordinate-mode batch history;
2. consume the versioned detached validation evidence that identifies the retained external
   artifact and protected-base policy, while keeping validation separate from authorization;
3. bind evidence and approval to that exact candidate, base, and policy;
4. publish or reject it through target-bound, crash-recoverable operations; and
5. reconcile merge completion from accepted Git history before granting any downstream authority.

Implementation should extract only the ports this slice actually needs—starting with a candidate
source and candidate-lifecycle boundary. A broad storage rewrite, generic workflow engine, PR
intake, and remote authentication do not need to land in the same change. HTTP hosting, another
database, additional forges, and a dashboard remain deferred until this Gate workflow is complete.

The first slice remains explicitly trusted-source-only: a disposable Git worktree is not a security
sandbox, and validators executing candidate-controlled code can otherwise reach the broker user's
files, credentials, and network. Accepting untrusted or remote producers requires a credential-free
isolated runner with resource and network policy.

After local ref validation and authority are proven, a separate increment may add pull-request adoption. It must pin
the exact head and base, bind a stable forge identity, distinguish self-reported producer metadata
from authenticated identity, and remain safe when refs move during intake. It also requires an
installed forge check with restricted bypass and either detached attestations or a broker-owned
wrapper change, because today's provenance commit cannot be appended to an existing PR without
changing its head.

## Later — portable authority and wider verification

Later capabilities are directional and will be prioritized by real integrations:

- authenticated HTTP and remote MCP adapters with transport-derived principals and scoped
  capabilities;
- a second state backend that proves the storage boundary before any distributed or highly
  available design;
- generalized evidence providers and signed approval attestations;
- additional versioned attestation predicates beyond the implemented Gate validation envelope;
- KMS- or identity-backed signing alongside the local Ed25519 signer;
- stable forge repository identity beyond a mutable locator;
- GitHub App and webhook reconciliation;
- native merge-queue and `merge_group` verification that distinguishes the authorized source
  candidate from the final integration artifact; and
- a second forge implementation that proves the adapter contract.

These are not commitments to build a hosted dashboard, multi-tenant execution service, distributed
consensus system, or automatic conflict-resolution engine.

## Conditions for `1.0`

The `1.0` target is the Coordinate workflow plus trusted local-ref Gate validation, retention,
diagnostics, and detached evidence. It does not require Gate merge authorization, remote submission,
another forge, another database, HTTP hosting, a dashboard, or a workload sandbox. Existing Gate
validation formats and commands are included in the intended stable contract.

The project reaches `1.0` when adopters can depend on that scope. The checklist below is release
qualification work, not a claim that a release candidate has already passed:

- Freeze the documented CLI/JSON, root Node API, MCP inputs, errors, and format-specific compatibility
  rules. Reviewed declaration, representative CLI JSON, and MCP input-schema baselines guard changes;
  they are not a full cross-implementation conformance suite.
- Retain immutable schema identities and document which formats are strict, extensible, nested, or
  signed. Preserve strict policy validation; do not promise that every format tolerates new keys or
  has its own integer version.
- Exercise upgrades from named released packages using their actual saved bytes and document required
  drain steps. Current migration tests cover version-1 state without `submissions` and unversioned
  archived slices, including a frozen `v0.12.1` release-source fixture generated with current
  development dependencies. They do not certify every historical npm version or an in-flight
  repository upgrade. Migration never rewrites signed evidence or invents missing publication target
  bindings.
- Publish portable accepted/rejected conformance fixtures and reusable `ForgePublisher` contract
  cases for exact identity, retries, ambiguous responses, revocation, and terminal reconciliation.
- Preserve the documented OS-account authority of CLI/Node and launch-bound local MCP profiles.
  Remote authentication is required only if a remote transport is added later.
- Map every supported external side effect to recovery tests, including selected fresh-process
  interruption/restart tests. State and audit are not one transaction; document that audit events
  may be missing after committed state and that unsupported filesystem durability is not promised.
- Pass the complete supported OS/Node matrix on the exact release revision, install and exercise
  the tested tarballs, and complete an adopter walkthrough of publication, approval, reconciliation,
  restart, and upgrade. Confirm registry/provenance facts only after publication succeeds.
- Publish the support window and a concise operational recovery/backup procedure for that scope.

Software versions, repository protocol versions, and attestation predicate versions will remain
separate so one can evolve without implying that the others changed.
