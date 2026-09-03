import path from "node:path";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { BrokerConfig, ValidatorConfig } from "./types.js";
import { BrokerError } from "./errors.js";

const AGENT_BLOCK_START = "<!-- agent-merge-broker:start -->";
const AGENT_BLOCK_END = "<!-- agent-merge-broker:end -->";
const AGENT_BLOCK = `${AGENT_BLOCK_START}
## Agent Merge Broker

This repository uses Agent Merge Broker as its implementation-integration authority. Before editing,
read \`.merge-broker/agent-instructions.md\` and follow its claim, lease, candidate, and revision
protocol. Workers do not push implementation branches, open pull requests, or merge their own work.
${AGENT_BLOCK_END}`;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".build",
  ".next",
  ".swiftpm",
  "DerivedData",
  "dist",
  "build",
  "node_modules",
  "vendor",
]);

export interface BootstrapPlan {
  ecosystems: string[];
  focused: ValidatorConfig[];
  authoritative: ValidatorConfig[];
  serializedPatterns: string[];
  unresolved: string[];
}

export interface AgentContractResult {
  path: string;
  changed: boolean;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function posix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function discoverFiles(root: string, maxDepth = 4): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = posix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await visit(root, 0);
  return files.sort();
}

const PACKAGE_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"];

function packageManager(
  files: Set<string>,
  packageJson: Record<string, unknown>,
  directory: string,
): string {
  const declared = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : undefined;
  if (declared && new Set(["npm", "pnpm", "yarn", "bun"]).has(declared)) return declared;
  let candidate = directory;
  while (true) {
    const at = (name: string) => files.has(candidate === "." ? name : `${candidate}/${name}`);
    if (at("pnpm-lock.yaml")) return "pnpm";
    if (at("yarn.lock")) return "yarn";
    if (at("bun.lock") || at("bun.lockb")) return "bun";
    if (at("package-lock.json")) return "npm";
    if (candidate === ".") break;
    candidate = posix(path.dirname(candidate));
  }
  return "npm";
}

function runScript(manager: string, script: string, directory: string): string {
  const prefix = directory === "." ? "" : ` --dir ${shellQuote(directory)}`;
  if (manager === "pnpm") return `pnpm${prefix} run ${shellQuote(script)}`;
  if (manager === "yarn") {
    return directory === "."
      ? `yarn run ${shellQuote(script)}`
      : `yarn --cwd ${shellQuote(directory)} run ${shellQuote(script)}`;
  }
  if (manager === "bun") {
    return directory === "."
      ? `bun run ${shellQuote(script)}`
      : `bun --cwd ${shellQuote(directory)} run ${shellQuote(script)}`;
  }
  return directory === "."
    ? `npm run ${shellQuote(script)}`
    : `npm --prefix ${shellQuote(directory)} run ${shellQuote(script)}`;
}

function packagePaths(directory: string): string[] {
  return directory === "." ? ["**/*"] : [`${directory}/**`];
}

async function packageValidators(
  root: string,
  packageFiles: string[],
  files: Set<string>,
): Promise<{
  ecosystems: string[];
  focused: ValidatorConfig[];
  authoritative: ValidatorConfig[];
  unresolved: string[];
  rootComplete: boolean;
}> {
  const focused: ValidatorConfig[] = [];
  const authoritative: ValidatorConfig[] = [];
  const ecosystems: string[] = [];
  const unresolved: string[] = [];
  let rootComplete = false;
  for (const packageFile of packageFiles) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(path.join(root, packageFile), "utf8")) as Record<string, unknown>;
    } catch {
      unresolved.push(`${packageFile} is not valid JSON; JavaScript validation was not configured.`);
      continue;
    }
    const directory = posix(path.dirname(packageFile));
    const label = directory === "." ? "workspace" : directory;
    const scripts = manifest.scripts && typeof manifest.scripts === "object"
      ? manifest.scripts as Record<string, unknown>
      : {};
    const manager = packageManager(files, manifest, directory);
    ecosystems.push(`${manager}:${label}`);
    const exact = (name: string) => typeof scripts[name] === "string";
    const selected = ["lint", "typecheck", "type-check", "test", "build"].filter(exact);
    for (const script of selected) {
      const validator: ValidatorConfig = {
        name: `${label} ${script}`,
        command: runScript(manager, script, directory),
        timeoutSeconds: script === "build" ? 1_200 : 900,
      };
      if (script === "lint" || script === "typecheck" || script === "type-check") {
        focused.push({ ...validator, paths: packagePaths(directory), timeoutSeconds: 600 });
      }
    }
    const completeScript = ["verify", "ci", "check"].find(exact);
    if (completeScript) {
      if (directory === "." || !rootComplete) {
        authoritative.push({
          name: `${label} ${completeScript}`,
          command: runScript(manager, completeScript, directory),
          timeoutSeconds: 1_200,
        });
      }
      if (directory === ".") rootComplete = true;
    } else if (!rootComplete) {
      authoritative.push(...selected.map((script) => ({
        name: `${label} ${script}`,
        command: runScript(manager, script, directory),
        timeoutSeconds: script === "build" ? 1_200 : 900,
      })));
    }
    if (!rootComplete && !completeScript && selected.length === 0) {
      unresolved.push(`${packageFile} declares no recognized verify, ci, check, lint, typecheck, test, or build script.`);
    }
  }
  return { ecosystems, focused, authoritative, unresolved, rootComplete };
}

function swiftValidators(packageFiles: string[]): ValidatorConfig[] {
  return packageFiles.map((packageFile) => {
    const directory = posix(path.dirname(packageFile));
    const label = directory === "." ? "Swift workspace" : `Swift ${directory}`;
    const packageArgument = directory === "." ? "" : ` --package-path ${shellQuote(directory)}`;
    const cacheKey = createHash("sha256").update(directory).digest("hex").slice(0, 12);
    return {
      name: `${label} tests`,
      command: `swift test${packageArgument} --scratch-path "$MERGE_BROKER_CACHE_DIR/swift-${cacheKey}"`,
      paths: directory === "."
        ? ["**/*.swift", "Package.swift", "Package.resolved"]
        : [`${directory}/**/*.swift`, `${directory}/Package.swift`, `${directory}/Package.resolved`],
      timeoutSeconds: 1_200,
      executionArchitecture: "native",
    };
  });
}

function deduplicateValidators(validators: ValidatorConfig[]): ValidatorConfig[] {
  const seen = new Set<string>();
  return validators.filter((validator) => {
    const key = `${validator.command}\0${JSON.stringify(validator.paths ?? [])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function detectBootstrapPlan(root: string): Promise<BootstrapPlan> {
  const discovered = await discoverFiles(root);
  const files = new Set(discovered);
  const packageFiles = discovered
    .filter((file) => file === "package.json" || file.endsWith("/package.json"))
    .sort((left, right) => left === "package.json" ? -1 : right === "package.json" ? 1 : left.localeCompare(right));
  const packages = await packageValidators(root, packageFiles, files);
  const swiftPackages = discovered.filter((file) => file === "Package.swift" || file.endsWith("/Package.swift"));
  const swift = swiftValidators(swiftPackages);
  const ecosystems = [...packages.ecosystems, ...swiftPackages.map((file) => `swift:${posix(path.dirname(file))}`)].sort();
  const focused = deduplicateValidators([...packages.focused, ...swift]);
  const authoritative = deduplicateValidators([
    ...packages.authoritative,
    ...(packages.rootComplete ? [] : swift.map(({ paths: _paths, ...item }) => item)),
  ]);
  const serializedPatterns = [
    ...discovered.filter((file) => PACKAGE_LOCKS.includes(path.posix.basename(file))),
    ...swiftPackages.map((file) => posix(path.join(path.dirname(file), "Package.resolved"))),
  ].sort();
  const unresolved = [...packages.unresolved];
  if (discovered.some((file) => file.endsWith(".xcodeproj/project.pbxproj") || file.endsWith(".xcworkspace/contents.xcworkspacedata"))) {
    unresolved.push("Xcode project detected, but no destination or scheme was inferred. Add an explicit xcodebuild validator.");
  }
  if (focused.length === 0 && authoritative.length === 0) {
    unresolved.push("No supported validation entry point was detected; configure validation before integrating work.");
  }
  return { ecosystems, focused, authoritative, serializedPatterns, unresolved };
}

export function applyBootstrapPlan(config: BrokerConfig, plan: BootstrapPlan): boolean {
  let changed = false;
  if (
    config.validation.authority === "broker" &&
    config.validation.focused.length === 0 &&
    config.validation.authoritative.length === 0 &&
    plan.authoritative.length > 0
  ) {
    config.validation.focused = plan.focused;
    config.validation.authoritative = plan.authoritative;
    changed = true;
  }
  const serialized = [...new Set([...config.leases.serializedPatterns, ...plan.serializedPatterns])].sort();
  if (JSON.stringify(serialized) !== JSON.stringify(config.leases.serializedPatterns)) {
    config.leases.serializedPatterns = serialized;
    changed = true;
  }
  return changed;
}

export async function installAgentContract(root: string): Promise<AgentContractResult> {
  const target = path.join(root, "AGENTS.md");
  const current = (await exists(target)) ? await readFile(target, "utf8") : "";
  const start = current.indexOf(AGENT_BLOCK_START);
  const end = current.indexOf(AGENT_BLOCK_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new BrokerError(
      "INVALID_AGENT_CONTRACT",
      `The managed Merge Broker block in ${target} is incomplete; restore both marker lines before re-running init.`,
    );
  }
  let next: string;
  if (start >= 0 && end >= start) {
    next = `${current.slice(0, start)}${AGENT_BLOCK}${current.slice(end + AGENT_BLOCK_END.length)}`;
  } else {
    next = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${AGENT_BLOCK}\n`;
  }
  if (next === current) return { path: target, changed: false };
  await writeFile(target, next, "utf8");
  return { path: target, changed: true };
}

export async function hasAgentContract(root: string): Promise<boolean> {
  const target = path.join(root, "AGENTS.md");
  if (!(await exists(target))) return false;
  const contents = await readFile(target, "utf8");
  return contents.includes(AGENT_BLOCK_START) && contents.includes(AGENT_BLOCK_END);
}
