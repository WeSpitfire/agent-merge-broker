import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { BrokerError } from "./errors.js";
import { GATE_AUTHORITY_FILENAME, validateGateAuthority } from "./gate-authority.js";
import { decodeArchivedStateSlice, decodeBrokerState, decodeSubmissionRecord } from "./state-codec.js";
import type { StateStore } from "./store.js";
import {
  ARCHIVED_STATE_VERSION,
  CONFIG_VERSION,
  GATE_AUTHORITY_VERSION,
  STATE_VERSION,
  SUBMISSION_VERSION,
  type MigrationReport,
  type SavedFormatFinding,
  type SavedFormatName,
} from "./types.js";

/** Receipts have no runtime type constant; their schema fixes version 1. */
const RECEIPT_VERSION = 1;
/** Bound a scan the same way storage inspection does, so a runaway directory cannot stall it. */
const MAX_SCANNED_FILES = 100_000;

const CURRENT_VERSIONS: Readonly<Record<SavedFormatName, number>> = {
  config: CONFIG_VERSION,
  state: STATE_VERSION,
  "archived-state": ARCHIVED_STATE_VERSION,
  submission: SUBMISSION_VERSION,
  "gate-authority": GATE_AUTHORITY_VERSION,
  receipt: RECEIPT_VERSION,
};

type JsonObject = Record<string, unknown>;

/**
 * One forward-only upgrade of a saved format. Every format version bump must add a migration from
 * each version still supported, so `migrate` can bring a repository to the current release.
 */
interface Migration {
  id: string;
  format: SavedFormatName;
  description: string;
  applies(value: JsonObject): boolean;
  apply(value: JsonObject): JsonObject;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "state-v1-add-submissions",
    format: "state",
    description: "Add the empty submissions collection to state written before 0.13.0.",
    applies: (value) => value.version === STATE_VERSION && value.submissions === undefined,
    apply: (value) => ({ ...value, submissions: {} }),
  },
  {
    id: "archived-state-record-version-1",
    format: "archived-state",
    description: "Record version 1 in an archived state slice written before 0.16.0.",
    applies: (value) => value.version === undefined,
    apply: (value) => ({ version: ARCHIVED_STATE_VERSION, ...value }),
  },
];

export interface SavedFormatLocations {
  repositoryRoot: string;
  store: StateStore;
}

interface ScannedFile {
  finding: SavedFormatFinding;
  value?: JsonObject;
}

function errorReason(error: unknown): string {
  if (error instanceof BrokerError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function listJson(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.filter((name) => name.endsWith(".json")).sort().map((name) => path.join(directory, name));
}

async function scanFile(
  format: SavedFormatName,
  file: string,
  decode: (value: JsonObject) => void,
): Promise<ScannedFile | undefined> {
  const status = await lstat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!status) return undefined;
  const unreadable = (reason: string, version: number | null = null): ScannedFile => ({
    finding: { format, path: file, version, status: "unreadable", reason },
  });
  if (status.isSymbolicLink() || !status.isFile()) return unreadable("Not a regular file.");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    return unreadable(`Invalid JSON: ${errorReason(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unreadable("Expected a JSON object.");
  }
  const record = value as JsonObject;
  const version = Number.isSafeInteger(record.version) ? record.version as number : null;
  const current = CURRENT_VERSIONS[format];
  if (version !== null && version > current) {
    return {
      finding: {
        format, path: file, version, status: "unsupported",
        reason: `Written by a newer release (version ${version}; this release reads version ${current}).`,
      },
    };
  }
  const migration = MIGRATIONS.find((candidate) => candidate.format === format && candidate.applies(record));
  if (version !== current && !migration) {
    return unreadable(record.version === undefined ? "No version is recorded." : `Unsupported version: ${String(record.version)}`, version);
  }
  try {
    decode(structuredClone(migration ? migration.apply(record) : record));
  } catch (error) {
    return unreadable(errorReason(error), version);
  }
  return {
    finding: migration
      ? { format, path: file, version, status: "upgradable", migration: migration.id, reason: migration.description }
      : { format, path: file, version, status: "current" },
    value: record,
  };
}

async function scanSavedFormats(locations: SavedFormatLocations): Promise<{ files: ScannedFile[]; complete: boolean }> {
  const { store } = locations;
  const plan: Array<[SavedFormatName, string, (value: JsonObject) => void]> = [
    ["state", path.join(store.directory, "state.json"), (value) => void decodeBrokerState(value)],
    ["gate-authority", path.join(store.commonGitDirectory, GATE_AUTHORITY_FILENAME), (value) => void validateGateAuthority(value)],
  ];
  const archived = (await listJson(store.archiveDirectory))
    .filter((file) => path.basename(file).startsWith("state-"));
  for (const file of archived) plan.push(["archived-state", file, (value) => void decodeArchivedStateSlice(value)]);
  for (const directory of [store.submissionsDirectory, store.archivedSubmissionsDirectory]) {
    for (const file of await listJson(directory)) plan.push(["submission", file, (value) => void decodeSubmissionRecord(value)]);
  }
  for (const file of await listJson(store.receiptsDirectory)) {
    plan.push(["receipt", file, (value) => {
      if (value.version !== RECEIPT_VERSION || typeof value.taskId !== "string") {
        throw new BrokerError("STATE_CORRUPT", "Receipt must record version 1 and a taskId.");
      }
    }]);
  }
  const complete = plan.length <= MAX_SCANNED_FILES;
  const files: ScannedFile[] = [];
  for (const [format, file, decode] of plan.slice(0, MAX_SCANNED_FILES)) {
    const scanned = await scanFile(format, file, decode);
    if (scanned) files.push(scanned);
  }
  return { files, complete };
}

function summarize(files: ScannedFile[], complete: boolean, extra: SavedFormatFinding[] = []): MigrationReport {
  const findings = [...extra, ...files.map((file) => file.finding)];
  return {
    applied: false,
    findings,
    pending: findings.filter((finding) => finding.status === "upgradable").length,
    blocked: findings.filter((finding) => finding.status === "unsupported" || finding.status === "unreadable").length,
    migrated: 0,
    complete,
  };
}

/** The configuration finding is separate: it is committed policy, never rewritten by migrate. */
export async function configFinding(repositoryRoot: string, error?: unknown): Promise<SavedFormatFinding> {
  const file = path.join(repositoryRoot, ".merge-broker", "config.json");
  if (!error) return { format: "config", path: file, version: CONFIG_VERSION, status: "current" };
  let version: number | null = null;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
    if (Number.isSafeInteger(value.version)) version = value.version as number;
  } catch {
    // The load error below is the useful diagnostic.
  }
  return {
    format: "config",
    path: file,
    version,
    status: version !== null && version > CONFIG_VERSION ? "unsupported" : "unreadable",
    reason: errorReason(error),
  };
}

/** Report saved formats without initializing state or taking locks. */
export async function inspectSavedFormats(locations: SavedFormatLocations): Promise<MigrationReport> {
  const { files, complete } = await scanSavedFormats(locations);
  return summarize(files, complete, [await configFinding(locations.repositoryRoot)]);
}

/**
 * Apply every pending migration under the state lock. Refuses when any file is unsupported or
 * unreadable: a partial upgrade next to a file from a newer release would leave a repository that
 * neither release can fully read.
 */
export async function applySavedFormatMigrations(locations: SavedFormatLocations): Promise<MigrationReport> {
  const { store } = locations;
  const configuration = await configFinding(locations.repositoryRoot);
  const preview = await inspectSavedFormats(locations);
  if (preview.blocked > 0) {
    throw new BrokerError("MIGRATION_BLOCKED", "Saved formats include unsupported or unreadable files; nothing was migrated.", {
      findings: preview.findings.filter((finding) => finding.status === "unsupported" || finding.status === "unreadable"),
    });
  }
  if (preview.pending === 0) return preview;
  const run = new Date().toISOString().replace(/[:.]/gu, "-");
  return await store.withStorageLock(async () => {
    // Rescan under the lock: another process may have written or upgraded files since the preview.
    const { files, complete } = await scanSavedFormats(locations);
    const report = summarize(files, complete, [configuration]);
    if (report.blocked > 0) {
      throw new BrokerError("MIGRATION_BLOCKED", "Saved formats changed and now include unsupported or unreadable files; nothing was migrated.");
    }
    let migrated = 0;
    for (const file of files) {
      if (file.finding.status !== "upgradable" || !file.value) continue;
      const migration = MIGRATIONS.find((candidate) => candidate.id === file.finding.migration);
      if (!migration) continue;
      await store.migrateJsonFile(file.finding.path, run, migration.apply(file.value));
      migrated += 1;
    }
    return {
      ...report,
      applied: true,
      migrated,
      ...(migrated > 0 ? { backupDirectory: path.join(store.archiveDirectory, "migrations", run) } : {}),
    };
  });
}
