import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import childProcess, { type SpawnOptions } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import {
  commandForArchitecture,
  resolveShell,
  runCommand,
  withoutCurrentDirectoryExecutableSearch,
} from "./process.js";
import { fakeProcess } from "./test-support/fake-process.js";

test("portable command fixtures preserve literal arguments and process I/O, then restore spawning", async (context) => {
  const command = "merge-broker-test-command-that-does-not-exist";
  await context.test("real Node subprocess", async (subcontext) => {
    await fakeProcess(subcontext, command, `
      console.log(JSON.stringify({ args, input }));
      console.error("fixture error output");
      process.exitCode = 7;
    `);
    const args = ["argument with spaces", 'literal "quotes"', "a&b", "100%"];
    const result = await runCommand(command, args, { cwd: process.cwd(), input: "first\nsecond\n", allowFailure: true });
    assert.deepEqual(JSON.parse(result.stdout), { args, input: "first\nsecond\n" });
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr, /fixture error output/u);
    assert.equal((await runCommand(process.execPath, ["-e", "console.log('unchanged')"], { cwd: process.cwd() })).stdout.trim(), "unchanged");
  });
  await assert.rejects(runCommand(command, [], { cwd: process.cwd() }), { code: "ENOENT" });
});

test("uses non-profile PowerShell with literal-safe placeholders on Windows", () => {
  const shell = resolveShell(undefined, "win32");
  assert.equal(shell.executable, "powershell.exe");
  assert.deepEqual(shell.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(shell.quote("src/O'Brien & Co/file.ts"), "'src/O''Brien & Co/file.ts'");
});

test("doubles typographic PowerShell single quotes so committed paths stay literal", () => {
  const shell = resolveShell(undefined, "win32");
  for (const quote of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
    assert.equal(shell.quote(`a${quote};calc;${quote}.ts`), `'a${quote}${quote};calc;${quote}${quote}.ts'`);
  }
});

test("disables Windows current-directory executable search only while spawning", () => {
  const name = "NoDefaultCurrentDirectoryInExePath";
  const unset: NodeJS.ProcessEnv = {};
  assert.equal(withoutCurrentDirectoryExecutableSearch(() => unset[name], "win32", unset), "1");
  assert.equal(Object.prototype.hasOwnProperty.call(unset, name), false);

  const preset: NodeJS.ProcessEnv = { [name]: "operator" };
  assert.throws(() => withoutCurrentDirectoryExecutableSearch(() => {
    assert.equal(preset[name], "1");
    throw new Error("spawn failed");
  }, "win32", preset), /spawn failed/u);
  assert.equal(preset[name], "operator");

  const posix: NodeJS.ProcessEnv = {};
  assert.equal(withoutCurrentDirectoryExecutableSearch(() => posix[name], "linux", posix), undefined);
});

test("recognizes configured PowerShell and cmd interpreters", () => {
  assert.equal(resolveShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").quote("100%"), "'100%'");
  assert.deepEqual(resolveShell("C:\\Windows\\System32\\cmd.exe").args, ["/d", "/s", "/c"]);
});

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

test("supervised commands preserve literal arguments, stdin, exit status, and bounded output", async () => {
  const args = ["spaces and & symbols", 'literal "quotes"', "backslash\\", "日本語 café 🧪"];
  const script = `let input=''; for await (const value of process.stdin) input+=value; console.log(JSON.stringify({args:process.argv.slice(1),input})); console.error('x'.repeat(10000)+'TAIL'); process.exitCode=7;`;
  const result = await runCommand(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: process.cwd(), input: "first\nsecond 日本語 café 🧪\n", allowFailure: true, killProcessTree: true, maxOutputBytes: 1024,
  });
  assert.equal(result.exitCode, 7);
  assert.deepEqual(JSON.parse(result.stdout), { args, input: "first\nsecond 日本語 café 🧪\n" });
  assert.match(result.stderr, /output truncated.*[\s\S]*TAIL/u);
});

test("zero-exit supervisors cannot pass validation before initialization or command completion", async (context) => {
  for (const stage of ["initializing", "reporting command completion"] as const) {
    await context.test(stage, async (subcontext) => {
      const originalSpawn = childProcess.spawn;
      const source = stage === "initializing" ? "process.exit(0);" : process.platform === "win32"
        ? `process.stderr.write("MERGE_BROKER_SUPERVISOR_READY\\n"); process.stdin.once("data", () => process.exit(0));`
        : `process.send({type:"ready"}); process.once("message", () => process.exit(0));`;
      const replacement = ((_executable: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) =>
        originalSpawn(process.execPath, ["--input-type=commonjs", "-e", source],
          (Array.isArray(argsOrOptions) ? options : argsOrOptions as SpawnOptions | undefined) ?? {})) as typeof childProcess.spawn;
      const mocked = subcontext.mock.method(childProcess, "spawn", replacement);
      syncBuiltinESMExports();
      subcontext.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
      for (const allowFailure of [false, true]) {
        await assert.rejects(runCommand(process.execPath, ["-e", "throw new Error('must not execute')"], {
          cwd: process.cwd(), killProcessTree: true, allowFailure,
        }), new RegExp(`Validator supervisor exited before ${stage}`, "u"));
      }
    });
  }
});

test("a supervised empty successful command reports its completion explicitly", async () => {
  const result = await runCommand(process.execPath, ["-e", ""], { cwd: process.cwd(), killProcessTree: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test(
  "kills validator descendants when the command times out",
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-process-"));
    context.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const marker = path.join(directory, "descendant-survived");
    // Windows starts taskkill as a separate process, so give its tree walk a wider margin.
    const lateMs = process.platform === "win32" ? 3_000 : 400;
    const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), ${lateMs})`;
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
    await new Promise<void>((resolve) => setTimeout(resolve, lateMs + 200));
    await assert.rejects(access(marker));
  },
);
