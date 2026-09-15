import { spawn, spawnSync } from "node:child_process";
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
  /** Maximum bytes retained independently for stdout and stderr. */
  maxOutputBytes?: number;
  /** Terminate descendants as well as the immediate process when a timeout expires. */
  killProcessTree?: boolean;
  /** Use the host's native architecture when the Node process is translated. */
  executionArchitecture?: "process" | "native";
}

export interface ResolvedShell {
  executable: string;
  args: string[];
  quote: (value: string) => string;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quotePowerShell(value: string): string {
  // PowerShell accepts the typographic single quotes U+2018-U+201B as string delimiters too, so
  // each of them must be doubled like an ASCII apostrophe to stay literal.
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/gu, "$&$&")}'`;
}

/**
 * On Windows, libuv looks for a bare executable name in the working directory before PATH unless
 * the spawning process has `NoDefaultCurrentDirectoryInExePath` set. Broker commands run with a
 * candidate-controlled working directory, where a committed `git.exe` or `powershell.exe` would
 * otherwise be selected. The variable is set only while the synchronous spawn call runs, so the host
 * process and the child's own environment are unchanged.
 */
export function withoutCurrentDirectoryExecutableSearch<T>(
  operation: () => T,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): T {
  if (platform !== "win32") return operation();
  const name = "NoDefaultCurrentDirectoryInExePath";
  const previous = environment[name];
  environment[name] = "1";
  try {
    return operation();
  } finally {
    if (previous === undefined) delete environment[name];
    else environment[name] = previous;
  }
}

/**
 * Validators must run in a predictable interpreter. Deliberately not the operator's `$SHELL`, and
 * deliberately not a login shell: sourcing personal dotfiles would make an integration decision
 * depend on whose machine assembled the batch. The environment still comes from the calling
 * process, so PATH and toolchain managers work; a validator that needs more can set `env`.
 */
export function resolveShell(
  configured?: string,
  hostPlatform: NodeJS.Platform = process.platform,
): ResolvedShell {
  if (configured) {
    const isCmd = /(^|[\\/])cmd(\.exe)?$/iu.test(configured);
    if (isCmd) return { executable: configured, args: ["/d", "/s", "/c"], quote: quoteCmd };
    const isPowerShell = /(^|[\\/])(powershell|pwsh)(\.exe)?$/iu.test(configured);
    if (isPowerShell) {
      return {
        executable: configured,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        quote: quotePowerShell,
      };
    }
    return { executable: configured, args: ["-c"], quote: quotePosix };
  }
  return hostPlatform === "win32"
    ? {
        executable: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        quote: quotePowerShell,
      }
    : { executable: "/bin/sh", args: ["-c"], quote: quotePosix };
}

function quoteForDisplay(value: string): string {
  return /[\s"'\\]/u.test(value) ? JSON.stringify(value) : value;
}

export function nativeArchitecture(
  platform: NodeJS.Platform = process.platform,
  processArchitecture: string = process.arch,
): string {
  if (platform !== "darwin" || processArchitecture === "arm64") return processArchitecture;
  const probe = spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return probe.status === 0 && probe.stdout.trim() === "1" ? "arm64" : processArchitecture;
}

export function commandForArchitecture(
  executable: string,
  args: string[],
  executionArchitecture: "process" | "native" = "process",
  host: { platform?: NodeJS.Platform; processArchitecture?: string; nativeArchitecture?: string } = {},
): { executable: string; args: string[] } {
  if (executionArchitecture !== "native") return { executable, args };
  const platform = host.platform ?? process.platform;
  const processArchitecture = host.processArchitecture ?? process.arch;
  const hostArchitecture = host.nativeArchitecture ?? nativeArchitecture(platform, processArchitecture);
  if (platform !== "darwin" || hostArchitecture === processArchitecture) return { executable, args };
  const archFlag = hostArchitecture === "x64" ? "-x86_64" : `-${hostArchitecture}`;
  return { executable: "/usr/bin/arch", args: [archFlag, executable, ...args] };
}

class OutputCapture {
  private text = "";
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly limit?: number) {}

  append(chunk: string): void {
    if (this.limit === undefined) {
      this.text += chunk;
      return;
    }
    const value = Buffer.from(chunk, "utf8");
    if (!this.truncated) {
      const combined = Buffer.concat([Buffer.from(this.text, "utf8"), value]);
      if (combined.byteLength <= this.limit) {
        this.text = combined.toString("utf8");
        return;
      }
      this.truncated = true;
      const headBytes = Math.floor(this.limit * 0.75);
      const tailBytes = this.limit - headBytes;
      this.head = combined.subarray(0, headBytes);
      this.tail = combined.subarray(-tailBytes);
      this.text = "";
      return;
    }
    const tailBytes = this.limit - this.head.byteLength;
    this.tail = Buffer.concat([this.tail, value]).subarray(-tailBytes);
  }

  value(): string {
    if (!this.truncated) return this.text;
    return `${this.head.toString("utf8")}\n... output truncated by Merge Broker ...\n${this.tail.toString("utf8")}`;
  }
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, tree: boolean): void {
  if (tree && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already gone away.
    }
  }
  if (tree && process.platform === "win32" && child.pid) {
    // taskkill discovers descendants through the root's parent links, so the root must still be
    // alive while it walks the tree. Console processes also ignore a non-forced request. Force the
    // whole tree first and only then fall back to terminating the direct child.
    let fallback = false;
    const killDirectChild = (): void => {
      if (fallback) return;
      fallback = true;
      child.kill(signal);
    };
    const taskkill = withoutCurrentDirectoryExecutableSearch(() =>
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }),
    );
    taskkill.once("error", killDirectChild);
    taskkill.once("exit", killDirectChild);
    taskkill.unref();
    return;
  }
  child.kill(signal);
}

export async function runCommand(
  executable: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const command = commandForArchitecture(executable, args, options.executionArchitecture);
  const rendered = [command.executable, ...command.args].map(quoteForDisplay).join(" ");

  // Snapshot the inherited environment before the Windows search guard touches process.env.
  const env = options.env ?? { ...process.env };
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = withoutCurrentDirectoryExecutableSearch(() =>
      spawn(command.executable, command.args, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: "pipe",
        detached: options.killProcessTree === true && process.platform !== "win32",
        windowsHide: true,
      }),
    );
    const stdout = new OutputCapture(options.maxOutputBytes);
    const stderr = new OutputCapture(options.maxOutputBytes);
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate(child, "SIGTERM", options.killProcessTree ?? false);
          forceTimer = setTimeout(
            () => terminate(child, "SIGKILL", options.killProcessTree ?? false),
            2_000,
          );
          forceTimer.unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.append(chunk);
    });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut && options.killProcessTree) terminate(child, "SIGKILL", true);
      if (forceTimer) clearTimeout(forceTimer);
      const exitCode = code ?? (signal ? 128 : 1);
      let stderrValue = stderr.value();
      if (timedOut) {
        stderrValue += `\nTimed out after ${options.timeoutMs}ms`;
      }
      const result = { command: rendered, exitCode, stdout: stdout.value(), stderr: stderrValue };
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new CommandError(rendered, exitCode, result.stdout, result.stderr));
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
