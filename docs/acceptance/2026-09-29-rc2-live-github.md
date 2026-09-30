# Live GitHub acceptance trial — 2026-09-29

This trial exercised the exact published candidate `agent-merge-broker@1.0.0-rc.2`
(npm `next`, source commit `b5e5f92bd1b86bb1688aaa4be67de6bee636595e`) against a real
protected GitHub repository. The broker was the installed npm package CLI, not a
source checkout. It was operated by the implementer; it does not replace the
independent [adopter walkthrough](ADOPTER-TRIAL.md).

The disposable public [acceptance repository](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260929)
was archived after the run, preserving its
[pull request](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260929/pull/1),
[validation run](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260929/actions/runs/36666058600),
and [provenance run](https://github.com/WeSpitfire/amb-1-0-live-acceptance-20260929/actions/runs/36666058595).
Its `main` branch required pull-request merges with up-to-date `validation` and
`provenance` checks (active ruleset, no force pushes, no deletions). The committed
protected-base policy required signed provenance and approval of the exact candidate
by a declared actor under policy revision `live-acceptance-rc2`, with `validation`
and `provenance` as required GitHub checks. The provenance job used the released
`WeSpitfire/agent-merge-broker/verify@v1.0.0-rc.2` composite action.

| Step | Observed result |
| --- | --- |
| Two workers claimed disjoint `src/checkout/**` and `src/search/**` scopes in linked worktrees | Both candidates were nominated locally; neither worker pushed or merged. |
| First integration dry run | Rejected the checkout worker's synthetic `FIXME` marker with `VALIDATION_FAILED` (exit 1); remote `main` stayed at `8b2e4c91a06d7d182bfcb4bb99bdf93a5678d1f5`. |
| Corrected integration dry run | Passed authoritative validation with both workers selected; candidate head `6116e035a5e581ce87097b5d979c7aab33bd14cd`. |
| Publication | Broker published batch `20260930T034810251Z-602114` as PR #1 at head `0c88d07a9a2471b158c8a988c71c609469c8d0cc` (integration branch plus signed provenance commit). |
| Manual verification evidence | Recorded against the exact candidate/base/policy tuple with an evidence URL. |
| Wrong candidate approval | Refused with `CANDIDATE_MISMATCH` (exit 3); no auto-merge request was queued. |
| Exact candidate approval | Recorded policy `live-acceptance-rc2`, base `8b2e4c91…`, and the PR head above; manual, `validation`, and `provenance` evidence satisfied; auto-merge enabled. |
| Protected merge | Both validation and provenance jobs passed. GitHub merged PR #1 as `be2a0e19389cc002949d6405d2d5570cba0686b4`; the resulting tree contains both worker files and the signed batch attestation `.merge-broker/attestations/20260930T034810251Z-602114.json`. |
| Fresh-process recovery and reconciliation | `recover` found no abandoned transaction; `batch sync` recorded the batch and both tasks as `merged`. Remote `main` matched the GitHub merge commit. |

An earlier [source-level rehearsal](2026-09-24-live-github.md) performed the same
scenario against pre-RC source identifying as `0.16.0`. This record is the
exact-published-candidate result the [`1.0.0-rc.2` acceptance](2026-09-29-rc2.md)
required. The independent adopter walkthrough remains a separate open gate.
