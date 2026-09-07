# Releasing

`agent-merge-broker` is published to npm by GitHub Actions trusted publishing. Releases use an
immutable exact-version Git tag and npm provenance; no long-lived npm token is stored in the
repository.

## Repository prerequisites

1. Protect `main` and require CI, authoritative repository validation, and the provenance verifier
   where the broker is enforced.
2. Keep npm trusted publishing scoped to this repository and `release.yml`; do not add a fallback
   `NPM_TOKEN`.
3. Enable GitHub private vulnerability reporting and periodically test the reporting link in
   `docs/SECURITY.md`.
4. Keep integration signing keys and forge credentials out of worker environments.

## Release verification — 0.14.2

The release workflow resolves the release tag to one immutable commit, verifies it equals the
release event's SHA, and checks `v<package version>` before
dispatching the shared verification workflow. CI uses that same workflow for its own immutable
commit; a green run for some other revision of `main` cannot authorize publication.

The shared matrix runs Node.js 22, 24, and 26 on Linux, macOS, and Windows. Every lane installs locked
dependencies, runs the full verification suite and both local examples, checks immutable schemas,
and installs/exercises the actual npm tarball in a clean consumer. The consumer checks package
exports/types, CLI aliases, initialization assets, and MCP startup. Portable forge fixtures and real
subprocess interruption/restart tests run as part of the suite.

The Ubuntu/Node 24 lane uploads its tested tarball and an integrity manifest containing source SHA,
version, filename, and SHA-256. The publishing job depends on the entire matrix. It checks out that
same source revision, verifies the manifest and tarball digest, and publishes the downloaded bytes
with npm provenance. It does not rebuild or substitute a freshly packed artifact after verification.
The workflow's identity-token permission supplies npm trusted publishing; no fallback token is used.

Use an explicitly local path such as `./release-package/agent-merge-broker-<version>.tgz` for
`npm publish`; the bare relative path can be interpreted as GitHub shorthand. The packaged smoke
test runs a publish dry-run against the tarball before the publishing job receives authority.
The immutable `v0.14.0` and `v0.14.1` GitHub tags remain available, but neither reached npm. Their
publishing-path and npm dry-run JSON compatibility fixes are in release target `0.14.2`.

## Release procedure

1. Update `CHANGELOG.md` and remove the `Unreleased` marker for the target version.
2. Update `package.json` with `npm version <major|minor|patch> --no-git-tag-version`.
3. Build and run `npm run verify`, `npm run example`, `npm run example:gate`,
   `npm run test:package`, and `node scripts/update-schema-snapshots.mjs --check`. Run production
   dependency audits for both the package and documentation site and build the site after syncing
   its canonical documents.
4. Commit the release metadata and merge it through the normal protected workflow.
5. Create a GitHub release tagged `v<version>`.

Publishing the GitHub release invokes the complete matrix and publishes only after all its jobs
succeed. Release documentation must not claim npm availability until that release actually
completes; changing `package.json` locally does not make a version available on npm.

After publication, verify the version and intended npm dist-tag, then inspect npm's provenance
attestation for the expected source repository and commit. A tarball publication may omit advisory
`gitHead` metadata; compare it if present, but use the signed provenance source SHA as the source
binding. A successful local check or pushed Git commit alone is not proof of npm publication.

The composite action is documented with the same exact release tag, for example
`WeSpitfire/agent-merge-broker/verify@v0.14.2`. Do not document a floating major tag unless that tag
actually exists and is maintained deliberately.

Do not reuse or move a published version tag. If a release is incorrect, deprecate it and publish a corrected patch version.

## Schema compatibility

Root schema files retain their historical aliases. Immutable packaged snapshots use fingerprinted
URN identities, mapped by `schemas/identities.json`. When changing a schema, run the build and
`node scripts/update-schema-snapshots.mjs --write`, commit the new snapshot and mapping, and retain
all previous snapshots. The generator refuses to overwrite a changed immutable snapshot. These
URNs identify content; they do not claim an unpublished URL is already available. Consumers should
pin a released package version or Git commit when retrieving the files.
