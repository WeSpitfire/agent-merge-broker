import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { commandForArchitecture, runCommand } from "./process.js";

test("runs native validators through Apple's architecture launcher only when translated", () => {
  assert.deepEqual(
    commandForArchitecture("/bin/sh", ["-c", "swift test"], "native", {
      platform: "darwin",
      processArchitecture: "x64",
      nativeArchitecture: "arm64",
    }),
    { executable: "/usr/bin/arch", args: ["-arm64", "/bin/sh", "-c", "swift test"] },
  );
  assert.deepEqual(
    commandForArchitecture("/bin/sh", ["-c", "swift test"], "native", {
      platform: "darwin",
      processArchitecture: "arm64",
      nativeArchitecture: "arm64",
    }),
    { executable: "/bin/sh", args: ["-c", "swift test"] },
  );
  assert.deepEqual(
    commandForArchitecture("/bin/sh", ["-c", "swift test"], "process", {
      platform: "darwin",
      processArchitecture: "x64",
      nativeArchitecture: "arm64",
    }),
    { executable: "/bin/sh", args: ["-c", "swift test"] },
  );
});

test("bounds command output while retaining the beginning and end", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('HEAD' + 'x'.repeat(1000000) + 'TAIL')"],
    { cwd: process.cwd(), maxOutputBytes: 1_024 },
  );
  assert.ok(result.stdout.startsWith("HEAD"));
  assert.ok(result.stdout.endsWith("TAIL"));
  assert.match(result.stdout, /output truncated by Merge Broker/u);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") < 1_100);
});

test(
  "kills validator descendants when the command times out",
  { skip: process.platform === "win32" ? "POSIX process-group behavior" : false },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-process-"));
    context.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const marker = path.join(directory, "descendant-survived");
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 400)`;
    const parentScript = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const result = await runCommand(process.execPath, ["-e", parentScript], {
      cwd: directory,
      timeoutMs: 75,
      allowFailure: true,
      killProcessTree: true,
    });
    assert.match(result.stderr, /Timed out after 75ms/u);
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    await assert.rejects(access(marker));
  },
);
