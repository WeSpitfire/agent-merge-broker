import path from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { BrokerError } from "./errors.js";
import {
  generateProvenanceSigningIdentity,
  provenanceKeyId,
  publicKeyFromPrivate,
  type ProvenanceSigningIdentity,
} from "./provenance.js";
import {
  STATE_VERSION,
  type AuditEvent,
  type BrokerState,
  type CommitReceipt,
  type CurrentBrokerState,
  type SubmissionRecord,
} from "./types.js";

/** Most recent audit bytes scanned by a read. Older events remain in the rotated segments. */
const AUDIT_TAIL_BYTES = 1_024 * 1_024;

/** Size at which the active audit file is rotated into an archive segment. */
const AUDIT_ROTATE_BYTES = 16 * 1_024 * 1_024;
const GATE_AUTHORITY_LOCK_NAME = "merge-broker-gate-authority";
/** Windows can transiently refuse a directory rename while another process closes a child handle. */
const WINDOWS_LOCK_RENAME_RETRY_MS = 2_000;

export interface LockStatus {
  name: string;
  held: boolean;
  path: string;
  owner?: { pid?: number; host?: string; createdAt?: string; nonce?: string };
  ageMs?: number;
  /** True only when the holder is provably gone: this machine, and the process no longer exists. */
  abandoned?: boolean;
}

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type AuditRecorder = (
  event: string,
  fields?: Omit<AuditEvent, "sequence" | "at" | "event">,
) => void;

export interface ArchivedStateSlice {
  archivedAt?: string;
  cutoff?: string;
  tasks: BrokerState["tasks"];
  batches: BrokerState["batches"];
}

export class StateStore {
  readonly commonGitDirectory: string;
  readonly directory: string;
  readonly worktreesDirectory: string;
  readonly archiveDirectory: string;
  readonly tokensDirectory: string;
  readonly submissionsDirectory: string;
  readonly provenanceSigningKeyFile: string;
  readonly provenanceKeysDirectory: string;
  private readonly stateFile: string;
  private readonly auditFile: string;
  private readonly receiptsDirectory: string;
  private readonly batchesDirectory: string;
  private readonly lockTimeoutMs: number;

  constructor(commonGitDir: string, stateDirectory: string, lockTimeoutSeconds: number) {
    this.commonGitDirectory = path.resolve(commonGitDir);
    this.directory = path.resolve(this.commonGitDirectory, stateDirectory);
    const relativeState = path.relative(this.commonGitDirectory, this.directory);
    if (
      relativeState === "" ||
      relativeState === ".." ||
      relativeState.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeState)
    ) {
      throw new BrokerError(
        "UNSAFE_PATH",
        "Broker state directory must be a child of Git's common directory.",
        { commonGitDirectory: this.commonGitDirectory, stateDirectory },
      );
    }
    this.worktreesDirectory = path.join(this.directory, "worktrees");
    this.archiveDirectory = path.join(this.directory, "archive");
    this.tokensDirectory = path.join(this.directory, "tokens");
    this.submissionsDirectory = path.join(this.directory, "submissions");
    this.provenanceSigningKeyFile = path.join(this.directory, "provenance-signing-key.pem");
    this.provenanceKeysDirectory = path.join(this.directory, "provenance-keys");
    this.stateFile = path.join(this.directory, "state.json");
    this.auditFile = path.join(this.directory, "audit.jsonl");
    this.receiptsDirectory = path.join(this.directory, "receipts");
    this.batchesDirectory = path.join(this.directory, "batches");
    this.lockTimeoutMs = lockTimeoutSeconds * 1_000;
  }

  /** Create one directory at a time and reject symlink/junction redirection before use. */
  private async ensurePhysicalDirectoryTree(directory: string): Promise<void> {
    const commonStatus = await lstat(this.commonGitDirectory);
    const physicalCommon = await realpath(this.commonGitDirectory);
    if (!commonStatus.isDirectory() || commonStatus.isSymbolicLink()) {
      throw new BrokerError("UNSAFE_PATH", "Git's common directory is not a physical directory.");
    }
    const relative = path.relative(this.commonGitDirectory, path.resolve(directory));
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new BrokerError("UNSAFE_PATH", "Broker state path escapes Git's common directory.", {
        directory,
      });
    }
    let cursor = this.commonGitDirectory;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const [status, physical] = await Promise.all([lstat(cursor), realpath(cursor)]);
      const physicalRelative = path.relative(physicalCommon, physical);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        physicalRelative === "" ||
        physicalRelative === ".." ||
        physicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(physicalRelative)
      ) {
        throw new BrokerError(
          "UNSAFE_PATH",
          "Broker state directory is redirected outside Git's physical common directory.",
          { directory: cursor, physicalPath: physical },
        );
      }
    }
  }

  async initialize(): Promise<void> {
    await this.ensurePhysicalDirectoryTree(this.directory);
    await chmod(this.directory, 0o700).catch(() => undefined);
    await Promise.all(
      [
        this.worktreesDirectory,
        this.receiptsDirectory,
        this.batchesDirectory,
        this.archiveDirectory,
        this.tokensDirectory,
        this.submissionsDirectory,
        this.provenanceKeysDirectory,
      ].map(async (directory) => {
        await this.ensurePhysicalDirectoryTree(directory);
        await chmod(directory, 0o700).catch(() => undefined);
      }),
    );
    if (!(await exists(this.stateFile))) {
      try {
        await writeFile(
          this.stateFile,
          `${JSON.stringify({
            version: STATE_VERSION,
            sequence: 0,
            tasks: {},
            batches: {},
            submissions: {},
          } satisfies CurrentBrokerState, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await chmod(this.stateFile, 0o600).catch(() => undefined);
  }

  async read(): Promise<CurrentBrokerState> {
    await this.initialize();
    const source = await readFile(this.stateFile, "utf8");
    let state: BrokerState;
    try {
      state = JSON.parse(source) as BrokerState;
    } catch (error) {
      throw new BrokerError("STATE_CORRUPT", `Broker state is not valid JSON: ${this.stateFile}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (state.version !== STATE_VERSION) {
      throw new BrokerError("STATE_VERSION", `Unsupported broker state version: ${String(state.version)}`);
    }
    if (state.submissions === undefined) {
      // Additive v1 migration: old readers preserve unknown fields, and old state files become
      // current on their next normal transaction without a separate destructive migration step.
      state.submissions = {};
    } else if (
      state.submissions === null ||
      typeof state.submissions !== "object" ||
      Array.isArray(state.submissions)
    ) {
      throw new BrokerError("STATE_CORRUPT", "Broker state submissions must be an object keyed by submission ID.");
    }
    return state as CurrentBrokerState;
  }

  async transaction<T>(mutator: (state: CurrentBrokerState, audit: AuditRecorder) => Promise<T> | T): Promise<T> {
    return await this.withLock("state", async () => {
      const state = await this.read();
      const events: AuditEvent[] = [];
      const record: AuditRecorder = (event, fields = {}) => {
        state.sequence += 1;
        events.push({ sequence: state.sequence, at: new Date().toISOString(), event, ...fields });
      };
      const result = await mutator(state, record);
      await this.atomicWrite(this.stateFile, state);
      if (events.length > 0) {
        await this.rotateAuditIfLarge();
        await appendFile(this.auditFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(this.auditFile, 0o600).catch(() => undefined);
      }
      return result;
    });
  }

  async withIntegrationLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withLock("integration", operation);
  }

  /**
   * Serializes Gate authority setup, adoption, and recovery at a config-independent location.
   * Holding this lock across validation prevents an explicit replacement from changing trust roots
   * while an older authority is still making progress.
   */
  async withGateAuthorityLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withLock(GATE_AUTHORITY_LOCK_NAME, operation, {
      directory: this.commonGitDirectory,
      initialize: false,
    });
  }

  async inspectGateAuthorityLock(): Promise<LockStatus> {
    const lock = await this.inspectLockAt(GATE_AUTHORITY_LOCK_NAME, this.commonGitDirectory);
    return { ...lock, name: "gate-authority" };
  }

  async releaseGateAuthorityLock(options: { force?: boolean } = {}): Promise<LockStatus> {
    const lock = await this.releaseLockAt(
      GATE_AUTHORITY_LOCK_NAME,
      options,
      this.commonGitDirectory,
    );
    return { ...lock, name: "gate-authority" };
  }

  /**
   * Serializes side-effecting work for one batch without blocking operations for unrelated batches.
   * The nonce is passed to the operation as a fencing identity and is also used to ensure an old
   * holder can never release a lock that has since been acquired by somebody else.
   */
  async withBatchLock<T>(batchId: string, operation: (ownerNonce: string) => Promise<T> | T): Promise<T> {
    return await this.withLock(this.batchLockName(batchId), operation);
  }

  batchLockName(batchId: string): string {
    return `batch-${safeName(batchId)}`;
  }

  async inspectBatchLock(batchId: string): Promise<LockStatus> {
    return await this.inspectLock(this.batchLockName(batchId));
  }

  async releaseBatchLock(batchId: string, options: { force?: boolean } = {}): Promise<LockStatus> {
    return await this.releaseLock(this.batchLockName(batchId), options);
  }

  async writeReceipt(receipt: CommitReceipt): Promise<string> {
    await this.initialize();
    const target = path.join(this.receiptsDirectory, `${safeName(receipt.taskId)}.json`);
    await this.atomicWrite(target, receipt);
    return target;
  }

  tokenPath(taskId: string): string {
    return path.join(this.tokensDirectory, `${safeName(taskId)}.token`);
  }

  /**
   * Holds a worker's lease token for it. A token shown once and never stored forces every adopter to
   * build a token store, and the obvious implementation puts a live credential in the working tree
   * where `git add` and validator commands can reach it. Here it stays owner-readable, beside the
   * state it authorizes, under a directory whose contents are already trusted.
   */
  async writeToken(taskId: string, token: string, target = this.tokenPath(taskId)): Promise<string> {
    const parent = path.dirname(target);
    const relativeToTokens = path.relative(this.tokensDirectory, parent);
    const brokerOwnedParent = !relativeToTokens.startsWith("..") && !path.isAbsolute(relativeToTokens);
    await mkdir(parent, { recursive: true, ...(brokerOwnedParent ? { mode: 0o700 } : {}) });
    if (brokerOwnedParent) await chmod(parent, 0o700).catch(() => undefined);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
    return target;
  }

  async readToken(taskId: string): Promise<string | undefined> {
    try {
      return (await readFile(this.tokenPath(taskId), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async deleteToken(taskId: string): Promise<void> {
    await rm(this.tokenPath(taskId), { force: true });
  }

  async readProvenanceSigningKey(trustedPublicKey?: string): Promise<string | undefined> {
    if (trustedPublicKey) {
      const keyId = provenanceKeyId(trustedPublicKey);
      try {
        return (await readFile(path.join(this.provenanceKeysDirectory, `${keyId}.pem`), "utf8")).trim() || undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      return (await readFile(this.provenanceSigningKeyFile, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Creates or imports the private half of the repository's provenance identity. It lives beside
   * runtime state, never in the working tree; only its public half is committed as verification
   * policy. Existing key material is reused unless rotation is explicit.
   */
  async provisionProvenanceSigningKey(options: {
    privateKey?: string;
    rotate?: boolean;
  } = {}): Promise<Omit<ProvenanceSigningIdentity, "privateKey"> & { keyPath: string }> {
    return await this.transaction(async () => {
      const existing = await this.readProvenanceSigningKey();
      if (existing && !options.rotate) {
        if (options.privateKey) {
          const existingId = provenanceKeyId(publicKeyFromPrivate(existing));
          const suppliedId = provenanceKeyId(publicKeyFromPrivate(options.privateKey));
          if (existingId !== suppliedId) {
            throw new BrokerError(
              "SIGNING_KEY_EXISTS",
              `A different provenance key already exists at ${this.provenanceSigningKeyFile}. Pass rotate explicitly to replace it.`,
              { existingKeyId: existingId, suppliedKeyId: suppliedId },
            );
          }
        }
        const publicKey = publicKeyFromPrivate(existing);
        await this.writePrivateKey(path.join(this.provenanceKeysDirectory, `${provenanceKeyId(publicKey)}.pem`), existing);
        return { publicKey, keyId: provenanceKeyId(publicKey), keyPath: this.provenanceSigningKeyFile };
      }

      const identity = options.privateKey
        ? {
            privateKey: options.privateKey,
            publicKey: publicKeyFromPrivate(options.privateKey),
            keyId: provenanceKeyId(publicKeyFromPrivate(options.privateKey)),
          }
        : generateProvenanceSigningIdentity();
      // Keyed copies are retained across rotation. If a process stops between replacing the local
      // current key and committing the new public-key policy, either policy can still find its
      // matching private key rather than leaving integration bricked halfway through rotation.
      await this.writePrivateKey(path.join(this.provenanceKeysDirectory, `${identity.keyId}.pem`), identity.privateKey);
      await this.writePrivateKey(this.provenanceSigningKeyFile, identity.privateKey);
      return {
        publicKey: identity.publicKey,
        keyId: identity.keyId,
        keyPath: this.provenanceSigningKeyFile,
      };
    });
  }

  private async writePrivateKey(target: string, privateKey: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700).catch(() => undefined);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, privateKey, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async writeBatchManifest(batchId: string, manifest: unknown): Promise<string> {
    await this.initialize();
    const target = path.join(this.batchesDirectory, `${safeName(batchId)}.json`);
    await this.atomicWrite(target, manifest);
    return target;
  }

  /** Writes a private, atomic snapshot of a durable submission record for external inspection. */
  async writeSubmissionManifest(submission: SubmissionRecord): Promise<string> {
    await this.initialize();
    const target = path.join(this.submissionsDirectory, `${safeName(submission.id)}.json`);
    await this.atomicWrite(target, submission);
    return target;
  }

  private async readAuditFile(target: string, limit: number): Promise<AuditEvent[]> {
    if (!(await exists(target))) return [];
    const handle = await open(target, "r");
    let text: string;
    let partialStart: boolean;
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - AUDIT_TAIL_BYTES);
      partialStart = start > 0;
      const length = size - start;
      if (length === 0) return [];
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    if (partialStart) lines.shift();
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        continue;
      }
    }
    return events.slice(-limit);
  }

  /**
   * Reads the newest audit events across the active stream and rotated segments. Deliberately
   * tolerant: a tail read can begin mid-line, and a crash between writing and flushing can leave a
   * truncated final line. Neither is a reason to make the audit trail unreadable.
   */
  async readAudit(limit = 100): Promise<AuditEvent[]> {
    const active = await this.readAuditFile(this.auditFile, limit);
    if (active.length >= limit) return active.slice(-limit);
    const archived = await readdir(this.archiveDirectory).catch(() => [] as string[]);
    const segments = archived
      .filter((file) => file.startsWith("audit-") && file.endsWith(".jsonl"))
      .sort()
      .reverse();
    const older: AuditEvent[] = [];
    for (const segment of segments) {
      older.unshift(...await this.readAuditFile(path.join(this.archiveDirectory, segment), limit - active.length));
      if (older.length + active.length >= limit) break;
    }
    return [...older, ...active]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-limit);
  }

  /** Completed state is archived in disjoint slices. Metrics use these so housekeeping is not data loss. */
  async readArchivedState(): Promise<ArchivedStateSlice[]> {
    const archived = await readdir(this.archiveDirectory).catch(() => [] as string[]);
    const slices: ArchivedStateSlice[] = [];
    for (const file of archived.filter((item) => item.startsWith("state-") && item.endsWith(".json")).sort()) {
      try {
        const value = JSON.parse(await readFile(path.join(this.archiveDirectory, file), "utf8")) as Partial<ArchivedStateSlice>;
        if (!value.tasks || !value.batches) continue;
        slices.push({
          ...(typeof value.archivedAt === "string" ? { archivedAt: value.archivedAt } : {}),
          ...(typeof value.cutoff === "string" ? { cutoff: value.cutoff } : {}),
          tasks: value.tasks,
          batches: value.batches,
        });
      } catch {
        // A bad historical slice must not hide current operational metrics. Its file remains for
        // manual recovery, while the audit trail still records that pruning occurred.
      }
    }
    return slices;
  }

  /**
   * Moves the active audit file aside once it grows large enough to make reads expensive. Segments
   * are never deleted: an audit stream that silently forgets is worse than a large one.
   */
  private async rotateAuditIfLarge(): Promise<void> {
    const current = await stat(this.auditFile).catch(() => undefined);
    if (!current || current.size < AUDIT_ROTATE_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    await mkdir(this.archiveDirectory, { recursive: true });
    await rename(this.auditFile, path.join(this.archiveDirectory, `audit-${stamp}.jsonl`));
  }

  /** Writes a retired slice of state to the archive directory and returns its path. */
  async archive(name: string, value: unknown): Promise<string> {
    await mkdir(this.archiveDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const label = name.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 32) || "archive";
    const target = path.join(this.archiveDirectory, `${label}-${stamp}.json`);
    await this.atomicWrite(target, value);
    return target;
  }

  async inspectLock(name: string): Promise<LockStatus> {
    return await this.inspectLockAt(name, this.directory);
  }

  private async inspectLockAt(name: string, directory: string): Promise<LockStatus> {
    const lockDirectory = path.join(directory, `${name}.lock`);
    const lockStat = await stat(lockDirectory).catch(() => undefined);
    if (!lockStat) return { name, held: false, path: lockDirectory };
    let owner: LockStatus["owner"];
    try {
      const parsed = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as {
        pid?: unknown;
        host?: unknown;
        createdAt?: unknown;
        nonce?: unknown;
      };
      owner = {
        ...(Number.isInteger(parsed.pid) ? { pid: parsed.pid as number } : {}),
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
        ...(typeof parsed.nonce === "string" ? { nonce: parsed.nonce } : {}),
      };
    } catch {
      owner = undefined;
    }
    return {
      name,
      held: true,
      path: lockDirectory,
      ...(owner ? { owner } : {}),
      ageMs: Date.now() - lockStat.mtimeMs,
      abandoned: this.lockOwnerCrashed(owner),
    };
  }

  /**
   * Releases a held lock. Without `force` this refuses unless the holder is provably gone, because
   * removing a live lock allows two integrations to run against the same repository at once.
   */
  async releaseLock(name: string, options: { force?: boolean } = {}): Promise<LockStatus> {
    return await this.releaseLockAt(name, options, this.directory);
  }

  private async releaseLockAt(
    name: string,
    options: { force?: boolean },
    directory: string,
  ): Promise<LockStatus> {
    const status = await this.inspectLockAt(name, directory);
    if (!status.held) return status;
    if (!options.force && !status.abandoned) {
      throw new BrokerError(
        "LOCK_HELD",
        `The ${name} lock is held by ${status.owner?.host ?? "an unknown host"} (pid ${
          status.owner?.pid ?? "unknown"
        }) and is not provably abandoned. Re-run with --force only after confirming no operation using this lock can still progress.`,
        { lock: status },
      );
    }
    if (status.owner?.nonce) {
      const released = await this.releaseOwnedLock(status.path, status.owner.nonce);
      if (!released) return await this.inspectLockAt(name, directory);
    } else {
      // Compatibility for locks written by releases before owner nonces were introduced. New locks
      // always take the owner-checked path above.
      await rm(status.path, { recursive: true, force: true });
    }
    return { ...status, held: false };
  }

  private async withLock<T>(
    name: string,
    operation: (ownerNonce: string) => Promise<T> | T,
    options: { directory?: string; initialize?: boolean } = {},
  ): Promise<T> {
    if (options.initialize === false) {
      await mkdir(options.directory ?? this.directory, { recursive: true, mode: 0o700 });
    } else {
      await this.initialize();
    }
    const lockDirectory = path.join(options.directory ?? this.directory, `${name}.lock`);
    const startedAt = Date.now();
    const ownerNonce = randomUUID();
    const owner = {
      pid: process.pid,
      host: hostname(),
      createdAt: new Date().toISOString(),
      nonce: ownerNonce,
    };
    while (true) {
      if (await this.tryAcquireLock(lockDirectory, owner)) break;
      const lockStat = await stat(lockDirectory).catch(() => undefined);
      // Time is not proof that a holder stopped. Reclaim only a process proven dead on this host;
      // foreign or unreadable owners require the explicit force-unlock path. Moving an old owner's
      // directory to a nonce-specific tombstone prevents two delayed reclaimers from deleting a
      // successor's lock. Do not open owner.json for a fresh lock: on Windows, that reader can
      // transiently prevent the live owner from renaming its directory during release.
      if (lockStat && Date.now() - lockStat.mtimeMs > 2_000) {
        const currentOwner = await this.readLockOwner(lockDirectory);
        if (
          this.lockOwnerCrashed(currentOwner) &&
          await this.reclaimLock(lockDirectory, currentOwner)
        ) {
          continue;
        }
      }
      if (Date.now() - startedAt > this.lockTimeoutMs) {
        throw new BrokerError("LOCK_TIMEOUT", `Timed out waiting for the ${name} lock.`, { lockDirectory });
      }
      await delay(50 + Math.floor(Math.random() * 100));
    }

    try {
      return await operation(ownerNonce);
    } finally {
      await this.releaseOwnedLock(lockDirectory, ownerNonce);
    }
  }

  /** Builds a complete owner directory before atomically publishing it as the active lock. */
  private async tryAcquireLock(
    lockDirectory: string,
    owner: { pid: number; host: string; createdAt: string; nonce: string },
  ): Promise<boolean> {
    const candidate = `${lockDirectory}.candidate-${owner.nonce}`;
    await mkdir(candidate, { mode: 0o700 });
    let acquired = false;
    try {
      await writeFile(path.join(candidate, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await rename(candidate, lockDirectory);
        acquired = true;
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // The destination can disappear immediately after rename reports that another owner holds
        // it. Windows reports this directory collision as EPERM, while POSIX filesystems normally
        // use EEXIST or ENOTEMPTY. Classify the atomic result instead of relying only on a later
        // existence check, which otherwise turns ordinary high-contention handoff into an error.
        if (
          code === "EEXIST" ||
          code === "ENOTEMPTY" ||
          (process.platform === "win32" && code === "EPERM")
        ) return false;
        if (await exists(lockDirectory)) return false;
        throw error;
      }
    } finally {
      if (!acquired) await rm(candidate, { recursive: true, force: true });
    }
  }

  private async readLockOwner(lockDirectory: string): Promise<LockStatus["owner"]> {
    try {
      const parsed = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as {
        pid?: unknown;
        host?: unknown;
        createdAt?: unknown;
        nonce?: unknown;
      };
      return {
        ...(Number.isInteger(parsed.pid) ? { pid: parsed.pid as number } : {}),
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
        ...(typeof parsed.nonce === "string" ? { nonce: parsed.nonce } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Removes only the active lock carrying this exact ownership nonce. */
  private async releaseOwnedLock(lockDirectory: string, ownerNonce: string): Promise<boolean> {
    const retired = `${lockDirectory}.released-${ownerNonce}`;
    const startedAt = Date.now();
    while (true) {
      // Recheck before every attempt so a delayed Windows retry can never retire a successor's
      // lock after an out-of-protocol forced replacement.
      const current = await this.readLockOwner(lockDirectory);
      if (current?.nonce !== ownerNonce) return false;
      try {
        await rename(lockDirectory, retired);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return false;
        const retryableWindowsSharingViolation =
          process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
        if (!retryableWindowsSharingViolation || Date.now() - startedAt >= WINDOWS_LOCK_RENAME_RETRY_MS) {
          throw error;
        }
        await delay(10 + Math.floor(Math.random() * 40));
      }
    }
    const moved = await this.readLockOwner(retired);
    if (moved?.nonce !== ownerNonce) {
      // This requires an out-of-protocol forced replacement between the owner check and rename.
      // Restore it rather than deleting somebody else's lock.
      await rename(retired, lockDirectory).catch(() => undefined);
      return false;
    }
    await rm(retired, { recursive: true, force: true });
    return true;
  }

  /**
   * Atomically moves a provably dead owner aside. Its nonce-specific, non-empty tombstone is kept so
   * a delayed second reclaimer cannot later move a newly acquired lock into the same destination.
   */
  private async reclaimLock(lockDirectory: string, owner: LockStatus["owner"]): Promise<boolean> {
    const identity = lockOwnerIdentity(owner);
    if (!identity) return false;
    const reclaimed = `${lockDirectory}.reclaimed-${identity}`;
    try {
      await rename(lockDirectory, reclaimed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY" || await exists(reclaimed)) return false;
      throw error;
    }
    const moved = await this.readLockOwner(reclaimed);
    if (lockOwnerIdentity(moved) === identity) return true;
    await rename(reclaimed, lockDirectory).catch(() => undefined);
    return false;
  }

  /**
   * True only when the lock is provably abandoned: written by this machine, by a process that is
   * gone. An unreadable owner file is not proof -- it is also what a lock looks like in the instant
   * between creating the directory and recording its owner.
   */
  private lockOwnerCrashed(owner: LockStatus["owner"]): boolean {
    if (!owner) return false;
    // Records written before owners carried a hostname fall back to the process check. Treating them
    // as foreign instead would strand a crashed holder's lock for the full stale timeout.
    if (owner.host !== undefined && owner.host !== hostname()) return false;
    if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return false;
    try {
      process.kill(owner.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }

  private async atomicWrite(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }
}

function lockOwnerIdentity(owner: LockStatus["owner"]): string | undefined {
  if (!owner) return undefined;
  if (owner.nonce) return owner.nonce.replace(/[^a-zA-Z0-9_-]/gu, "-");
  if (owner.pid === undefined && owner.host === undefined && owner.createdAt === undefined) return undefined;
  return `legacy-${createHash("sha256").update(JSON.stringify(owner)).digest("hex").slice(0, 24)}`;
}

function safeName(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable || "record"}-${digest}`;
}
