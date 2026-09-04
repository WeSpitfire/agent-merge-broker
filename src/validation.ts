import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveShell, runShell, type ResolvedShell } from "./process.js";
import { matchesAny } from "./patterns.js";
import { ValidationError } from "./errors.js";
import { isGateGitEnvironmentOverride } from "./git.js";
import type { ValidationResult, ValidatorConfig } from "./types.js";

const OUTPUT_LIMIT_BYTES = 64 * 1_024;
// Keep the legacy inline path surface below the smallest common shell/process boundary. Larger
// lists travel through a JSON file so Gate's bounded path set cannot overflow argv or the Windows
// environment block before a validator even starts.
const INLINE_FILES_LIMIT_BYTES = 4 * 1_024;
const BROKER_CREDENTIAL_ENVIRONMENT = new Set([
  "MERGE_BROKER_TOKEN",
  "MERGE_BROKER_SIGNING_KEY",
  "MERGE_BROKER_SIGNING_KEY_FILE",
]);

interface ValidationCacheIdentity {
  device: string;
  inode: string;
  physicalPath: string;
  physicalParent: string;
}

const validationCacheIdentities = new Map<string, ValidationCacheIdentity>();

export async function createValidationCacheDirectory(): Promise<string> {
  const directory = path.resolve(await mkdtemp(path.join(tmpdir(), "agent-merge-broker-validator-")));
  const [status, exactStatus, physicalPath, physicalParent] = await Promise.all([
    lstat(directory),
    lstat(directory, { bigint: true }),
    realpath(directory),
    realpath(path.dirname(directory)),
  ]);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Validation cache root is not a physical directory: ${directory}`);
  }
  validationCacheIdentities.set(directory, {
    device: exactStatus.dev.toString(),
    inode: exactStatus.ino.toString(),
    physicalPath,
    physicalParent,
  });
  return directory;
}

async function repairCacheDirectoryPermissions(
  directory: string,
  inspected: { value: number },
): Promise<void> {
  const status = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  // Never chmod through a validator-created symlink. `rm` can unlink it from its writable parent
  // without changing the target's permissions.
  if (!status || status.isSymbolicLink() || !status.isDirectory()) return;
  inspected.value += 1;
  if (inspected.value > 200_000) {
    throw new Error("Validation cache contains too many directories to clean up safely.");
  }
  await chmod(directory, 0o700);
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await repairCacheDirectoryPermissions(path.join(directory, entry.name), inspected);
      }
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
}

export async function removeValidationCacheDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const expected = validationCacheIdentities.get(resolved);
  if (!expected) {
    throw new Error(`Validation cache has no broker-captured root identity: ${resolved}`);
  }
  const status = await lstat(resolved).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!status) {
    validationCacheIdentities.delete(resolved);
    return;
  }
  const [exactStatus, physicalPath, physicalParent] = await Promise.all([
    lstat(resolved, { bigint: true }),
    realpath(resolved),
    realpath(path.dirname(resolved)),
  ]);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    exactStatus.dev.toString() !== expected.device ||
    exactStatus.ino.toString() !== expected.inode ||
    physicalPath !== expected.physicalPath ||
    physicalParent !== expected.physicalParent
  ) {
    throw new Error(`Validation cache root identity changed; refusing recursive cleanup: ${resolved}`);
  }
  try {
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Validators can accidentally remove owner permissions from a tool cache. Repair directories
    // without following symlinks, then make one final bounded removal attempt.
    await repairCacheDirectoryPermissions(resolved, { value: 0 });
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  validationCacheIdentities.delete(resolved);
}

function renderCommand(
  command: string,
  taskId: string | undefined,
  filesInput: "inline" | "json",
  inlineFiles: string | undefined,
  filesFile: string,
  shell: ResolvedShell,
  validatorCacheDirectory: string,
): string {
  if (filesInput === "inline" && inlineFiles === undefined) {
    throw new ValidationError(
      `Validator path input is too large for a portable command line or environment. Set filesInput to json and read {filesFile} or MERGE_BROKER_FILES_FILE.`,
      { filesFile, maximumInlineBytes: INLINE_FILES_LIMIT_BYTES },
    );
  }
  if (filesInput === "json" && command.includes("{files}")) {
    throw new ValidationError(
      "Validator uses {files} while filesInput is json. Use {filesFile} and read the JSON array instead.",
      { filesFile },
    );
  }
  return command
    .replaceAll("{taskId}", shell.quote(taskId ?? ""))
    .replaceAll("{files}", inlineFiles ?? "")
    .replaceAll("{filesFile}", shell.quote(filesFile))
    .replaceAll("{validatorCacheDir}", shell.quote(validatorCacheDirectory));
}

function inlineFileInputs(files: string[], shell: ResolvedShell): {
  environment?: string;
  arguments?: string;
} {
  const environment = files.join("\n");
  if (Buffer.byteLength(environment, "utf8") > INLINE_FILES_LIMIT_BYTES) return {};
  const argumentsValue = files.map(shell.quote).join(" ");
  if (Buffer.byteLength(argumentsValue, "utf8") > INLINE_FILES_LIMIT_BYTES) return {};
  return { environment, arguments: argumentsValue };
}

/**
 * A validator command is repository-trusted, but a lease token is a worker credential that no
 * validator needs. Passing it through would hand every configured command the ability to submit or
 * cancel on that worker's behalf.
 */
function validatorEnvironment(
  overrides: Record<string, string> | undefined,
  gateSubmission: boolean,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    // Windows treats environment names case-insensitively. Filter the merged environment rather
    // than destructuring a few uppercase inherited keys, which also prevents validator.env from
    // adding a differently cased copy of a worker or signing credential on any host.
    if (
      BROKER_CREDENTIAL_ENVIRONMENT.has(normalized) ||
      (gateSubmission && isGateGitEnvironmentOverride(name))
    ) {
      delete environment[name];
    }
  }
  return environment;
}

export async function runValidators(options: {
  validators: ValidatorConfig[];
  scope: "focused" | "authoritative";
  cwd: string;
  taskId?: string;
  files: string[];
  baseSha: string;
  headSha: string;
  batchId: string;
  /** Present for trusted local-ref intake, which intentionally has no Coordinate-mode batch. */
  submissionId?: string;
  /** Reject a validator cwd reached through a symlink/junction or outside the validation root. */
  requirePhysicalWorkingDirectory?: boolean;
  shell?: string;
  /** Share one isolated toolchain cache across the stages of a single integration transaction. */
  cacheDirectory?: string;
}): Promise<ValidationResult[]> {
  if (options.validators.length === 0) return [];
  const shell = resolveShell(options.shell);
  const results: ValidationResult[] = [];
  const ownsCache = options.cacheDirectory === undefined;
  const cacheDirectory = options.cacheDirectory ?? await createValidationCacheDirectory();
  const physicalCacheRoot = await realpath(cacheDirectory);
  try {
    for (const validator of options.validators) {
      const forbiddenGateOverride = options.submissionId
        ? Object.keys(validator.env ?? {}).find(isGateGitEnvironmentOverride)
        : undefined;
      if (forbiddenGateOverride) {
        throw new ValidationError(
          `Gate validator ${validator.name} cannot override ${forbiddenGateOverride}; Git execution, repository, and transport selection are broker authority.`,
          { validator: validator.name, environmentVariable: forbiddenGateOverride },
        );
      }
      if (
        options.scope === "focused" &&
        validator.paths &&
        validator.paths.length > 0 &&
        !options.files.some((file) => matchesAny(file, validator.paths ?? []))
      ) {
        continue;
      }
      const validatorCwd = path.resolve(options.cwd, validator.workingDirectory ?? ".");
      if (options.requirePhysicalWorkingDirectory) {
        const root = await realpath(options.cwd);
        const relative = path.relative(path.resolve(options.cwd), validatorCwd);
        let cursor = path.resolve(options.cwd);
        for (const component of relative.split(path.sep).filter(Boolean)) {
          cursor = path.join(cursor, component);
          if ((await lstat(cursor)).isSymbolicLink()) {
            throw new ValidationError(
              `Validator ${validator.name} working directory traverses a symbolic link or junction.`,
              { validator: validator.name, workingDirectory: validator.workingDirectory },
            );
          }
        }
        const physical = await realpath(validatorCwd);
        const physicalRelative = path.relative(root, physical);
        if (physicalRelative.startsWith("..") || path.isAbsolute(physicalRelative)) {
          throw new ValidationError(
            `Validator ${validator.name} working directory escapes the candidate worktree.`,
            { validator: validator.name, workingDirectory: validator.workingDirectory },
          );
        }
      }
      const relativeFiles = validator.workingDirectory
        ? options.files.map((file) => path.relative(validatorCwd, path.resolve(options.cwd, file)).split(path.sep).join("/"))
        : options.files;
      const validatorCacheKey = createHash("sha256")
        .update(`${validator.workingDirectory ?? "."}\0${validator.name}`)
        .digest("hex")
        .slice(0, 12);
      const validatorCacheDirectory = path.join(cacheDirectory, validatorCacheKey);
      await mkdir(validatorCacheDirectory, { recursive: true });
      const [currentCacheRoot, cacheStatus, physicalValidatorCache] = await Promise.all([
        realpath(cacheDirectory),
        lstat(validatorCacheDirectory),
        realpath(validatorCacheDirectory),
      ]);
      const cacheRelative = path.relative(physicalCacheRoot, physicalValidatorCache);
      if (
        currentCacheRoot !== physicalCacheRoot ||
        cacheStatus.isSymbolicLink() ||
        !cacheStatus.isDirectory() ||
        cacheRelative.startsWith("..") ||
        path.isAbsolute(cacheRelative)
      ) {
        throw new ValidationError(
          `Validator ${validator.name} redirected the isolated validation cache.`,
          { validator: validator.name, cacheDirectory: validatorCacheDirectory },
        );
      }
      // The tool cache is intentionally stable across stages, but the broker-owned path-list file
      // is not. A fresh unpredictable, create-only name prevents one validator from replacing the
      // next stage's transport with a symlink to an unrelated host path.
      const filesFile = path.join(validatorCacheDirectory, `files-${randomUUID()}.json`);
      await writeFile(filesFile, `${JSON.stringify(relativeFiles)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const inlineFiles = inlineFileInputs(relativeFiles, shell);
      const filesInput = validator.filesInput ?? "inline";
      const command = renderCommand(
        validator.command,
        options.taskId,
        filesInput,
        inlineFiles.arguments,
        filesFile,
        shell,
        validatorCacheDirectory,
      );
      const startedAt = new Date();
      const result = await runShell(command, {
        cwd: validatorCwd,
        allowFailure: true,
        timeoutMs: (validator.timeoutSeconds ?? 900) * 1_000,
        maxOutputBytes: OUTPUT_LIMIT_BYTES,
        killProcessTree: true,
        shell,
        executionArchitecture: validator.executionArchitecture ?? "process",
        env: {
          ...validatorEnvironment(validator.env, options.submissionId !== undefined),
          MERGE_BROKER_TASK_ID: options.taskId ?? "",
          MERGE_BROKER_FILES: filesInput === "inline" ? inlineFiles.environment ?? "" : "",
          MERGE_BROKER_FILES_FILE: filesFile,
          MERGE_BROKER_FILES_FILE_FORMAT: "json",
          MERGE_BROKER_BASE_SHA: options.baseSha,
          MERGE_BROKER_HEAD_SHA: options.headSha,
          MERGE_BROKER_BATCH_ID: options.batchId,
          MERGE_BROKER_SUBMISSION_ID: options.submissionId ?? "",
          MERGE_BROKER_CACHE_DIR: cacheDirectory,
        },
      });
      const finishedAt = new Date();
      const validation: ValidationResult = {
        name: validator.name,
        command,
        scope: options.scope,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      results.push(validation);
      if (result.exitCode !== 0) {
        throw new ValidationError(`Validator \"${validator.name}\" failed.`, {
          validation,
          completedValidations: results,
        });
      }
    }
    return results;
  } finally {
    if (ownsCache) await removeValidationCacheDirectory(cacheDirectory);
  }
}
