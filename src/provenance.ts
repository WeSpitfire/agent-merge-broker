import path from "node:path";
import type { BatchProvenance, BatchRecord, TaskRecord } from "./types.js";

export function provenancePath(directory: string, batchId: string): string {
  return path.posix.join(directory.replaceAll("\\", "/"), `${batchId}.json`);
}

export function buildBatchProvenance(options: {
  batch: BatchRecord;
  tasks: TaskRecord[];
  integratedHeadSha: string;
}): BatchProvenance {
  const { batch, tasks, integratedHeadSha } = options;
  return {
    version: 1,
    generator: "agent-merge-broker",
    batchId: batch.id,
    baseBranch: batch.baseBranch,
    baseSha: batch.baseSha,
    integratedHeadSha,
    taskIds: [...batch.taskIds],
    tasks: tasks.map((task) => ({
      id: task.id,
      commits: [...task.commits],
      actualPaths: [...task.actualPaths],
      dependsOn: [...task.dependsOn],
    })),
    validations: batch.validations.map((result) => ({
      name: result.name,
      scope: result.scope,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })),
    createdAt: new Date().toISOString(),
  };
}
