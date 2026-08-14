# Security model

## Trust boundary

Agent Merge Broker is intended for trusted repositories and trusted integration hosts. The checked-in configuration is executable policy: validator commands run through the host shell inside an integration worktree. Reviewing a configuration change is as important as reviewing a CI workflow change.

Do not run the broker automatically on untrusted fork configuration. A safe forge integration should load policy from the protected base branch, not from an incoming change.

## Credentials

- Lease tokens contain 192 bits of randomness and only SHA-256 digests are persisted.
- Tokens should be supplied through `MERGE_BROKER_TOKEN` or a process-level secret channel.
- Do not place tokens in commits, task titles, validator commands, or logs.
- Git and GitHub credentials remain owned by the host's normal credential helpers.
- Validator stdout and stderr are retained locally and may contain accidental secrets. Output is capped, not redacted.

Runtime state is stored inside Git's common directory and inherits its filesystem permissions. Anyone who can modify the repository's Git directory can modify broker state or audit records. The audit stream is append-only by convention, not cryptographically tamper-evident.

## Git safety

The broker does not force-push, reset the user's base worktree, merge into the base branch, or delete source branches. It creates uniquely named integration branches and temporary worktrees under its own state directory.

Failed integration worktrees are removed by default. Enabling `keepFailedWorktrees` can retain source content, generated artifacts, and secrets written by validators; operators must clean these worktrees deliberately after diagnosis.

Commit receipts are immutable IDs, but their objects can disappear after aggressive source-repository garbage collection if no ref retains them. Integrate or otherwise retain submitted commits before pruning unreachable branches.

## Command construction

Configuration is trusted. `{files}` and `{taskId}` placeholders are shell-quoted, and structured metadata is also supplied as environment variables. Prefer environment variables when composing complex commands.

Task and batch metadata must still be treated as untrusted display text by external dashboards. The bundled GitHub publisher constructs command arguments without a shell and sends PR content through stdin.

## Reporting vulnerabilities

Before a public security address is established, report vulnerabilities privately to the repository owner. Do not open a public issue containing exploitable details or credentials.
