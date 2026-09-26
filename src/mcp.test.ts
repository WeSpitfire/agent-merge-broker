import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMcpServer, mcpToolNames } from "./mcp.js";
import { MergeBroker } from "./broker.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { canonicalJson } from "./test-support/public-contracts.js";

async function request(transport: InMemoryTransport, message: JSONRPCMessage): Promise<JSONRPCMessage> {
  return await new Promise<JSONRPCMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP response.")), 2_000);
    transport.onmessage = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
    void transport.send(message).catch(reject);
  });
}

async function connect(options: Parameters<typeof createMcpServer>[0]): Promise<{
  transport: InMemoryTransport;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await clientTransport.start();
  await server.connect(serverTransport);
  await request(clientTransport, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "merge-broker-test", version: "1" },
    },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { transport: clientTransport, close: async () => await server.close() };
}

let nextRequestId = 100;
async function callTool(
  transport: InMemoryTransport,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const response = await request(transport, {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.ok("result" in response && response.result && typeof response.result === "object");
  const result = response.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  const content = result.structuredContent ?? {};
  return {
    isError: result.isError === true,
    body: (result.isError ? content.error : content.result) as Record<string, unknown>,
  };
}

async function toolContracts(profile: "worker" | "operator"): Promise<Array<{ name: string; inputSchema: unknown }>> {
  const server = createMcpServer({ profile, version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await clientTransport.start();
  await server.connect(serverTransport);
  await request(clientTransport, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "merge-broker-test", version: "1" },
    },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const response = await request(clientTransport, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await server.close();
  assert.ok("result" in response && response.result && typeof response.result === "object");
  const tools = (response.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
  return tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

async function listedTools(profile: "worker" | "operator"): Promise<string[]> {
  return (await toolContracts(profile)).map((tool) => tool.name).sort();
}

test("MCP profile names and complete input schemas match the reviewed baseline", async () => {
  const actual = { worker: await toolContracts("worker"), operator: await toolContracts("operator") };
  const expected = await readFile(new URL("../src/test-support/contracts/mcp-tools.json", import.meta.url), "utf8");
  assert.equal(canonicalJson(actual), expected,
    "MCP inputs changed. Review profile authority and compatibility before deliberately updating the baseline.");
});

test("worker MCP profile cannot integrate, publish, verify, or approve", async () => {
  const tools = await listedTools("worker");
  assert.deepEqual(tools, mcpToolNames("worker").sort());
  for (const denied of ["broker_integrate", "batch_publish", "batch_record_verification", "batch_approve"]) {
    assert.equal(tools.includes(denied), false);
  }
});

test("operator MCP profile exposes the explicit control-plane tools", async () => {
  const tools = await listedTools("operator");
  assert.deepEqual(tools, mcpToolNames("operator").sort());
  assert.equal(tools.includes("broker_integrate"), true);
  assert.equal(tools.includes("batch_approve"), true);
});

test("an unknown MCP profile fails closed", () => {
  assert.throws(
    () => createMcpServer({ profile: "admin" as "worker" }),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_MCP_PROFILE",
  );
});

async function initializedRepository(context: TestContext): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-mcp-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const git = async (...args: string[]): Promise<void> => {
    await runCommand("git", args, { cwd: repo });
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Merge Broker Test");
  await git("config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git("add", "README.md");
  await git("commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  return repo;
}

test("a worker MCP server cannot use another worker's stored lease token", async (context) => {
  const repo = await initializedRepository(context);

  const alice = await connect({ cwd: repo, profile: "worker", version: "test", agent: "alice" });
  const bob = await connect({ cwd: repo, profile: "worker", version: "test", agent: "bob" });
  context.after(async () => {
    await alice.close();
    await bob.close();
  });

  const claimed = await callTool(alice.transport, "task_claim", { taskId: "SHARED", paths: ["src/**"] });
  assert.equal(claimed.isError, false, JSON.stringify(claimed.body));
  for (const [tool, args] of [
    ["task_heartbeat", { taskId: "SHARED" }],
    ["task_extend", { taskId: "SHARED", paths: ["docs/**"] }],
    ["task_release", { taskId: "SHARED" }],
    ["task_candidate", { taskId: "SHARED" }],
  ] as const) {
    const denied = await callTool(bob.transport, tool, args);
    assert.equal(denied.isError, true, tool);
    assert.equal(denied.body.code, "LEASE_NOT_OWNED", tool);
  }
  const impersonated = await callTool(bob.transport, "task_claim", { taskId: "OTHER", paths: ["lib/**"], holder: "alice" });
  assert.equal(impersonated.isError, true);
  assert.equal(impersonated.body.code, "INVALID_ARGUMENTS");

  assert.equal((await callTool(alice.transport, "task_heartbeat", { taskId: "SHARED" })).isError, false);

  // A restarted server with the same explicit identity resumes its own lease.
  await alice.close();
  const restarted = await connect({ cwd: repo, profile: "worker", version: "test", agent: "alice" });
  context.after(async () => await restarted.close());
  const resumed = await callTool(restarted.transport, "task_release", { taskId: "SHARED" });
  assert.equal(resumed.isError, false, JSON.stringify(resumed.body));
});

test("an operator MCP server records only the actor it was started with", async (context) => {
  const repo = await initializedRepository(context);
  const binding = { batchId: "BATCH-1", candidateSha: "a".repeat(40), baseSha: "b".repeat(40) };

  const anonymous = await connect({ cwd: repo, profile: "operator", version: "test", actor: "" });
  context.after(async () => await anonymous.close());
  const refused = await callTool(anonymous.transport, "batch_approve", { ...binding, actor: "release-manager" });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.code, "ACTOR_REQUIRED");

  const operator = await connect({ cwd: repo, profile: "operator", version: "test", actor: "release-manager" });
  context.after(async () => await operator.close());
  for (const [tool, args] of [
    ["batch_approve", binding],
    ["batch_record_verification", { ...binding, name: "qa", status: "passed" }],
    ["batch_request_changes", { ...binding, reason: "needs work" }],
  ] as const) {
    const impersonated = await callTool(operator.transport, tool, { ...args, actor: "someone-else" });
    assert.equal(impersonated.isError, true, tool);
    assert.equal(impersonated.body.code, "INVALID_ARGUMENTS", tool);
  }
  // With the bound actor (given or omitted), the request reaches approval policy, which is disabled here.
  for (const args of [binding, { ...binding, actor: "release-manager" }]) {
    const reached = await callTool(operator.transport, "batch_approve", args);
    assert.equal(reached.isError, true);
    assert.equal(reached.body.code, "APPROVAL_DISABLED");
  }
});
