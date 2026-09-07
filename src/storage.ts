import path from "node:path";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { BrokerError } from "./errors.js";
import type { StateStore } from "./store.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_SCAN_ENTRIES = 100_000;
const MAX_SCAN_DEPTH = 64;
const MAX_COMPACTION_FILES = 100;
const MAX_COMPACTION_BYTES = 256 * 1_024 * 1_024;
/** Audit rotation normally produces 16 MiB segments; oversized records remain untouched. */
export const MAX_COMPACT_AUDIT_BYTES = 64 * 1_024 * 1_024;
const ROTATED_AUDIT = /^audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/u;

export type StorageCategory = "state" | "audit" | "archives" | "worktrees" | "credentials"
  | "receipts" | "manifests" | "service-logs" | "other" | "provenance";

interface StorageSkip {
  path: string;
  reason: string;
}

export interface StorageReport {
  runtimeDirectory: string;
  provenanceDirectory?: string;
  /** Logical file lengths, not allocated disk blocks or Git object database storage. */
  logicalBytes: number;
  files: number;
  categories: { category: StorageCategory; logicalBytes: number; files: number }[];
  skipped: StorageSkip[];
  complete: boolean;
}

export interface StorageCompactionOptions {
  apply?: boolean;
  olderThanDays?: number;
}

export interface StorageCompactionResult {
  applied: boolean;
  olderThanDays: number;
  eligibleFiles: number;
  eligibleBytes: number;
  compressedFiles: number;
  savedBytes: number;
  entries: {
    path: string;
    bytes: number;
    status: "eligible" | "compressed" | "unchanged" | "skipped";
    compressedBytes?: number;
    reason?: string;
  }[];
  skipped: StorageSkip[];
}

function childRelative(parent: string, target: string): string {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BrokerError("UNSAFE_PATH", "Storage inspection must stay inside its configured directory.");
  }
  return relative;
}

async function statusIfPresent(target: string): Promise<Stats | undefined> {
  return await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

/** Walk every configured path component without traversing a symlink or Windows junction. */
async function physicalDirectory(parent: string, target: string): Promise<Stats | undefined> {
  const relative = childRelative(parent, target);
  let cursor = path.resolve(parent);
  for (const component of ["", ...relative.split(path.sep)]) {
    cursor = path.join(cursor, component);
    const status = await statusIfPresent(cursor);
    if (!status) return undefined;
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new BrokerError("UNSAFE_PATH", "Storage path contains a nonphysical directory.", { path: cursor });
    }
  }
  return await lstat(cursor);
}

function categoryFor(relative: string): StorageCategory {
  const parts = relative.split(path.sep);
  const first = parts[0] ?? "";
  if (first === "audit.jsonl" || (first === "archive" && /^audit-.*\.jsonl(?:\.gz)?$/u.test(parts[1] ?? ""))) return "audit";
  if (first === "archive") return "archives";
  if (first === "worktrees") return "worktrees";
  if (first === "tokens" || first === "provenance-keys" || first === "provenance-signing-key.pem") return "credentials";
  if (first === "receipts") return "receipts";
  if (first === "batches" || first === "submissions") return "manifests";
  if (first === "serve.log" || first.startsWith("serve.log.")) return "service-logs";
  if (first === "state.json" || first.endsWith(".lock")) return "state";
  return "other";
}

/** Metadata-only, bounded inspection. No token, key, evidence, or worktree file contents are read. */
export async function inspectStorage(
  store: StateStore,
  options: { repositoryRoot: string; provenanceDirectory?: string },
): Promise<StorageReport> {
  const report: StorageReport = {
    runtimeDirectory: store.directory,
    logicalBytes: 0,
    files: 0,
    categories: [],
    skipped: [],
    complete: true,
  };
  const categories = new Map<StorageCategory, StorageReport["categories"][number]>();
  let visited = 0;
  function skipTraversalError(error: unknown, target: string): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(code)) return false;
    report.skipped.push({ path: target, reason: `Filesystem entry could not be inspected (${code}); totals are partial.` });
    report.complete = false;
    return true;
  }
  async function scan(directory: string, relative: string, provenance: boolean, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) {
      report.skipped.push({ path: directory, reason: "Directory depth limit reached." });
      report.complete = false;
      return;
    }
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        visited += 1;
        if (visited > MAX_SCAN_ENTRIES) {
          report.complete = false;
          return;
        }
        const target = path.join(directory, entry.name);
        const itemRelative = path.join(relative, entry.name);
        const status = await statusIfPresent(target).catch((error: unknown) => {
          if (!skipTraversalError(error, target)) throw error;
          return null;
        });
        if (status === null) continue;
        if (!status) {
          report.skipped.push({ path: target, reason: "Entry changed during inspection." });
          report.complete = false;
          continue;
        }
        if (status.isSymbolicLink()) {
          report.skipped.push({ path: target, reason: "Symlink or junction not followed." });
          report.complete = false;
        } else if (status.isDirectory()) {
          await scan(target, itemRelative, provenance, depth + 1);
        } else if (status.isFile()) {
          const category = provenance ? "provenance" : categoryFor(itemRelative);
          const total = categories.get(category) ?? { category, logicalBytes: 0, files: 0 };
          total.logicalBytes += status.size;
          total.files += 1;
          categories.set(category, total);
          report.logicalBytes += status.size;
          report.files += 1;
        } else {
          report.skipped.push({ path: target, reason: "Non-regular filesystem entry not inspected." });
          report.complete = false;
        }
        if (visited > MAX_SCAN_ENTRIES) return;
      }
    } catch (error) {
      if (!skipTraversalError(error, directory)) throw error;
    }
  }
  async function inspectRoot(parent: string, directory: string, provenance: boolean): Promise<void> {
    try {
      if (await physicalDirectory(parent, directory)) await scan(directory, "", provenance, 0);
    } catch (error) {
      if (skipTraversalError(error, directory)) return;
      if (!(error instanceof BrokerError) || error.code !== "UNSAFE_PATH") throw error;
      report.skipped.push({ path: directory, reason: "Configured storage path is redirected or not a directory." });
      report.complete = false;
    }
  }
  await inspectRoot(store.commonGitDirectory, store.directory, false);
  if (options.provenanceDirectory) {
    const directory = path.resolve(options.repositoryRoot, options.provenanceDirectory);
    childRelative(options.repositoryRoot, directory);
    report.provenanceDirectory = directory;
    await inspectRoot(options.repositoryRoot, directory, true);
  }
  if (visited > MAX_SCAN_ENTRIES) {
    report.skipped.push({ path: store.directory, reason: "100,000-entry inspection limit reached; totals are partial." });
  }
  report.categories = [...categories.values()].sort((left, right) => left.category.localeCompare(right.category));
  return report;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function syncDirectory(directory: string): Promise<void> {
  // POSIX directory fsync makes the new archive entry durable before its source is unlinked.
  // Windows does not expose the same directory-handle operation through Node.
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Preview by default. Only closed rotated audit segments become smaller, verified gzip files.
 * There is no age-based deletion of evidence, active logs, recovery data, signing keys, or Git refs.
 */
export async function compactAuditStorage(
  store: StateStore,
  options: StorageCompactionOptions = {},
): Promise<StorageCompactionResult> {
  if (options.apply !== undefined && typeof options.apply !== "boolean") {
    throw new BrokerError("INVALID_ARGUMENT", "Storage compaction apply must be an explicit boolean.");
  }
  const olderThanDays = options.olderThanDays ?? 30;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new BrokerError("INVALID_ARGUMENT", "Storage compaction age must be a nonnegative number of days.");
  }
  const result: StorageCompactionResult = {
    applied: options.apply === true, olderThanDays, eligibleFiles: 0, eligibleBytes: 0,
    compressedFiles: 0, savedBytes: 0, entries: [], skipped: [],
  };
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  async function run(): Promise<StorageCompactionResult> {
    const archiveStatus = await physicalDirectory(store.commonGitDirectory, store.archiveDirectory);
    if (!archiveStatus) return result;
    const archiveRealPath = await realpath(store.archiveDirectory);
    const archive = await opendir(store.archiveDirectory);
    let visited = 0;
    for await (const entry of archive) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES) {
        result.skipped.push({ path: "archive", reason: "Archive inspection limit reached; run again after reviewing storage." });
        break;
      }
      if (!ROTATED_AUDIT.test(entry.name)) continue;
      const target = path.join(store.archiveDirectory, entry.name);
      const relative = path.join("archive", entry.name);
      const status = await statusIfPresent(target);
      if (!status) continue;
      if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
        result.skipped.push({ path: relative, reason: "Only regular audit segments without additional hard links are eligible." });
        continue;
      }
      if (status.mtimeMs > cutoff) continue;
      if (status.size > MAX_COMPACT_AUDIT_BYTES) {
        result.skipped.push({ path: relative, reason: "Segment exceeds the 64 MiB compaction limit." });
        continue;
      }
      if (await statusIfPresent(`${target}.gz`)) {
        result.skipped.push({ path: relative, reason: "A compressed copy already exists; both files were preserved." });
        continue;
      }
      if (result.eligibleFiles >= MAX_COMPACTION_FILES || result.eligibleBytes + status.size > MAX_COMPACTION_BYTES) {
        result.skipped.push({ path: relative, reason: "Compaction pass limit reached; run again for more segments." });
        break;
      }
      result.eligibleFiles += 1;
      result.eligibleBytes += status.size;
      const item: StorageCompactionResult["entries"][number] = { path: relative, bytes: status.size, status: "eligible" };
      result.entries.push(item);
      if (!options.apply) continue;

      const parentNow = await physicalDirectory(store.commonGitDirectory, store.archiveDirectory);
      if (!parentNow || parentNow.dev !== archiveStatus.dev || parentNow.ino !== archiveStatus.ino
        || await realpath(store.archiveDirectory) !== archiveRealPath) {
        throw new BrokerError("UNSAFE_PATH", "Audit archive directory changed during compaction.");
      }
      const source = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let original: Buffer;
      try {
        const openedStatus = await source.stat();
        if (!openedStatus.isFile() || !sameFile(status, openedStatus)) {
          throw new BrokerError("STORAGE_CHANGED", "Audit segment changed during compaction.", { path: relative });
        }
        original = Buffer.alloc(status.size);
        let offset = 0;
        while (offset < original.length) {
          const { bytesRead } = await source.read(original, offset, original.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== original.length || !sameFile(status, await source.stat())) {
          throw new BrokerError("STORAGE_CHANGED", "Audit segment changed during compaction.", { path: relative });
        }
      } finally {
        await source.close();
      }
      const compressed = await compress(original);
      if (compressed.length >= original.length) {
        item.status = "unchanged";
        item.reason = "Compression would not save space.";
        continue;
      }
      if (!(await decompress(compressed, { maxOutputLength: MAX_COMPACT_AUDIT_BYTES })).equals(original)) {
        throw new BrokerError("STORAGE_VERIFICATION_FAILED", "Compressed audit segment did not round-trip.");
      }
      const destination = await open(`${target}.gz`, "wx", 0o600);
      try {
        await destination.writeFile(compressed);
        await destination.sync();
      } finally {
        await destination.close();
      }
      await syncDirectory(store.archiveDirectory);
      // Never unlink a replacement or a source that acquired another writer while being read.
      const sourceNow = await statusIfPresent(target);
      const finalParent = await physicalDirectory(store.commonGitDirectory, store.archiveDirectory);
      if (!sourceNow || sourceNow.isSymbolicLink() || !sameFile(status, sourceNow)
        || !finalParent || finalParent.dev !== archiveStatus.dev || finalParent.ino !== archiveStatus.ino) {
        throw new BrokerError("STORAGE_CHANGED", "Audit storage changed; the original and compressed files were preserved.");
      }
      await unlink(target);
      item.status = "compressed";
      item.compressedBytes = compressed.length;
      result.compressedFiles += 1;
      result.savedBytes += original.length - compressed.length;
    }
    return result;
  }
  // Preview never initializes the store or creates lock/state files.
  return options.apply ? await store.withStorageLock(run) : await run();
}
