# Getting started

This guide takes a repository from “agents commit independently” to one broker-owned integration
path. Start locally, prove the workflow with a small task, then enable remote publication.

## Before you begin

You need:

- Node.js 20.12 or newer;
- Git 2.31 or newer with worktree support;
- a clean Git repository with a known base branch; and
- GitHub CLI (`gh`) only if the broker will create pull requests.

Windows, macOS, and Linux are supported. On Windows, make sure Git and Node are available to the
same user account that will run the broker or its Scheduled Task.

The broker treats checked-in configuration as executable policy. Validator commands run on the
integration host, so review `.merge-broker/config.json` like a CI workflow.

## 1. Try the isolated demo

The package contains a source-checkout demo. It creates a throwaway repository, so it never touches
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

## 2. Install and initialize

From the repository you want to coordinate:

```bash
npm install --save-dev agent-merge-broker
npx merge-broker init --base main --base-ref origin/main --remote origin
git add .merge-broker AGENTS.md
git commit -m 'Configure Agent Merge Broker'
npx merge-broker doctor
```

Initialization writes:

- `.merge-broker/config.json`, the shared repository policy;
- `.merge-broker/agent-instructions.md`, a worker-facing contract;
- a managed block in root `AGENTS.md`, which directs repository agents to that contract; and
- a private provenance key under Git's common runtime directory, never in the worktree.

Runtime state, receipts, tokens, audit events, temporary worktrees, and private keys are owner-only
inside Git's common directory. Every linked worktree shares that authority.

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
batch. `{files}` and `{taskId}` are shell-quoted, and the same values are available through
`MERGE_BROKER_FILES` and `MERGE_BROKER_TASK_ID`.

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
npx merge-broker validate
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

For a protected GitHub repository, a useful progression is:

1. Set `publish.mode` to `pull-request` and keep `autoMerge` false.
2. Install and authenticate `gh` on the integration host.
3. Require the repository's tests and provenance verification in branch protection.
4. Enable `autoMerge` only after `merge-broker doctor` reports the host ready.

See [Security](SECURITY.md) before delegating authoritative validation to required CI or enabling
exact-candidate approval.

## 5. Run one worker task

Claim the smallest accurate scope before editing:

```bash
npx merge-broker task claim TASK-123 \
  --holder codex/customer-search \
  --path 'src/customers/**' \
  --path 'test/customers/**'
```

The broker stores the lease token in its private runtime token vault. Heartbeat long work:

```bash
npx merge-broker task heartbeat TASK-123
```

Commit the focused change, then nominate the commits made after the assigned base:

```bash
git commit -am 'Add customer search'
npx merge-broker task candidate TASK-123 --since-base
```

The worker stops there. It does not push, rebase, merge, or open a pull request. Nominating again
before integration replaces that task's unread receipt.

## 6. Integrate as the authority

Inspect the deterministic next batch and perform a disposable dry run:

```bash
npx merge-broker plan
npx merge-broker integrate --dry-run
```

Retain the validated branch locally:

```bash
npx merge-broker integrate
```

Or publish according to the checked-in policy:

```bash
npx merge-broker integrate --publish
npx merge-broker batch sync <batch-id>
```

Only one prepared or published batch is allowed by default. This keeps each candidate born from the
current base instead of creating a queue of branches that immediately become stale.

## 7. Keep the broker running

For a maintained integration host, install the per-user background service:

```bash
npx merge-broker install-service
```

The service uses launchd on macOS, a systemd user unit on Linux, and a per-user Windows Scheduled
Task. Each writes to the log path reported by the command. The installer refuses to overwrite or
remove a service file without the broker ownership marker. Service installation also refuses while
`publish.mode` is `none`, because an unattended loop that cannot publish would only strand work.

You can also run one cycle from CI or a scheduler:

```bash
npx merge-broker serve --once --publish
```

## Common recipes

### Multiple linked worktrees

Initialize once from any checkout. Claims, tokens, state, and locks live in Git's common directory,
so every linked worktree sees the same scheduler. Pass `--worktree` only when the task's checkout is
not the command's current directory.

### Connect an MCP coding agent

Run `merge-broker-mcp -C <repository> --profile worker` as a stdio MCP server. Worker tools can
claim, validate, nominate, and revise their own leased work; lease tokens remain in the local vault
and are not returned in MCP messages. A trusted integration controller can run a separate
`--profile operator` server for planning, integration, publication, evidence, and approval. Do not
give the operator profile to ordinary implementation agents.

### Require exact verification and approval

Set `approval.required` to true, declare evidence and authorized actors, and use pull-request
publication. Evidence and approval bind candidate SHA, base SHA, and policy revision. A correction
creates a new candidate revision on the same pull request and invalidates the earlier evidence.

### Let required CI make the complete decision

Set `validation.authority` to `required-ci` only when the forge requires the complete CI suite on the
protected base. This mode requires pull-request publication and signed provenance. Keep local
focused checks fast; leave `validation.authoritative` empty because required CI is the authority.

### Recover after an interrupted process

First confirm no broker process is active, then inspect and recover:

```bash
npx merge-broker doctor
npx merge-broker recover
```

Recovery requeues abandoned integrations without spending their retry budget. It also reconciles a
candidate revision interrupted between recording its intent, moving the branch, and finalizing
state. An unexpected external branch head is never guessed at; the intent remains for inspection.

### Diagnose a task that will not move

```bash
npx merge-broker status
npx merge-broker plan
npx merge-broker events --limit 50
npx merge-broker doctor
```

Look for unmet dependencies, overlapping scopes, an outstanding batch, expired leases, failed
validators, an unreachable base, or missing forge authentication.

## Production checklist

- Commit `.merge-broker/config.json`, `.merge-broker/agent-instructions.md`, and `AGENTS.md`; review
  validator changes like CI changes.
- Configure at least one complete validation authority.
- Protect the base branch and require provenance verification for broker pull requests.
- Keep lease tokens, the provenance private key, and forge credentials off worker branches.
- Install the local pre-push guard if it helps workers follow the intended path.
- Install or schedule the integration loop; submission alone does not run a batch.
- Run `merge-broker doctor` after cloning, changing policy, rotating keys, or moving hosts.
- Use `merge-broker doctor --support-bundle` for a sanitized diagnostic attachment, and review it
  before sharing.
- Back up the provenance signing key and test the recovery procedure.

Continue with [Architecture](ARCHITECTURE.md) for invariants and [Protocol](PROTOCOL.md) when building
an adapter.
