# Two agents, one integration branch

A five-minute demonstration that runs entirely on your machine. No forge, no network, no
credentials.

```bash
npm run build
sh examples/two-agents/run.sh
```

Pass `KEEP=1` to leave the throwaway repository in place for inspection.

## What it shows

The script builds a small repository with two independent areas, commits the broker's policy, and
then runs two workers in their own linked worktrees:

1. **Leases are declared before editing.** Each agent claims a narrow path scope. A third agent that
   tries to claim an area already leased is refused, by name, before it writes anything.
2. **Tokens are held for the worker.** No step in the script handles a credential. The token is
   stored owner-readable beside broker state when the task is claimed, and later commands for that
   task find it.
3. **Agents commit; they do not integrate.** Each worker makes two ordinary commits and runs
   `task submit --since-base`. Nothing is pushed, rebased, or merged by an agent.
4. **The broker decides what can go together.** `plan` selects a non-conflicting batch;
   `integrate` cherry-picks it into a disposable worktree, runs the repository's validators, and
   retains one branch only if they pass.
5. **The result carries authenticated provenance.** The final commit records the base, integrated
   parent, every task receipt, and validators, then signs that manifest with the private key kept in
   Git runtime state.

Four commits from two agents become one validated branch.

## Where to look next

- The generated `.merge-broker/config.json` in the demo repository is the whole policy surface.
- `merge-broker events` in the demo repository prints the decision trail.
- `.merge-broker/attestations/<batch>.json` on the integration branch is what
  `merge-broker verify-provenance` checks on a pull request.
