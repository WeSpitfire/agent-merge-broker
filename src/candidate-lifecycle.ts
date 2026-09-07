import { BrokerError } from "./errors.js";
import type { AuditRecorder } from "./store.js";
import type {
  BatchRecord, BrokerConfig, BrokerState, CandidateRecord, CandidateRevisionIntent,
  RevisionResult, TaskRecord, VerificationEvidence,
} from "./types.js";

/** Candidate state transitions; callers own persistence and external publication. */
function now(): string {
  return new Date().toISOString();
}

export function requireTask(state: BrokerState, taskId: string): TaskRecord {
  const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
  if (!task) throw new BrokerError("UNKNOWN_TASK", `Unknown task: ${taskId}`);
  return task;
}

export function requireBatch(state: BrokerState, id: string): BatchRecord {
  const batch = Object.hasOwn(state.batches, id) ? state.batches[id] : undefined;
  if (!batch) throw new BrokerError("UNKNOWN_BATCH", `Unknown batch: ${id}`);
  return batch;
}

export function approvalPolicy(config: BrokerConfig): NonNullable<BrokerConfig["approval"]> {
  return config.approval ?? {
    required: false,
    policyRevision: "default",
    requiredVerifications: [],
    requiredChecks: [],
    authorizedActors: [],
  };
}

export function requiredEvidenceNames(config: BrokerConfig): string[] {
  const policy = approvalPolicy(config);
  return [
    ...policy.requiredVerifications,
    ...policy.requiredChecks.map((name) => `github-check:${name}`),
  ];
}

export function candidateState(candidate: CandidateRecord): CandidateRecord["state"] {
  if (
    candidate.state === "changes_requested" ||
    candidate.state === "blocked" ||
    candidate.state === "superseded" ||
    candidate.state === "abandoned" ||
    candidate.state === "merged"
  ) {
    return candidate.state;
  }
  const evidence = new Map(candidate.verifications.map((item) => [item.name, item]));
  if (candidate.requiredVerifications.some((name) => evidence.get(name)?.status === "failed")) {
    return "verification_failed";
  }
  if (candidate.requiredVerifications.every((name) => evidence.get(name)?.status === "passed")) {
    return candidate.approval ? (candidate.state === "merging" ? "merging" : "approved") : "ready_for_approval";
  }
  return "verifying";
}

export function makeCandidate(config: BrokerConfig, sha: string, baseSha: string, revision: number): CandidateRecord {
  const policy = approvalPolicy(config);
  const candidate: CandidateRecord = {
    revision,
    sha,
    baseSha,
    policyRevision: policy.policyRevision,
    state: "verifying",
    requiredVerifications: requiredEvidenceNames(config),
    verifications: [],
    createdAt: now(),
  };
  candidate.state = candidateState(candidate);
  return candidate;
}

export function requireCurrentCandidate(batch: BatchRecord): CandidateRecord {
  if (!batch.candidate) {
    throw new BrokerError("NO_CANDIDATE", `Batch ${batch.id} has no approval candidate.`);
  }
  return batch.candidate;
}

export function assertNoPendingRevision(batch: BatchRecord): void {
  if (batch.revisionIntent) {
    throw new BrokerError(
      "REVISION_IN_PROGRESS",
      `Batch ${batch.id} has a candidate revision awaiting recovery; retry after recovery completes.`,
      { batchId: batch.id, candidateSha: batch.revisionIntent.candidateSha },
    );
  }
}

export function finalizeCandidateRevision(
  state: BrokerState,
  audit: AuditRecorder,
  batchId: string,
  intent: CandidateRevisionIntent,
): RevisionResult {
  const storedBatch = requireBatch(state, batchId);
  const storedIntent = storedBatch.revisionIntent;
  if (
    !storedIntent ||
    storedIntent.candidateSha !== intent.candidateSha ||
    storedIntent.previousCandidateSha !== intent.previousCandidateSha
  ) {
    throw new BrokerError("REVISION_INTENT_CHANGED", `Candidate revision intent changed for batch ${batchId}.`);
  }
  const storedCandidate = requireCurrentCandidate(storedBatch);
  if (
    storedCandidate.sha !== intent.previousCandidateSha ||
    storedCandidate.state !== "changes_requested"
  ) {
    throw new BrokerError("CANDIDATE_CHANGED", "Candidate state changed while its revision was published.");
  }
  const superseded: CandidateRecord = {
    ...structuredClone(storedCandidate),
    state: "superseded",
    reason: `Superseded by candidate revision ${intent.revision}.`,
  };
  const nextBatch = structuredClone(intent.nextBatch) as BatchRecord;
  nextBatch.candidateHistory = [...(storedBatch.candidateHistory ?? []), superseded];
  delete nextBatch.revisionIntent;
  state.batches[batchId] = nextBatch;

  const nextTask = requireTask(state, intent.taskId);
  const actor = nextTask.lease?.holder;
  nextTask.commits = [...intent.revisedTask.commits];
  nextTask.actualPaths = [...intent.revisedTask.actualPaths];
  nextTask.warnings = [...intent.revisedTask.warnings];
  nextTask.submittedAt = intent.revisedTask.submittedAt;
  nextTask.updatedAt = now();
  delete nextTask.lease;
  delete nextTask.lastError;
  for (const id of nextBatch.taskIds) {
    const batchTask = requireTask(state, id);
    batchTask.validations = nextBatch.validations.filter(
      (result) => !result.taskId || result.taskId === id,
    );
    batchTask.updatedAt = now();
  }
  audit("batch.candidate_revised", {
    ...(actor ? { actor } : {}),
    taskId: intent.taskId,
    batchId,
    details: {
      previousCandidateSha: intent.previousCandidateSha,
      candidateSha: intent.candidateSha,
      previousBaseSha: superseded.baseSha,
      baseSha: nextBatch.candidate?.baseSha,
      revision: intent.revision,
    },
  });
  return {
    batch: structuredClone(nextBatch),
    task: structuredClone(nextTask),
    previousCandidate: superseded,
  };
}

export function assertCandidateBinding(
  candidate: CandidateRecord,
  binding: { candidateSha: string; baseSha: string; policyRevision?: string },
): void {
  const policyRevision = binding.policyRevision ?? candidate.policyRevision;
  if (
    binding.candidateSha !== candidate.sha ||
    binding.baseSha !== candidate.baseSha ||
    policyRevision !== candidate.policyRevision
  ) {
    throw new BrokerError(
      "CANDIDATE_MISMATCH",
      "The supplied candidate SHA, base SHA, or policy revision does not match the current candidate.",
      {
        expected: {
          candidateSha: candidate.sha,
          baseSha: candidate.baseSha,
          policyRevision: candidate.policyRevision,
        },
        supplied: { ...binding, policyRevision },
      },
    );
  }
}

export function assertCurrentApprovalPolicy(config: BrokerConfig, candidate: CandidateRecord): void {
  const policy = approvalPolicy(config);
  const required = requiredEvidenceNames(config);
  const approvalActorCurrent =
    !candidate.approval ||
    policy.authorizedActors.length === 0 ||
    policy.authorizedActors.includes(candidate.approval.actor);
  if (
    candidate.policyRevision !== policy.policyRevision ||
    candidate.requiredVerifications.length !== required.length ||
    candidate.requiredVerifications.some((name) => !required.includes(name)) ||
    !approvalActorCurrent
  ) {
    throw new BrokerError(
      "CANDIDATE_POLICY_STALE",
      "The approval policy changed after this candidate was assembled. Rebuild it before verification or approval.",
      {
        candidatePolicyRevision: candidate.policyRevision,
        currentPolicyRevision: policy.policyRevision,
        candidateRequiredVerifications: candidate.requiredVerifications,
        currentRequiredVerifications: required,
        candidateApprover: candidate.approval?.actor,
        currentAuthorizedActors: policy.authorizedActors,
      },
    );
  }
}

export function upsertEvidence(candidate: CandidateRecord, evidence: VerificationEvidence): void {
  candidate.verifications = candidate.verifications.filter((item) => item.name !== evidence.name);
  candidate.verifications.push(evidence);
  candidate.state = candidateState(candidate);
  delete candidate.reason;
}
