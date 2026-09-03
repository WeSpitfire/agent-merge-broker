# Support

Use the channel that matches the problem:

- Setup, configuration, or usage question: open a GitHub discussion if enabled, otherwise a
  question issue with a reviewed `merge-broker doctor --support-bundle` attachment.
- Reproducible defect: use the bug report template and include the smallest safe repository fixture.
- Feature or adapter proposal: use the feature request template and describe the authority and
  recovery boundaries it changes.
- Vulnerability: use [GitHub private vulnerability reporting](https://github.com/WeSpitfire/agent-merge-broker/security/advisories/new).

The support bundle includes the broker version, platform, sanitized diagnostics, and the latest 50
audit events. It redacts repository and home paths, URLs, and secret-bearing fields, but automated
redaction cannot understand every project's validator output or metadata. Review the complete file
before posting it.

When a bundle cannot be attached, include the broker version, Node and Git versions, operating
system, publication mode, and exact stable error code manually. Never post lease tokens, private
keys, credentials, or sensitive validator output.

For the tested platform matrix and features that are not included today, see
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

This is a volunteer open source project. There is no guaranteed response time or private production
support channel.
