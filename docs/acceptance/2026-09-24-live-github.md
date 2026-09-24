# Synthetic GitHub acceptance rehearsal — 2026-09-24

This source-level rehearsal exercised commit `ef285cf67d7165b487405ed1f66a73e21063ceb2`
on macOS with the broker built from that checkout. The package still identified itself as `0.16.0`;
these results do not certify a published 1.0 release candidate or an independent adopter trial.

The disposable public [acceptance repository](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260924)
was archived after the run, preserving its [pull request](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260924/pull/1)
and [GitHub Actions run](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260924/actions/runs/36074528881).
Its `main` branch required up-to-date `validation` and `provenance` checks and pull-request merges,
with administrator enforcement, no force pushes, and no deletion. The protected-base policy
required signed provenance and approval of the exact candidate by the `operator` label.

| Step | Observed result |
| --- | --- |
| Two workers claimed disjoint `src/checkout/**` and `src/search/**` scopes | Both candidates were nominated locally; neither worker pushed or merged. |
| First integration dry run | Rejected the checkout worker's synthetic `FIXME` marker with `VALIDATION_FAILED`; remote `main` stayed at `98c81209dacc025e2da8411e783502514fd52ed5`. |
| Corrected integration dry run | Passed authoritative validation with both workers selected. |
| Publication | Broker published batch `20260924T234752426Z-fbd5b1` as PR #1 at head `ec92d163d0739d2160d97c8ad1ae02623f7bbea4`. |
| Wrong candidate approval | Refused with `CANDIDATE_MISMATCH`; no auto-merge request was queued. |
| Exact candidate approval | Recorded policy `live-acceptance-v1`, base `98c81209dacc025e2da8411e783502514fd52ed5`, and the PR head above; enabled auto-merge. |
| Protected merge | Both validation and provenance jobs passed. GitHub merged PR #1 as `415233af9de208b1b1f1b6fff73a8136de46d6fa`; the resulting tree contains both worker files and the signed batch attestation. |
| Fresh-process recovery and reconciliation | `recover` found no abandoned transaction; `batch sync` recorded the batch and both tasks as merged. Remote `main` matched the GitHub merge commit. |

The GitHub job used the released `verify@v0.16.0` action to validate provenance against the
protected base. The local broker executing the workflow came from the source commit named above.
The required nine-lane source CI run for that commit also passed separately. An exact-version
release-candidate rehearsal, published-package upgrade/restore checks, and an independent adopter
walkthrough remain release qualifications.
