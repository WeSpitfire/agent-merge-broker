# Roadmap

This roadmap is organized by capability rather than promised release numbers or dates. Items marked
**planned** are not available in the current npm package. See
[Compatibility and current limits](docs/COMPATIBILITY.md) for the exact shipped boundary.

## Now — consolidate the recoverable transaction core

Version `0.12.1` is the current baseline. It ships Coordinate mode: leases and commit receipts,
deterministic batching, disposable-worktree validation, optional exact-candidate approval, signed
provenance support, bound Git/GitHub publication, and recovery for interrupted publication,
auto-merge, revocation, revision, and stale-base refresh.

Near-term work should make that foundation easier to operate and change safely:

- document every durable intent, retry rule, ambiguous state, lock, and recovery transition;
- keep the public `MergeBroker` API stable while separating candidate lifecycle and transaction
  mechanics into smaller internal modules;
- define the trust model and acceptance tests for external candidate intake;
- strengthen repository governance, cross-platform release evidence, and real-forge canary coverage;
- keep current package, repository, CLI, and on-disk identities stable; and
- preserve Coordinate mode as the supported local-first workflow.

This phase does not add a remote service or claim that arbitrary pull requests can already enter the
candidate lifecycle.

## Next — adopt one immutable Git ref safely

The first Gate-mode vertical slice is **planned** adoption of a Git commit already available to the
broker's repository. It should not begin with a PR number, uploaded bundle, or unauthenticated network
request.

The slice is complete only when the broker can:

1. resolve the requested ref to a full commit ID and retain it under a broker-owned reference;
2. resolve the configured base independently and enforce the intended ancestry boundary;
3. derive changed paths and commit history from Git rather than producer metadata;
4. load the applicable policy from the configured base;
5. validate the retained bytes in a disposable worktree under the current trusted-repository model;
6. create an exact candidate identity without inventing a path lease or pretending the producer used
   Coordinate mode;
7. bind any evidence and approval to that candidate, base, and policy; and
8. publish or reject it through the same target-bound, recoverable transaction machinery used today.

A proposed command might eventually look like:

```bash
amb candidate adopt --ref <git-ref>
```

That syntax is illustrative, not part of the current CLI contract. The broker selects the protected
target and policy; a producer-supplied base must never choose the authority that evaluates it.

Implementation should extract only the ports this slice actually needs—starting with a candidate
source and candidate-lifecycle boundary. A broad storage rewrite, generic workflow engine, PR intake,
and remote authentication do not need to land in the same change.

The first slice remains explicitly trusted-source-only: a disposable Git worktree is not a security
sandbox, and validators executing candidate-controlled code can otherwise reach the broker user's
files, credentials, and network. Accepting untrusted or remote producers requires a credential-free
isolated runner with resource and network policy.

After local ref adoption is proven, a separate increment may add pull-request adoption. It must pin
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
