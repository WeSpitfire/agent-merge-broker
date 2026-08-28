#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import { BrokerError, CommandError } from "./errors.js";
import {
  formatServeEvent,
  isErrorEvent,
  serveEventJson,
  shouldReportIdle,
  type ServeEvent,
} from "./serve-log.js";
import { MergeBroker } from "./broker.js";
import { GitRepository } from "./git.js";
import { policyFromBase, verifyProvenance } from "./verify.js";
import type {
  BatchRecord,
  BrokerState,
  LocalValidationResult,
  SchedulePlan,
  TaskRecord,
} from "./types.js";

const program = new Command();
const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function globalOptions(): { cwd: string; json: boolean } {
  const options = program.opts<{ cwd?: string; json?: boolean }>();
  return { cwd: options.cwd ?? process.cwd(), json: options.json ?? false };
}

function output(value: unknown, human?: string): void {
  if (globalOptions().json || !human) console.log(JSON.stringify(value, null, 2));
  else console.log(human);
}

interface TokenOptions {
  token?: string;
  tokenFile?: string;
}

/**
 * Finds the lease token for a task: an explicit flag first, then an explicit file, then the
 * environment, and finally the copy the broker kept when the task was claimed on this machine.
 */
async function findLeaseToken(
  broker: MergeBroker,
  taskId: string,
  options: TokenOptions,
): Promise<string | undefined> {
  if (options.token) return options.token;
  if (options.tokenFile) {
    const contents = (await readFile(path.resolve(options.tokenFile), "utf8")).trim();
    if (!contents) throw new BrokerError("LEASE_TOKEN", `No lease token in ${options.tokenFile}.`);
    return contents;
  }
  if (process.env.MERGE_BROKER_TOKEN) return process.env.MERGE_BROKER_TOKEN;
  return await broker.store.readToken(taskId);
}

async function requireLeaseToken(broker: MergeBroker, taskId: string, options: TokenOptions): Promise<string> {
  const token = await findLeaseToken(broker, taskId, options);
  if (!token) {
    throw new BrokerError(
      "LEASE_TOKEN",
      `No lease token for ${taskId}. Pass --token or --token-file, set MERGE_BROKER_TOKEN, or claim the task on this machine so the broker holds it for you.`,
    );
  }
  return token;
}

function defaultHolder(): string {
  return process.env.MERGE_BROKER_AGENT ?? process.env.USER ?? `${os.hostname()}:${process.pid}`;
}

function taskSummary(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    priority: task.priority,
    agent: task.agent,
    commits: task.commits.length,
    paths: task.actualPaths.length > 0 ? task.actualPaths : task.expectedPaths,
    dependencies: task.dependsOn,
    leaseHolder: task.lease?.holder,
    leaseExpiresAt: task.lease?.expiresAt,
    batchId: task.batchId,
    updatedAt: task.updatedAt,
    warnings: task.warnings,
    lastError: task.lastError,
  };
}

function publicTask(task: TaskRecord): Record<string, unknown> {
  const { lease, ...rest } = task;
  if (!lease) return rest;
  const { tokenHash: _tokenHash, ...publicLease } = lease;
  return { ...rest, lease: publicLease };
}

function publicState(state: BrokerState): Record<string, unknown> {
  return {
    ...state,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, value]) => [id, publicTask(value)])),
  };
}

function stateHuman(state: BrokerState): string {
  const tasks = Object.values(state.tasks).sort((a, b) => a.id.localeCompare(b.id));
  if (tasks.length === 0) return "No broker tasks.";
  return tasks
    .map(
      (task) =>
        `${task.id.padEnd(24)} ${task.status.padEnd(12)} commits=${String(task.commits.length).padEnd(3)} ${
          task.lease ? `lease=${task.lease.holder}` : ""
        }`,
    )
    .join("\n");
}

function planHuman(plan: SchedulePlan): string {
  const selected = plan.selected.map((task) => `  + ${task.id} (${task.commits.length} commit(s))`);
  const rejected = plan.rejected.map(
    (item) => `  - ${item.taskId}: ${item.reason}${item.conflictsWith ? ` with ${item.conflictsWith}` : ""}`,
  );
  return [
    `Selected ${plan.selected.length} task(s), ${plan.totalCommits} commit(s):`,
    ...(selected.length > 0 ? selected : ["  (none)"]),
    ...(rejected.length > 0 ? ["Deferred:", ...rejected] : []),
  ].join("\n");
}

function batchHuman(batch: BatchRecord): string {
  return [
    `Batch ${batch.id}: ${batch.status}`,
    `Tasks: ${batch.taskIds.join(", ")}`,
    batch.validationAuthority ? `Validation authority: ${batch.validationAuthority}` : undefined,
    `Base: ${batch.baseBranch} @ ${batch.baseSha}`,
    batch.branchName ? `Branch: ${batch.branchName}` : undefined,
    batch.headSha ? `Head: ${batch.headSha}` : undefined,
    batch.pullRequestUrl ? `Pull request: ${batch.pullRequestUrl}` : undefined,
    batch.autoMergeEnabled ? "Auto-merge: enabled" : undefined,
    // The batch is published either way; this says what still needs a hand.
    batch.publishWarning ? `Auto-merge not queued: ${batch.publishWarning}` : undefined,
    batch.error ? `Error: ${batch.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function localValidationHuman(result: LocalValidationResult): string {
  const lines = [
    result.ok ? "Validation passed." : "Validation failed.",
    `Base: ${result.baseRef} @ ${result.baseSha}`,
    `Files: ${result.files.length}`,
  ];
  for (const validation of result.validations) {
    lines.push(`  ${validation.exitCode === 0 ? "ok  " : "FAIL"} ${validation.name} (${validation.scope})`);
  }
  if (result.validations.length === 0) {
    lines.push("  no validators matched — check validation.focused and validation.authoritative");
  }
  const failed = result.validations.find((validation) => validation.exitCode !== 0);
  if (failed) {
    // The point of running this locally is to read the failure, so print it rather than making the
    // worker re-run the command by hand to see what broke.
    lines.push("", `--- ${failed.name} ---`, [failed.stdout, failed.stderr].filter(Boolean).join("\n").trimEnd());
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

async function openBroker(): Promise<MergeBroker> {
  return await MergeBroker.open(globalOptions().cwd);
}

program
  .name("merge-broker")
  .description("Transaction coordinator for parallel code-producing agents and humans")
  .version(PACKAGE_VERSION)
  .option("-C, --cwd <directory>", "run as if started in this directory")
  .option("--json", "emit machine-readable JSON");

program
  .command("init")
  .description("initialize Merge Broker in the current Git repository")
  .option("--base <branch>", "base branch", "main")
  .option("--base-ref <revision>", "Git revision used as the integration base")
  .option("--remote <name>", "Git remote", "origin")
  .option("--force", "replace the existing configuration")
  .action(async (options: { base: string; baseRef?: string; remote: string; force?: boolean }) => {
    const result = await MergeBroker.initialize(globalOptions().cwd, {
      baseBranch: options.base,
      ...(options.baseRef ? { baseRef: options.baseRef } : {}),
      remote: options.remote,
      force: options.force ?? false,
    });
    output(
      result,
      `${result.created ? "Initialized" : "Already initialized"} Merge Broker at ${result.configPath}`,
    );
  });

program
  .command("doctor")
  .description("verify repository discovery, configuration, state, and base branch")
  .action(async () => {
    const result = await (await openBroker()).doctor();
    const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
    output(
      result,
      [
        result.ok === false ? "Merge Broker needs attention." : "Merge Broker is ready.",
        `Repository: ${String(result.repository)}`,
        `State: ${String(result.stateDirectory)}`,
        ...warnings.map((warning) => `Warning: ${warning}`),
      ].join("\n"),
    );
  });

const provenance = program.command("provenance").description("configure authenticated batch provenance");

provenance
  .command("setup-signing")
  .description("generate or import the Ed25519 identity used to sign batch manifests")
  .option("--private-key <path>", "import an existing Ed25519 private key instead of generating one")
  .option("--rotate", "replace the current repository signing identity")
  .action(async (options: { privateKey?: string; rotate?: boolean }) => {
    const result = await (await openBroker()).setupProvenanceSigning({
      ...(options.privateKey ? { privateKeyFile: options.privateKey } : {}),
      rotate: options.rotate ?? false,
    });
    output(
      result,
      [
        `Authenticated provenance enabled with key ${result.keyId}.`,
        `Private key: ${result.keyPath}`,
        "Commit .merge-broker/config.json so remote verification trusts the public key.",
      ].join("\n"),
    );
  });

const task = program.command("task").description("register, lease, and submit work");

task
  .command("register <id>")
  .description("register a task before an agent begins work")
  .option("--title <title>")
  .option("--agent <name>")
  .option("--base <revision>")
  .option("--path <pattern>", "expected path or glob; repeatable", collect, [])
  .option("--depends-on <task>", "dependency task ID; repeatable", collect, [])
  .option("--priority <number>", "higher values are scheduled first", "0")
  .option("--worktree <path>")
  .action(
    async (
      id: string,
      options: {
        title?: string;
        agent?: string;
        base?: string;
        path: string[];
        dependsOn: string[];
        priority: string;
        worktree?: string;
      },
    ) => {
      const registered = await (await openBroker()).registerTask({
        id,
        ...(options.title ? { title: options.title } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.base ? { base: options.base } : {}),
        expectedPaths: options.path,
        dependsOn: options.dependsOn,
        priority: Number(options.priority),
        ...(options.worktree ? { worktree: options.worktree } : {}),
      });
      output(publicTask(registered), `Registered task ${registered.id} at ${registered.baseSha}.`);
    },
  );

task
  .command("claim <id>")
  .description("acquire an expiring lease, registering the task if necessary")
  .option("--holder <name>", "lease holder", defaultHolder())
  .option("--title <title>")
  .option("--agent <name>")
  .option("--base <revision>")
  .option("--path <pattern>", "expected path or glob; repeatable", collect, [])
  .option("--depends-on <task>", "dependency task ID; repeatable", collect, [])
  .option("--priority <number>", "higher values are scheduled first")
  .option("--worktree <path>", "agent worktree")
  .option("--token-file <path>", "write the lease token here instead of the broker state directory")
  .option("--no-store-token", "do not persist the token; handle custody yourself")
  .action(
    async (
      id: string,
      options: {
        holder: string;
        title?: string;
        agent?: string;
        base?: string;
        path: string[];
        dependsOn: string[];
        priority?: string;
        worktree?: string;
        tokenFile?: string;
        storeToken: boolean;
      },
    ) => {
      const result = await (await openBroker()).claimTask({
        id,
        holder: options.holder,
        ...(options.title ? { title: options.title } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.base ? { base: options.base } : {}),
        ...(options.path.length > 0 ? { expectedPaths: options.path } : {}),
        ...(options.dependsOn.length > 0 ? { dependsOn: options.dependsOn } : {}),
        ...(options.priority ? { priority: Number(options.priority) } : {}),
        worktree: options.worktree ?? globalOptions().cwd,
        ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
        storeToken: options.storeToken,
      });
      output(
        { task: publicTask(result.task), token: result.token, tokenPath: result.tokenPath },
        [
          `Claimed task ${result.task.id} until ${result.task.lease?.expiresAt}.`,
          ...(result.tokenPath
            ? [
                `Lease token stored at ${result.tokenPath} (readable only by you).`,
                "Commands for this task on this machine will find it automatically.",
              ]
            : [`Lease token: ${result.token}`, "Save this token; it is shown only once."]),
        ].join("\n"),
      );
    },
  );

task
  .command("extend <id>")
  .description("extend an active task lease with additional expected paths")
  .option("--path <pattern>", "expected path or glob; repeatable", collect, [])
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .action(async (id: string, options: { path: string[] } & TokenOptions) => {
    const broker = await openBroker();
    const result = await broker.extendTask(id, options.path, await requireLeaseToken(broker, id, options));
    output(publicTask(result), `Extended task ${id} to ${result.expectedPaths.length} path pattern(s).`);
  });

task
  .command("retry <id>")
  .description("explicitly return a failed task's unchanged receipt to the submitted queue")
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .action(async (id: string, options: TokenOptions) => {
    const broker = await openBroker();
    const result = await broker.retryTask(id, await findLeaseToken(broker, id, options));
    output(publicTask(result), `Returned task ${id} to the integration queue.`);
  });

task
  .command("heartbeat <id>")
  .description("extend an active task lease")
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .action(async (id: string, options: TokenOptions) => {
    const broker = await openBroker();
    const result = await broker.heartbeat(id, await requireLeaseToken(broker, id, options));
    output(publicTask(result), `Lease for ${id} extended until ${result.lease?.expiresAt}.`);
  });

task
  .command("submit <id>")
  .description("submit one or more immutable Git commits as a receipt")
  .option("--commit <revision>", "commit to integrate; repeatable", collect, [])
  .option("--since-base", "submit every linear commit made after the task's recorded base")
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .action(async (id: string, options: { commit: string[]; sinceBase?: boolean } & TokenOptions) => {
    if (options.sinceBase && options.commit.length > 0) {
      throw new BrokerError("INVALID_ARGUMENTS", "Use either --since-base or explicit --commit values, not both.");
    }
    const broker = await openBroker();
    const commits = options.commit.length > 0 ? options.commit : ["HEAD"];
    const result = await broker.submitTask(id, commits, await requireLeaseToken(broker, id, options), {
      sinceBase: options.sinceBase ?? false,
    });
    output(
      { ...result, task: publicTask(result.task) },
      `Submitted ${result.task.commits.length} commit(s) for ${id}.\nReceipt: ${result.receiptPath}`,
    );
  });

task
  .command("release <id>")
  .description("release a task lease")
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .option("--force", "revoke the lease without its token, for a holder that is gone")
  .action(async (id: string, options: { force?: boolean } & TokenOptions) => {
    const broker = await openBroker();
    const result = options.force
      ? await broker.releaseTask(id, undefined, { force: true })
      : await broker.releaseTask(id, await requireLeaseToken(broker, id, options));
    output(publicTask(result), `Released task ${id}.`);
  });

task
  .command("cancel <id>")
  .description("cancel a task that has not been batched")
  .option("--token <token>")
  .option("--token-file <path>", "read the lease token from this file")
  .option("--force", "cancel without a lease token, for a holder that is gone")
  .action(async (id: string, options: { force?: boolean } & TokenOptions) => {
    const broker = await openBroker();
    const result = await broker.cancelTask(id, await findLeaseToken(broker, id, options), {
      force: options.force ?? false,
    });
    output(publicTask(result), `Cancelled task ${id}.`);
  });

task
  .command("show <id>")
  .description("show one task")
  .action(async (id: string) => {
    const result = await (await openBroker()).task(id);
    output(publicTask(result), JSON.stringify(taskSummary(result), null, 2));
  });

program
  .command("status")
  .description("show broker task and batch state")
  .action(async () => {
    const state = await (await openBroker()).state();
    output(publicState(state), stateHuman(state));
  });

program
  .command("plan")
  .description("show the next deterministic non-conflicting batch")
  .option("--task <id>", "restrict planning to task ID; repeatable", collect, [])
  .option("--max-tasks <number>")
  .action(async (options: { task: string[]; maxTasks?: string }) => {
    const result = await (await openBroker()).plan({
      ...(options.task.length > 0 ? { taskIds: options.task } : {}),
      ...(options.maxTasks ? { maxTasks: Number(options.maxTasks) } : {}),
    });
    output(result, planHuman(result));
  });

program
  .command("integrate")
  .description("transactionally cherry-pick and validate the next batch")
  .option("--task <id>", "restrict integration to task ID; repeatable", collect, [])
  .option("--max-tasks <number>")
  .option("--dry-run", "verify without retaining an integration branch")
  .option("--publish", "publish according to the configured publishing mode")
  .option("--force", "integrate even though an earlier batch has not merged yet")
  .action(
    async (options: {
      task: string[];
      maxTasks?: string;
      dryRun?: boolean;
      publish?: boolean;
      force?: boolean;
    }) => {
      const result = await (await openBroker()).integrate({
        ...(options.task.length > 0 ? { taskIds: options.task } : {}),
        ...(options.maxTasks ? { maxTasks: Number(options.maxTasks) } : {}),
        dryRun: options.dryRun ?? false,
        publish: options.publish ?? false,
        force: options.force ?? false,
      });
      output(result, batchHuman(result.batch));
    },
  );

program
  .command("validate")
  .description("run the configured validators against the working tree, before submitting")
  .option("--task <id>", "task ID to expose to validators as {taskId}")
  .option("--scope <scope>", "focused, authoritative, or all", "all")
  .option("--base <ref>", "compare against this revision instead of the configured base")
  .option("--file <path>", "validate these files instead of the working-tree diff; repeatable", collect, [])
  .option("--cwd <path>", "validate this worktree instead of the repository root")
  .action(
    async (options: { task?: string; scope: string; base?: string; file: string[]; cwd?: string }) => {
      if (!["focused", "authoritative", "all"].includes(options.scope)) {
        throw new BrokerError("INVALID_ARGUMENTS", "--scope must be focused, authoritative, or all.");
      }
      const result = await (await openBroker()).validateWorkingTree({
        ...(options.task ? { taskId: options.task } : {}),
        scope: options.scope as "focused" | "authoritative" | "all",
        ...(options.base ? { base: options.base } : {}),
        ...(options.file.length > 0 ? { files: options.file } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      output(result, localValidationHuman(result));
      // A failing pre-flight must fail the command, or a worker script that runs it before
      // submitting would sail straight past the answer it asked for.
      if (!result.ok) process.exitCode = 1;
    },
  );

const batch = program.command("batch").description("inspect and advance integration batches");

batch
  .command("list")
  .description("list batches")
  .action(async () => {
    const batches = Object.values((await (await openBroker()).state()).batches).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    output(
      batches,
      batches.length > 0
        ? batches.map((item) => `${item.id.padEnd(30)} ${item.status.padEnd(10)} ${item.taskIds.join(", ")}`).join("\n")
        : "No batches.",
    );
  });

batch
  .command("show <id>")
  .description("show a batch")
  .action(async (id: string) => {
    const state = await (await openBroker()).state();
    const result = Object.hasOwn(state.batches, id) ? state.batches[id] : undefined;
    if (!result) throw new BrokerError("UNKNOWN_BATCH", `Unknown batch: ${id}`);
    output(result, batchHuman(result));
  });

batch
  .command("publish <id>")
  .description("push a prepared batch and optionally open its pull request")
  .action(async (id: string) => {
    const result = await (await openBroker()).publishBatch(id);
    output(result, batchHuman(result));
  });

batch
  .command("refresh <id>")
  .description("re-cut a batch the base branch moved past, so it can merge again")
  .option("--publish", "publish the replacement according to the configured publishing mode")
  .action(async (id: string, options: { publish?: boolean }) => {
    const result = await (await openBroker()).refreshBatch(id, {
      publish: options.publish ?? false,
    });
    if (!result.refreshed) {
      output(result, `Batch ${id} is already cut from the current base (${result.baseSha}). Nothing to do.`);
      return;
    }
    const lines = [
      `Batch ${id} superseded; its tasks were re-cut from ${result.baseSha}.`,
      result.pullRequestClosed === false
        ? `Its pull request could not be closed and is still open: ${result.closed.pullRequestUrl}`
        : undefined,
      result.integration ? batchHuman(result.integration.batch) : undefined,
    ].filter(Boolean);
    output(result, lines.join("\n"));
  });

batch
  .command("sync [id]")
  .description("reconcile one or all published batches with GitHub or the remote base branch")
  .option("--all", "sync every published batch")
  .action(async (id: string | undefined, options: { all?: boolean }) => {
    const broker = await openBroker();
    if (options.all || !id) {
      const result = await broker.syncPublishedBatches();
      output(
        result,
        `Merged: ${result.synced.length}; closed: ${result.closed.length}; unchanged: ${result.unchanged.length}; errors: ${result.errors.length}`,
      );
      return;
    }
    const result = await broker.syncBatch(id);
    output(result, batchHuman(result));
  });

batch
  .command("complete <id>")
  .description("manually mark a prepared or published batch as merged")
  .option("--merge-commit <sha>")
  .action(async (id: string, options: { mergeCommit?: string }) => {
    const result = await (await openBroker()).markBatchMerged(id, undefined, options.mergeCommit);
    output(result, batchHuman(result));
  });

program
  .command("audit")
  .description("audit Git worktrees, task registrations, and stale leases")
  .action(async () => {
    const result = await (await openBroker()).auditWorktrees();
    const human = [
      `Worktrees: ${result.worktrees.length}`,
      `Stale leases: ${result.staleLeases.length > 0 ? result.staleLeases.join(", ") : "none"}`,
      `Unregistered worktrees: ${
        result.unregisteredWorktrees.length > 0 ? result.unregisteredWorktrees.join(", ") : "none"
      }`,
    ].join("\n");
    output(result, human);
  });

program
  .command("metrics")
  .description("summarize local throughput, batch, and validation measurements")
  .action(async () => {
    const result = await (await openBroker()).metrics();
    output(result, JSON.stringify(result, null, 2));
  });

program
  .command("install-hooks")
  .description("install the pre-push guard that keeps implementation branches out of the forge")
  .option("--force", "replace an existing hooks path, disabling the hooks it holds")
  .option("--uninstall", "remove the guard and restore the previous hooks path")
  .action(async (options: { force?: boolean; uninstall?: boolean }) => {
    const result = await (await openBroker()).installHooks({
      force: options.force ?? false,
      uninstall: options.uninstall ?? false,
    });
    output(
      result,
      result.installed
        ? [
            `Installed the pre-push guard at ${result.hookFile}.`,
            ...(result.previousHooksPath ? [`Replaced core.hooksPath ${result.previousHooksPath}.`] : []),
            "Commit .githooks/ so every clone of this repository is covered.",
          ].join("\n")
        : "Removed the pre-push guard.",
    );
  });

program
  .command("install-service")
  .description("run the integration loop as a background service, so submitted work publishes without a terminal")
  .option("--uninstall", "remove the service")
  .option("--interval <seconds>", "poll interval", "15")
  .option("--no-eager", "wait for a full or aged batch instead of integrating immediately")
  .option("--cli-path <path>", "absolute path to the broker CLI the service should run")
  .option("--log-file <path>", "where the service writes its output")
  .action(async (options: {
    uninstall?: boolean;
    interval: string;
    eager: boolean;
    cliPath?: string;
    logFile?: string;
  }) => {
    const result = await (await openBroker()).installService({
      uninstall: options.uninstall ?? false,
      intervalSeconds: Number.parseInt(options.interval, 10),
      eager: options.eager,
      ...(options.cliPath ? { cliPath: options.cliPath } : {}),
      ...(options.logFile ? { logFile: options.logFile } : {}),
    });
    if ("removed" in result) {
      output(result, result.removed ? `Removed ${result.file}.` : "No service was installed.");
      return;
    }
    output(
      result,
      [
        `Installed ${result.name} at ${result.file}.`,
        result.loaded
          ? "The integration loop is running and will publish verified batches on its own."
          : `Written, but the loader refused it: ${result.loaderMessage ?? "unknown error"}`,
        `Output: ${result.logFile}`,
      ].join("\n"),
    );
  });

program
  .command("verify-provenance")
  .description("verify a batch's immutable structure and protected-base provenance signature")
  .requiredOption("--branch <ref>", "head branch of the pull request")
  .requiredOption("--head <sha>", "head commit of the pull request")
  .requiredOption("--base <sha>", "current tip of the target branch")
  .option("--base-branch <name>", "expected target branch")
  .option("--branch-prefix <prefix>", "integration branch prefix")
  .option("--provenance-directory <path>", "directory holding batch manifests")
  .action(
    async (options: {
      branch: string;
      head: string;
      base: string;
      baseBranch?: string;
      branchPrefix?: string;
      provenanceDirectory?: string;
    }) => {
      const repo = await GitRepository.discover(globalOptions().cwd);
      // Policy comes from the base branch, never from the change being verified.
      const policy = await policyFromBase(repo, options.base);
      const result = await verifyProvenance({
        repo,
        branch: options.branch,
        headSha: options.head,
        baseSha: options.base,
        baseBranch: options.baseBranch ?? policy.baseBranch ?? "main",
        branchPrefix: options.branchPrefix ?? policy.branchPrefix ?? "merge-broker/",
        provenanceDirectory:
          options.provenanceDirectory ?? policy.provenanceDirectory ?? ".merge-broker/attestations",
        ...(policy.publicKey ? { publicKey: policy.publicKey } : {}),
        requireSignature: policy.requireSignature ?? false,
      });
      output(
        result,
        [
          `${result.authenticated ? "Authenticated" : "Structurally verified"} broker batch ${result.batchId}.`,
          `Tasks: ${result.taskIds.join(", ")}`,
          `Integrated head: ${result.parentSha}`,
          `Validation authority: ${policy.validationAuthority ?? "broker"}`,
          `Validations recorded: ${result.manifest.validations.length}`,
          ...(result.authenticated
            ? [`Signature key: ${result.signatureKeyId}`]
            : ["Warning: no protected-base signature policy authenticated this manifest."]),
        ].join("\n"),
      );
    },
  );

program
  .command("prune")
  .description("retire completed tasks and batches from active state into the archive")
  .option("--older-than <days>", "retire records completed at least this many days ago", "30")
  .option("--dry-run", "report what would be retired without changing state")
  .action(async (options: { olderThan: string; dryRun?: boolean }) => {
    const olderThanDays = Number(options.olderThan);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new BrokerError("INVALID_LIMIT", "--older-than must be a non-negative number of days.");
    }
    const result = await (await openBroker()).prune({ olderThanDays, dryRun: options.dryRun ?? false });
    output(
      result,
      [
        `${result.dryRun ? "Would retire" : "Retired"} ${result.tasks.length} task(s) and ${
          result.batches.length
        } batch(es) completed before ${result.cutoff}.`,
        ...(result.retainedForDependencies.length > 0
          ? [`Kept as dependencies of active work: ${result.retainedForDependencies.join(", ")}`]
          : []),
        ...(result.archivePath ? [`Archive: ${result.archivePath}`] : []),
      ].join("\n"),
    );
  });

program
  .command("recover")
  .description("recover tasks left integrating after a broker process stopped unexpectedly")
  .action(async () => {
    const result = await (await openBroker()).recoverAbandonedIntegrations();
    output(
      result,
      result.batches.length > 0
        ? [
            `Recovered ${result.batches.length} abandoned batch(es).`,
            `Requeued tasks: ${result.tasks.join(", ") || "none"}`,
            ...(result.cleanupWarnings.length > 0
              ? result.cleanupWarnings.map((warning) => `Cleanup warning: ${warning}`)
              : []),
          ].join("\n")
        : "No abandoned integration transactions.",
    );
  });

program
  .command("unlock [name]")
  .description("release a stuck state or integration lock left by a crashed process")
  .option("--force", "release even when the holder cannot be proven gone")
  .action(async (name: string | undefined, options: { force?: boolean }) => {
    const broker = await openBroker();
    if (!name) {
      const locks = await broker.inspectLocks();
      output(
        locks,
        locks
          .map((lock) =>
            lock.held
              ? `${lock.name}: held by ${lock.owner?.host ?? "unknown"} (pid ${
                  lock.owner?.pid ?? "unknown"
                }), ${Math.round((lock.ageMs ?? 0) / 1_000)}s old${lock.abandoned ? ", owner process is gone" : ""}`
              : `${lock.name}: free`,
          )
          .join("\n"),
      );
      return;
    }
    const result = await broker.releaseLock(name, { force: options.force ?? false });
    output(result, `Released the ${result.name} lock.`);
  });

program
  .command("events")
  .description("show the append-only local audit trail")
  .addOption(new Option("--limit <number>", "maximum events").default("100"))
  .action(async (options: { limit: string }) => {
    const result = await (await openBroker()).store.readAudit(Number(options.limit));
    output(
      result,
      result.map((event) => `${event.at} #${event.sequence} ${event.event} ${event.taskId ?? event.batchId ?? ""}`).join("\n"),
    );
  });

program
  .command("serve")
  .description("poll for ready batches and integrate them")
  .option("--interval <seconds>", "poll interval", "15")
  .option("--publish", "publish each successful batch")
  .option("--eager", "integrate immediately instead of waiting for a full or aged batch")
  .option("--once", "perform one polling cycle and exit")
  .action(
    async (options: { interval: string; publish?: boolean; eager?: boolean; once?: boolean }) => {
      let stopping = false;
      const json = program.opts<{ json?: boolean }>().json ?? false;
      let lastOutputAt = Date.now();
      const say = (event: ServeEvent): void => {
        const now = new Date();
        const line = json ? serveEventJson(event, now) : formatServeEvent(event, now);
        if (isErrorEvent(event)) console.error(line);
        else console.log(line);
        lastOutputAt = now.getTime();
      };
      const stop = (signal: string) => () => {
        stopping = true;
        say({ kind: "stopped", signal });
      };
      process.once("SIGINT", stop("SIGINT"));
      process.once("SIGTERM", stop("SIGTERM"));
      if (!options.once) {
        say({
          kind: "started",
          version: program.version() ?? "unknown",
          repository: (await openBroker()).repo.root,
          intervalSeconds: Number(options.interval),
          publish: options.publish ?? false,
          eager: options.eager ?? false,
        });
      }
      const recovery = await (await openBroker()).recoverAbandonedIntegrations();
      if (!options.once && recovery.batches.length > 0) {
        say({ kind: "recovered", batches: recovery.batches, tasks: recovery.tasks });
      }
      do {
        const broker = await openBroker();
        const reconciliation = await broker.syncPublishedBatches();
        for (const failure of reconciliation.errors) {
          say({ kind: "sync-failed", batchId: failure.batchId, message: String(failure.error) });
        }
        for (const merged of reconciliation.synced) {
          say({ kind: "merged", batchId: merged.id });
        }
        for (const abandoned of reconciliation.closed) {
          say({ kind: "closed", batchId: abandoned.id });
        }
        const plan = await broker.plan();
        const oldest = plan.selected.reduce(
          (minimum, item) => Math.min(minimum, item.submittedAt ? Date.parse(item.submittedAt) : Date.now()),
          Date.now(),
        );
        const aged = Date.now() - oldest >= broker.config.scheduling.maxWaitSeconds * 1_000;
        const full = plan.selected.length >= broker.config.scheduling.maxTasks;
        if (plan.selected.length > 0 && (options.eager || options.once || aged || full)) {
          // Announced before the work, not after it. Validators can run for
          // minutes, and the silence was the whole problem.
          if (!options.once) say({ kind: "integrating", tasks: plan.selected.map((item) => item.id) });
          try {
            const result = await broker.integrate({ publish: options.publish ?? false });
            if (options.once) output(result, batchHuman(result.batch));
            else {
              say({
                kind: "integrated",
                batchId: result.batch.id,
                state: result.batch.status,
                published: options.publish ?? false,
              });
            }
          } catch (error) {
            if (options.once) throw error;
            say({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
          }
        } else if (!options.once && shouldReportIdle(lastOutputAt, Date.now())) {
          say({ kind: "idle", waiting: plan.selected.length, quietSeconds: (Date.now() - lastOutputAt) / 1_000 });
        }
        if (options.once || stopping) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Number(options.interval) * 1_000));
      } while (!stopping);
    },
  );

program.parseAsync().catch((error: unknown) => {
  const json = program.opts<{ json?: boolean }>().json ?? false;
  if (json) {
    const value =
      error instanceof BrokerError
        ? { error: { code: error.code, message: error.message, details: error.details } }
        : { error: { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) } };
    console.error(JSON.stringify(value, null, 2));
  } else if (error instanceof CommandError) {
    console.error(`${error.message}${error.stderr ? `\n${error.stderr.trim()}` : ""}`);
  } else if (error instanceof BrokerError) {
    console.error(`${error.code}: ${error.message}`);
    if (process.env.MERGE_BROKER_DEBUG && error.details) console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
});
