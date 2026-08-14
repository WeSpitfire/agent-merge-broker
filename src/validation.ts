import { runShell } from "./process.js";
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

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderCommand(command: string, taskId: string | undefined, files: string[]): string {
  return command
    .replaceAll("{taskId}", taskId ? shellQuote(taskId) : "''")
    .replaceAll("{files}", files.map(shellQuote).join(" "));
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
}): Promise<ValidationResult[]> {
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
    const command = renderCommand(validator.command, options.taskId, options.files);
    const startedAt = new Date();
    const result = await runShell(command, {
      cwd: options.cwd,
      allowFailure: true,
      timeoutMs: (validator.timeoutSeconds ?? 900) * 1_000,
      env: {
        ...process.env,
        ...validator.env,
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
