import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { BrokerError } from "./errors.js";
import { validateProvenancePublicKey } from "./provenance.js";
import { CONFIG_VERSION, type BrokerConfig, type MergeMethod, type PublishMode } from "./types.js";

export const CONFIG_DIRECTORY = ".merge-broker";
export const CONFIG_FILENAME = "config.json";
export const AGENT_INSTRUCTIONS_FILENAME = "agent-instructions.md";

const AGENT_INSTRUCTIONS = `# Merge Broker agent contract

This repository coordinates parallel work with Agent Merge Broker.

1. Claim a task and declare the smallest accurate path scope before editing:
   \`merge-broker task claim <task-id> --holder <agent> --path 'src/area/**'\`
2. Heartbeat long-running work with \`merge-broker task heartbeat <task-id>\`. The broker holds the
   lease token for you; pass \`--token\` only when working from another machine.
3. Work only inside the declared scope. Coordinate a new claim before expanding it.
4. Commit the completed, focused change. Agents do not merge, rebase, push, or administer branches.
5. Submit immutable commits to the broker:
   \`merge-broker task submit <task-id> --since-base\`
6. Report the task ID, commit SHA, changed paths, and validation performed.

The broker owns integration ordering, conflict resolution requests, validation, batching, and publication.
`;

export function defaultConfig(baseBranch = "main", remote = "origin", baseRef = baseBranch): BrokerConfig {
  return {
    version: CONFIG_VERSION,
    baseBranch,
    baseRef,
    remote,
    stateDirectory: "merge-broker",
    leases: {
      ttlSeconds: 1_800,
      lockTimeoutSeconds: 15,
      serializedPatterns: [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
      ],
    },
    policies: {
      unexpectedPaths: "error",
      requireCleanWorktree: false,
      requireDependencies: true,
    },
    scheduling: {
      maxTasks: 6,
      maxCommits: 12,
      maxWaitSeconds: 600,
      allowPathOverlap: false,
    },
    integration: {
      branchPrefix: "merge-broker/",
      history: "preserve",
      keepFailedWorktrees: false,
      refreshBase: true,
      maxAttempts: 3,
      provenance: {
        enabled: true,
        directory: ".merge-broker/attestations",
        requireSignature: false,
      },
    },
    validation: {
      focused: [],
      authoritative: [],
    },
    publish: {
      mode: "none",
      draft: false,
      autoMerge: true,
      mergeMethod: "squash",
      labels: [],
      titleTemplate: "Integration batch {batchId}",
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_DIRECTORY, CONFIG_FILENAME);
}

export async function initializeConfig(
  repoRoot: string,
  options: { baseBranch?: string; baseRef?: string; remote?: string; force?: boolean } = {},
): Promise<{ path: string; config: BrokerConfig; created: boolean }> {
  const target = configPath(repoRoot);
  if ((await exists(target)) && !options.force) {
    const instructions = path.join(path.dirname(target), AGENT_INSTRUCTIONS_FILENAME);
    if (!(await exists(instructions))) await writeFile(instructions, AGENT_INSTRUCTIONS, "utf8");
    return { path: target, config: await loadConfig(repoRoot), created: false };
  }
  const config = defaultConfig(options.baseBranch, options.remote, options.baseRef);
  await mkdir(path.dirname(target), { recursive: true });
  await writeConfig(repoRoot, config);
  const instructions = path.join(path.dirname(target), AGENT_INSTRUCTIONS_FILENAME);
  if (!(await exists(instructions))) await writeFile(instructions, AGENT_INSTRUCTIONS, "utf8");
  return { path: target, config, created: true };
}

function assertString(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} must be a non-empty string.`);
  }
}

function assertPositiveInteger(value: unknown, key: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} must be a positive integer.`);
  }
}

function assertBoolean(value: unknown, key: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} must be a boolean.`);
  }
}

function assertStringArray(value: unknown, key: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} must be an array of non-empty strings.`);
  }
}

function assertAllowedKeys(value: unknown, key: string, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} must be an object.`);
  }
  const unexpected = Object.keys(value).filter((item) => !allowed.includes(item));
  if (unexpected.length > 0) {
    throw new BrokerError("INVALID_CONFIG", `Unknown configuration field(s) in ${key}: ${unexpected.join(", ")}.`);
  }
}

function assertSafeGitName(value: string, key: string, allowTrailingSlash = false): void {
  const candidate = allowTrailingSlash ? value.replace(/\/+$/u, "") : value;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(candidate) ||
    candidate.includes("..") ||
    candidate.includes("//") ||
    candidate.endsWith(".") ||
    (!allowTrailingSlash && candidate.endsWith("/"))
  ) {
    throw new BrokerError("INVALID_CONFIG", `Configuration field ${key} is not a safe Git name.`);
  }
}

export function validateConfig(value: unknown): BrokerConfig {
  if (!value || typeof value !== "object") {
    throw new BrokerError("INVALID_CONFIG", "Configuration must be a JSON object.");
  }
  const config = value as BrokerConfig;
  assertAllowedKeys(config, "root", [
    "version",
    "baseBranch",
    "baseRef",
    "remote",
    "stateDirectory",
    "leases",
    "policies",
    "scheduling",
    "integration",
    "validation",
    "publish",
  ]);
  if (config.version !== CONFIG_VERSION) {
    throw new BrokerError("INVALID_CONFIG", `Unsupported configuration version: ${String(config.version)}`);
  }
  assertString(config.baseBranch, "baseBranch");
  assertString(config.baseRef, "baseRef");
  assertString(config.remote, "remote");
  assertSafeGitName(config.baseBranch, "baseBranch");
  assertSafeGitName(config.baseRef, "baseRef");
  assertSafeGitName(config.remote, "remote");
  assertString(config.stateDirectory, "stateDirectory");
  if (
    path.isAbsolute(config.stateDirectory) ||
    config.stateDirectory === "." ||
    config.stateDirectory.split(/[\\/]/u).some((part) => part === "..") ||
    new Set(["branches", "hooks", "info", "logs", "objects", "refs", "worktrees"]).has(
      config.stateDirectory.split(/[\\/]/u)[0] ?? "",
    )
  ) {
    throw new BrokerError("INVALID_CONFIG", "stateDirectory must stay inside Git's common directory.");
  }
  assertAllowedKeys(config.leases, "leases", ["ttlSeconds", "lockTimeoutSeconds", "serializedPatterns"]);
  assertPositiveInteger(config.leases?.ttlSeconds, "leases.ttlSeconds");
  assertPositiveInteger(config.leases?.lockTimeoutSeconds, "leases.lockTimeoutSeconds");
  assertStringArray(config.leases?.serializedPatterns, "leases.serializedPatterns");
  assertAllowedKeys(config.policies, "policies", [
    "unexpectedPaths",
    "requireCleanWorktree",
    "requireDependencies",
  ]);
  if (
    config.policies?.unexpectedPaths !== "error" &&
    config.policies?.unexpectedPaths !== "warn" &&
    config.policies?.unexpectedPaths !== "allow"
  ) {
    throw new BrokerError("INVALID_CONFIG", "policies.unexpectedPaths must be error, warn, or allow.");
  }
  assertBoolean(config.policies?.requireCleanWorktree, "policies.requireCleanWorktree");
  assertBoolean(config.policies?.requireDependencies, "policies.requireDependencies");
  assertAllowedKeys(config.scheduling, "scheduling", [
    "maxTasks",
    "maxCommits",
    "maxWaitSeconds",
    "allowPathOverlap",
  ]);
  assertPositiveInteger(config.scheduling?.maxTasks, "scheduling.maxTasks");
  assertPositiveInteger(config.scheduling?.maxCommits, "scheduling.maxCommits");
  assertPositiveInteger(config.scheduling?.maxWaitSeconds, "scheduling.maxWaitSeconds");
  assertBoolean(config.scheduling?.allowPathOverlap, "scheduling.allowPathOverlap");
  assertAllowedKeys(config.integration, "integration", [
    "branchPrefix",
    "history",
    "keepFailedWorktrees",
    "refreshBase",
    "maxAttempts",
    "provenance",
  ]);
  assertString(config.integration?.branchPrefix, "integration.branchPrefix");
  assertSafeGitName(config.integration.branchPrefix, "integration.branchPrefix", true);
  if (!(["preserve", "squash"] as const).includes(config.integration?.history)) {
    throw new BrokerError("INVALID_CONFIG", "integration.history must be preserve or squash.");
  }
  assertBoolean(config.integration?.keepFailedWorktrees, "integration.keepFailedWorktrees");
  config.integration.refreshBase ??= true;
  config.integration.maxAttempts ??= 3;
  assertBoolean(config.integration.refreshBase, "integration.refreshBase");
  assertPositiveInteger(config.integration.maxAttempts, "integration.maxAttempts");
  if (config.integration.provenance !== undefined) {
    assertAllowedKeys(config.integration.provenance, "integration.provenance", [
      "enabled",
      "directory",
      "requireSignature",
      "publicKey",
    ]);
    assertBoolean(config.integration.provenance.enabled, "integration.provenance.enabled");
    assertString(config.integration.provenance.directory, "integration.provenance.directory");
    config.integration.provenance.requireSignature ??= false;
    assertBoolean(config.integration.provenance.requireSignature, "integration.provenance.requireSignature");
    if (config.integration.provenance.publicKey !== undefined) {
      assertString(config.integration.provenance.publicKey, "integration.provenance.publicKey");
      try {
        validateProvenancePublicKey(config.integration.provenance.publicKey);
      } catch (error) {
        throw new BrokerError(
          "INVALID_CONFIG",
          `integration.provenance.publicKey must be an Ed25519 public key: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (config.integration.provenance.requireSignature && !config.integration.provenance.enabled) {
      throw new BrokerError("INVALID_CONFIG", "Signed provenance cannot be required while provenance is disabled.");
    }
    if (config.integration.provenance.requireSignature && !config.integration.provenance.publicKey) {
      throw new BrokerError(
        "INVALID_CONFIG",
        "integration.provenance.publicKey is required when requireSignature is true.",
      );
    }
    const directory = config.integration.provenance.directory.replaceAll("\\", "/");
    if (
      path.isAbsolute(directory) ||
      directory === "." ||
      directory.split("/").some((part) => part === ".." || part === ".git")
    ) {
      throw new BrokerError(
        "INVALID_CONFIG",
        "integration.provenance.directory must be a safe repository-relative directory.",
      );
    }
  }
  assertAllowedKeys(config.validation, "validation", ["shell", "focused", "authoritative"]);
  if (!Array.isArray(config.validation.focused) || !Array.isArray(config.validation.authoritative)) {
    throw new BrokerError("INVALID_CONFIG", "validation.focused and validation.authoritative must be arrays.");
  }
  if (config.validation.shell !== undefined) assertString(config.validation.shell, "validation.shell");
  assertAllowedKeys(config.publish, "publish", [
    "mode",
    "draft",
    "autoMerge",
    "mergeMethod",
    "labels",
    "titleTemplate",
  ]);
  if (!(["none", "branch", "pull-request"] satisfies PublishMode[]).includes(config.publish?.mode)) {
    throw new BrokerError("INVALID_CONFIG", "publish.mode must be none, branch, or pull-request.");
  }
  assertBoolean(config.publish?.draft, "publish.draft");
  // Absent on configurations written before auto-merge existed. Defaulting to false keeps an
  // upgrade from silently starting to land agent work on the base branch.
  config.publish.autoMerge ??= false;
  config.publish.mergeMethod ??= "squash";
  assertBoolean(config.publish.autoMerge, "publish.autoMerge");
  if (!(["squash", "merge", "rebase"] satisfies MergeMethod[]).includes(config.publish.mergeMethod)) {
    throw new BrokerError("INVALID_CONFIG", "publish.mergeMethod must be squash, merge, or rebase.");
  }
  if (config.publish.autoMerge && config.publish.draft) {
    throw new BrokerError(
      "INVALID_CONFIG",
      "publish.autoMerge cannot be combined with publish.draft: GitHub refuses to merge a draft pull request.",
    );
  }
  // "none" is the generated default and simply means publishing is not enabled yet, so auto-merge
  // is allowed to sit there as declared intent. "branch" mode has no pull request to merge.
  if (config.publish.autoMerge && config.publish.mode === "branch") {
    throw new BrokerError(
      "INVALID_CONFIG",
      "publish.autoMerge has no effect in branch mode: set publish.mode to pull-request.",
    );
  }
  assertStringArray(config.publish?.labels, "publish.labels");
  assertString(config.publish?.titleTemplate, "publish.titleTemplate");
  for (const [scope, validators] of Object.entries(config.validation ?? {})) {
    if (scope === "shell") continue;
    if (!Array.isArray(validators)) {
      throw new BrokerError("INVALID_CONFIG", `validation.${scope} must be an array.`);
    }
    for (const validator of validators) {
      assertAllowedKeys(validator, `validation.${scope}[]`, ["name", "command", "paths", "timeoutSeconds", "env"]);
      assertString(validator.name, `validation.${scope}.name`);
      assertString(validator.command, `validation.${scope}.command`);
      if (validator.paths !== undefined) assertStringArray(validator.paths, `validation.${scope}.paths`);
      if (validator.timeoutSeconds !== undefined) {
        assertPositiveInteger(validator.timeoutSeconds, `validation.${scope}.timeoutSeconds`);
      }
      if (
        validator.env !== undefined &&
        (typeof validator.env !== "object" ||
          validator.env === null ||
          Object.values(validator.env).some((item) => typeof item !== "string"))
      ) {
        throw new BrokerError("INVALID_CONFIG", `validation.${scope}.env must contain only string values.`);
      }
    }
  }
  return config;
}

export async function loadConfig(repoRoot: string): Promise<BrokerConfig> {
  const target = configPath(repoRoot);
  let source: string;
  try {
    source = await readFile(target, "utf8");
  } catch (error) {
    throw new BrokerError(
      "NOT_INITIALIZED",
      `Merge Broker is not initialized. Run \"merge-broker init\" in ${repoRoot}.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    return validateConfig(JSON.parse(source));
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("INVALID_CONFIG", `Could not parse ${target}: ${String(error)}`);
  }
}

export async function writeConfig(repoRoot: string, config: BrokerConfig): Promise<string> {
  const target = configPath(repoRoot);
  validateConfig(config);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return target;
}
