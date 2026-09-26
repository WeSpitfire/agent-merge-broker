# Releasing

`agent-merge-broker` is published to npm by GitHub Actions trusted publishing. Releases use an
immutable exact-version Git tag and npm provenance; no long-lived npm token is stored in the
repository.

Version `0.15.0` adds the `agent-merge-broker-core` companion package and dual-package verification
below. Core has a separate first-publication and trusted-publisher setup. The full package remains independently
publishable; adding a second package must not interrupt its established publishing identity.

## Repository prerequisites

1. Protect `main` and require CI, authoritative repository validation, and the provenance verifier
   where the broker is enforced.
   Require every `verify / verify (<os>, <node>)` check in the nine-lane matrix before merging;
   a successful Linux lane is not a substitute for a failing Windows or macOS lane.
2. Keep npm trusted publishing scoped to this repository and `release.yml`; do not add a fallback
   `NPM_TOKEN`.
3. Enable GitHub private vulnerability reporting and periodically test the reporting link in
   `docs/SECURITY.md`.
4. Keep integration signing keys and forge credentials out of worker environments.

## Release verification — 0.15.0

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

### Lean packages — 0.15.0

Every verification lane exercises the full and core tarballs in separate clean consumers. Full
keeps the MCP compatibility checks; core checks the shared CLI/API without installing the MCP SDK.
Packaging checks reject debug maps and long guides/examples in either tarball and enforce footprint
budgets. This is one source implementation with two distributions, not a second broker codebase.

The tested artifacts have separate destinations and integrity manifests:

```bash
npm run test:package -- --pack-destination release-package --core-pack-destination release-core-package
```

The Ubuntu/Node 24 lane uploads full and core artifacts for the same immutable source SHA. The
existing full-package job publishes its verified artifact as before. A separate core publishing job
uses the tested `npm-core-package-<source SHA>` artifact and the same tag/version, matrix gate,
integrity verification, and npm provenance. It runs only when the repository variable
`PUBLISH_CORE_PACKAGE` equals `true`.

For a local core tarball, run `npm run pack:core -- --pack-destination <emptydirectory>` with an
empty destination. This builds only the tarball, not a release-verified integrity manifest; use
`test:package` above for publishable artifacts. `npm run build:debug` optionally generates local
JavaScript/declaration maps for debugging. These maps are not included in either npm package.

### First core publication

Leave `PUBLISH_CORE_PACKAGE` unset until a maintainer completes bootstrap. npm trusted publishing
requires an existing package, and trust is configured separately for each package:

1. Confirm the `agent-merge-broker-core` name is available and approve the initial public release.
2. Publish the verified core tarball from the approved release using an authenticated maintainer
   session and npm's required authentication. Do not substitute unverified or rebuilt bytes.
3. Configure the core package's trusted publisher for `WeSpitfire/agent-merge-broker`, workflow
   `release.yml`, and permit direct publishing rather than staging-only access.
4. Enable `PUBLISH_CORE_PACKAGE=true` for subsequent unpublished versions. Do not attempt to publish
   the bootstrap version again.

See npm's [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) and
[trust configuration](https://docs.npmjs.com/cli/v11/commands/npm-trust/). Do not add a fallback
`NPM_TOKEN` to the repository. Until bootstrap and publication complete, docs must keep core marked
unpublished and must not promise registry installation commands for it.

## Release procedure

1. Update `CHANGELOG.md` and remove the `Unreleased` marker for the target version.
2. Update the root package version and lockfile together with
   `npm version <major|minor|patch> --no-git-tag-version`. Core packaging derives the same version
   from the root package; never release different source versions under one tag.
3. Build and run `npm run verify`, `npm run example`, `npm run example:gate`,
   `npm run test:package`, and `node scripts/update-schema-snapshots.mjs --check`. Run production
   dependency audits for both the package and documentation site and build the site after syncing
   its canonical documents.
4. Commit the release metadata and merge it through the normal protected workflow.
5. Create a GitHub release tagged `v<version>`.

Publishing the GitHub release invokes the complete matrix and publishes only after all its jobs
succeed. Release documentation must not claim npm availability until that release actually
completes; changing `package.json` locally does not make a version available on npm.

After publication, verify each published package's version and intended npm dist-tag, then inspect npm's provenance
attestation for the expected source repository and commit. A tarball publication may omit advisory
`gitHead` metadata; compare it if present, but use the signed provenance source SHA as the source
binding. A successful local check or pushed Git commit alone is not proof of npm publication.

The composite action is documented with the same exact release tag, for example
`WeSpitfire/agent-merge-broker/verify@v1.0.0-rc.1`. Do not document a floating major tag unless that tag
actually exists and is maintained deliberately.

Do not reuse or move a published version tag. If a release is incorrect, deprecate it and publish a corrected patch version.

### Release candidates

Use a prerelease version such as `1.0.0-rc.1` and mark its GitHub release as a prerelease.
The release resolver validates both pieces of metadata before any publishing job is authorized:
prereleases publish to npm's `next` dist-tag, and normal versions publish to `latest`. A missing or
contradictory prerelease flag fails the release. Release versions with SemVer build metadata are
not accepted, so the package version and immutable Git tag remain unambiguous.

Both packages use the same resolved channel. A core bootstrap must also explicitly pass
`--tag next` when its approved version is a prerelease; do not accidentally make an RC the default
installation. Verify both dist-tags after publication. The packaged consumers always install exact
tarball bytes, not whichever version a mutable dist-tag points to.

### 1.0 acceptance evidence

The [roadmap](../ROADMAP.md) defines the supported scope. Before publishing
`1.0.0`, record an acceptance result for the exact candidate version and source SHA covering:

- all nine verification lanes and both installed tarballs, including frozen public contracts and
  released-format migration fixtures;
- process death during active validation, and crash/lost-response recovery at the documented
  Coordinate publication and authorization boundaries;
- a clean installation and upgrade/backup-restore rehearsal from each supported starting version;
- a disposable protected GitHub repository workflow: two workers, rejected and accepted validation,
  exact-candidate approval, publication, merge reconciliation, and restart;
- a guide-following trial by someone other than the implementer; and
- npm availability, intended dist-tags, and provenance for every distribution advertised for 1.0.

Give the independent adopter the [walkthrough record](https://github.com/WeSpitfire/agent-merge-broker/blob/main/docs/acceptance/ADOPTER-TRIAL.md) and ask them to
follow the published guide without implementation help. Keep their completed record and evidence
links with the exact candidate's acceptance result; an unfilled template is not a passing trial.

The live GitHub rehearsal requires explicit permission for its repository, credentials, pushes,
pull requests, and merges. Use synthetic content, never an adopter's working repository. Local fake
forge tests do not count as this live result. A pending or unavailable check remains a release
blocker in the acceptance record; do not silently mark it complete or promote an RC.

Keep contract fixtures and harnesses in development/test-only paths. Completing this checklist does
not require new runtime dependencies, a hosted service, or a second forge adapter.

## Schema compatibility

Root schema files retain their historical aliases. Immutable packaged snapshots use fingerprinted
URN identities, mapped by `schemas/identities.json`. When changing a schema, run the build and
`node scripts/update-schema-snapshots.mjs --write`, commit the new snapshot and mapping, and retain
all previous snapshots. The generator refuses to overwrite a changed immutable snapshot. These
URNs identify content; they do not claim an unpublished URL is already available. Consumers should
pin a released package version or Git commit when retrieving the files.
