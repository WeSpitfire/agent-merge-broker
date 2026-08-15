import path from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { BrokerError } from "./errors.js";
import { STATE_VERSION, type AuditEvent, type BrokerState, type CommitReceipt } from "./types.js";

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
  private readonly stateFile: string;
  private readonly auditFile: string;
  private readonly receiptsDirectory: string;
  private readonly batchesDirectory: string;
  private readonly lockTimeoutMs: number;

  constructor(commonGitDir: string, stateDirectory: string, lockTimeoutSeconds: number) {
    this.directory = path.resolve(commonGitDir, stateDirectory);
    this.worktreesDirectory = path.join(this.directory, "worktrees");
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

  async writeBatchManifest(batchId: string, manifest: unknown): Promise<string> {
    await this.initialize();
    const target = path.join(this.batchesDirectory, `${safeName(batchId)}.json`);
    await this.atomicWrite(target, manifest);
    return target;
  }

  async readAudit(limit = 100): Promise<AuditEvent[]> {
    if (!(await exists(this.auditFile))) return [];
    const contents = await readFile(this.auditFile, "utf8");
    return contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
      .slice(-limit);
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
