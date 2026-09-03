import type { BatchRecord, BrokerConfig, BrokerState, TaskRecord } from "./types.js";

const FINAL_BATCH_STATUSES = new Set<BatchRecord["status"]>(["merged", "closed", "failed"]);

function taskLine(task: TaskRecord): string {
  const details = [
    `commits=${task.commits.length}`,
    task.lease ? `lease=${task.lease.holder} until ${task.lease.expiresAt}` : undefined,
    task.batchId ? `batch=${task.batchId}` : undefined,
    task.lastError ? `error=${task.lastError}` : undefined,
  ].filter(Boolean);
  return `  ${task.id.padEnd(24)} ${task.status.padEnd(12)} ${details.join("  ")}`.trimEnd();
}

function batchLine(batch: BatchRecord): string {
  const details = [
    `tasks=${batch.taskIds.length}`,
    batch.branchName ? `branch=${batch.branchName}` : undefined,
    batch.pullRequestUrl ? `pr=${batch.pullRequestUrl}` : undefined,
    batch.candidate ? `candidate=${batch.candidate.state}` : undefined,
    batch.error ? `error=${batch.error}` : undefined,
  ].filter(Boolean);
  return `  ${batch.id.padEnd(30)} ${batch.status.padEnd(10)} ${details.join("  ")}`.trimEnd();
}

function batchAction(batch: BatchRecord, config: BrokerConfig): string | undefined {
  if (batch.status === "running") {
    return `Batch ${batch.id} is integrating. If its process stopped, confirm that first, then run: merge-broker recover`;
  }
  if (batch.status === "prepared") {
    if (config.publish.mode === "none") {
      return `Batch ${batch.id} is ready on ${batch.branchName ?? "its integration branch"}. Land it, then run: merge-broker batch complete ${batch.id}`;
    }
    return `Publish batch ${batch.id}: merge-broker batch publish ${batch.id}`;
  }
  if (batch.status !== "published") return undefined;
  const candidate = batch.candidate;
  if (!candidate) return `Reconcile batch ${batch.id}: merge-broker batch sync ${batch.id}`;
  if (candidate.state === "changes_requested" || candidate.state === "verification_failed") {
    return `Revise batch ${batch.id} by reopening an affected task: merge-broker task reopen <task-id>`;
  }
  if (candidate.state === "ready_for_approval") {
    return `Approve batch ${batch.id} after review: merge-broker batch approve ${batch.id} --candidate ${candidate.sha} --base ${candidate.baseSha} --policy-revision ${candidate.policyRevision} --actor <actor>`;
  }
  return `Reconcile verification or merge state for batch ${batch.id}: merge-broker batch sync ${batch.id}`;
}

/** Human status is an operator surface: it includes both state and the safest useful next action. */
export function formatBrokerStatus(state: BrokerState, config: BrokerConfig, at = new Date()): string {
  const tasks = Object.values(state.tasks).sort((left, right) => left.id.localeCompare(right.id));
  const batches = Object.values(state.batches).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const actions: string[] = [];

  for (const batch of batches.filter((item) => !FINAL_BATCH_STATUSES.has(item.status))) {
    const action = batchAction(batch, config);
    if (action) actions.push(action);
  }

  const hasOutstandingBatch = batches.some((batch) => batch.status === "prepared" || batch.status === "published");
  const submitted = tasks.filter((task) => task.status === "submitted");
  if (submitted.length > 0 && !hasOutstandingBatch) {
    actions.push(`Plan ${submitted.length} submitted task(s): merge-broker plan`);
  }
  for (const task of tasks) {
    if (task.status === "registered") {
      actions.push(`Claim ${task.id}: merge-broker task claim ${task.id} --path '<scope>'`);
    } else if (task.status === "claimed" && task.lease && Date.parse(task.lease.expiresAt) <= at.getTime()) {
      actions.push(`The lease for ${task.id} expired; reclaim it before editing: merge-broker task claim ${task.id}`);
    } else if (task.status === "failed" && !task.batchId) {
      actions.push(`Repair ${task.id} with a new lease, or deliberately retry its unchanged receipt: merge-broker task claim ${task.id}`);
    }
  }

  return [
    `Tasks (${tasks.length})`,
    ...(tasks.length > 0 ? tasks.map(taskLine) : ["  none"]),
    "",
    `Batches (${batches.length})`,
    ...(batches.length > 0 ? batches.map(batchLine) : ["  none"]),
    "",
    "Next actions",
    ...(actions.length > 0 ? [...new Set(actions)].map((action) => `  - ${action}`) : ["  none — no work is waiting"]),
  ].join("\n");
}
