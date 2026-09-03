import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveShell, runShell, type ResolvedShell } from "./process.js";
import { matchesAny } from "./patterns.js";
import { ValidationError } from "./errors.js";
import type { ValidationResult, ValidatorConfig } from "./types.js";

const OUTPUT_LIMIT_BYTES = 64 * 1_024;

export async function createValidationCacheDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "agent-merge-broker-validator-"));
}

export async function removeValidationCacheDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function renderCommand(
  command: string,
  taskId: string | undefined,
  files: string[],
  shell: ResolvedShell,
  validatorCacheDirectory: string,
): string {
  return command
    .replaceAll("{taskId}", shell.quote(taskId ?? ""))
    .replaceAll("{files}", files.map(shell.quote).join(" "))
    .replaceAll("{validatorCacheDir}", shell.quote(validatorCacheDirectory));
}

/**
 * A validator command is repository-trusted, but a lease token is a worker credential that no
 * validator needs. Passing it through would hand every configured command the ability to submit or
 * cancel on that worker's behalf.
 */
function validatorEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const {
    MERGE_BROKER_TOKEN: _token,
    MERGE_BROKER_SIGNING_KEY: _signingKey,
    MERGE_BROKER_SIGNING_KEY_FILE: _signingKeyFile,
    ...inherited
  } = process.env;
  return { ...inherited, ...overrides };
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
  shell?: string;
  /** Share one isolated toolchain cache across the stages of a single integration transaction. */
  cacheDirectory?: string;
}): Promise<ValidationResult[]> {
  if (options.validators.length === 0) return [];
  const shell = resolveShell(options.shell);
  const results: ValidationResult[] = [];
  const ownsCache = options.cacheDirectory === undefined;
  const cacheDirectory = options.cacheDirectory ?? await createValidationCacheDirectory();
  try {
    for (const validator of options.validators) {
      if (
        options.scope === "focused" &&
        validator.paths &&
        validator.paths.length > 0 &&
        !options.files.some((file) => matchesAny(file, validator.paths ?? []))
      ) {
        continue;
      }
      const validatorCwd = path.resolve(options.cwd, validator.workingDirectory ?? ".");
      const relativeFiles = validator.workingDirectory
        ? options.files.map((file) => path.relative(validatorCwd, path.resolve(options.cwd, file)).split(path.sep).join("/"))
        : options.files;
      const validatorCacheKey = createHash("sha256")
        .update(`${validator.workingDirectory ?? "."}\0${validator.name}`)
        .digest("hex")
        .slice(0, 12);
      const validatorCacheDirectory = path.join(cacheDirectory, validatorCacheKey);
      await mkdir(validatorCacheDirectory, { recursive: true });
      const command = renderCommand(validator.command, options.taskId, relativeFiles, shell, validatorCacheDirectory);
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
          ...validatorEnvironment(validator.env),
          MERGE_BROKER_TASK_ID: options.taskId ?? "",
          MERGE_BROKER_FILES: relativeFiles.join("\n"),
          MERGE_BROKER_BASE_SHA: options.baseSha,
          MERGE_BROKER_HEAD_SHA: options.headSha,
          MERGE_BROKER_BATCH_ID: options.batchId,
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
