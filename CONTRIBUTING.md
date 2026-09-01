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
```

Tests use temporary real Git repositories rather than mocks for transaction behavior. Add a regression fixture for changes to leases, receipts, cherry-picking, validation, batching, or lifecycle transitions.

## Pull requests

- Keep changes focused and explain any state or protocol compatibility impact.
- Update JSON schemas and documentation with persisted-format changes.
- Avoid agent-specific behavior in the core; expose it through an adapter boundary.
- Preserve the invariant that no branch is retained after failed validation.
- Include tests for both the successful transaction and its recovery path.

Run `npm run verify` before submitting. CI also runs `npm pack --dry-run` to verify the distributable package.

See [SUPPORT.md](SUPPORT.md) for usage questions and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the
project's participation expectations.

## Compatibility

Until version 1.0, breaking changes are allowed but must increment the relevant on-disk `version` field and include a migration or a clear reset procedure. Never silently reinterpret existing state.
