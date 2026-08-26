import { resolveShell, runShell, type ResolvedShell } from "./process.js";
import { matchesAny } from "./patterns.js";
import { ValidationError } from "./errors.js";
import type { ValidationResult, ValidatorConfig } from "./types.js";

const OUTPUT_LIMIT_BYTES = 64 * 1_024;

function truncateOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= OUTPUT_LIMIT_BYTES) return value;
  const head = value.slice(0, 48 * 1_024);
  const tail = value.slice(-16 * 1_024);
  return `${head}\n... output truncated by Merge Broker ...\n${tail}`;
}

function renderCommand(
  command: string,
  taskId: string | undefined,
  files: string[],
  shell: ResolvedShell,
): string {
  return command
    .replaceAll("{taskId}", shell.quote(taskId ?? ""))
    .replaceAll("{files}", files.map(shell.quote).join(" "));
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
}): Promise<ValidationResult[]> {
  const shell = resolveShell(options.shell);
  const results: ValidationResult[] = [];
  for (const validator of options.validators) {
    if (
      options.scope === "focused" &&
      validator.paths &&
      validator.paths.length > 0 &&
      !options.files.some((file) => matchesAny(file, validator.paths ?? []))
    ) {
      continue;
    }
    const command = renderCommand(validator.command, options.taskId, options.files, shell);
    const startedAt = new Date();
    const result = await runShell(command, {
      cwd: options.cwd,
      allowFailure: true,
      timeoutMs: (validator.timeoutSeconds ?? 900) * 1_000,
      shell,
      env: {
        ...validatorEnvironment(validator.env),
        MERGE_BROKER_TASK_ID: options.taskId ?? "",
        MERGE_BROKER_FILES: options.files.join("\n"),
        MERGE_BROKER_BASE_SHA: options.baseSha,
        MERGE_BROKER_HEAD_SHA: options.headSha,
        MERGE_BROKER_BATCH_ID: options.batchId,
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
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
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
}
