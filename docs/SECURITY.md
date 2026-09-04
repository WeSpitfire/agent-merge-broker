# Security model

## Trust boundary

Agent Merge Broker is intended for trusted repositories and trusted integration hosts. The checked-in configuration is executable policy: validator commands run through the host shell inside an integration worktree. Reviewing a configuration change is as important as reviewing a CI workflow change.

Do not run the broker automatically on untrusted fork configuration. A safe forge integration should load policy from the protected base branch, not from an incoming change.

Coordinate-mode operations load `.merge-broker/config.json` from the worktree in which the broker is
opened. Current-main trusted local-ref intake requires that checkout to match a separately registered
protected-target locator, uses the registration to select the base/fetch target, then loads its
effective evaluator policy from the exact protected-base commit; it never uses the candidate's copy
to judge that candidate. The remote `verify-provenance` path also
reads verification policy from the supplied protected-base commit. None of these rules makes it
safe to invoke an operator command from an untrusted fork checkout. Run the service and operator
surfaces from a controlled checkout, and protect who may change its configuration or invoke it.

## Credentials

- Lease tokens contain 192 bits of randomness and only SHA-256 digests are persisted in broker state.
- By default the broker also keeps the token itself in `<state>/tokens/`, mode 0600, so callers do
  not have to invent a credential store. This grants nothing new: anyone who can read that directory
  can already edit broker state directly. It exists because the alternative in practice is a token
  written into the working tree, where `git add` and validator commands can reach it. Claim with
  `--no-store-token` to opt out, or `--token-file` to place it elsewhere.
- Tokens may also be supplied through `MERGE_BROKER_TOKEN` or a process-level secret channel.
- `MERGE_BROKER_TOKEN` is removed from the environment passed to validator commands. Configuration
  is trusted to execute commands, but a validator has no need for a credential that can submit or
  cancel work on a worker's behalf.
- Do not place tokens in commits, task titles, validator commands, or logs.
- Git and GitHub credentials remain owned by the host's normal credential helpers.
- Validator stdout and stderr are retained locally and may contain accidental secrets. Capture is
  bounded while the process runs, not only truncated afterward; output is capped, not redacted.
- New repositories receive an Ed25519 provenance private key under Git's common runtime directory,
  mode 0600. Only the public key is committed. `MERGE_BROKER_SIGNING_KEY` and
  `MERGE_BROKER_SIGNING_KEY_FILE` support supervised hosts and are removed from validator
  environments. Back up the private key as an operational credential; losing it blocks signed
  integration until the public-key policy is deliberately rotated.
- Rotation retains mode-0600 private keys by public-key ID. This makes a crash between local key
  rotation and committing new public-key policy recoverable and lets in-flight protected-base policy
  select its matching key. Retire old keys deliberately only after no supported base trusts them.

Runtime state is stored inside Git's common directory. Broker-owned directories are mode 0700 and
state, audit, receipt, manifest, token, and key files are mode 0600 on POSIX systems. Anyone who can
modify the repository's Git directory can still modify broker state or audit records. The audit
stream is append-only by convention, not cryptographically tamper-evident.

State, integration, fixed Gate-authority, and per-batch locks are correctness controls between
cooperating local processes, not authorization boundaries. Their owner nonces prevent an old process
from releasing a successor's lock, and only a provably dead same-host process is reclaimed
automatically. An operator with filesystem access can force-unlock, edit state, or replace Git objects; the security model
already trusts that operator and host. A shared Git directory does not provide distributed consensus
or protect against a hostile second machine.

## Git safety

The broker never resets the user's base worktree, merges into the base branch, or deletes source
branches. Initial publication pushes the recorded candidate SHA with a create-only lease. Candidate
revision is the sole force update, limited to the broker's own integration branch and guarded by
`--force-with-lease` against the prior candidate SHA. Broker-created commits use a fixed identity,
disable signing, and bypass ambient hooks so machine-specific Git configuration cannot alter the
validated artifact. Temporary worktrees stay under the broker state directory.

After every successful focused and authoritative validator set, the broker requires the same `HEAD`
and a clean integration or submission worktree. A validator that commits, checks out another
revision, edits a tracked file, or creates a non-ignored untracked file causes
`VALIDATOR_MUTATED_WORKTREE`; its claimed success is not retained. Broker-generated squash and
provenance commits occur only afterward on Coordinate batches through the fixed identity and
hook-free Git path. This byte-preservation check does not sandbox a validator: trusted configuration
can still modify other refs, contact the network, write outside the worktree, or exfiltrate any
credential available to its process.

Failed integration worktrees are removed by default. Enabling `keepFailedWorktrees` can retain source content, generated artifacts, and secrets written by validators; operators must clean these worktrees deliberately after diagnosis.

Commit receipts are immutable IDs, but their objects can disappear after aggressive source-repository garbage collection if no ref retains them. Integrate or otherwise retain submitted commits before pruning unreachable branches.

## Trusted local-ref intake

Version `0.13.0` ships this capability. `candidate adopt --ref` is for candidate code trusted to
execute on the broker host. The disposable
worktree is filesystem hygiene, not workload isolation. Focused and authoritative validators can
run candidate-controlled build scripts with the broker process's ordinary filesystem and network
access. The broker removes lease tokens and provenance signing keys from validator environments, but
it cannot remove every ambient repository, package-manager, SSH, cloud, or credential-helper secret.
Do not point this command at an untrusted fork ref; use an isolated, credential-free runner outside
this product when the producer is not trusted.

The operator first runs `candidate authority setup` from a reviewed protected checkout. Its
versioned registration lives at a fixed path in Git's common directory, outside candidate commits
and outside the mutable `stateDirectory` locator. It binds the base ref, branch, remote, refresh
behavior, state directory, and, when available, a canonical fetch-URL fingerprint without retaining a
raw URL or credentials. Setup, replacement, adoption, and recovery hold one fixed-root lock; inspect
it through `doctor` or `unlock`, and force-release it only after proving its holder cannot progress.
Target changes require explicit `--replace`, and pending submissions remain bound to their original
authority digest.
The configured state directory uses portable ASCII components, excludes Git administrative and
fixed authority names, and is created and rechecked as a physical directory tree below the Git
common directory; a pre-existing symlink or junction is not followed.

The operator supplies only a repository-local Git revision. There is no producer-selected base or
path list. The broker resolves the registered base independently, requires the mutable and committed
protected-base target fields to match the registration, and loads policy only from that exact base.
Protected-base refresh uses the registered fetch URL even when Git config declares a different
publication `pushurl`. Gate requires Git 2.46 or newer, refuses object-store overrides, alternates,
redirected object directories, and legacy grafts, and recursively verifies that every object-store
entry is a contained regular file or physical directory under a 500,000-entry cap. It enforces a
nonempty merge-free raw-parent chain bounded by both `scheduling.maxCommits` and a 1,000-commit hard
ceiling. It records the source name for diagnostics, but the full commit/tree IDs and create-only
`refs/merge-broker/adopted/<submission-id>` ref are the artifact authority. Moving or deleting the
source name afterward cannot retarget the record.

Before looking up the candidate or base, Gate rejects nonempty ambient `GIT_INDEX_FILE`, `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_QUARANTINE_PATH`, `GIT_GRAFT_FILE`, `GIT_SHALLOW_FILE`, and
`GIT_REPLACE_REF_BASE`. It also rejects Git configuration injection through `GIT_CONFIG`,
`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_NOSYSTEM`, indexed `GIT_CONFIG_KEY_<n>` or `GIT_CONFIG_VALUE_<n>`, and transport/tool
selection through `GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, or
`GIT_PROXY_COMMAND`; standard proxy variables, `GIT_HTTP_*`, `GIT_SSL_*`, `CURL_CA_BUNDLE`,
`SSL_CERT_FILE`, and `SSL_CERT_DIR` are denied as well. Names are matched case-insensitively.
Configured `core.sshCommand`, `core.gitProxy`, `url.*.insteadOf`/`pushInsteadOf`, and HTTP
proxy/TLS/routing overrides are refused before bound fetches and publication pushes. HTTP
authorization headers remain supported, but configured `Host` or `:authority` replacement is
refused. Exact locators that Git could reinterpret through an effective
local/global/system `remote.*` subsection or legacy remote shorthand are refused as well. A
protected-base Gate validator whose `env` declares any denied environment key is also rejected, even
if its value is empty; Gate-internal Git commands and every Gate validator child environment remove
those inherited values as a second defense. This prevents ambient or declarative configuration from
silently selecting another Git executable, transport, repository, index, namespace, object store,
graft, shallow boundary, or replacement-ref namespace. The protected validator command itself
remains trusted code and is not sandboxed.

The validation worktree is populated directly from retained blob bytes. Checkout hooks,
clean/smudge/process filters, `ident`, EOL conversion, and submodule helpers do not transform those
bytes. Fresh, inode-bound empty hook directories isolate every broker Git transaction; a replaced or
populated directory fails the operation and is never recursively removed as an assumed broker
directory. Gate also hashes every retained commit, tree, and blob object against its recorded ID and
parses the leading tree/contiguous parent block byte-for-byte. Before reading `HEAD` or the index,
the broker proves that the worktree's regular `.git`
gitfile still names the exact linked-worktree administration entry captured at creation, that its
regular backlink returns to this physical worktree, and that Git reports the same common repository
and physical top level. The physical worktree and cache roots are bound by full-width device/inode
identity before recursive cleanup, preventing a renamed directory at the same pathname from being
deleted as broker-owned. A marker swap is `VALIDATOR_MUTATED_WORKTREE`. Cleanup and recovery may
repair only this marker after independently finding the exact registry backlink; if that identity
cannot be proved, state remains recoverable instead of risking removal of a sibling worktree.

Post-validator checks compare `HEAD`, the index, raw tracked blobs, executable modes, symlink targets,
and untracked paths against the retained tree. The nonignored untracked-path listing is captured with
a 4 KiB ceiling: either any output or an overflow is a validator mutation, without retaining an
unbounded diagnostic. These checks protect artifact identity; they do not sandbox execution or
prevent a trusted validator from changing other host resources.

The submission record and retained ref share the same local trust boundary as the rest of broker
state. Their policy digest detects accidental or replay inconsistency; it is not a remote signature
or defense against an operator who can edit the Git common directory. Records and refs are not
pruned in this first slice. `validated` means every validator selected by the protected-base policy
passed; an empty validator policy can therefore produce an empty successful result and is not a
substitute for configuring a real gate. Most importantly, the status grants no approval,
publication, provenance, or merge authority. It is not accepted by batch commands and is not an
enforceable protected-branch result.

The broker records `retentionEstablishedAt` before any validator runs. If that established ref is
later missing, it records `retentionCompromisedAt` before create-only repair. The tombstone survives
a stop after repair and permanently invalidates an otherwise-passing run; recovery cannot mistake
the loss for an initial pin that never happened.

## Merge authorization

`approval.required` moves broker merge authority behind an exact candidate tuple: candidate SHA,
base SHA, and policy revision. Manual evidence and approval repeat that tuple and identify their
actors. GitHub checks are accepted only from the live PR whose head matches the candidate; approval
re-reads the head/base, becomes effective only after a post-write OPEN observation, and the merge
command uses `--match-head-commit`.

That second observation is a causal boundary. An approval with `approvedAt` but no `confirmedAt`
cannot authorize a queue. If policy revision or evidence requirements change, an approving actor is
removed, a required check regresses, review requests changes, conflicts appear, or the PR head,
target branch, or base SHA changes, reconciliation records revocation before attempting to disable
auto-merge. While the PR remains open, it deletes approval only after the queue is observed disabled;
a terminal PR is reconciled separately. An unknown queue state is treated as possibly live for
revocation and never as proof of authorization.

Turning `publish.autoMerge` off also disables an observed or possibly live queue. Turning
`approval.required` off does not authorize a candidate assembled under required approval; that
candidate must be re-cut. Turning it on for an existing open PR first disables any possibly live
queue and adopts only an exact matching head/base as a new, unapproved candidate; an already-merged
untracked candidate is an invariant failure. `policyRevision` remains an operator-maintained
identifier rather than a digest of the complete configuration, so bump it whenever an
approval-policy meaning changes. The broker additionally compares current evidence requirements and
authorized actors, but the identifier does not cryptographically bind every validator or
configuration field.

This protects broker-mediated merges, not an administrator bypass in the forge UI. Repositories that
need the invariant to be organizationally mandatory must also protect the base branch, limit bypass
permission, require the configured checks, and restrict who can push broker integration branches.
An out-of-band merge is detected during reconciliation and recorded as an invariant violation, but
the broker cannot undo code that GitHub already merged.

For a merged PR whose reported base has advanced, the broker does not trust terminal forge state or
the final tree alone. It fetches the recorded target and accepts only a merge commit on that target
whose history is rooted at the approved base and whose tree equals the candidate: the candidate
itself as a fast-forward, a one-parent squash on the exact base, a two-parent merge with exact base
and candidate parents, or a linear rebase with the same ordered tree at every commit. A forged or
unrecognized topology fails the batch instead of releasing dependencies. A transient inability to
fetch the bound target remains retryable.

GitHub does not expose an atomic “match this base SHA” merge guard. Require branches to be up to date
when broker base binding must be preventative rather than only detected and proven during
reconciliation. Native merge-queue/`merge_group` verification is planned; the current broker does
not authorize the combined artifact created by a forge merge queue.

`batch complete` is a manual authority boundary, not equivalent to automatic reconciliation. It
checks a causally confirmed, non-revoked exact approval plus the current approval policy and actor
when approval policy applies, but it does not inspect the live PR or fetch the target. The operator
is asserting that the result really landed. Use it only after independently verifying a workflow
for which the forge cannot expose sufficient proof.

Authorized actor names are local policy identifiers, not cryptographic identities. Adapters should
derive them from an authenticated execution context and should not accept an untrusted worker's
free-form value. Stronger signed approval attestations are a compatible future extension.

The final provenance commit is immutable. Do not use a forge's update-branch button on an integration
branch. Even when the merged side is the real base, conflict resolution can introduce content that a
path-only check cannot distinguish from the base change. Close and re-cut stale work with `batch
refresh`, which reruns validation and produces a new signed manifest.

## Command construction

Configuration is trusted. `{taskId}`, `{filesFile}`, and the bounded legacy `{files}` placeholder are
shell-quoted, and structured metadata is also supplied as environment variables. Every validator
gets `MERGE_BROKER_FILES_FILE` pointing to an owner-readable UTF-8 JSON array and
`MERGE_BROKER_FILES_FILE_FORMAT=json`. Parse that JSON as data; do not source or evaluate it.
Validators default to `filesInput: "inline"`; if either the newline environment form or quoted
argument form exceeds 4 KiB, the broker fails closed before execution instead of silently exposing an
empty list. An explicit `filesInput: "json"` uses the JSON file, leaves `MERGE_BROKER_FILES` empty,
and rejects `{files}`. During local-ref intake, `MERGE_BROKER_SUBMISSION_ID` identifies the durable
record and `MERGE_BROKER_TASK_ID` is empty; callers must not infer a task or authorization from the
compatibility `MERGE_BROKER_BATCH_ID=submission:<submission-id>` value.

Validators run under a fixed interpreter — `/bin/sh` on macOS/Linux, non-profile PowerShell on
Windows, or `validation.shell` — and never under a login shell. Sourcing an operator's personal
profile would make an integration decision depend on whose machine assembled the batch, and would
let a compromised dotfile influence what the broker reports as validated. Quoting follows the
selected shell. Explicit `cmd.exe` policy remains subject to cmd's percent-expansion semantics, so
PowerShell or package scripts are preferred on Windows.

Validator timeouts terminate the spawned process tree: a process group on POSIX and `taskkill /t`
on Windows. Repository configuration remains trusted code and can deliberately start detached work
beyond that tree; do not run untrusted fork policy.

The MCP adapter enforces capability separation at server startup. The worker profile never registers
integration, publication, evidence, or approval tools and never returns stored lease tokens. The
operator profile is a control-plane credential: expose it only to a trusted client with the same
authority as the integration host.

Task and batch metadata must still be treated as untrusted display text by external dashboards. The
bundled GitHub publisher constructs command arguments without a shell and sends PR content through
stdin. It fingerprints the selected canonical Git push URL and, for pull requests, records the
host-qualified forge locator at assembly; the URL itself is not stored because it may embed
credentials. Publication fails if the named remote later points elsewhere, and every
repository-ambiguous `gh` operation receives an explicit `--repo` selector. Local paths are resolved
to their physical target so a symlink or junction cannot be redirected after validation.

These are locator guarantees, not a stable forge-object identity. Repository namespace transfers,
delete-and-recreate operations at the same URL, DNS replacement, and a compromised Git/forge host
remain trusted-infrastructure events; this release does not protect against replacement or
compromise inside that trusted infrastructure.

Batches written before `0.12.0` have no durable selected remote, URL fingerprint, publication mode,
or forge selector. The broker fails closed rather than deriving a replacement identity from mutable
current configuration. Drain prepared and published batches before upgrading. For an already
in-flight legacy batch, restore and inspect the original remote and PR; never edit state to fabricate
a target binding. Close and retry the work as a new batch when exact reconciliation is unavailable.

## Enforcement boundaries

`install-hooks` is a local convenience, not a security control: a pre-push hook is client-side and
any worker can bypass it. It exists to make the intended path the easy one and to catch mistakes
early.

`verify-provenance` is an enforceable boundary only when all of the following are true:

- the forge requires it on the protected base branch;
- protected-base policy sets `integration.provenance.requireSignature` and trusts an Ed25519 public
  key;
- the corresponding private key and integration push credentials are unavailable to untrusted
  workers; and
- the repository requires either broker-authoritative validation or its own authoritative CI suite.

Set `validation.authority` to `required-ci` only when that suite is a required pull-request check on
the protected base. The broker requires pull-request publication and signed provenance for this
mode, but it cannot prove that an arbitrary forge has made the named CI jobs mandatory. A check that
merely runs, but is not required, is not an authority and can be bypassed at merge time.

The verifier reads policy from the protected base, never the change being judged. A valid signature
authenticates the broker identity and the immutable manifest contents. It does not prove those
contents are good, and it cannot protect a key exposed to the same worker it is meant to constrain.
Legacy unsigned manifests receive structural verification only and must not be treated as proof that
the broker created them.

## Reporting vulnerabilities

Use [GitHub private vulnerability reporting](https://github.com/WeSpitfire/agent-merge-broker/security/advisories/new)
to report vulnerabilities to the maintainers. Do not open a public issue containing exploitable
details or credentials. If the private-reporting form is unavailable, contact the repository owner
through a private channel and disclose only enough publicly to arrange secure follow-up.
