# Contributing

Contributions are welcome once the public repository is available.

## Development

```bash
npm install
npm run verify
node dist/cli.js --help
```

Tests use temporary real Git repositories rather than mocks for transaction behavior. Add a regression fixture for changes to leases, receipts, cherry-picking, validation, batching, or lifecycle transitions.

## Pull requests

- Keep changes focused and explain any state or protocol compatibility impact.
- Update JSON schemas and documentation with persisted-format changes.
- Avoid agent-specific behavior in the core; expose it through an adapter boundary.
- Preserve the invariant that no branch is retained after failed validation.
- Include tests for both the successful transaction and its recovery path.

Run `npm run verify` before submitting. CI also runs `npm pack --dry-run` to verify the distributable package.

## Compatibility

Until version 1.0, breaking changes are allowed but must increment the relevant on-disk `version` field and include a migration or a clear reset procedure. Never silently reinterpret existing state.
