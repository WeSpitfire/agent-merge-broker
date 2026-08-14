#!/usr/bin/env node
import os from "node:os";
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import { BrokerError, CommandError } from "./errors.js";
import { MergeBroker } from "./broker.js";
import type { BatchRecord, BrokerState, SchedulePlan, TaskRecord } from "./types.js";

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

function requiredToken(value?: string): string {
  const token = value ?? process.env.MERGE_BROKER_TOKEN;
  if (!token) {
    throw new BrokerError(
      "LEASE_TOKEN",
      "A lease token is required. Pass --token or set MERGE_BROKER_TOKEN.",
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
    `Base: ${batch.baseBranch} @ ${batch.baseSha}`,
    batch.branchName ? `Branch: ${batch.branchName}` : undefined,
    batch.headSha ? `Head: ${batch.headSha}` : undefined,
    batch.pullRequestUrl ? `Pull request: ${batch.pullRequestUrl}` : undefined,
    batch.error ? `Error: ${batch.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
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
    output(result, `Merge Broker is ready.\nRepository: ${String(result.repository)}\nState: ${String(result.stateDirectory)}`);
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
      });
      output(
        { task: publicTask(result.task), token: result.token },
        [
          `Claimed task ${result.task.id} until ${result.task.lease?.expiresAt}.`,
          `Lease token: ${result.token}`,
          "Save this token; it is shown only once.",
        ].join("\n"),
      );
    },
  );

task
  .command("extend <id>")
  .description("extend an active task lease with additional expected paths")
  .option("--path <pattern>", "expected path or glob; repeatable", collect, [])
  .option("--token <token>")
  .action(async (id: string, options: { path: string[]; token?: string }) => {
    const result = await (await openBroker()).extendTask(id, options.path, requiredToken(options.token));
    output(publicTask(result), `Extended task ${id} to ${result.expectedPaths.length} path pattern(s).`);
  });

task
  .command("retry <id>")
  .description("return a failed task to the submitted queue")
  .option("--token <token>")
  .action(async (id: string, options: { token?: string }) => {
    const result = await (await openBroker()).retryTask(id, options.token ?? process.env.MERGE_BROKER_TOKEN);
    output(publicTask(result), `Returned task ${id} to the integration queue.`);
  });

task
  .command("heartbeat <id>")
  .description("extend an active task lease")
  .option("--token <token>")
  .action(async (id: string, options: { token?: string }) => {
    const result = await (await openBroker()).heartbeat(id, requiredToken(options.token));
    output(publicTask(result), `Lease for ${id} extended until ${result.lease?.expiresAt}.`);
  });

task
  .command("submit <id>")
  .description("submit one or more immutable Git commits as a receipt")
  .option("--commit <revision>", "commit to integrate; repeatable", collect, [])
  .option("--token <token>")
  .action(async (id: string, options: { commit: string[]; token?: string }) => {
    const commits = options.commit.length > 0 ? options.commit : ["HEAD"];
    const result = await (await openBroker()).submitTask(id, commits, requiredToken(options.token));
    output(
      { ...result, task: publicTask(result.task) },
      `Submitted ${result.task.commits.length} commit(s) for ${id}.\nReceipt: ${result.receiptPath}`,
    );
  });

task
  .command("release <id>")
  .description("release a task lease")
  .option("--token <token>")
  .action(async (id: string, options: { token?: string }) => {
    const result = await (await openBroker()).releaseTask(id, requiredToken(options.token));
    output(publicTask(result), `Released task ${id}.`);
  });

task
  .command("cancel <id>")
  .description("cancel a task that has not been batched")
  .option("--token <token>")
  .action(async (id: string, options: { token?: string }) => {
    const result = await (await openBroker()).cancelTask(id, options.token ?? process.env.MERGE_BROKER_TOKEN);
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
  .action(
    async (options: { task: string[]; maxTasks?: string; dryRun?: boolean; publish?: boolean }) => {
      const result = await (await openBroker()).integrate({
        ...(options.task.length > 0 ? { taskIds: options.task } : {}),
        ...(options.maxTasks ? { maxTasks: Number(options.maxTasks) } : {}),
        dryRun: options.dryRun ?? false,
        publish: options.publish ?? false,
      });
      output(result, batchHuman(result.batch));
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
  .command("sync [id]")
  .description("reconcile one or all published batches with GitHub or the remote base branch")
  .option("--all", "sync every published batch")
  .action(async (id: string | undefined, options: { all?: boolean }) => {
    const broker = await openBroker();
    if (options.all || !id) {
      const result = await broker.syncPublishedBatches();
      output(
        result,
        `Merged: ${result.synced.length}; unchanged: ${result.unchanged.length}; errors: ${result.errors.length}`,
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
      process.once("SIGINT", () => {
        stopping = true;
      });
      process.once("SIGTERM", () => {
        stopping = true;
      });
      do {
        const broker = await openBroker();
        const reconciliation = await broker.syncPublishedBatches();
        for (const failure of reconciliation.errors) {
          console.error(`Could not sync batch ${failure.batchId}: ${failure.error}`);
        }
        const plan = await broker.plan();
        const oldest = plan.selected.reduce(
          (minimum, item) => Math.min(minimum, item.submittedAt ? Date.parse(item.submittedAt) : Date.now()),
          Date.now(),
        );
        const aged = Date.now() - oldest >= broker.config.scheduling.maxWaitSeconds * 1_000;
        const full = plan.selected.length >= broker.config.scheduling.maxTasks;
        if (plan.selected.length > 0 && (options.eager || options.once || aged || full)) {
          try {
            const result = await broker.integrate({ publish: options.publish ?? false });
            output(result, batchHuman(result.batch));
          } catch (error) {
            if (options.once) throw error;
            console.error(`Integration attempt failed: ${error instanceof Error ? error.message : String(error)}`);
          }
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
