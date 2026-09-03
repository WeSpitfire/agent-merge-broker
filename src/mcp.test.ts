import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { createMcpServer, mcpToolNames } from "./mcp.js";
import { BrokerError } from "./errors.js";

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

async function listedTools(profile: "worker" | "operator"): Promise<string[]> {
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
  const tools = (response.result as { tools: Array<{ name: string }> }).tools;
  return tools.map((tool) => tool.name).sort();
}

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
