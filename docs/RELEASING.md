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

## Release procedure

1. Update `CHANGELOG.md` and remove the `Unreleased` marker for the target version.
2. Update `package.json` with `npm version <major|minor|patch> --no-git-tag-version`.
3. Run `npm run verify`, `npm run example`, `npm pack --dry-run`, and production dependency audits
   for both the package and documentation site.
4. Commit the release metadata and merge it through the normal protected workflow.
5. Create a GitHub release tagged `v<version>`.

Publishing the GitHub release invokes the release workflow, repeats verification, checks that the tag equals the package version, and publishes with npm provenance.

The composite action is documented with the same exact release tag, for example
`WeSpitfire/agent-merge-broker/verify@v0.6.0`. Do not document a floating major tag unless that tag
actually exists and is maintained deliberately.

Do not reuse or move a published version tag. If a release is incorrect, deprecate it and publish a corrected patch version.
