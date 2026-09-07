import path from "node:path";
import { BrokerError } from "./errors.js";
import { adoptedRef, type GitRepository } from "./git.js";
import type { StateStore } from "./store.js";
import type { SubmissionArchiveOptions, SubmissionArchiveResult, SubmissionRecord } from "./types.js";

const TERMINAL = new Set(["validated", "rejected", "failed", "abandoned"]);

function activeRecord(records: Record<string, SubmissionRecord>, id: string): SubmissionRecord {
  const record = Object.hasOwn(records, id) ? records[id] : undefined;
  if (!record) throw new BrokerError("UNKNOWN_SUBMISSION", `Unknown active candidate submission: ${id}`);
  return record;
}

/** Local maintenance has no dependency on a still-usable validation authority registration. */
export class SubmissionRetentionManager {
  constructor(private readonly repo: GitRepository, private readonly store: StateStore) {}

  async abandon(id: string, reason: string): Promise<SubmissionRecord> {
    const message = reason.trim();
    if (!message || message.length > 4_096) {
      throw new BrokerError("INVALID_ARGUMENTS", "Abandonment requires a reason of 1–4096 characters.");
    }
    return await this.store.withIntegrationLock(async () => {
      await this.store.transaction((state, audit) => {
        const record = activeRecord(state.submissions, id);
        if (record.status === "abandoned") return;
        if (record.status !== "received" && record.status !== "validating") {
          throw new BrokerError("SUBMISSION_NOT_PENDING", "Only a pending submission can be abandoned; archive a terminal record instead.");
        }
        const at = new Date().toISOString();
        record.status = "abandoned";
        record.abandonedAt = at;
        record.abandonReason = message;
        record.finishedAt = at;
        record.updatedAt = at;
        record.errorCode = "SUBMISSION_ABANDONED";
        record.error = message;
        audit("submission.abandoned", { submissionId: id, details: { reason: message } });
      });
      // The terminal transition precedes cleanup. Failure leaves ownership information available
      // for recovery, but must never make an operator-abandoned validator executable again.
      await this.cleanupAbandoned(id);
      return structuredClone(activeRecord((await this.store.read()).submissions, id));
    });
  }

  async archive(options: SubmissionArchiveOptions = {}): Promise<SubmissionArchiveResult> {
    const days = options.olderThanDays ?? (options.ids?.length ? 0 : 30);
    if (!Number.isFinite(days) || days < 0) {
      throw new BrokerError("INVALID_LIMIT", "olderThanDays must be a non-negative number.");
    }
    const cutoffMs = Date.now() - days * 86_400_000;
    if (!Number.isFinite(cutoffMs) || Math.abs(cutoffMs) > 8_640_000_000_000_000) {
      throw new BrokerError("INVALID_LIMIT", "olderThanDays is outside the supported date range.");
    }
    const cutoff = new Date(cutoffMs).toISOString();
    const dryRun = options.dryRun ?? true;
    const releaseArtifacts = options.releaseArtifacts ?? false;
    return await this.store.withIntegrationLock(async () => {
      const state = await this.store.read();
      const selected = options.ids?.length
        ? [...new Set(options.ids)].map((id) => activeRecord(state.submissions, id))
        : Object.values(state.submissions);
      const pending = selected.filter((record) => !TERMINAL.has(record.status) || record.worktree || record.worktreeIdentity);
      if (options.ids?.length && pending.length > 0) {
        throw new BrokerError("SUBMISSION_NOT_TERMINAL", "Pending submissions or unfinished cleanup cannot be archived.", {
          submissions: pending.map((record) => record.id),
        });
      }
      const eligible = selected.filter((record) =>
        TERMINAL.has(record.status) && !record.worktree && !record.worktreeIdentity &&
        Date.parse(record.finishedAt ?? record.updatedAt) <= cutoffMs);
      const result: SubmissionArchiveResult = {
        submissions: eligible.map((record) => record.id).sort(),
        retainedPending: pending.map((record) => record.id).sort(),
        cutoff, dryRun, releaseArtifacts, archivePaths: [],
      };
      if (dryRun) return result;
      // Persist every intended retirement before performing any ref side effect. Recovery uses
      // the exact captured release decision, not whatever options the next caller happens to use.
      await this.store.transaction((current, audit) => {
        for (const id of result.submissions) {
          const record = activeRecord(current.submissions, id);
          if (record.archiveIntent && record.archiveIntent.releaseArtifact !== releaseArtifacts) {
            throw new BrokerError("SUBMISSION_ARCHIVE_PENDING", "An existing archive intent has a different artifact-retention decision. Run recover first.");
          }
          record.archiveIntent ??= { requestedAt: new Date().toISOString(), releaseArtifact: releaseArtifacts };
          audit("submission.archive_requested", { submissionId: id, details: { releaseArtifacts } });
        }
      });
      for (const id of result.submissions) result.archivePaths.push(await this.completeArchive(id));
      return result;
    });
  }

  async recover(): Promise<{ archived: string[]; cleaned: string[]; warnings: string[] }> {
    return await this.store.withIntegrationLock(async () => {
      const result = { archived: [] as string[], cleaned: [] as string[], warnings: [] as string[] };
      for (const record of Object.values((await this.store.read()).submissions)) {
        try {
          if (record.archiveIntent) {
            await this.completeArchive(record.id);
            result.archived.push(record.id);
          } else if (record.status === "abandoned" && (record.worktree || record.worktreeIdentity)) {
            await this.cleanupAbandoned(record.id);
            result.cleaned.push(record.id);
          }
        } catch (error) {
          result.warnings.push(`Could not finish candidate maintenance ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    });
  }

  private async cleanupAbandoned(id: string): Promise<void> {
    const record = activeRecord((await this.store.read()).submissions, id);
    if (record.status !== "abandoned") throw new BrokerError("SUBMISSION_CHANGED", "Submission is no longer abandoned.");
    if (record.worktree) {
      const expected = path.join(this.store.worktreesDirectory, `submission-${record.id}`);
      if (path.resolve(record.worktree) !== path.resolve(expected)) {
        throw new BrokerError("UNSAFE_PATH", "Abandoned worktree does not match its recorded submission path.");
      }
      await this.repo.removeWorktree(expected, {
        strictGateCleanup: true,
        ...(record.worktreeIdentity ? { expectedRootIdentity: record.worktreeIdentity } : {}),
      });
    } else if (record.worktreeIdentity) {
      throw new BrokerError("STATE_CORRUPT", "Abandoned worktree identity has no recorded path.");
    }
    const terminal = await this.store.transaction((state, audit) => {
      const current = activeRecord(state.submissions, id);
      delete current.worktree;
      delete current.worktreeIdentity;
      audit("submission.abandonment_cleaned", { submissionId: id });
      return structuredClone(current);
    });
    await this.store.ensureSubmissionManifest(terminal);
  }

  private async completeArchive(id: string): Promise<string> {
    const record = activeRecord((await this.store.read()).submissions, id);
    const intent = record.archiveIntent;
    if (!intent || !TERMINAL.has(record.status) || record.worktree || record.worktreeIdentity) {
      throw new BrokerError("SUBMISSION_NOT_TERMINAL", "Only an exact terminal retirement intent can be completed.");
    }
    if (record.artifact.retainedRef !== adoptedRef(id)) {
      throw new BrokerError("SUBMISSION_REF_CHANGED", "Submission does not name its broker-owned retention ref.");
    }
    await this.repo.assertGateGitSupported();
    if (intent.releaseArtifact) await this.repo.releasePinnedLocalRef(id, record.artifact.sha);
    else await this.repo.assertPinnedLocalRef(id, record.artifact.sha);
    const archived = structuredClone(record);
    archived.archivedAt = intent.requestedAt;
    if (intent.releaseArtifact) archived.artifactReleasedAt = intent.requestedAt;
    delete archived.archiveIntent;
    const archivePath = await this.store.writeArchivedSubmission(archived);
    // The archive is durable before its derivative snapshot. Keep the active retirement intent
    // until both writes finish, so a lost manifest-write response is replayable without scanning
    // every archived record on each recovery.
    await this.store.ensureSubmissionManifest(archived);
    await this.store.transaction((state, audit) => {
      const current = activeRecord(state.submissions, id);
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        throw new BrokerError("SUBMISSION_CHANGED", "Submission changed before archival completed.");
      }
      delete state.submissions[id];
      audit("submission.archived", { submissionId: id, details: {
        candidateSha: record.artifact.sha,
        releasedArtifact: intent.releaseArtifact,
        archivePath,
      } });
    });
    return archivePath;
  }
}
