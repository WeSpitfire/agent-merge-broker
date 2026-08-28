# Security model

## Trust boundary

Agent Merge Broker is intended for trusted repositories and trusted integration hosts. The checked-in configuration is executable policy: validator commands run through the host shell inside an integration worktree. Reviewing a configuration change is as important as reviewing a CI workflow change.

Do not run the broker automatically on untrusted fork configuration. A safe forge integration should load policy from the protected base branch, not from an incoming change.

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
- Validator stdout and stderr are retained locally and may contain accidental secrets. Output is capped, not redacted.
- New repositories receive an Ed25519 provenance private key under Git's common runtime directory,
  mode 0600. Only the public key is committed. `MERGE_BROKER_SIGNING_KEY` and
  `MERGE_BROKER_SIGNING_KEY_FILE` support supervised hosts and are removed from validator
  environments. Back up the private key as an operational credential; losing it blocks signed
  integration until the public-key policy is deliberately rotated.
- Rotation retains mode-0600 private keys by public-key ID. This makes a crash between local key
  rotation and committing new public-key policy recoverable and lets in-flight protected-base policy
  select its matching key. Retire old keys deliberately only after no supported base trusts them.

Runtime state is stored inside Git's common directory and inherits its filesystem permissions. Anyone who can modify the repository's Git directory can modify broker state or audit records. The audit stream is append-only by convention, not cryptographically tamper-evident.

## Git safety

The broker does not force-push, reset the user's base worktree, merge into the base branch, or delete source branches. It creates uniquely named integration branches and temporary worktrees under its own state directory.

Failed integration worktrees are removed by default. Enabling `keepFailedWorktrees` can retain source content, generated artifacts, and secrets written by validators; operators must clean these worktrees deliberately after diagnosis.

Commit receipts are immutable IDs, but their objects can disappear after aggressive source-repository garbage collection if no ref retains them. Integrate or otherwise retain submitted commits before pruning unreachable branches.

The final provenance commit is immutable. Do not use a forge's update-branch button on an integration
branch. Even when the merged side is the real base, conflict resolution can introduce content that a
path-only check cannot distinguish from the base change. Close and re-cut stale work with `batch
refresh`, which reruns validation and produces a new signed manifest.

## Command construction

Configuration is trusted. `{files}` and `{taskId}` placeholders are shell-quoted, and structured metadata is also supplied as environment variables. Prefer environment variables when composing complex commands.

Validators run under a fixed interpreter — `/bin/sh` by default, or `validation.shell` — and never under a login shell. Sourcing an operator's personal profile would make an integration decision depend on whose machine assembled the batch, and would let a compromised dotfile influence what the broker reports as validated. Quoting follows the configured shell; POSIX shells are the supported and tested surface.

Task and batch metadata must still be treated as untrusted display text by external dashboards. The bundled GitHub publisher constructs command arguments without a shell and sends PR content through stdin.

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
