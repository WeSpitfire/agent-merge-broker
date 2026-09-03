import os from "node:os";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MergeBroker } from "./broker.js";
import { BrokerError } from "./errors.js";
import { formatBrokerStatus } from "./status.js";
import type { BrokerState, TaskRecord } from "./types.js";

export type McpProfile = "worker" | "operator";

function assertMcpProfile(profile: string): asserts profile is McpProfile {
  if (profile !== "worker" && profile !== "operator") {
    throw new BrokerError("INVALID_MCP_PROFILE", `Unknown MCP profile: ${profile}. Expected worker or operator.`);
  }
}

const WORKER_TOOLS = [
  "broker_status",
  "task_show",
  "task_claim",
  "task_heartbeat",
  "task_extend",
  "task_validate",
  "task_candidate",
  "task_release",
  "task_reopen",
  "task_revise",
] as const;

const OPERATOR_TOOLS = [
  "broker_plan",
  "batch_list",
  "batch_show",
  "broker_integrate",
  "batch_publish",
  "batch_sync",
  "batch_refresh",
  "batch_record_verification",
  "batch_approve",
  "batch_request_changes",
  "task_retry",
  "task_cancel",
  "broker_audit",
  "broker_metrics",
  "broker_recover",
] as const;

export function mcpToolNames(profile: McpProfile): string[] {
  assertMcpProfile(profile);
  return profile === "operator" ? [...WORKER_TOOLS, ...OPERATOR_TOOLS] : [...WORKER_TOOLS];
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
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, publicTask(task)])),
  };
}

function publicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "status") && Object.hasOwn(value, "expectedPaths") && Object.hasOwn(value, "commits")) {
    return publicTask(value as TaskRecord);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item)]));
}

function toolResult(value: unknown): CallToolResult {
  const result = publicValue(value);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

function toolError(error: unknown): CallToolResult {
  const body = error instanceof BrokerError
    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  const publicBody = publicValue(body);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(publicBody, null, 2) }],
    structuredContent: { error: publicBody },
  };
}

function wrapped<T>(handler: (input: T) => Promise<unknown>): (input: T) => Promise<CallToolResult> {
  return async (input) => {
    try {
      return toolResult(await handler(input));
    } catch (error) {
      return toolError(error);
    }
  };
}

async function storedToken(broker: MergeBroker, taskId: string): Promise<string> {
  const token = await broker.store.readToken(taskId);
  if (!token) {
    throw new BrokerError(
      "LEASE_TOKEN",
      `No broker-held lease token exists for ${taskId}. Claim or reopen the task through this MCP server first.`,
    );
  }
  return token;
}

function defaultHolder(): string {
  if (process.env.MERGE_BROKER_AGENT) return process.env.MERGE_BROKER_AGENT;
  try {
    return os.userInfo().username;
  } catch {
    return `${os.hostname()}:${process.pid}`;
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const externalMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/**
 * Creates a stdio-safe MCP server. Worker instances can only manage their own leased work;
 * integration, publication, verification, and approval exist only on the operator profile.
 */
export function createMcpServer(options: {
  cwd?: string;
  profile?: McpProfile;
  version?: string;
} = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const profile = options.profile ?? "worker";
  assertMcpProfile(profile);
  const open = async (): Promise<MergeBroker> => await MergeBroker.open(cwd);
  const server = new McpServer(
    { name: `agent-merge-broker-${profile}`, version: options.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "broker_status",
    {
      description: "Read broker state and the safe next actions. Never returns lease token hashes.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    wrapped(async () => {
      const broker = await open();
      const state = await broker.state();
      return { state: publicState(state), guidance: formatBrokerStatus(state, broker.config) };
    }),
  );

  server.registerTool(
    "task_show",
    {
      description: "Read one task without exposing its lease token hash.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: readOnly,
    },
    wrapped(async ({ taskId }) => publicTask(await (await open()).task(taskId))),
  );

  server.registerTool(
    "task_claim",
    {
      description: "Claim or create a task lease. The token is stored locally and is never returned to the model.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        holder: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        agent: z.string().min(1).optional(),
        base: z.string().min(1).optional(),
        dependsOn: z.array(z.string().min(1)).optional(),
        priority: z.number().int().optional(),
        worktree: z.string().min(1).optional(),
      }),
      annotations: localMutation,
    },
    wrapped(async (input) => {
      const broker = await open();
      const claimed = await broker.claimTask({
        id: input.taskId,
        holder: input.holder ?? defaultHolder(),
        expectedPaths: input.paths,
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.base ? { base: input.base } : {}),
        ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        worktree: input.worktree ?? cwd,
        storeToken: true,
      });
      return { task: publicTask(claimed.task), tokenStored: true };
    }),
  );

  server.registerTool(
    "task_heartbeat",
    {
      description: "Extend a task lease using its broker-held token.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: localMutation,
    },
    wrapped(async ({ taskId }) => {
      const broker = await open();
      return await broker.heartbeat(taskId, await storedToken(broker, taskId));
    }),
  );

  server.registerTool(
    "task_extend",
    {
      description: "Add expected path patterns to a leased task.",
      inputSchema: z.object({ taskId: z.string().min(1), paths: z.array(z.string().min(1)).min(1) }),
      annotations: localMutation,
    },
    wrapped(async ({ taskId, paths }) => {
      const broker = await open();
      return await broker.extendTask(taskId, paths, await storedToken(broker, taskId));
    }),
  );

  server.registerTool(
    "task_validate",
    {
      description: "Run configured validators against a working tree. This does not submit or integrate work.",
      inputSchema: z.object({
        taskId: z.string().min(1).optional(),
        scope: z.enum(["focused", "authoritative", "all"]).optional(),
        base: z.string().min(1).optional(),
        files: z.array(z.string().min(1)).optional(),
        worktree: z.string().min(1).optional(),
      }),
      annotations: localMutation,
    },
    wrapped(async (input) => await (await open()).validateWorkingTree({
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.base ? { base: input.base } : {}),
      ...(input.files ? { files: input.files } : {}),
      cwd: input.worktree ?? cwd,
    })),
  );

  const candidateSchema = z.object({
    taskId: z.string().min(1),
    commits: z.array(z.string().min(1)).optional(),
    sinceBase: z.boolean().optional(),
  });
  server.registerTool(
    "task_candidate",
    {
      description: "Nominate commits for a leased task. This explicitly does not authorize merging.",
      inputSchema: candidateSchema,
      annotations: localMutation,
    },
    wrapped(async ({ taskId, commits, sinceBase }) => {
      if (sinceBase && commits?.length) {
        throw new BrokerError("INVALID_ARGUMENTS", "Use either sinceBase or explicit commits, not both.");
      }
      const broker = await open();
      const result = await broker.submitTask(
        taskId,
        commits?.length ? commits : ["HEAD"],
        await storedToken(broker, taskId),
        { sinceBase: sinceBase ?? false },
      );
      return { ...result, mergeAuthorized: false };
    }),
  );

  server.registerTool(
    "task_release",
    {
      description: "Release a task lease using its broker-held token.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: localMutation,
    },
    wrapped(async ({ taskId }) => {
      const broker = await open();
      return await broker.releaseTask(taskId, await storedToken(broker, taskId));
    }),
  );

  server.registerTool(
    "task_reopen",
    {
      description: "Open an unapproved candidate for revision and store the new lease token locally.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        holder: z.string().min(1).optional(),
        paths: z.array(z.string().min(1)).optional(),
        worktree: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
      }),
      annotations: localMutation,
    },
    wrapped(async (input) => {
      const reopened = await (await open()).reopenTaskForRevision(input.taskId, {
        holder: input.holder ?? defaultHolder(),
        ...(input.paths ? { expectedPaths: input.paths } : {}),
        worktree: input.worktree ?? cwd,
        ...(input.reason ? { reason: input.reason } : {}),
        storeToken: true,
      });
      return { task: publicTask(reopened.task), batch: reopened.batch, tokenStored: true };
    }),
  );

  server.registerTool(
    "task_revise",
    {
      description: "Replace an opened candidate revision. Earlier approval and evidence are invalidated.",
      inputSchema: candidateSchema,
      annotations: externalMutation,
    },
    wrapped(async ({ taskId, commits, sinceBase }) => {
      if (sinceBase && commits?.length) {
        throw new BrokerError("INVALID_ARGUMENTS", "Use either sinceBase or explicit commits, not both.");
      }
      const broker = await open();
      return await broker.reviseTask(
        taskId,
        commits?.length ? commits : ["HEAD"],
        await storedToken(broker, taskId),
        { sinceBase: sinceBase ?? false },
      );
    }),
  );

  if (profile === "worker") return server;

  server.registerTool(
    "broker_plan",
    {
      description: "Read the next deterministic integration plan without changing state.",
      inputSchema: z.object({ taskIds: z.array(z.string().min(1)).optional(), maxTasks: z.number().int().positive().optional() }),
      annotations: readOnly,
    },
    wrapped(async (input) => await (await open()).plan({
      ...(input.taskIds ? { taskIds: input.taskIds } : {}),
      ...(input.maxTasks !== undefined ? { maxTasks: input.maxTasks } : {}),
    })),
  );

  server.registerTool(
    "batch_list",
    { description: "List all active batches.", inputSchema: z.object({}), annotations: readOnly },
    wrapped(async () => Object.values((await (await open()).state()).batches)),
  );
  server.registerTool(
    "batch_show",
    { description: "Read one active batch.", inputSchema: z.object({ batchId: z.string().min(1) }), annotations: readOnly },
    wrapped(async ({ batchId }) => {
      const state = await (await open()).state();
      const value = Object.hasOwn(state.batches, batchId) ? state.batches[batchId] : undefined;
      if (!value) throw new BrokerError("UNKNOWN_BATCH", `Unknown batch: ${batchId}`);
      return value;
    }),
  );

  server.registerTool(
    "broker_integrate",
    {
      description: "Assemble and validate the next batch. Publication is optional and still policy-gated.",
      inputSchema: z.object({
        taskIds: z.array(z.string().min(1)).optional(),
        maxTasks: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
        publish: z.boolean().optional(),
      }),
      annotations: externalMutation,
    },
    wrapped(async (input) => await (await open()).integrate({
      ...(input.taskIds ? { taskIds: input.taskIds } : {}),
      ...(input.maxTasks !== undefined ? { maxTasks: input.maxTasks } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.publish !== undefined ? { publish: input.publish } : {}),
    })),
  );
  server.registerTool(
    "batch_publish",
    {
      description: "Publish a prepared batch according to repository policy.",
      inputSchema: z.object({ batchId: z.string().min(1) }),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId }) => await (await open()).publishBatch(batchId)),
  );
  server.registerTool(
    "batch_sync",
    {
      description: "Reconcile one batch, or every published batch, with its remote merge state.",
      inputSchema: z.object({ batchId: z.string().min(1).optional() }),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId }) => batchId
      ? await (await open()).syncBatch(batchId)
      : await (await open()).syncPublishedBatches()),
  );
  server.registerTool(
    "batch_refresh",
    {
      description: "Re-cut a stale batch from the current base, optionally publishing the replacement.",
      inputSchema: z.object({ batchId: z.string().min(1), publish: z.boolean().optional() }),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId, publish }) => await (await open()).refreshBatch(batchId, { publish: publish ?? false })),
  );

  const bindingSchema = {
    batchId: z.string().min(1),
    candidateSha: z.string().min(1),
    baseSha: z.string().min(1),
    policyRevision: z.string().min(1).optional(),
    actor: z.string().min(1),
  };
  server.registerTool(
    "batch_record_verification",
    {
      description: "Attach verification evidence to an exact candidate/base/policy binding.",
      inputSchema: z.object({
        ...bindingSchema,
        name: z.string().min(1),
        status: z.enum(["passed", "failed"]),
        evidenceUrl: z.string().url().optional(),
        notes: z.string().optional(),
      }),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId, policyRevision, evidenceUrl, notes, ...input }) => await (await open()).recordVerification(batchId, {
      ...input,
      ...(policyRevision ? { policyRevision } : {}),
      ...(evidenceUrl ? { evidenceUrl } : {}),
      ...(notes ? { notes } : {}),
    })),
  );
  server.registerTool(
    "batch_approve",
    {
      description: "Authorize only an exact verified candidate/base/policy binding.",
      inputSchema: z.object(bindingSchema),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId, policyRevision, ...input }) => await (await open()).approveBatch(batchId, {
      ...input,
      ...(policyRevision ? { policyRevision } : {}),
    })),
  );
  server.registerTool(
    "batch_request_changes",
    {
      description: "Revoke candidate approval and require a revision for an exact binding.",
      inputSchema: z.object({ ...bindingSchema, reason: z.string().min(1) }),
      annotations: externalMutation,
    },
    wrapped(async ({ batchId, policyRevision, ...input }) => await (await open()).requestChanges(batchId, {
      ...input,
      ...(policyRevision ? { policyRevision } : {}),
    })),
  );

  server.registerTool(
    "task_retry",
    {
      description: "Return a failed task's unchanged receipt to the integration queue.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: localMutation,
    },
    wrapped(async ({ taskId }) => {
      const broker = await open();
      return await broker.retryTask(taskId, await broker.store.readToken(taskId));
    }),
  );
  server.registerTool(
    "task_cancel",
    {
      description: "Cancel an unbatched task. A live lease must have a broker-held token.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: localMutation,
    },
    wrapped(async ({ taskId }) => {
      const broker = await open();
      return await broker.cancelTask(taskId, await broker.store.readToken(taskId));
    }),
  );
  server.registerTool(
    "broker_audit",
    { description: "Audit worktree registration and stale leases.", inputSchema: z.object({}), annotations: readOnly },
    wrapped(async () => await (await open()).auditWorktrees()),
  );
  server.registerTool(
    "broker_metrics",
    { description: "Read throughput and validation metrics, including archived history.", inputSchema: z.object({}), annotations: readOnly },
    wrapped(async () => await (await open()).metrics()),
  );
  server.registerTool(
    "broker_recover",
    {
      description: "Recover integration state left running by a terminated broker process.",
      inputSchema: z.object({}),
      annotations: localMutation,
    },
    wrapped(async () => await (await open()).recoverAbandonedIntegrations()),
  );

  return server;
}
