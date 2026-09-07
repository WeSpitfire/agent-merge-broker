# Contributing

Contributions are welcome. Small bug fixes, recovery fixtures, documentation improvements, and
adapter work are all useful.

Before starting a large protocol or persisted-state change, open a feature request so compatibility
and migration expectations can be agreed before implementation. Use a security advisory rather
than a public issue for exploitable findings.

## Development

```bash
npm install
npm run verify
node dist/cli.js --help
npm run example
npm run example:gate
npm run test:package
```

The source checkout requires Node.js 22+ and Git 2.46+ for the Gate example. Tests use temporary real
Git repositories for transaction behavior, portable GitHub CLI fixtures, and subprocess
termination/restart checks for recovery. Add a regression fixture for changes to leases, receipts,
cherry-picking, validation, batching, or lifecycle transitions.

## Pull requests

- Keep changes focused and explain any state or protocol compatibility impact.
- Update JSON schemas and documentation with persisted-format changes.
- Avoid agent-specific behavior in the core; expose it through an adapter boundary.
- Preserve the invariant that failed Coordinate validation cannot retain a publication branch.
  Gate deliberately retains rejected artifacts for evidence and operator-controlled retirement.
- Include tests for both the successful transaction and its recovery path.

Run `npm run verify` before submitting. CI repeats verification and both examples on Linux, macOS,
and Windows with Node.js 22, 24, and 26, then installs and exercises the actual npm tarball. Releases
publish the tested tarball only after the complete matrix succeeds.

For schema changes, run `npm run build` and
`node scripts/update-schema-snapshots.mjs --write`. The generator adds new fingerprint snapshots and
updates the alias manifest; it refuses to overwrite changed immutable content. Commit new snapshots
alongside the root alias change, and retain existing snapshots for consumers. `--check` is read-only
and runs in CI. See [Protocol](docs/PROTOCOL.md) for identity and compatibility semantics.

See [SUPPORT.md](SUPPORT.md) for usage questions and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the
project's participation expectations.

## Compatibility

Until version 1.0, breaking changes are allowed but must increment the relevant on-disk `version` field and include a migration or a clear reset procedure. Never silently reinterpret existing state.
