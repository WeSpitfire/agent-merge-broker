import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { CONFIG_DIRECTORY, CONFIG_FILENAME, validateConfig } from "./config.js";
import { BrokerError, ValidationError } from "./errors.js";
import { assertGateAuthorityMatchesProtectedConfig } from "./gate-authority.js";
import { adoptedRef, GitRepository, remoteUrlFingerprint } from "./git.js";
import { StateStore } from "./store.js";
import {
  createValidationCacheDirectory,
  removeValidationCacheDirectory,
  runValidators,
} from "./validation.js";
import type {
  BrokerConfig,
  GateAuthorityRegistration,
  SubmissionBaseIdentity,
  SubmissionPolicyIdentity,
  SubmissionRecord,
  SubmissionWorktreeIdentity,
  ValidationResult,
} from "./types.js";

const POLICY_EVALUATOR_VERSION = "agent-merge-broker/submission-policy/v1";
const POLICY_CONFIG_PATH = `${CONFIG_DIRECTORY}/${CONFIG_FILENAME}`;
const MAXIMUM_POLICY_BYTES = 1 * 1_024 * 1_024;

export interface SubmissionRecovery {
  recovered: string[];
  warnings: string[];
}

interface LoadedSubmissionPolicy {
  config: BrokerConfig;
  identity: SubmissionPolicyIdentity;
}

function now(): string {
  return new Date().toISOString();
}

function submissionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  return `submission-${stamp}-${randomBytes(8).toString("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof BrokerError ? error.code : "SUBMISSION_FAILED";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      // Code-unit order is locale-independent, so the same protected policy has one digest on
      // every supported host.
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function submissionPolicyDocument(config: BrokerConfig): Record<string, unknown> {
  return {
    version: 1,
    policies: config.policies,
    scheduling: { maxCommits: config.scheduling.maxCommits },
    validation: config.validation,
    approval: config.approval,
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireSubmission(
  submissions: Record<string, SubmissionRecord>,
  id: string,
): SubmissionRecord {
  const submission = Object.hasOwn(submissions, id) ? submissions[id] : undefined;
  if (!submission) throw new BrokerError("UNKNOWN_SUBMISSION", `Unknown candidate submission: ${id}`);
  return submission;
}

/**
 * Trusted local-ref intake is deliberately its own aggregate. It does not manufacture a task,
 * lease, receipt, or integration batch for work that did not pass through Coordinate mode.
 */
export class LocalRefSubmissionManager {
  constructor(
    private readonly repo: GitRepository,
    private readonly store: StateStore,
    private readonly authority: GateAuthorityRegistration,
  ) {}

  async adopt(ref: string): Promise<SubmissionRecord> {
    const requestedRef = ref.trim();
    if (
      requestedRef.length === 0 ||
      requestedRef.length > 1_024 ||
      /[\x00-\x1f\x7f]/u.test(requestedRef)
    ) {
      throw new BrokerError(
        "INVALID_SUBMISSION_REF",
        "--ref must be a non-empty Git revision without control characters.",
      );
    }

    // Gate's local-only object guarantee depends on Git 2.46 and a repository-owned object store.
    // Check both before resolving either the candidate or the configured protected base.
    await this.repo.assertGateGitSupported();
    await this.repo.assertGateObjectStoreSupported();

    return await this.store.withIntegrationLock(async () => {
      const base = await this.resolveConfiguredBase();
      const policy = await this.loadPolicy(base.sha);
      assertGateAuthorityMatchesProtectedConfig(this.authority, policy.config);
      if (policy.config.validation.authority !== "broker") {
        throw new BrokerError(
          "SUBMISSION_VALIDATION_UNAVAILABLE",
          "Trusted local-ref adoption currently requires validation.authority broker; required-ci needs a published change and is not part of this intake slice.",
          { authority: policy.config.validation.authority, baseSha: base.sha },
        );
      }

      const history = await this.repo.requireLinearHistory(base.sha, requestedRef, {
        maximumCommits: policy.config.scheduling.maxCommits,
      });
      const artifactSha = history.headOid;
      if (history.commits.length === 0) {
        throw new BrokerError(
          "EMPTY_SUBMISSION",
          `Candidate ${artifactSha} has no commits after protected base ${base.sha}.`,
          { candidateSha: artifactSha, baseSha: base.sha },
        );
      }
      if (history.commits.length > policy.config.scheduling.maxCommits) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Candidate has ${history.commits.length} commits; protected-base policy permits at most ${policy.config.scheduling.maxCommits}.`,
          { commits: history.commits.length, maximum: policy.config.scheduling.maxCommits },
        );
      }

      await this.repo.assertLocalObjectClosure([history.baseOid, ...history.commits]);

      // Preserve the conservative union of every path touched by the retained history, including
      // a path changed and later restored. A future publication may retain these commits, so a
      // final-tree-only diff is not enough input for path-scoped policy.
      const paths = await this.repo.changedFilesForLinearHistory(history.baseOid, history.commits);
      if (paths.length === 0) {
        throw new BrokerError(
          "EMPTY_SUBMISSION",
          `Candidate ${artifactSha} has no tree changes from protected base ${base.sha}.`,
          { candidateSha: artifactSha, baseSha: base.sha },
        );
      }
      const treeSha = await this.treeSha(artifactSha);
      const id = submissionId();
      const timestamp = now();
      const record: SubmissionRecord = {
        version: 1,
        id,
        status: "received",
        authorityDigest: this.authority.digest,
        source: { kind: "local-ref", ref: requestedRef },
        artifact: {
          kind: "git-commit",
          sha: artifactSha,
          treeSha,
          retainedRef: adoptedRef(id),
        },
        base,
        policy: policy.identity,
        commits: history.commits,
        paths,
        validations: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      // State is the durable intent. Pinning Git happens second, so a process stop never leaves a
      // broker-owned ref with no aggregate that can explain or recover it.
      await this.store.transaction((state, audit) => {
        if (Object.hasOwn(state.submissions, id)) {
          throw new BrokerError("SUBMISSION_EXISTS", `Candidate submission already exists: ${id}`);
        }
        state.submissions[id] = structuredClone(record);
        audit("submission.received", {
          submissionId: id,
          details: {
            source: requestedRef,
            candidateSha: artifactSha,
            baseSha: base.sha,
            policyDigest: policy.identity.digest,
          },
        });
      });

      return await this.validateLocked(id);
    });
  }

  async get(id: string): Promise<SubmissionRecord> {
    const state = await this.store.read();
    return structuredClone(requireSubmission(state.submissions, id));
  }

  async recoverPending(): Promise<SubmissionRecovery> {
    return await this.store.withIntegrationLock(async () => {
      const pending = Object.values((await this.store.read()).submissions)
        .filter((submission) => submission.status === "received" || submission.status === "validating")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const recovered: string[] = [];
      const warnings: string[] = [];
      // A repository may retain terminal Gate history while running ordinary Coordinate recovery
      // on a host below Gate's Git floor. Do not make unrelated recovery depend on Gate tooling
      // unless there is an in-progress submission that actually needs object inspection.
      if (pending.length === 0) return { recovered, warnings };
      await this.repo.assertGateGitSupported();
      await this.repo.assertGateObjectStoreSupported();
      for (const submission of pending) {
        try {
          await this.validateLocked(submission.id);
          recovered.push(submission.id);
        } catch (error) {
          warnings.push(`Could not recover candidate submission ${submission.id}: ${errorMessage(error)}`);
        }
      }
      return { recovered, warnings };
    });
  }

  private async validateLocked(id: string): Promise<SubmissionRecord> {
    const snapshot = requireSubmission((await this.store.read()).submissions, id);
    if (snapshot.status !== "received" && snapshot.status !== "validating") {
      return structuredClone(snapshot);
    }
    this.assertAuthorityIdentity(snapshot);

    const worktree = path.join(this.store.worktreesDirectory, `submission-${id}`);
    const validationStartedAt = snapshot.validationStartedAt ?? now();
    await this.store.transaction((state, audit) => {
      const current = requireSubmission(state.submissions, id);
      if (current.status !== "received" && current.status !== "validating") {
        throw new BrokerError("SUBMISSION_CHANGED", `Candidate submission ${id} changed before validation.`);
      }
      current.status = "validating";
      current.worktree = worktree;
      current.validationStartedAt ??= validationStartedAt;
      current.updatedAt = now();
      audit("submission.validation_started", {
        submissionId: id,
        details: { candidateSha: current.artifact.sha, baseSha: current.base.sha },
      });
    });

    const validations: ValidationResult[] = [];
    let terminalStatus: SubmissionRecord["status"] = "validated";
    let terminalError: string | undefined;
    let terminalErrorCode: string | undefined;
    let worktreeAdded = false;
    let worktreeIdentity: SubmissionWorktreeIdentity | undefined;
    let cacheDirectory: string | undefined;
    let cacheCleanupError: unknown;
    const journalRetentionCompromise = async (): Promise<void> => {
      await this.store.transaction((state, audit) => {
        const stored = requireSubmission(state.submissions, id);
        if (stored.status !== "validating") {
          throw new BrokerError("SUBMISSION_CHANGED", `Candidate submission ${id} changed during retention repair.`);
        }
        stored.retentionCompromisedAt ??= now();
        stored.updatedAt = now();
        audit("submission.retention_compromised", {
          submissionId: id,
          details: { candidateSha: snapshot.artifact.sha },
        });
      });
    };
    try {
      const pinned = snapshot.retentionEstablishedAt
        ? await this.repo.retainPinnedLocalRef(
          snapshot.id,
          snapshot.artifact.sha,
          journalRetentionCompromise,
        ).then(() => ({ ref: snapshot.artifact.retainedRef, oid: snapshot.artifact.sha }))
        : await this.repo.pinLocalRef(snapshot.artifact.sha, snapshot.id);
      if (pinned.ref !== snapshot.artifact.retainedRef || pinned.oid !== snapshot.artifact.sha) {
        throw new BrokerError(
          "SUBMISSION_REF_CHANGED",
          `The retained ref for candidate submission ${id} does not match its durable artifact identity.`,
          { expected: snapshot.artifact, actual: pinned },
        );
      }
      if (!snapshot.retentionEstablishedAt) {
        await this.store.transaction((state, audit) => {
          const stored = requireSubmission(state.submissions, id);
          if (stored.status !== "validating") {
            throw new BrokerError("SUBMISSION_CHANGED", `Candidate submission ${id} changed while retaining its ref.`);
          }
          stored.retentionEstablishedAt ??= now();
          stored.updatedAt = now();
          audit("submission.retention_established", {
            submissionId: id,
            details: { candidateSha: snapshot.artifact.sha },
          });
        });
      }
      await this.assertRecordedIdentity(snapshot);
      const policy = await this.loadPolicy(snapshot.base.sha);
      assertGateAuthorityMatchesProtectedConfig(this.authority, policy.config);
      this.assertPolicyIdentity(snapshot.policy, policy.identity);

      await this.removeWorktreeIfPresent(worktree, snapshot.worktreeIdentity);
      // The previous inode is no longer meaningful once cleanup succeeds. Clear it durably before
      // Git can register a replacement worktree: a crash after registration but before capturing
      // the new inode must enter the narrow pristine-backlink recovery path, not compare I2 to I1
      // forever.
      await this.store.transaction((state) => {
        const current = requireSubmission(state.submissions, id);
        if (current.status !== "validating" || current.worktree !== worktree) {
          throw new BrokerError(
            "SUBMISSION_CHANGED",
            `Candidate submission ${id} changed before worktree replacement.`,
          );
        }
        delete current.worktreeIdentity;
        current.updatedAt = now();
      });
      const preparedWorktreeIdentity = await this.repo.prepareRawWorktreeRoot(worktree);
      worktreeAdded = true;
      worktreeIdentity = preparedWorktreeIdentity;
      await this.store.transaction((state) => {
        const current = requireSubmission(state.submissions, id);
        if (current.status !== "validating" || current.worktree !== worktree) {
          throw new BrokerError(
            "SUBMISSION_CHANGED",
            `Candidate submission ${id} changed before worktree registration.`,
          );
        }
        current.worktreeIdentity = structuredClone(preparedWorktreeIdentity);
        current.updatedAt = now();
      });
      await this.repo.addRawDetachedWorktree(worktree, snapshot.artifact.sha);
      const capturedWorktreeIdentity = await this.repo.gateWorktreeIdentity(worktree);
      if (
        capturedWorktreeIdentity.device !== preparedWorktreeIdentity.device ||
        capturedWorktreeIdentity.inode !== preparedWorktreeIdentity.inode
      ) {
        throw new BrokerError(
          "WORKTREE_IDENTITY_UNAVAILABLE",
          `Gate worktree root changed during registration for candidate submission ${id}.`,
        );
      }
      worktreeIdentity = capturedWorktreeIdentity;
      await this.store.transaction((state) => {
        const current = requireSubmission(state.submissions, id);
        if (current.status !== "validating" || current.worktree !== worktree) {
          throw new BrokerError(
            "SUBMISSION_CHANGED",
            `Candidate submission ${id} changed before validator execution.`,
          );
        }
        current.worktreeIdentity = structuredClone(capturedWorktreeIdentity);
        current.updatedAt = now();
      });
      cacheDirectory = await createValidationCacheDirectory();

      const focused = await runValidators({
        validators: policy.config.validation.focused,
        scope: "focused",
        cwd: worktree,
        files: snapshot.paths,
        baseSha: snapshot.base.sha,
        headSha: snapshot.artifact.sha,
        batchId: `submission:${id}`,
        submissionId: id,
        requirePhysicalWorkingDirectory: true,
        cacheDirectory,
        ...(policy.config.validation.shell ? { shell: policy.config.validation.shell } : {}),
      });
      validations.push(...focused);
      await this.assertValidatorPreservedCandidate(worktree, snapshot.artifact.sha, "focused");

      const authoritative = await runValidators({
        validators: policy.config.validation.authoritative,
        scope: "authoritative",
        cwd: worktree,
        files: snapshot.paths,
        baseSha: snapshot.base.sha,
        headSha: snapshot.artifact.sha,
        batchId: `submission:${id}`,
        submissionId: id,
        requirePhysicalWorkingDirectory: true,
        cacheDirectory,
        ...(policy.config.validation.shell ? { shell: policy.config.validation.shell } : {}),
      });
      validations.push(...authoritative);
      await this.assertValidatorPreservedCandidate(worktree, snapshot.artifact.sha, "authoritative");
    } catch (error) {
      const completed = error instanceof ValidationError
        ? error.details?.completedValidations
        : undefined;
      if (Array.isArray(completed)) {
        validations.push(
          ...(completed as ValidationResult[]).filter((item) => !validations.includes(item)),
        );
      }
      terminalStatus = error instanceof ValidationError ||
          (error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE")
        ? "rejected"
        : "failed";
      terminalError = errorMessage(error);
      terminalErrorCode = errorCode(error);
    } finally {
      if (cacheDirectory) {
        try {
          await removeValidationCacheDirectory(cacheDirectory);
        } catch (error) {
          cacheCleanupError = error;
        }
      }
    }

    if (cacheCleanupError) {
      const diagnostic = `Could not remove the isolated validator cache: ${errorMessage(cacheCleanupError)}`;
      if (terminalStatus === "validated") {
        terminalStatus = "failed";
        terminalErrorCode = "VALIDATION_CACHE_CLEANUP_FAILED";
        terminalError = diagnostic;
      } else {
        terminalError = terminalError ? `${terminalError}\n${diagnostic}` : diagnostic;
      }
    }

    // Cleanup is part of the transaction boundary. If it fails, leave `validating` durable so the
    // ordinary recovery command retries from the immutable ref instead of claiming completion.
    if (worktreeAdded) {
      await this.repo.removeWorktree(worktree, {
        strictGateCleanup: true,
        ...(worktreeIdentity ? { expectedRootIdentity: worktreeIdentity } : {}),
      });
    }
    else await this.removeWorktreeIfPresent(worktree, snapshot.worktreeIdentity);

    // This check is deliberately outside the validator-success path and after cleanup. A missing
    // broker-owned ref is restored with create-only CAS so a truthful validator rejection can
    // remain durable. A wrong or symbolic ref is never repaired, and loss of the ref invalidates
    // an otherwise-successful run even if cleanup was the last operation to remove it.
    await this.repo.retainPinnedLocalRef(
      snapshot.id,
      snapshot.artifact.sha,
      journalRetentionCompromise,
    );

    const current = requireSubmission((await this.store.read()).submissions, id);
    if (current.status !== "validating") {
      throw new BrokerError("SUBMISSION_CHANGED", `Candidate submission ${id} changed during validation.`);
    }
    if (current.retentionCompromisedAt && terminalStatus === "validated") {
      terminalStatus = "failed";
      terminalErrorCode = "SUBMISSION_REF_CHANGED";
      terminalError =
        `The retained ref for candidate submission ${id} was removed during validation; ` +
        "the broker restored it, but validation success was discarded.";
    }
    const finished = structuredClone(current);
    finished.status = terminalStatus;
    finished.validations = validations;
    finished.updatedAt = now();
    finished.finishedAt = finished.updatedAt;
    delete finished.worktree;
    delete finished.worktreeIdentity;
    if (terminalError) finished.error = terminalError;
    else delete finished.error;
    if (terminalErrorCode) finished.errorCode = terminalErrorCode;
    else delete finished.errorCode;

    // Keep the bounded but potentially expensive graph/tree/object proof out of the global state
    // lock while placing it immediately before the terminal transition.
    await this.assertRecordedIdentity(snapshot);
    const committed = await this.store.transaction(async (state, audit) => {
      // The expensive closure/history proof ran immediately above. Keep the global state lock
      // short, but read the direct retention ref as the final external fact before terminal state.
      await this.repo.assertPinnedLocalRef(snapshot.id, snapshot.artifact.sha);
      const stored = requireSubmission(state.submissions, id);
      if (
        stored.status !== "validating" ||
        stored.authorityDigest !== finished.authorityDigest ||
        stored.artifact.sha !== finished.artifact.sha ||
        stored.base.sha !== finished.base.sha ||
        stored.policy.digest !== finished.policy.digest
      ) {
        throw new BrokerError("SUBMISSION_CHANGED", `Candidate submission ${id} changed during validation.`);
      }
      state.submissions[id] = structuredClone(finished);
      audit(`submission.${terminalStatus}`, {
        submissionId: id,
        details: {
          candidateSha: finished.artifact.sha,
          baseSha: finished.base.sha,
          validations: validations.map((validation) => ({
            name: validation.name,
            scope: validation.scope,
            exitCode: validation.exitCode,
          })),
          ...(terminalError ? { error: terminalError, errorCode: terminalErrorCode } : {}),
        },
      });
      return structuredClone(finished);
    });

    // State is authoritative and must lead the derived sidecar. A crash here leaves a missing or
    // stale manifest, never a false terminal success; recovery regenerates terminal sidecars.
    try {
      await this.store.writeSubmissionManifest(committed);
    } catch (error) {
      throw new BrokerError(
        "SUBMISSION_MANIFEST_WRITE_FAILED",
        `Candidate submission ${id} reached terminal state, but its derived manifest could not be written.`,
        { submissionId: id, cause: errorMessage(error) },
      );
    }
    return committed;
  }

  private async resolveConfiguredBase(): Promise<SubmissionBaseIdentity> {
    const target = this.authority.target;
    const configuredRef = target.baseRef;
    const exactRemoteUrl = target.fetchUrlFingerprint
      ? await this.repo.remoteFetchUrl(target.remote)
      : undefined;
    if (
      exactRemoteUrl &&
      remoteUrlFingerprint(exactRemoteUrl) !== target.fetchUrlFingerprint
    ) {
      throw new BrokerError(
        "GATE_AUTHORITY_MISMATCH",
        `Remote ${target.remote} no longer points at the fetch target registered for Gate adoption.`,
        {
          expectedFingerprint: target.fetchUrlFingerprint,
          actualFingerprint: remoteUrlFingerprint(exactRemoteUrl),
        },
      );
    }

    let sha: string;
    const configuredRefNamesTarget =
      configuredRef === target.baseBranch ||
      configuredRef === `${target.remote}/${target.baseBranch}` ||
      configuredRef === `refs/remotes/${target.remote}/${target.baseBranch}`;
    if (
      target.refreshBase &&
      configuredRefNamesTarget &&
      exactRemoteUrl
    ) {
      const fetched = await this.repo.fetchBranchHead(
        exactRemoteUrl,
        target.baseBranch,
      );
      if (!fetched) {
        throw new BrokerError(
          "BASE_REFRESH_FAILED",
          `Could not refresh ${target.remote}/${target.baseBranch}; refusing to adopt a candidate against stale policy.`,
        );
      }
      sha = fetched;
    } else {
      sha = await this.repo.resolveLocalCommit(configuredRef);
    }

    return {
      ref: configuredRef,
      baseBranch: target.baseBranch,
      remote: target.remote,
      ...(target.fetchUrlFingerprint ? { fetchUrlFingerprint: target.fetchUrlFingerprint } : {}),
      sha,
    };
  }

  private assertAuthorityIdentity(submission: SubmissionRecord): void {
    const target = this.authority.target;
    if (
      submission.authorityDigest !== this.authority.digest ||
      submission.base.ref !== target.baseRef ||
      submission.base.baseBranch !== target.baseBranch ||
      submission.base.remote !== target.remote ||
      submission.base.fetchUrlFingerprint !== target.fetchUrlFingerprint
    ) {
      throw new BrokerError(
        "GATE_AUTHORITY_CHANGED",
        `Candidate submission ${submission.id} was received under a different Gate authority. Restore that registration before recovery; do not silently replay it under a replacement.`,
        {
          submissionId: submission.id,
          submissionAuthorityDigest: submission.authorityDigest,
          currentAuthorityDigest: this.authority.digest,
        },
      );
    }
  }

  private async loadPolicy(baseSha: string): Promise<LoadedSubmissionPolicy> {
    const object = `${baseSha}:${POLICY_CONFIG_PATH}`;
    const blob = await this.repo.localObjectGit(
      ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", object],
      this.repo.root,
      true,
    );
    const configBlobSha = blob.stdout.trim();
    if (blob.exitCode !== 0 || !configBlobSha) {
      throw new BrokerError(
        "SUBMISSION_POLICY_UNAVAILABLE",
        `Protected base ${baseSha} does not contain ${POLICY_CONFIG_PATH}. Commit broker policy on the protected side before adopting candidates.`,
        { baseSha, configPath: POLICY_CONFIG_PATH },
      );
    }
    const sizeResult = await this.repo.localObjectGit(
      ["--no-replace-objects", "cat-file", "-s", configBlobSha],
      this.repo.root,
      true,
    );
    const policyBytes = Number(sizeResult.stdout.trim());
    if (
      sizeResult.exitCode !== 0 ||
      !Number.isSafeInteger(policyBytes) ||
      policyBytes < 0 ||
      policyBytes > MAXIMUM_POLICY_BYTES
    ) {
      throw new BrokerError(
        "SUBMISSION_POLICY_INVALID",
        `Protected-base policy ${POLICY_CONFIG_PATH} exceeds the ${MAXIMUM_POLICY_BYTES}-byte Gate safety limit or has an invalid Git object size.`,
        { baseSha, configBlobSha, policyBytes: sizeResult.stdout.trim(), maximumBytes: MAXIMUM_POLICY_BYTES },
      );
    }
    const contents = await this.repo.localObjectGit(
      ["--no-replace-objects", "cat-file", "blob", configBlobSha],
      this.repo.root,
      true,
    );
    if (contents.exitCode !== 0) {
      throw new BrokerError(
        "SUBMISSION_POLICY_UNAVAILABLE",
        `Could not read protected-base policy blob ${configBlobSha}.`,
        { baseSha, configBlobSha, stderr: contents.stderr },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.stdout);
    } catch (error) {
      throw new BrokerError(
        "SUBMISSION_POLICY_INVALID",
        `Protected-base policy ${POLICY_CONFIG_PATH} is not valid JSON.`,
        { baseSha, cause: errorMessage(error) },
      );
    }
    let config: BrokerConfig;
    try {
      config = validateConfig(parsed);
    } catch (error) {
      throw new BrokerError(
        "SUBMISSION_POLICY_INVALID",
        `Protected-base policy ${POLICY_CONFIG_PATH} is invalid: ${errorMessage(error)}`,
        { baseSha, cause: errorMessage(error) },
      );
    }
    const document = submissionPolicyDocument(config);
    const digest = createHash("sha256")
      .update(`${POLICY_EVALUATOR_VERSION}\0${canonicalJson(document)}`)
      .digest("hex");
    return {
      config,
      identity: {
        baseSha,
        configPath: POLICY_CONFIG_PATH,
        configBlobSha,
        digest,
        revision: config.approval?.policyRevision ?? "default",
        evaluatorVersion: POLICY_EVALUATOR_VERSION,
        configVersion: config.version,
      },
    };
  }

  private assertPolicyIdentity(
    expected: SubmissionPolicyIdentity,
    actual: SubmissionPolicyIdentity,
  ): void {
    if (
      expected.baseSha !== actual.baseSha ||
      expected.configPath !== actual.configPath ||
      expected.configBlobSha !== actual.configBlobSha ||
      expected.digest !== actual.digest ||
      expected.revision !== actual.revision ||
      expected.evaluatorVersion !== actual.evaluatorVersion ||
      expected.configVersion !== actual.configVersion
    ) {
      throw new BrokerError(
        "SUBMISSION_POLICY_CHANGED",
        "The protected-base policy no longer matches the identity recorded for this candidate submission.",
        { expected, actual },
      );
    }
  }

  private async assertRecordedIdentity(submission: SubmissionRecord): Promise<void> {
    // Validators run with trusted-host authority but may still alter repository plumbing by bug.
    // Re-prove the owned, non-redirected object store immediately before every replay/terminal
    // identity decision; otherwise a post-entry alternate or symlink could make borrowed bytes
    // appear durably retained.
    await this.repo.assertGateObjectStoreSupported();
    const history = await this.repo.requireLinearHistory(
      submission.base.sha,
      submission.artifact.sha,
      { maximumCommits: submission.commits.length },
    );
    await this.repo.assertLocalObjectClosure([history.baseOid, ...history.commits]);
    const [treeSha, paths] = await Promise.all([
      this.treeSha(submission.artifact.sha),
      this.repo.changedFilesForLinearHistory(history.baseOid, history.commits),
    ]);
    if (
      history.baseOid !== submission.base.sha ||
      history.headOid !== submission.artifact.sha ||
      treeSha !== submission.artifact.treeSha ||
      !sameStrings(history.commits, submission.commits) ||
      !sameStrings(paths, submission.paths)
    ) {
      throw new BrokerError(
        "SUBMISSION_IDENTITY_CHANGED",
        `Git no longer reproduces the durable identity of candidate submission ${submission.id}.`,
        { submissionId: submission.id },
      );
    }
  }

  private async treeSha(commit: string): Promise<string> {
    const result = await this.repo.localObjectGit(
      ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`],
      this.repo.root,
      true,
    );
    const treeSha = result.stdout.trim();
    if (result.exitCode !== 0 || !treeSha) {
      throw new BrokerError("UNKNOWN_COMMIT", `Could not resolve the tree for Git commit ${commit}.`, {
        commit,
        stderr: result.stderr,
      });
    }
    return treeSha;
  }

  private async assertValidatorPreservedCandidate(
    worktree: string,
    expectedHead: string,
    validatorScope: "focused" | "authoritative",
  ): Promise<void> {
    try {
      await this.repo.assertRawWorktree(worktree, expectedHead);
    } catch (error) {
      if (error instanceof BrokerError && error.code === "VALIDATOR_MUTATED_WORKTREE") {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `The ${validatorScope} validator changed the retained candidate. Validators must leave HEAD, index, and every worktree byte unchanged.`,
          { ...error.details, expectedHead, validatorScope },
        );
      }
      throw error;
    }
  }

  private async removeWorktreeIfPresent(
    worktree: string,
    expectedRootIdentity?: SubmissionWorktreeIdentity,
  ): Promise<void> {
    const root = `${path.resolve(this.store.worktreesDirectory)}${path.sep}`;
    const resolved = path.resolve(worktree);
    if (!resolved.startsWith(root)) {
      throw new BrokerError(
        "UNSAFE_PATH",
        `Refused to remove candidate worktree outside broker state: ${resolved}`,
      );
    }
    const exists = await lstat(resolved).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      await this.repo.removeWorktree(resolved, {
        strictGateCleanup: true,
        ...(expectedRootIdentity ? { expectedRootIdentity } : {}),
      });
      return;
    }

    // A missing path can still have a stale linked-worktree registry entry. Never prune or remove
    // it through ordinary cleanup without Gate's exact backlink/common-directory proof.
    const physicalResolved = path.join(
      await realpath(path.dirname(resolved)),
      path.basename(resolved),
    );
    const registered = (await Promise.all((await this.repo.listWorktrees()).map(async (item) =>
      path.join(
        await realpath(path.dirname(path.resolve(item.path))).catch(() => ""),
        path.basename(item.path),
      )))).some((physicalPath) => physicalPath === physicalResolved);
    if (registered) {
      await this.repo.removeWorktree(resolved, {
        strictGateCleanup: true,
        ...(expectedRootIdentity ? { expectedRootIdentity } : {}),
      });
    }
  }
}
