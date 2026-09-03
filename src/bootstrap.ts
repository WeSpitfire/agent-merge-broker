import path from "node:path";
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

const PACKAGE_LOCKS = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "Cargo.lock",
  "go.sum",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
];

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

function runScript(manager: string, script: string): string {
  return `${manager} run ${script}`;
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
        command: runScript(manager, script),
        ...(directory === "." ? {} : { workingDirectory: directory }),
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
          command: runScript(manager, completeScript),
          ...(directory === "." ? {} : { workingDirectory: directory }),
          timeoutSeconds: 1_200,
        });
      }
      if (directory === ".") rootComplete = true;
    } else if (!rootComplete) {
      authoritative.push(...selected.map((script) => ({
        name: `${label} ${script}`,
        command: runScript(manager, script),
        ...(directory === "." ? {} : { workingDirectory: directory }),
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
    return {
      name: `${label} tests`,
      command: "swift test --scratch-path {validatorCacheDir}",
      ...(directory === "." ? {} : { workingDirectory: directory }),
      paths: directory === "."
        ? ["**/*.swift", "Package.swift", "Package.resolved"]
        : [`${directory}/**/*.swift`, `${directory}/Package.swift`, `${directory}/Package.resolved`],
      timeoutSeconds: 1_200,
      executionArchitecture: "native",
    };
  });
}

function manifestScope(manifest: string, extensions: string[]): string[] {
  const directory = posix(path.dirname(manifest));
  const within = (name: string) => directory === "." ? name : `${directory}/${name}`;
  return [...extensions.map((extension) => within(`**/*.${extension}`)), manifest];
}

function goValidators(moduleFiles: string[]): ValidatorConfig[] {
  return moduleFiles.map((manifest) => {
    const directory = posix(path.dirname(manifest));
    return {
      name: `${directory === "." ? "Go workspace" : `Go ${directory}`} tests`,
      command: "go test ./...",
      ...(directory === "." ? {} : { workingDirectory: directory }),
      paths: [
        ...manifestScope(manifest, ["go"]),
        ...(directory === "." ? ["go.sum"] : [`${directory}/go.sum`]),
      ],
      timeoutSeconds: 1_200,
    };
  });
}

function rustValidators(manifestFiles: string[]): ValidatorConfig[] {
  return manifestFiles.map((manifest) => {
    const directory = posix(path.dirname(manifest));
    return {
      name: `${directory === "." ? "Rust workspace" : `Rust ${directory}`} tests`,
      command: "cargo test --workspace",
      ...(directory === "." ? {} : { workingDirectory: directory }),
      paths: [
        ...manifestScope(manifest, ["rs"]),
        ...(directory === "." ? ["Cargo.lock"] : [`${directory}/Cargo.lock`]),
      ],
      timeoutSeconds: 1_200,
    };
  });
}

async function pythonValidators(root: string, discovered: string[]): Promise<{
  ecosystems: string[];
  focused: ValidatorConfig[];
  authoritative: ValidatorConfig[];
  unresolved: string[];
}> {
  const manifests = discovered.filter((file) => path.posix.basename(file) === "pyproject.toml");
  const special = discovered.filter((file) => ["pytest.ini", "tox.ini", "noxfile.py"].includes(path.posix.basename(file)));
  const directories = [...new Set([...manifests, ...special].map((file) => posix(path.dirname(file))))].sort();
  const focused: ValidatorConfig[] = [];
  const authoritative: ValidatorConfig[] = [];
  const unresolved: string[] = [];
  for (const directory of directories) {
    const within = (name: string) => directory === "." ? name : `${directory}/${name}`;
    const pyproject = within("pyproject.toml");
    const source = manifests.includes(pyproject) ? await readFile(path.join(root, pyproject), "utf8") : "";
    const runner = discovered.includes(within("uv.lock"))
      ? "uv run "
      : discovered.includes(within("poetry.lock")) || /\[tool\.poetry\]/u.test(source)
        ? "poetry run "
        : "";
    const common = {
      ...(directory === "." ? {} : { workingDirectory: directory }),
      paths: [within("**/*.py"), ...(manifests.includes(pyproject) ? [pyproject] : [])],
      timeoutSeconds: 1_200,
    };
    const label = directory === "." ? "Python workspace" : `Python ${directory}`;
    if (discovered.includes(within("tox.ini"))) {
      authoritative.push({ name: `${label} tox`, command: `${runner}tox`, ...common });
      continue;
    }
    if (discovered.includes(within("noxfile.py"))) {
      authoritative.push({ name: `${label} nox`, command: `${runner}nox`, ...common });
      continue;
    }
    const declared: ValidatorConfig[] = [];
    if (discovered.includes(within("pytest.ini")) || /\[tool\.pytest\./u.test(source)) {
      declared.push({ name: `${label} tests`, command: `${runner}pytest`, ...common });
    }
    if (/\[tool\.ruff(?:\.|\])/u.test(source)) {
      const validator = { name: `${label} ruff`, command: `${runner}ruff check .`, ...common };
      focused.push(validator);
      declared.push(validator);
    }
    if (/\[tool\.mypy(?:\.|\])/u.test(source)) {
      const validator = { name: `${label} mypy`, command: `${runner}mypy .`, ...common };
      focused.push(validator);
      declared.push(validator);
    }
    if (declared.length === 0) {
      unresolved.push(`${pyproject} declares no supported pytest, Ruff, mypy, tox, or nox validation entry point.`);
    } else {
      authoritative.push(...declared);
    }
  }
  return { ecosystems: directories.map((directory) => `python:${directory}`), focused, authoritative, unresolved };
}

function deduplicateValidators(validators: ValidatorConfig[]): ValidatorConfig[] {
  const seen = new Set<string>();
  return validators.filter((validator) => {
    const key = `${validator.workingDirectory ?? "."}\0${validator.command}\0${JSON.stringify(validator.paths ?? [])}`;
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
  const goModules = discovered.filter((file) => file === "go.mod" || file.endsWith("/go.mod"));
  const go = goValidators(goModules);
  const rustManifests = discovered.filter((file) => file === "Cargo.toml" || file.endsWith("/Cargo.toml"));
  const rust = rustValidators(rustManifests);
  const python = await pythonValidators(root, discovered);
  const ecosystems = [
    ...packages.ecosystems,
    ...swiftPackages.map((file) => `swift:${posix(path.dirname(file))}`),
    ...goModules.map((file) => `go:${posix(path.dirname(file))}`),
    ...rustManifests.map((file) => `rust:${posix(path.dirname(file))}`),
    ...python.ecosystems,
  ].sort();
  const focused = deduplicateValidators([...packages.focused, ...swift, ...go, ...rust, ...python.focused]);
  const authoritative = deduplicateValidators([
    ...packages.authoritative,
    ...(packages.rootComplete
      ? []
      : [...swift, ...go, ...rust, ...python.authoritative].map(({ paths: _paths, ...item }) => item)),
  ]);
  const serializedPatterns = [
    ...discovered.filter((file) => PACKAGE_LOCKS.includes(path.posix.basename(file))),
    ...swiftPackages.map((file) => posix(path.join(path.dirname(file), "Package.resolved"))),
  ].sort();
  const unresolved = [...packages.unresolved, ...python.unresolved];
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
