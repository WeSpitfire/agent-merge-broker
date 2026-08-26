import path from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
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
import { STATE_VERSION, type AuditEvent, type BrokerState, type CommitReceipt } from "./types.js";

/** Most recent audit bytes scanned by a read. Older events remain in the rotated segments. */
const AUDIT_TAIL_BYTES = 1_024 * 1_024;

/** Size at which the active audit file is rotated into an archive segment. */
const AUDIT_ROTATE_BYTES = 16 * 1_024 * 1_024;

export interface LockStatus {
  name: string;
  held: boolean;
  path: string;
  owner?: { pid?: number; host?: string; createdAt?: string };
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

export class StateStore {
  readonly directory: string;
  readonly worktreesDirectory: string;
  readonly archiveDirectory: string;
  readonly tokensDirectory: string;
  readonly provenanceSigningKeyFile: string;
  readonly provenanceKeysDirectory: string;
  private readonly stateFile: string;
  private readonly auditFile: string;
  private readonly receiptsDirectory: string;
  private readonly batchesDirectory: string;
  private readonly lockTimeoutMs: number;

  constructor(commonGitDir: string, stateDirectory: string, lockTimeoutSeconds: number) {
    this.directory = path.resolve(commonGitDir, stateDirectory);
    this.worktreesDirectory = path.join(this.directory, "worktrees");
    this.archiveDirectory = path.join(this.directory, "archive");
    this.tokensDirectory = path.join(this.directory, "tokens");
    this.provenanceSigningKeyFile = path.join(this.directory, "provenance-signing-key.pem");
    this.provenanceKeysDirectory = path.join(this.directory, "provenance-keys");
    this.stateFile = path.join(this.directory, "state.json");
    this.auditFile = path.join(this.directory, "audit.jsonl");
    this.receiptsDirectory = path.join(this.directory, "receipts");
    this.batchesDirectory = path.join(this.directory, "batches");
    this.lockTimeoutMs = lockTimeoutSeconds * 1_000;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.directory, { recursive: true }),
      mkdir(this.worktreesDirectory, { recursive: true }),
      mkdir(this.receiptsDirectory, { recursive: true }),
      mkdir(this.batchesDirectory, { recursive: true }),
      mkdir(this.archiveDirectory, { recursive: true }),
      mkdir(this.tokensDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.provenanceKeysDirectory, { recursive: true, mode: 0o700 }),
    ]);
    if (!(await exists(this.stateFile))) {
      try {
        await writeFile(
          this.stateFile,
          `${JSON.stringify({
            version: STATE_VERSION,
            sequence: 0,
            tasks: {},
            batches: {},
          } satisfies BrokerState, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  async read(): Promise<BrokerState> {
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
    return state;
  }

  async transaction<T>(mutator: (state: BrokerState, audit: AuditRecorder) => Promise<T> | T): Promise<T> {
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
        await appendFile(this.auditFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      }
      return result;
    });
  }

  async withIntegrationLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withLock("integration", operation, 24 * 60 * 60 * 1_000);
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
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700).catch(() => undefined);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
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
  }

  async writeBatchManifest(batchId: string, manifest: unknown): Promise<string> {
    await this.initialize();
    const target = path.join(this.batchesDirectory, `${safeName(batchId)}.json`);
    await this.atomicWrite(target, manifest);
    return target;
  }

  /**
   * Reads the tail of the active audit stream. Deliberately tolerant: a tail read can begin
   * mid-line, and a crash between writing and flushing can leave a truncated final line. Neither is
   * a reason to make the whole audit trail unreadable, which is exactly when it is needed most.
   */
  async readAudit(limit = 100): Promise<AuditEvent[]> {
    if (!(await exists(this.auditFile))) return [];
    const handle = await open(this.auditFile, "r");
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
    const lockDirectory = path.join(this.directory, `${name}.lock`);
    const lockStat = await stat(lockDirectory).catch(() => undefined);
    if (!lockStat) return { name, held: false, path: lockDirectory };
    let owner: LockStatus["owner"];
    try {
      const parsed = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as {
        pid?: unknown;
        host?: unknown;
        createdAt?: unknown;
      };
      owner = {
        ...(Number.isInteger(parsed.pid) ? { pid: parsed.pid as number } : {}),
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
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
      abandoned: await this.lockOwnerCrashed(lockDirectory),
    };
  }

  /**
   * Releases a held lock. Without `force` this refuses unless the holder is provably gone, because
   * removing a live lock allows two integrations to run against the same repository at once.
   */
  async releaseLock(name: string, options: { force?: boolean } = {}): Promise<LockStatus> {
    const status = await this.inspectLock(name);
    if (!status.held) return status;
    if (!options.force && !status.abandoned) {
      throw new BrokerError(
        "LOCK_HELD",
        `The ${name} lock is held by ${status.owner?.host ?? "an unknown host"} (pid ${
          status.owner?.pid ?? "unknown"
        }) and is not provably abandoned. Re-run with --force only after confirming no integration is running.`,
        { lock: status },
      );
    }
    await rm(status.path, { recursive: true, force: true });
    return { ...status, held: false };
  }

  private async withLock<T>(name: string, operation: () => Promise<T>, staleMs = 60_000): Promise<T> {
    await this.initialize();
    const lockDirectory = path.join(this.directory, `${name}.lock`);
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(lockDirectory);
        await writeFile(
          path.join(lockDirectory, "owner.json"),
          `${JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const lockStat = await stat(lockDirectory).catch(() => undefined);
        // A crashed holder on this machine can be detected directly, so its lock is reclaimed after a
        // short grace period. A holder on another machine cannot be probed at all -- the state
        // directory is shared, but process IDs are not -- so those wait out the full stale timeout
        // rather than risk two integrations running at once.
        const age = lockStat ? Date.now() - lockStat.mtimeMs : 0;
        if (lockStat && (age > staleMs || (age > 2_000 && (await this.lockOwnerCrashed(lockDirectory))))) {
          await rm(lockDirectory, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - startedAt > this.lockTimeoutMs) {
          throw new BrokerError("LOCK_TIMEOUT", `Timed out waiting for the ${name} lock.`, { lockDirectory });
        }
        await delay(50 + Math.floor(Math.random() * 100));
      }
    }

    try {
      return await operation();
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }

  /**
   * True only when the lock is provably abandoned: written by this machine, by a process that is
   * gone. An unreadable owner file is not proof -- it is also what a lock looks like in the instant
   * between creating the directory and recording its owner.
   */
  private async lockOwnerCrashed(lockDirectory: string): Promise<boolean> {
    let owner: { pid?: unknown; host?: unknown };
    try {
      owner = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as {
        pid?: unknown;
        host?: unknown;
      };
    } catch {
      return false;
    }
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
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}

function safeName(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable || "record"}-${digest}`;
}
