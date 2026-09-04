# Roadmap

This roadmap is organized by capability rather than promised release numbers or dates. Items marked
**planned** are not available in the current npm package. See
[Compatibility and current limits](docs/COMPATIBILITY.md) for the exact shipped boundary.

## Now — consolidate the recoverable transaction core

Version `0.13.0` is the current baseline. It ships Coordinate mode: leases and commit receipts,
deterministic batching, disposable-worktree validation, optional exact-candidate approval, signed
provenance support, bound Git/GitHub publication, and recovery for interrupted publication,
auto-merge, revocation, revision, and stale-base refresh. It also ships the trusted local-ref Gate
validation increment below.

Near-term work should make that foundation easier to operate and change safely:

- document every durable intent, retry rule, ambiguous state, lock, and recovery transition;
- keep the public `MergeBroker` API stable while separating candidate lifecycle and transaction
  mechanics into smaller internal modules;
- extend the proven local-ref submission boundary toward merge-authorized candidate lifecycle
  without conflating the two records;
- strengthen repository governance, cross-platform release evidence, and real-forge canary coverage;
- keep current package, repository, CLI, and on-disk identities stable; and
- preserve Coordinate mode as the supported local-first workflow.

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

## Next — turn a validated submission into a merge-authorized Gate candidate

Validation is not merge authorization. The next Gate slice is **planned** and must deliberately
connect the retained submission to the exact-candidate lifecycle while preserving its separate
origin. It is complete only when the broker can:

1. create an exact candidate identity without inventing a path lease, task receipt, or synthetic
   Coordinate-mode batch history;
2. define provenance that honestly identifies the retained external artifact and protected-base
   policy;
3. bind evidence and approval to that exact candidate, base, and policy;
4. publish or reject it through target-bound, crash-recoverable operations; and
5. reconcile merge completion from accepted Git history before granting any downstream authority.

Implementation should extract only the ports this slice actually needs—starting with a candidate
source and candidate-lifecycle boundary. A broad storage rewrite, generic workflow engine, PR
intake, and remote authentication do not need to land in the same change.

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
- an additive standard attestation envelope, such as in-toto/DSSE, around a versioned broker
  predicate;
- KMS- or identity-backed signing alongside the local Ed25519 signer;
- stable forge repository identity beyond a mutable locator;
- GitHub App and webhook reconciliation;
- native merge-queue and `merge_group` verification that distinguishes the authorized source
  candidate from the final integration artifact; and
- a second forge implementation that proves the adapter contract.

These are not commitments to build a hosted dashboard, multi-tenant execution service, distributed
consensus system, or automatic conflict-resolution engine.

## Conditions for `1.0`

The project reaches `1.0` when adopters can depend on the contract, including:

- stable and documented repository, candidate, and attestation formats;
- immutable schema identifiers and published compatibility rules;
- migration tooling for supported older formats;
- conformance fixtures and adapter contract tests;
- explicit authentication and authorization semantics for every supported transport;
- recovery guarantees tested across every supported external side effect; and
- a stated support window for public CLI, JSON, Node, and protocol interfaces.

Software versions, repository protocol versions, and attestation predicate versions will remain
separate so one can evolve without implying that the others changed.
