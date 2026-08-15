import { spawn } from "node:child_process";
import { CommandError } from "./errors.js";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface ResolvedShell {
  executable: string;
  args: string[];
  quote: (value: string) => string;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * cmd.exe has no escape for a literal `%`, so a path containing one can still be expanded as an
 * environment reference. Git paths that contain `%` or `"` are pathological; POSIX shells are the
 * supported and tested surface.
 */
function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Validators must run in a predictable interpreter. Deliberately not the operator's `$SHELL`, and
 * deliberately not a login shell: sourcing personal dotfiles would make an integration decision
 * depend on whose machine assembled the batch. The environment still comes from the calling
 * process, so PATH and toolchain managers work; a validator that needs more can set `env`.
 */
export function resolveShell(configured?: string): ResolvedShell {
  if (configured) {
    const isCmd = /(^|[\\/])cmd(\.exe)?$/iu.test(configured);
    return isCmd
      ? { executable: configured, args: ["/d", "/s", "/c"], quote: quoteCmd }
      : { executable: configured, args: ["-c"], quote: quotePosix };
  }
  return process.platform === "win32"
    ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"], quote: quoteCmd }
    : { executable: "/bin/sh", args: ["-c"], quote: quotePosix };
}

function quoteForDisplay(value: string): string {
  return /[\s"'\\]/u.test(value) ? JSON.stringify(value) : value;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const rendered = [executable, ...args].map(quoteForDisplay).join(" ");

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 1);
      if (timedOut) {
        stderr += `\nTimed out after ${options.timeoutMs}ms`;
      }
      const result = { command: rendered, exitCode, stdout, stderr };
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new CommandError(rendered, exitCode, stdout, stderr));
      } else {
        resolve(result);
      }
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runShell(
  command: string,
  options: RunOptions & { shell?: ResolvedShell },
): Promise<CommandResult> {
  const shell = options.shell ?? resolveShell();
  return await runCommand(shell.executable, [...shell.args, command], options);
}
