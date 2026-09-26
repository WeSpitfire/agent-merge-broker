# Independent 1.0 candidate walkthrough

Use this record only for a guide-following trial by someone other than the candidate's
implementer. Keep it outside the release tag until the trial is complete. Use a disposable
repository and synthetic files; never put a real project's secrets or unreviewed code in it.

## Trial identity

- Candidate npm version and dist-tag:
- Candidate Git tag and immutable source SHA:
- Date, operating system, Node.js, Git, and GitHub CLI versions:
- Adopter (name or handle) and confirmation they did not implement the candidate:
- Disposable repository and relevant PR/check links:
- Full or core distribution used (check actual npm availability first):

## Follow the published guide

Start with [Getting started](../GETTING_STARTED.md) and [Releasing](../RELEASING.md).
Use the exact candidate version, not a moving npm dist-tag. Record each result and any
step where the guide required outside explanation.

- [ ] Install the exact candidate from npm into a clean environment; confirm CLI version,
      package identity, and `doctor` output.
- [ ] Initialize a disposable Git repository and review its checked-in policy.
- [ ] Have two workers claim disjoint scopes and submit committed work without either
      worker pushing or merging the protected branch.
- [ ] Observe one rejected validation and correct the worker input.
- [ ] Assemble and validate the corrected batch; record the candidate SHA, base SHA,
      policy revision, and target repository.
- [ ] Publish through a protected PR. Confirm validation and provenance checks apply
      to the exact head and that no merge occurs before approval.
- [ ] Attempt a mismatched candidate approval and confirm it is refused. Then approve
      the exact candidate and observe the protected merge.
- [ ] Restart the broker process, run recovery/reconciliation, and confirm both tasks
      and the batch end in `merged` without duplicate publication.
- [ ] Follow the upgrade guide from an exact earlier published version using a separate
      disposable repository. Back up all broker runtime data, run migration/doctor, and
      verify old state and new work; restore original bytes offline and check the old CLI
      can read its own state. Do not downgrade a live repository.
- [ ] If a guide step fails or needs undisclosed expertise, record the blocker instead
      of checking it off.

## Outcome

- Pass/fail and evidence links:
- Unexpected behavior, missing instructions, or confusing terminology:
- Any release-blocking issue and reproduction:
- Adopter sign-off and date:

A blank or implementer-completed copy is not independent acceptance evidence. A failed
step remains a release blocker until corrected and repeated on the exact candidate.
