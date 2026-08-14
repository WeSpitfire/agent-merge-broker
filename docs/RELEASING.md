# Releasing

The package name `agent-merge-broker` was unclaimed on npm when the project was initialized. Registry availability is not reserved until the first publication.

## First release setup

1. Create the public GitHub repository and update package metadata if its owner differs from `WeSpitfire`.
2. Confirm the package name and ownership with `npm view agent-merge-broker`.
3. Configure npm trusted publishing for the GitHub repository and the `release.yml` workflow, or add an appropriately scoped `NPM_TOKEN` and adjust the workflow.
4. Protect `main` and require the CI workflow.
5. Add a private vulnerability-reporting contact to `docs/SECURITY.md`.

## Release procedure

1. Update `CHANGELOG.md` and remove the `Unreleased` marker for the target version.
2. Update `package.json` with `npm version <major|minor|patch> --no-git-tag-version`.
3. Run `npm run verify` and `npm pack --dry-run`.
4. Commit the release metadata and merge it through the normal protected workflow.
5. Create a GitHub release tagged `v<version>`.

Publishing the GitHub release invokes the release workflow, repeats verification, checks that the tag equals the package version, and publishes with npm provenance.

Do not reuse or move a published version tag. If a release is incorrect, deprecate it and publish a corrected patch version.
