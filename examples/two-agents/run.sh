#!/bin/sh
# Two agents, one integration branch.
#
# Builds a throwaway Git repository, runs two workers in parallel worktrees, and lets the broker
# assemble their commits into a single validated branch. Nothing here touches a network or a forge.
#
#   sh examples/two-agents/run.sh          # run and clean up
#   KEEP=1 sh examples/two-agents/run.sh   # keep the demo repository for inspection
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BROKER=${MERGE_BROKER_BIN:-"node $ROOT/dist/cli.js"}

if [ ! -f "$ROOT/dist/cli.js" ] && [ -z "${MERGE_BROKER_BIN:-}" ]; then
  echo "Build the broker first: npm run build" >&2
  exit 1
fi

DEMO=$(mktemp -d 2>/dev/null || mktemp -d -t merge-broker-demo)
REPO="$DEMO/shop"
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo
    echo "Demo repository kept at: $REPO"
  else
    rm -rf "$DEMO"
  fi
}
trap cleanup EXIT

say() {
  echo
  echo "── $1"
}

# ----------------------------------------------------------------------------------------------
say "Creating a repository with two independent areas"

mkdir -p "$REPO"
cd "$REPO"
git init -q -b main
git config user.name "Demo"
git config user.email "demo@merge-broker.invalid"
mkdir -p src/checkout src/search
echo "export const total = 0;" > src/checkout/total.ts
echo "export const query = '';" > src/search/query.ts
echo "# Shop" > README.md
git add .
git commit -qm "initial"

# ----------------------------------------------------------------------------------------------
say "Initializing the broker and committing its policy"

$BROKER init --base main --base-ref main >/dev/null

# Repository policy is committed, so every linked worktree sees the same rules. Validators run in
# the disposable integration worktree, never in an agent's worktree.
cat > .merge-broker/config.json <<'JSON'
{
  "version": 1,
  "baseBranch": "main",
  "baseRef": "main",
  "remote": "origin",
  "stateDirectory": "merge-broker",
  "leases": {
    "ttlSeconds": 1800,
    "lockTimeoutSeconds": 15,
    "serializedPatterns": ["package-lock.json"]
  },
  "policies": {
    "unexpectedPaths": "error",
    "requireCleanWorktree": true,
    "requireDependencies": true
  },
  "scheduling": {
    "maxTasks": 6,
    "maxCommits": 12,
    "maxWaitSeconds": 600,
    "allowPathOverlap": false
  },
  "integration": {
    "branchPrefix": "merge-broker/",
    "history": "preserve",
    "keepFailedWorktrees": false,
    "refreshBase": false,
    "maxAttempts": 3,
    "provenance": { "enabled": true, "directory": ".merge-broker/attestations" }
  },
  "validation": {
    "focused": [
      { "name": "changed files exist", "paths": ["src/**"], "command": "for file in {files}; do test -e \"$file\"; done", "timeoutSeconds": 60 }
    ],
    "authoritative": [
      { "name": "no FIXME markers", "command": "! grep -r FIXME src", "timeoutSeconds": 60 }
    ]
  },
  "publish": {
    "mode": "none",
    "draft": false,
    "autoMerge": false,
    "mergeMethod": "squash",
    "labels": [],
    "titleTemplate": "Integration batch {batchId}"
  }
}
JSON
git add .merge-broker
git commit -qm "add broker policy"

# ----------------------------------------------------------------------------------------------
say "Two agents claim disjoint scopes and start work in their own worktrees"

for agent in checkout search; do
  git worktree add -q "$DEMO/agent-$agent" -b "agent/$agent" main
  # The token is stored for us, so no agent script has to carry a credential around.
  $BROKER -C "$DEMO/agent-$agent" task claim "$agent" \
    --holder "agent-$agent" \
    --path "src/$agent/**" | sed 's/^/   /'
done

# ----------------------------------------------------------------------------------------------
say "A third agent tries to claim an area that is already leased"

set +e
CONFLICT=$($BROKER -C "$REPO" task claim latecomer --holder agent-latecomer --path 'src/checkout/**' 2>&1)
CONFLICT_STATUS=$?
set -e
echo "$CONFLICT" | sed 's/^/   /'
if [ "$CONFLICT_STATUS" -eq 0 ]; then
  echo "   unexpected: the overlapping claim was allowed" >&2
  exit 1
fi

# ----------------------------------------------------------------------------------------------
say "Each agent commits inside its own scope and submits immutable commits"

for agent in checkout search; do
  cd "$DEMO/agent-$agent"
  echo "export const $agent = true;" > "src/$agent/feature.ts"
  git add "src/$agent/feature.ts"
  git commit -qm "add $agent feature"
  echo "export const ${agent}Version = 2;" >> "src/$agent/feature.ts"
  git add "src/$agent/feature.ts"
  git commit -qm "version $agent feature"

  # No --commit list and no token: the broker knows the base it handed out and holds the lease.
  $BROKER -C "$DEMO/agent-$agent" task submit "$agent" --since-base | sed 's/^/   /'
done
cd "$REPO"

# ----------------------------------------------------------------------------------------------
say "The broker plans one non-conflicting batch"

$BROKER plan | sed 's/^/   /'

# ----------------------------------------------------------------------------------------------
say "Integrating: cherry-pick, validate, and retain one branch"

$BROKER integrate | sed 's/^/   /'

BRANCH=$(git branch --list 'merge-broker/*' --format '%(refname:short)')
say "Result: $BRANCH"
git log --oneline "main..$BRANCH" | sed 's/^/   /'

say "The final commit records how the batch was assembled"
git show --stat --format='   %s' "$BRANCH" | sed 's/^/   /' | head -8

echo
echo "Four commits from two agents became one validated branch, with no agent pushing anything."
