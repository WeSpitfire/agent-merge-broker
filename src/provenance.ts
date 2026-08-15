import path from "node:path";
import type { BatchProvenance, BatchRecord, TaskRecord } from "./types.js";

export function provenancePath(directory: string, batchId: string): string {
  return path.posix.join(directory.replaceAll("\\", "/"), `${batchId}.json`);
}

export function buildBatchProvenance(options: {
  batch: BatchRecord;
  tasks: TaskRecord[];
  integratedHeadSha: string;
  integratedPaths: string[];
}): BatchProvenance {
  const { batch, tasks, integratedHeadSha, integratedPaths } = options;
  const integratedPathSet = new Set(integratedPaths);
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
      // A corrective commit may intentionally cancel an earlier change. The
      // attestation describes the integrated result, while task receipts retain
      // the historical union used for scope checks and validation routing.
      actualPaths: task.actualPaths.filter((file) => integratedPathSet.has(file)),
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
