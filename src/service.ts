import path from "node:path";
import { homedir, platform } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";

/**
 * Running the integration loop as a supervised background service.
 *
 * `serve` already polls for verified batches and publishes them, but it only
 * runs while somebody remembers to start it in a terminal. A submitted task
 * then sits in `submitted` indefinitely, which reads to the author as the
 * broker refusing the work rather than as nobody driving it. This installs the
 * loop as a per-user service so submission is the last manual step.
 *
 * Deliberately a *user* service on both platforms. A system daemon would need
 * root, would run as the wrong user for the repository's SSH and forge
 * credentials, and would publish on behalf of somebody who is not logged in.
 */

export const SERVICE_MARKER = "Installed by Agent Merge Broker";

export type ServicePlatform = "launchd" | "systemd";

export interface ServiceDefinition {
  platform: ServicePlatform;
  /** launchd label or systemd unit name, unique per repository. */
  name: string;
  /** Absolute path of the file the loader reads. */
  file: string;
  contents: string;
  logFile: string;
}

export interface ServiceInstallation extends ServiceDefinition {
  installed: boolean;
  loaded: boolean;
  /** Set when the loader refused, so the caller can report it without guessing. */
  loaderMessage?: string;
}

export function currentServicePlatform(value: string = platform()): ServicePlatform {
  if (value === "darwin") return "launchd";
  if (value === "linux") return "systemd";
  throw new BrokerError(
    "UNSUPPORTED_PLATFORM",
    `No supervised service is available on ${value}. Run "merge-broker serve --publish" from a terminal instead.`,
  );
}

/**
 * A repository-scoped identity. Two checkouts of the same project — which this
 * codebase has — must not fight over one service, and a label collision would
 * silently leave one of them unserved.
 */
export function serviceName(repositoryRoot: string): string {
  const base = path.basename(repositoryRoot).replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  let hash = 0;
  for (const character of repositoryRoot) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `merge-broker.serve.${base}.${hash.toString(16).padStart(8, "0")}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface ServiceOptions {
  repositoryRoot: string;
  /** Absolute path to the node executable that will run the CLI. */
  nodePath: string;
  /** Absolute path to the broker CLI entry point. */
  cliPath: string;
  intervalSeconds: number;
  eager: boolean;
  /**
   * Directories added to PATH. A launchd agent inherits almost nothing, so git
   * and the forge CLI are invisible unless they are named here — the failure
   * looks like the loop starting and then doing nothing.
   */
  pathEntries: string[];
  logFile: string;
}

export function launchdPlist(options: ServiceOptions): string {
  const args = [
    options.nodePath,
    options.cliPath,
    "-C",
    options.repositoryRoot,
    "serve",
    "--publish",
    "--interval",
    String(options.intervalSeconds),
    ...(options.eager ? ["--eager"] : []),
  ];
  const argumentXml = args
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${SERVICE_MARKER}. Remove with: merge-broker install-service --uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceName(options.repositoryRoot))}</string>
  <key>ProgramArguments</key>
  <array>
${argumentXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.repositoryRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(options.pathEntries.join(":"))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(options: ServiceOptions): string {
  const args = [
    options.nodePath,
    options.cliPath,
    "-C",
    options.repositoryRoot,
    "serve",
    "--publish",
    "--interval",
    String(options.intervalSeconds),
    ...(options.eager ? ["--eager"] : []),
  ];
  return `# ${SERVICE_MARKER}. Remove with: merge-broker install-service --uninstall
[Unit]
Description=Agent Merge Broker integration loop for ${options.repositoryRoot}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.repositoryRoot}
Environment=PATH=${options.pathEntries.join(":")}
ExecStart=${args.map((value) => JSON.stringify(value)).join(" ")}
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
}

export function serviceFilePath(
  servicePlatform: ServicePlatform,
  name: string,
  home: string = homedir(),
): string {
  return servicePlatform === "launchd"
    ? path.join(home, "Library", "LaunchAgents", `${name}.plist`)
    : path.join(home, ".config", "systemd", "user", `${name}.service`);
}

export function describeService(options: ServiceOptions, home: string = homedir()): ServiceDefinition {
  const servicePlatform = currentServicePlatform();
  const name = serviceName(options.repositoryRoot);
  return {
    platform: servicePlatform,
    name,
    file: serviceFilePath(servicePlatform, name, home),
    contents: servicePlatform === "launchd" ? launchdPlist(options) : systemdUnit(options),
    logFile: options.logFile,
  };
}

async function load(
  definition: ServiceDefinition,
  cwd: string,
): Promise<{ loaded: boolean; message?: string }> {
  const commands: Array<[string, string[]]> = definition.platform === "launchd"
    ? [
        ["launchctl", ["unload", definition.file]],
        ["launchctl", ["load", "-w", definition.file]],
      ]
    : [
        ["systemctl", ["--user", "daemon-reload"]],
        ["systemctl", ["--user", "enable", "--now", definition.name]],
      ];
  let message: string | undefined;
  for (const [command, args] of commands.slice(0, -1)) {
    // The first command tears down a previous copy. It fails when there is
    // none, which is the normal case on a first install, so it never decides
    // the outcome.
    await runCommand(command, args, { cwd, allowFailure: true }).catch(() => undefined);
  }
  const [command, args] = commands[commands.length - 1]!;
  const result = await runCommand(command, args, { cwd, allowFailure: true }).catch((error: unknown) => {
    message = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  if (!result) return message === undefined ? { loaded: false } : { loaded: false, message };
  if (result.exitCode !== 0) {
    return { loaded: false, message: result.stderr.trim() || result.stdout.trim() };
  }
  return { loaded: true };
}

export async function installService(
  options: ServiceOptions,
  home: string = homedir(),
): Promise<ServiceInstallation> {
  const definition = describeService(options, home);
  await mkdir(path.dirname(definition.file), { recursive: true });
  await mkdir(path.dirname(definition.logFile), { recursive: true });
  await writeFile(definition.file, definition.contents, "utf8");
  const outcome = await load(definition, options.repositoryRoot);
  return {
    ...definition,
    installed: true,
    loaded: outcome.loaded,
    ...(outcome.message ? { loaderMessage: outcome.message } : {}),
  };
}

export async function uninstallService(
  repositoryRoot: string,
  home: string = homedir(),
): Promise<{ name: string; file: string; removed: boolean }> {
  const servicePlatform = currentServicePlatform();
  const name = serviceName(repositoryRoot);
  const file = serviceFilePath(servicePlatform, name, home);
  const existed = await readFile(file, "utf8").then(() => true, () => false);
  if (servicePlatform === "launchd") {
    await runCommand("launchctl", ["unload", "-w", file], { cwd: repositoryRoot, allowFailure: true })
      .catch(() => undefined);
  } else {
    await runCommand("systemctl", ["--user", "disable", "--now", name], {
      cwd: repositoryRoot,
      allowFailure: true,
    }).catch(() => undefined);
  }
  await rm(file, { force: true });
  return { name, file, removed: existed };
}
