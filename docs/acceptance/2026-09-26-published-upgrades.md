# Published-package upgrade rehearsal — 2026-09-26

This is a source-level rehearsal against broker commit
`32f7af2718ed9a6decd06f4bbd5d6af76a35fe4f` on macOS with Node `v22.23.1`.
It is not an exact-version `1.0.0-rc.1` result, an independent adopter trial, or a
claim that older in-flight publication can be migrated automatically.

Each starting version below was actually published to npm. Its registry tarball was
downloaded, SHA-256 hashed, installed in an isolated directory, and used to initialize
a fresh local Git repository with a bare `origin` and a registered task. The current
source-built CLI then inspected and, when needed, applied migration. The rehearsal
checked the existing task was unchanged, registered another task with the new CLI,
restored the old `state.json` bytes after stopping broker processes, and confirmed
that the original installed CLI read the restored task again. The checked-in policy
configuration also remained byte-for-byte unchanged.

| Published starting version | npm tarball SHA-256 | Pending migrations | Upgrade, continuation, exact-byte restore |
| --- | --- | ---: | --- |
| `0.12.0` | `f6e0d4490b0a39857027a7d0c3a091b88b5b5cd327656dc92c00cf50ab1ecaf1` | 1 | Passed |
| `0.12.1` | `494499a47dedfee261cccf847fc0dc35a0e8396a4aba925b5aab4958717e6ab5` | 1 | Passed |
| `0.13.0` | `e2477826e1764ba90d7b75e90b1b5ac7227c93bc8f1671a0f827ce4363bbf090` | 0 | Passed |
| `0.14.2` | `da6db0fee067fccdb0d059b7f8538d32ead44d06c6db6c4cf6449baf04a59fe5` | 0 | Passed |
| `0.15.0` | `47409ef0c88b18ade91ba7e69794eb46e8c180d807b26b07446ec45dea1c042e` | 0 | Passed |
| `0.15.1` | `d2e7954d0bf136197a16fd9cd1d28a95fbf723fc4f2182505f3261f3494a4770` | 0 | Passed |
| `0.16.0` | `0465ae4266c508e6aaaca6b697822b21dd044a9ca4b1dba384acd0e02a9dec2f` | 0 | Passed |

For both `0.12.x` cases, `migrate --apply` added the empty `submissions` collection.
Its generated migration backup exactly matched the original state bytes. For every
version, the operator-style backup/restore check returned the state file to its exact
original bytes after exercising continuation with the new CLI. The old CLI then
reported the original task and no post-upgrade task.

This tests an idle, registered-task state, not a complete historical repository or an
in-flight remote operation. The separate frozen `v0.12.1` release-source fixture tests
archive-slice migration and original-byte backups; it was not created from the npm
tarball. Versions earlier than `0.12.0`, compressed historical archives, old signing
keys, active validators, and prepared/published batches were not part of this rehearsal.
Drain in-flight work before upgrading, especially from pre-`0.12.0`, as described in
[Getting started](../GETTING_STARTED.md#upgrade-the-broker). Do not infer an automatic
downgrade migration from the exact-byte restore check.
