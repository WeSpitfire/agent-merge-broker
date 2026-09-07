# Getting started

This guide takes a repository from “agents commit independently” to one broker-owned integration
path. Start locally, prove the Coordinate workflow with a small task, then enable remote
publication. A separate section covers validation-only intake for a trusted Git ref assembled
outside that workflow.

This guide covers version `0.15.0`. The documentation tracks source; check npm's version history to
confirm published availability. The companion core package is published separately; check its
[npm version history](https://www.npmjs.com/package/agent-merge-broker-core?activeTab=versions) too.

## Before you begin

You need:

- Node.js 22 or newer;
- Git 2.31 or newer with worktree support;
- a clean Git repository with a known base branch; and
- GitHub CLI (`gh`) only if the broker will create pull requests.

Windows, macOS, and Linux are supported. On Windows, make sure Git and Node are available to the
same user account that will run the broker or its Scheduled Task.

See [Compatibility and current limits](COMPATIBILITY.md) for the tested matrix, the precise Windows
service model, release availability, and integrations that are not built in.

The broker treats checked-in configuration as executable policy. Validator commands run on the
integration host, so review `.merge-broker/config.json` like a CI workflow.

## 1. Try the isolated demo

The source repository contains a demo. It creates a throwaway repository, so it never touches
your current project or needs forge credentials:

```bash
git clone https://github.com/WeSpitfire/agent-merge-broker.git
cd agent-merge-broker
npm install
npm run build
npm run example
```

You should see two non-overlapping workers accepted, an overlapping claim refused, and four commits
assembled into one validated branch.

For the trusted local-ref route, run `npm run example:gate` after building. This example
creates a local bare remote and two candidate branches, shows a successful and rejected result,
verifies detached signed evidence outside the repository, and previews archival. Both examples
remove their temporary repositories unless `KEEP=1` is set.

## 2. Install and initialize

Install once outside your projects, then initialize each repository that needs coordination:

```bash
npm install --global agent-merge-broker@0.15.0
# From the repository you want to coordinate:
merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker AGENTS.md
git commit -m 'Configure Agent Merge Broker'
merge-broker doctor
```

The global install keeps the broker's dependencies out of each project's `node_modules` and
manifest; it still uses space in npm's global installation. Use the same reviewed version across
your team. For global-install permission errors, use npm's documented
[user-owned installation options](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).

For occasional commands without a global install, request the package and executable explicitly:

```bash
npm exec --yes --package=agent-merge-broker@0.15.0 -- merge-broker doctor
```

[npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/) uses npm's cache when the requested
package is not installed locally; it does not add a dependency to your manifest. Cached copies
still use disk space, and an exact top-level version does not replace a dependency lockfile.
Avoid an unqualified `npx merge-broker` in an unconfigured project: the executable name is not
the npm package name.

For a repository-owned version and reproducible CI dependencies, install locally instead and commit
both the manifest and lockfile:

```bash
npm install --save-dev --save-exact agent-merge-broker@0.15.0
npm exec --no -- merge-broker doctor
```

Run `npm ci` in CI. The remaining examples assume the global `merge-broker` command; with a local
installation, invoke it through a package script or prefix commands with `npm exec --no --`.
Use a stable global or project-local installation for background services, whose launchers record
the installed CLI's absolute path; do not anchor a service to an evictable npm-exec cache entry.

### Choose the package — 0.15.0

Version `0.15.0` adds `agent-merge-broker-core`: the Coordinate/Gate CLI and core Node API without
the MCP server, SDK dependency, or `createMcpServer` export. The existing `agent-merge-broker`
package keeps MCP support and its current API. Both share the `merge-broker`/`amb` commands, so
choose one package per global or local installation, not both. Confirm the desired core version
in npm's version history before installing it; the full package remains an independent option.

Both tarballs keep runtime code, TypeScript declarations, schemas, initialization
templates, README, and license. Debug maps are omitted; use a source-checkout build for debugging.
Long guides/examples stay in the source repository instead of every installed copy. This changes
distribution size, not broker validation or recovery.

### What initialization adds

Initialization writes:

- `.merge-broker/config.json`, the shared repository policy;
- `.merge-broker/agent-instructions.md`, a worker-facing contract;
- a managed block in root `AGENTS.md`, which directs repository agents to that contract; and
- a private provenance key under Git's common runtime directory, never in the worktree.

Runtime state, receipts, trusted local-ref submission manifests, tokens, audit events, temporary
worktrees, and private keys are owner-only inside Git's common directory. Every linked worktree
shares that authority.

Re-running the command is safe: it preserves owner policy and surrounding `AGENTS.md` instructions,
and repairs only missing managed files or a legacy unsigned default. Pass `--no-detect` or
`--no-agent-contract` when a higher-level installer owns that output.

## 3. Review the detected validation gate

Initialization detects existing package manifests and selects declared `verify`, `ci`, or `check`
scripts as complete gates. When none exists, it composes the declared `lint`, `typecheck`, `test`,
and `build` scripts. It also detects declared SwiftPM, Go, Rust, and Python checks, including nested
packages through repository-relative `workingDirectory` values. It does not invent missing scripts,
Xcode schemes, simulator destinations, or repository policy; those are reported as unresolved
items in the command output.

Review the result and make sure it answers the same question your protected branch asks. For
example:

```json
{
  "validation": {
    "authority": "broker",
    "focused": [
      {
        "name": "changed TypeScript",
        "paths": ["src/**", "test/**"],
        "command": "npm test -- {files}",
        "timeoutSeconds": 300
      }
    ],
    "authoritative": [
      {
        "name": "complete suite",
        "command": "npm test",
        "timeoutSeconds": 900
      }
    ]
  }
}
```

Focused validators run after each task is applied. Authoritative validators run against the complete
batch. `{taskId}` is shell-quoted and is also available through `MERGE_BROKER_TASK_ID`. Every
validator receives `MERGE_BROKER_FILES_FILE`, which points to an owner-readable UTF-8 JSON array of
paths, and `MERGE_BROKER_FILES_FILE_FORMAT=json`; `{filesFile}` is the shell-quoted form of that
path.

Validators default to `filesInput: "inline"`. That mode supplies the newline-separated
`MERGE_BROKER_FILES` and shell-quoted `{files}` only when both representations fit within 4 KiB; if
either is larger, the validator fails with `VALIDATION_FAILED` before it starts, even if its command
does not use `{files}`. For potentially large path sets, set `"filesInput": "json"` and have the
validator parse the JSON array named by `MERGE_BROKER_FILES_FILE` or `{filesFile}`. JSON mode leaves
`MERGE_BROKER_FILES` empty and rejects commands that still contain `{files}`.

Trusted local-ref intake has no task or batch. It runs every matching focused validator once over
the complete derived path set, then runs the authoritative validators. In that path
`MERGE_BROKER_SUBMISSION_ID` identifies the durable submission, `MERGE_BROKER_TASK_ID` is empty, and
`MERGE_BROKER_BATCH_ID` is the compatibility label `submission:<submission-id>`, not a batch record.

After each focused or authoritative validator set returns successfully, the broker verifies that
the candidate `HEAD` did not move and that the worktree is clean. A validator that changes either
condition fails the transaction instead of causing the broker to retain bytes different from those
it reported as tested. Validator configuration is still trusted executable policy; this check does
not sandbox commands or prevent side effects outside the integration worktree.

`{validatorCacheDir}` expands to a shell-quoted, validator-specific directory within the shared
transaction cache. Auto-detected SwiftPM checks use it without relying on platform-specific
environment-variable syntax.

Commands use fixed non-login `/bin/sh` on macOS/Linux and non-profile PowerShell on Windows by
default. Prefer package-manager commands and repository scripts when one policy must run unchanged
on every platform.

Every integration transaction also receives a unique `MERGE_BROKER_CACHE_DIR`, shared across its
focused and authoritative stages and removed afterward. `executionArchitecture: "native"` runs a
validator under the Mac's hardware architecture when Node is running through Rosetta. Auto-detected
SwiftPM validators use both features, keeping Swift build artifacts architecture-isolated while
reusing them inside one transaction.

Run the configured checks against current work before submitting anything:

```bash
merge-broker validate
```

## 4. Choose publication deliberately

Start with local branches:

```json
{
  "publish": {
    "mode": "none",
    "draft": false,
    "autoMerge": false,
    "mergeMethod": "squash",
    "labels": [],
    "titleTemplate": "Integration batch {batchId}"
  }
}
```

Use `branch` to push the broker branch without opening a pull request. Use `pull-request` for GitHub
publication. Auto-merge is opt-in and every merge request is bound to the exact candidate head SHA.
The broker derives the GitHub repository from a hosted Git remote and records it with the batch,
together with the selected remote and a SHA-256 fingerprint of its canonical push URL. The URL
itself is not persisted because it may contain credentials. If `remote` points to a local mirror or
proxy, add `"repository": "owner/repository"` (or `"host/owner/repository"` for GitHub Enterprise)
inside `publish`; it never falls back to `gh`'s ambient default repository.

Those target values bind the batch, not the current configuration. Changing the remote URL, base
target, explicit repository, or `gh` default later cannot redirect an existing batch. The current
`publish.mode` can still choose whether a prepared candidate is retained, pushed, or opened as a
PR, but only when the target binding required for that action is already present. Otherwise restore
the recorded target or deliberately re-cut the batch.

For a protected GitHub repository, a useful progression is:

1. Set `publish.mode` to `pull-request` and keep `autoMerge` false.
2. Install and authenticate `gh` on the integration host.
3. Require the repository's tests and provenance verification in branch protection, and require the
   branch to be up to date before merging. Native merge-queue/`merge_group` verification is planned,
   not part of the current topology proof.
4. Enable `autoMerge` only after `merge-broker doctor` reports the host ready.

See [Security](SECURITY.md) before delegating authoritative validation to required CI or enabling
exact-candidate approval.

## 5. Run one worker task

Claim the smallest accurate scope before editing:

```bash
merge-broker task claim TASK-123 \
  --holder codex/customer-search \
  --path 'src/customers/**' \
  --path 'test/customers/**'
```

The broker stores the lease token in its private runtime token vault. Heartbeat long work:

```bash
merge-broker task heartbeat TASK-123
```

Commit the focused change, then nominate the commits made after the assigned base:

```bash
git commit -am 'Add customer search'
merge-broker task candidate TASK-123 --since-base
```

The worker stops there. It does not push, rebase, merge, or open a pull request. Nominating again
before integration replaces that task's unread receipt.

## 6. Integrate as the authority

Inspect the deterministic next batch and perform a disposable dry run:

```bash
merge-broker plan
merge-broker integrate --dry-run
```

Retain the validated branch locally:

```bash
merge-broker integrate
```

Or publish according to the checked-in policy:

```bash
merge-broker integrate --publish
merge-broker batch sync <batch-id>
```

Only one prepared or published batch is allowed by default. This keeps each candidate born from the
current base instead of creating a queue of branches that immediately become stale.

For a PR batch, `batch sync` does more than poll for terminal state. It checks the live head, target
branch, base SHA, queue state, reviews, conflicts, and configured checks. After a merge, it proves
the accepted fast-forward, squash, two-parent merge, or linear-rebase history when the forge reports
that the base advanced; an exact unchanged head/base/target binding is accepted directly. For
branch-only publication, it instead fetches the bound target and requires the exact batch head to be
an ancestor.

## 7. Validate a trusted local Git candidate

Gate intake, introduced in `0.13.0`, is validation-only. Use it when another trusted process has
already assembled the candidate in this
repository and you want broker policy to validate its exact bytes without pretending that it used
task leases.

First, from a reviewed checkout of the protected target, commit `.merge-broker/config.json` and
register that target outside the worktree:

```bash
merge-broker candidate authority setup
merge-broker candidate authority show
merge-broker candidate adopt --ref refs/heads/external-candidate
merge-broker candidate list
merge-broker candidate show <submission-id>
```

The setup record lives at `<git-common-dir>/merge-broker-gate-authority.json`. It contains a digest,
the target/ref/refresh/state locator, and a fingerprint of the canonical Git fetch URL when one is
available; it never stores the URL or credentials. Identical setup is idempotent. If any locator or
fetch target intentionally changes, review it first and run `candidate authority setup --replace`.
Replacement is serialized against adoption and recovery and is never an automatic repair.

If `integration.refreshBase` is true and the configured ref denotes the base branch (`main`,
`origin/main`, or `refs/remotes/origin/main`), setup requires a configured fetch URL and binds it. It
will not silently validate against a stale local branch. Set `integration.refreshBase` to false for an
intentionally offline/local target.

Before adopting, make sure:

- Git 2.46 or newer is installed;
- the ref and all of its Git objects are already available in this repository;
- ambient Git repository/index/object/history selectors and Git configuration-injection variables are
  unset, including Git executable/SSH/proxy transport selectors;
- the repository owns its recursively inspectable object store (no alternates file, redirected or
  special entry, legacy grafts, or more than 500,000 entries);
- `.merge-broker/config.json` is committed on the configured base and its blob is no larger than
  Gate's 1 MiB safety ceiling;
- the mutable checkout and that protected-base config both match the registered base ref, branch,
  remote, refresh setting, and state directory;
- `validation.authority` is `broker` (`required-ci` needs publication, which this slice does not do),
  and its validators do not declare Git repository/index/object/history or configuration-injection
  keys in `env`;
- the candidate is a nonempty, merge-free linear descendant of that base; and
- its commit count does not exceed the smaller of `scheduling.maxCommits` and Gate's 1,000-commit
  hard ceiling.

The command has no `--base`, `--file`, `--publish`, or `--force` option. The registration—not the
candidate or mutable checkout—selects the base. A refreshed base uses the registered fetch URL, not a
separate `pushurl`. The broker reads and validates policy from that exact base commit, derives paths
and byte-exact raw parent history without replacement refs or grafts, recomputes retained
commit/tree/blob IDs, pins the resolved artifact under a
broker-owned ref, and materializes tracked files directly from raw blobs. Checkout hooks,
clean/smudge/process filters, `ident`, EOL conversion, and submodule helpers do not run. After each
validator, Gate proves the worktree's `.git` gitfile, linked-worktree registry entry, backlink,
common repository, and physical root before reading `HEAD` or the index. It then checks tracked
bytes, modes, links, and untracked files against the retained tree. Any nonignored untracked path is
rejected, and its diagnostic listing is bounded at 4 KiB. Cleanup repairs a changed marker only when
its exact registry backlink is independently provable. Moving or deleting the producer's source ref
afterward does not change the recorded artifact.

The broker records that the retained ref was established before starting validators. If it later
finds that established ref missing, it journals the compromise before repairing it; a passing result
is discarded even when the process stops after repair and recovery resumes later.

When the final artifact identity remains provable, the result is a standalone `SubmissionRecord`
with status `validated`, `rejected`, or `failed`. Validator rejection and candidate mutation return
the durable diagnostic record and make the CLI exit nonzero. If the final object/ref identity cannot
be reproduced, the record instead stays `validating` and recovery warns until the exact identity is
restored. A validated record is evidence only: it is not a task, batch, approval candidate,
published branch, pull request, or authorization to merge. Version `0.14.2` can separately
export its validation evidence as a detached signed statement. Use Coordinate mode for the complete
approval and publication lifecycle today.

### Inspect and retire Gate records — 0.14.2

`doctor --gate` checks local Gate prerequisites and the registered protected policy without fetching
or running validators. A failed readiness check exits nonzero. Inspect a result and its bounded,
locally captured validator output with:

```bash
merge-broker doctor --gate
merge-broker candidate show <submission-id> --logs
```

Logs may contain repository data or accidental secrets; review them before sharing. `metrics`
includes submission counts, including archived records. To deliberately stop an unrecoverable
submission, record an operator reason:

```bash
merge-broker candidate abandon <submission-id> --reason 'Superseded by a corrected candidate'
```

Abandonment becomes durable before disposable-worktree cleanup. It preserves the artifact identity,
earlier validator results, reason, and retained ref. If cleanup cannot complete, `recover` retries
cleanup without running those validators again. Abandonment does not claim validation success or
grant permission to delete an unfamiliar worktree.

Preview retirement before applying it:

```bash
merge-broker candidate archive <submission-id>
merge-broker candidate archive <submission-id> --apply
merge-broker candidate archive --older-than 30
merge-broker candidate list --all
merge-broker candidate show <archived-submission-id>
```

The default is a dry run. Without IDs, records must be at least 30 days old unless `--older-than`
changes the threshold; explicit IDs default to no minimum age. Only terminal records without
pending cleanup are eligible. Applied archival writes a durable historical record and retires it
from active state while preserving its Git ref. Add `--release-artifacts` to the preview and apply
commands only when the exact broker-owned refs should also be released. That option deletes those
refs using their expected commit IDs; it never deletes Git objects or runs garbage collection.
Other refs may continue to retain the objects, and later Git maintenance controls their lifetime.
Choose retention before applying: the current archive command does not reopen archived records to
release their refs later.

### Export and verify Gate evidence — 0.14.2

Sign an eligible active result before archiving it:

```bash
merge-broker candidate attest <submission-id> --output candidate.dsse.json
```

The output file must not exist. Without `--output`, the envelope is printed as JSON. The broker
rechecks saved artifact and policy identities and uses the existing local private key matching the
public key in the protected-base configuration; it does not generate a replacement key or accept a
caller-supplied statement. The candidate commit remains unchanged. Successful signed evidence
requires at least one authoritative validator result and no failing result. An older or empty-policy
`validated` record is not enough: commit a meaningful authoritative policy on the reviewed base and
adopt a candidate against it again. `doctor --gate` also treats missing authoritative validators as
not ready; ordinary adoption retains its existing empty-policy compatibility behavior.

An offline consumer independently selects the trusted public PEM and expected identities:

```bash
merge-broker candidate verify-attestation candidate.dsse.json \
  --public-key trusted-public.pem \
  --candidate <commit-sha> --tree <tree-sha> --base <base-sha> \
  --policy-digest <sha256> --authority-digest <sha256>
```

Optional `--config-blob <sha>` and `--evaluator <version>` also constrain those policy fields.
Verification needs no repository, configuration file, forge, or network. It verifies Ed25519 DSSE
signatures and a versioned in-toto statement, then checks every expected identity. A signed rejection
or failure returns `verified: true`, `validationPassed: false`, and exit code 1. A passing validation
returns exit code 0. `mergeAuthorized` is always false; the signature proves the signer's validation
claim, not a right to publish or merge. Never derive all trust inputs from the untrusted envelope.

## 8. Keep the broker running

For a maintained integration host, install the per-user background service:

```bash
merge-broker install-service
```

The service uses launchd on macOS, a systemd user unit on Linux, and a per-user Windows Scheduled
Task. Each writes to the log path reported by the command. The installer refuses to overwrite or
remove a service file without the broker ownership marker. Service installation also refuses while
`publish.mode` is `none`, because an unattended loop that cannot publish would only strand work.

Each `serve --publish` cycle first reconciles published PRs, then resumes prepared publication,
uncertain auto-merge hand-offs, approval revocation, or stale-base refresh. It cuts new work only
after no prepared or published batch remains. A forge outage therefore leaves an explicit retryable
state and a log event rather than allowing a second PR or a later batch to pass it.

The Windows task uses the installing user's interactive token. It starts immediately and at that
user's logon, but it is not a boot-time machine service and will not run before the user logs on.
Node and the broker CLI are recorded by absolute path; Git, GitHub CLI, and validator commands must
remain available to that user's environment. Run `merge-broker doctor` as the service user after
installing or moving the repository.

You can also run one cycle from CI or a scheduler:

```bash
merge-broker serve --once --publish
```

## Common recipes

### Multiple linked worktrees

Initialize once from any checkout. Claims, tokens, state, and locks live in Git's common directory,
so every linked worktree sees the same scheduler. Pass `--worktree` only when the task's checkout is
not the command's current directory.

### Connect an MCP coding agent

MCP requires the full `agent-merge-broker` package, not the companion core package. With the global
installation above, configure `merge-broker-mcp` as a stdio server rooted at the repository:

```json
{
  "mcpServers": {
    "merge-broker": {
      "command": "merge-broker-mcp",
      "args": ["-C", "/absolute/repository/path", "--profile", "worker"]
    }
  }
}
```

Ensure the MCP host can find the global executable. If it cannot launch npm's command shims,
configure `node` with the installed package's absolute `dist/mcp-cli.js` path as its first argument
(use `npm root --global` to locate global packages). Worker tools can
inspect status, claim, heartbeat, extend, validate, nominate, release, reopen, and revise their own
leased work. Lease tokens remain in the local vault and are not returned in MCP messages.

A trusted integration controller can run a separate `--profile operator` server. It adds planning,
integration, publication, synchronization, refresh, evidence, approval, retry/cancel, audit,
metrics, and recovery tools. Do not give the operator profile to ordinary implementation agents;
it has the same control-plane authority as the integration host.

### Require exact verification and approval

Set `approval.required` to true, declare evidence and authorized actors, and use pull-request
publication. Evidence and approval bind candidate SHA, base SHA, and policy revision. A correction
creates a new candidate revision on the same pull request and invalidates the earlier evidence.

Approval is causal rather than a single local write. The broker records it, then observes that the
same PR is still open at the exact candidate head, target branch, and base SHA before marking it
confirmed. Policy, evidence, actor, review, conflict, head, or base drift after confirmation starts a
durable revocation and disables a possibly live auto-merge queue before deleting approval locally.

### Let required CI make the complete decision

Set `validation.authority` to `required-ci` only when the forge requires the complete CI suite on the
protected base. This mode requires pull-request publication and signed provenance. Keep local
focused checks fast; leave `validation.authoritative` empty because required CI is the authority.

### Recover after an interrupted process

Start by inspecting the recorded state and locks:

```bash
merge-broker doctor
merge-broker status
```

Use the recovery command that owns the interrupted transition:

| Observed condition | Resume command | Result |
| --- | --- | --- |
| Batch left `running`; tasks left `integrating` | `merge-broker recover` | After acquiring the integration lock, replay-safely removes broker-owned artifacts, marks the abandoned batch failed, and requeues tasks without spending an attempt; changed or checked-out refs are retained with a warning |
| Candidate revision stopped around its branch update | `merge-broker recover` | Finalizes an exact new head, rolls back an exact old head, or retains an unexpected third head for inspection |
| Gate submission left `received` or `validating` | `merge-broker recover` | Re-pins the recorded immutable artifact if needed, rechecks its base, tree, history, paths, and protected-base policy identity, then reruns validation to a terminal record or reports a warning |
| Gate abandonment left a disposable worktree | `merge-broker recover` | Retries cleanup under the saved physical identity without rerunning validators or releasing the retained ref |
| Gate record has an archive intent | `merge-broker recover` | Completes the recorded archive and optional exact-ref release, preserving the historical record |
| Batch is `prepared`, or push/PR creation failed | `merge-broker batch publish <id>` or `serve --publish` | Pushes the recorded SHA and rediscovers an existing PR across all PR states before creating one |
| `autoMergePending` or an auto-merge warning is visible | `merge-broker batch sync <id>`, then `batch publish <id>` if an authorized enable still needs retrying; `serve --publish` automates both | Reconciles the possibly live queue before safely completing or retrying the exact-head hand-off |
| Change request or automatic approval revocation was interrupted | `merge-broker batch sync <id>` | Finishes disabling any possibly live queue before finalizing local revocation |
| Base moved, or refresh was interrupted after disabling/closing the PR | `merge-broker batch refresh <id> --publish` or `serve --publish` | Distinguishes the broker's marked close from reviewer rejection, then re-cuts and revalidates on the recorded target |
| PR was closed by a reviewer | `merge-broker batch sync <id>` | Closes the batch and marks its tasks failed; reclaim and correct them, or use `task retry` only after deciding the unchanged receipts are safe |

`recover` is deliberately limited to interrupted local integration, candidate-revision branch
movement, retained local-ref validation, and Gate abandonment/archival operations.
It does not guess the result of a forge call.
Publication, auto-merge, revocation, and refresh recovery use `batch publish`, `batch sync`, `batch
refresh`, or the publishing service so the real remote state can be observed.

If a lock remains, first confirm that no broker process can still progress. Same-host locks whose
process is gone are reclaimed automatically after a short grace period. Foreign, unreadable, or live
locks never expire by age; inspect them with `doctor` or `unlock` and use `unlock state`,
`unlock integration`, `unlock gate-authority`, or `unlock batch:<batch-id> --force` only after
independently proving the owner is gone. The Gate authority lock lives directly in Git's common
directory, and these commands inspect/release that exact fixed-root path rather than the configurable
state directory.

### Upgrade with an in-flight pre-0.12 batch

Drain every `prepared` or `published` batch before upgrading from a release older than `0.12.0`.
Older records do not contain the selected remote, push-URL fingerprint, host-qualified forge
repository, or publication mode, and v0.12 cannot safely reconstruct those values from configuration
that may have changed.

If an old PR is already in flight after upgrade, restore and inspect its original remote and PR. Do
not edit `state.json` to manufacture a target binding. `batch sync` can reconcile an exact terminal
PR when enough proof remains. Otherwise close the old PR at the forge, run `batch sync` so its tasks
become failed, then deliberately `task retry` them to create a newly target-bound batch. For an old
branch-only or prepared batch, independently land and verify it before using the explicit
`batch complete` assertion, or finish it with the release that created it before allowing v0.12 to
mutate the state.

A batch created by v0.12 with `publish.mode` set to `none` carries a recorded no-publication marker.
If it could not record the remote binding and publication is enabled later, `batch refresh <id>
--publish` can therefore bind and re-cut it safely. If it already recorded every binding needed by
the newly selected mode, `batch publish <id>` can publish the unchanged validated candidate instead.

### Diagnose a task that will not move

```bash
merge-broker status
merge-broker plan
merge-broker events --limit 50
merge-broker doctor
```

Look for unmet dependencies, overlapping scopes, an outstanding prepared/published batch, pending
publication or auto-merge, a refresh/revocation intent, expired leases, failed validators, a changed
remote target, an unreachable base, or missing forge authentication.

To attach diagnostics to a support request:

```bash
merge-broker doctor --support-bundle > merge-broker-support.json
```

The bundle includes platform information, doctor output, and the latest 50 audit events. Repository
and home paths, URLs, and secret-bearing fields are redacted, but validator output and project
metadata can still be sensitive. Review the file before sharing it.

### Inspect and compact storage

Version `0.15.0` adds these commands:

```bash
merge-broker storage show
merge-broker storage compact --older-than 30          # preview only
merge-broker storage compact --older-than 30 --apply  # lossless compression
```

`storage show` reads filesystem metadata, not token, key, evidence, or worktree file contents. It
groups logical file sizes for broker-managed runtime and provenance storage. Totals are not allocated
disk blocks, Git object-database size, or globally installed npm dependencies. Symlinks are not
followed, scans are bounded, and skipped entries make totals partial. Paths can still be sensitive;
review a report before sharing it.

`storage compact` defaults to a 30-day minimum modification age and only considers closed rotated
audit `.jsonl` segments. Without `--apply`, it reports eligibility without compressing files.
Applying it writes a verified gzip copy before removing the original and skips segments where
compression would not save space. Work is bounded per pass; review skipped entries before repeating.
`events` reads compressed rotations as well as ordinary audit segments.

Upgrade every broker that reads this shared audit history before applying compaction. Older
released versions, including `0.14.2`, only read uncompressed `.jsonl` rotations. Leave originals
uncompressed if continued access from those versions is required.

This is lossless compression, not age-based evidence deletion. It does not remove active audit logs,
state, receipts, candidate records, signing keys, worktrees, provenance, or retained Git refs, and it
does not run Git garbage collection. Existing Gate archival and its explicit ref-retention choice
remain separate. Back up important evidence and private keys independently.

## Production checklist

- Commit `.merge-broker/config.json`, `.merge-broker/agent-instructions.md`, and `AGENTS.md`; review
  validator changes like CI changes.
- Configure at least one complete validation authority.
- Protect the base branch, require provenance verification for broker pull requests, and require
  branches to be current before merge. Do not route broker candidates through a native merge queue
  until `merge_group` verification is implemented.
- Keep lease tokens, the provenance private key, and forge credentials off worker branches.
- Keep the configured publication remote and mode stable while batches are in flight. A target
  mismatch fails closed; a mode change can select a different next publication step but still cannot
  retarget the batch.
- Install the local pre-push guard if it helps workers follow the intended path.
- Install or schedule the integration loop; submission alone does not run a batch.
- For Gate intake, register authority from a reviewed protected checkout before first
  adoption, and use `--replace` only for an intentional target change. Treat `candidate adopt` as
  trusted-host validation only; do not invoke it automatically for untrusted fork refs, and do not
  treat `validated` as permission to publish or merge.
- Run `merge-broker doctor` after cloning, changing policy, rotating keys, or moving hosts.
- Use `merge-broker doctor --support-bundle` for a sanitized diagnostic attachment, and review it
  before sharing.
- Back up the provenance signing key and test the recovery procedure.
- Drain prepared and published work before a pre-v0.12 upgrade.

Continue with [Compatibility and current limits](COMPATIBILITY.md) for the supported boundary,
[Architecture](ARCHITECTURE.md) for invariants, and [Protocol](PROTOCOL.md) when building an adapter.
