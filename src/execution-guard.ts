import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { lstat, mkdir, open, opendir, readFile, rename, rm } from "node:fs/promises";
import { BrokerError } from "./errors.js";
import { canProbeProcessIdentity, linuxProcessIdentity } from "./process-identity.js";

// A command may outlive the broker PID that owns integration.lock. These separate records are
// published before a supervisor receives permission to execute. Recovery never signals saved PIDs:
// it waits for a POSIX process group to disappear, or for a Windows supervisor to prove its job empty.
const executions = new AsyncLocalStorage<string>();
const GUARD_DIRECTORY = "validator-executions";
const MAX_GUARDS = 1_024;
const MAX_GUARD_BYTES = 4_096;
export interface ExecutionGuard {
  file: string;
  nonce: string;
}
interface ExecutionRecord {
  version: 1;
  nonce: string;
  pid: number;
  host: string;
  platform: string;
  processIdentity?: string;
  kind: "process-group" | "windows-job";
  cwd: string;
}

export async function withExecutionGuards<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  return await executions.run(path.join(directory, GUARD_DIRECTORY), operation);
}

export async function registerExecution(pid: number, cwd: string): Promise<ExecutionGuard | undefined> {
  const directory = executions.getStore();
  if (!directory) return undefined;
  const processIdentity = linuxProcessIdentity();
  if (process.platform === "linux" && !processIdentity) {
    throw new BrokerError("LOCK_HELD",
      "Linux boot and PID namespace identity are unavailable; the validator was not started.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new BrokerError("UNSAFE_PATH", "Validator execution records require a physical directory.");
  }
  const nonce = randomUUID();
  const file = path.join(directory, `${nonce}.json`);
  const temporary = `${file}.tmp`;
  const record: ExecutionRecord = {
    version: 1, nonce, pid, host: hostname(), platform: `${process.platform}-${process.arch}`,
    ...(processIdentity ? { processIdentity } : {}),
    kind: process.platform === "win32" ? "windows-job" : "process-group",
    cwd,
  };
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  // Directory syncing is unsupported on Windows. POSIX local filesystems must persist the entry
  // before the child is released; failure stops the command before it has executed anything.
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return { file, nonce };
}

async function guardFiles(directory: string): Promise<string[]> {
  const root = path.join(directory, GUARD_DIRECTORY);
  const status = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!status) return [];
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new BrokerError("UNSAFE_PATH", "Validator execution records are not a physical directory.", { directory: root });
  }
  const entries = await opendir(root);
  const files: string[] = [];
  let seen = 0;
  for await (const entry of entries) {
    if (++seen > MAX_GUARDS) {
      throw new BrokerError("LOCK_HELD", "Too many validator execution records to prove cleanup safe.", { directory: root });
    }
    if (entry.name.endsWith(".json")) files.push(path.join(root, entry.name));
  }
  return files;
}

async function executionFinished(file: string): Promise<boolean> {
  const status = await lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_GUARD_BYTES) return false;
  let record: ExecutionRecord;
  try { record = JSON.parse(await readFile(file, "utf8")) as ExecutionRecord; } catch { return false; }
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    record.version !== 1 || record.host !== hostname() ||
    record.platform !== `${process.platform}-${process.arch}` ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
    typeof record.nonce !== "string" || path.basename(file) !== `${record.nonce}.json`
  ) return false;
  if (record.kind === "windows-job" && process.platform === "win32") {
    // The supervisor records this only after the kernel reports an empty job. Unexpected death
    // closes its KILL_ON_JOB_CLOSE handle, but kernel termination can still have pending I/O.
    // Without explicit completion proof, retain the record for inspected operator recovery.
    const done = await lstat(`${file}.done`).catch(() => undefined);
    if (done?.isFile() && !done.isSymbolicLink() && done.size <= MAX_GUARD_BYTES &&
      await readFile(`${file}.done`, "utf8").then((value) => value === record.nonce, () => false)) return true;
    return false;
  }
  if (record.kind !== "process-group" || process.platform === "win32") return false;
  if (!canProbeProcessIdentity(record.processIdentity, process.platform, linuxProcessIdentity())) return false;
  try {
    process.kill(-record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Also gate cleanup in the original broker after an unexpected supervisor failure. */
export async function assertExecutionsStopped(): Promise<void> {
  const directory = executions.getStore();
  if (directory) await waitForExecutions(path.dirname(directory), 0);
}

export async function retireExecution(guard: ExecutionGuard | undefined): Promise<boolean> {
  if (!guard) return true;
  if (!(await executionFinished(guard.file))) return false;
  await rm(guard.file);
  await rm(`${guard.file}.done`, { force: true });
  return true;
}

export async function waitForExecutions(directory: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (true) {
    const pending: string[] = [];
    for (const file of await guardFiles(directory)) {
      if (await executionFinished(file)) {
        await rm(file);
        await rm(`${file}.done`, { force: true });
      } else pending.push(file);
    }
    if (pending.length === 0) return;
    if (Date.now() - started >= timeoutMs) {
      throw new BrokerError("LOCK_HELD",
        "A previous validator execution has not been proven stopped. Integration and recovery did not start. " +
        "Inspect the execution records and stop the old validator tree; only then use unlock integration --force.",
        { executions: pending });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Explicit operator override; no saved PID is ever signalled or interpreted as permission to kill. */
export async function forceClearExecutions(directory: string): Promise<void> {
  for (const file of await guardFiles(directory)) {
    if (!/^[a-f0-9-]+\.json$/u.test(path.basename(file))) continue;
    await rm(file);
    await rm(`${file}.done`, { force: true });
  }
}
