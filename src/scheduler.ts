import { matchedSerializedPatterns, pathsOverlap } from "./patterns.js";
import type { BrokerConfig, BrokerState, SchedulePlan, TaskRecord } from "./types.js";

function timestamp(value?: string): number {
  return value ? Date.parse(value) : Number.MAX_SAFE_INTEGER;
}

function taskFromState(state: BrokerState, taskId: string): TaskRecord | undefined {
  return Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
}

function dependencyReady(
  task: TaskRecord,
  selected: Set<string>,
  state: BrokerState,
  requireDependencies: boolean,
): boolean {
  if (!requireDependencies) return true;
  return task.dependsOn.every((dependency) => {
    const dependencyTask = taskFromState(state, dependency);
    return dependencyTask?.status === "merged" || selected.has(dependency);
  });
}

function compareTasks(left: TaskRecord, right: TaskRecord): number {
  return (
    right.priority - left.priority ||
    timestamp(left.submittedAt) - timestamp(right.submittedAt) ||
    left.id.localeCompare(right.id)
  );
}

export function scheduleTasks(
  state: BrokerState,
  config: BrokerConfig,
  options: { taskIds?: string[]; maxTasks?: number } = {},
): SchedulePlan {
  const requested = options.taskIds ? new Set(options.taskIds) : undefined;
  const candidates = Object.values(state.tasks)
    .filter((task) => task.status === "submitted" && (!requested || requested.has(task.id)))
    .sort(compareTasks);
  const selected: TaskRecord[] = [];
  const selectedIds = new Set<string>();
  const rejected: SchedulePlan["rejected"] = [];
  const rejectedIds = new Set<string>();
  const maxTasks = Math.min(options.maxTasks ?? config.scheduling.maxTasks, config.scheduling.maxTasks);
  let totalCommits = 0;

  let madeProgress = true;
  while (madeProgress && selected.length < maxTasks) {
    madeProgress = false;
    for (const task of candidates) {
      if (selectedIds.has(task.id) || rejectedIds.has(task.id)) continue;
      if (!dependencyReady(task, selectedIds, state, config.policies.requireDependencies)) continue;
      if (totalCommits + task.commits.length > config.scheduling.maxCommits) {
        rejected.push({ taskId: task.id, reason: "batch commit limit" });
        rejectedIds.add(task.id);
        continue;
      }

      const collision = selected.find((chosen) => {
        if (!config.scheduling.allowPathOverlap && pathsOverlap(task.actualPaths, chosen.actualPaths)) return true;
        const taskResources = matchedSerializedPatterns(task.actualPaths, config.leases.serializedPatterns);
        const chosenResources = matchedSerializedPatterns(chosen.actualPaths, config.leases.serializedPatterns);
        return taskResources.some((resource) => chosenResources.includes(resource));
      });
      if (collision) {
        rejected.push({ taskId: task.id, reason: "conflicting change set", conflictsWith: collision.id });
        rejectedIds.add(task.id);
        continue;
      }

      selected.push(task);
      selectedIds.add(task.id);
      totalCommits += task.commits.length;
      madeProgress = true;
      if (selected.length >= maxTasks) break;
    }
  }

  for (const task of candidates) {
    if (selectedIds.has(task.id) || rejectedIds.has(task.id)) continue;
    const missing = config.policies.requireDependencies ? task.dependsOn.filter((dependency) => {
      const dependencyTask = taskFromState(state, dependency);
      return dependencyTask?.status !== "merged" && !selectedIds.has(dependency);
    }) : [];
    rejected.push({
      taskId: task.id,
      reason: missing.length > 0 ? `dependencies not integrated: ${missing.join(", ")}` : "batch task limit",
    });
  }

  if (requested) {
    for (const taskId of requested) {
      const task = taskFromState(state, taskId);
      if (!task) rejected.push({ taskId, reason: "unknown task" });
      else if (task.status !== "submitted") {
        rejected.push({ taskId, reason: `task status is ${task.status}` });
      }
    }
  }
  return { selected, rejected, totalCommits };
}
