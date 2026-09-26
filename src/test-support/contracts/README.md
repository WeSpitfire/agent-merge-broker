# Reviewed public contract baselines

These fixtures capture the current pre-1.0 source contract. They do not certify a released npm
artifact or claim that the 1.0 release checklist is complete. Tests compare current behavior with
the checked-in bytes; tests never regenerate their expected results.

- `public-api.txt` records root export lists and the emitted declarations behind the selected public
  symbols, including `MergeBroker` methods and shared input/result records. Comments and private
  implementation members are omitted; the private constructor remains because constructibility
  affects callers. Supporting declarations for inferred attestation types are included. This is a
  review guard, not a general TypeScript semantic-compatibility checker.
- `mcp-tools.json` records every worker/operator tool name and full input schema from `tools/list`.
  Human descriptions and the MCP SDK's protocol metadata are outside this baseline.
- `cli-json.json` records representative task registration/show, planning, migration inspection,
  missing-task, and usage-error documents, including exit codes and stdout/stderr placement.
  Commit IDs, timestamps, and repository paths are checked/normalized; error messages are checked
  as nonempty strings because their prose is not a stable interface. This is not coverage of every
  CLI command or every optional result field.

Run `npm run build` before the focused checks:

```sh
node --test dist/public-api.test.js dist/public-json.test.js dist/mcp.test.js
```

When a guard fails, inspect the changed declaration or actual JSON before changing a fixture.
Record any compatibility change in the appropriate documentation and changelog, decide whether it
requires a software/format version change, and update only the reviewed baseline. Root exports in a
new module also require adding its public declarations to `publicDeclarationsSnapshot` in
`src/test-support/public-contracts.ts`. Compiler upgrades can change declaration spelling without
changing semantics; those differences still require review.

The helpers `publicDeclarationsSnapshot`, `canonicalJson`, and `cliJsonContract` can print candidate
snapshots for review. MCP snapshots use the same initialized `tools/list` exchange as `mcp.test.ts`.
Fixtures are source-test assets, excluded from published tarballs with `dist/test-support`.
