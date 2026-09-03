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
    spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
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

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "pipe",
      detached: options.killProcessTree === true && process.platform !== "win32",
      windowsHide: true,
    });
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
