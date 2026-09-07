import childProcess, { type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Execute a Node fixture in place of one external command. Unlike a PATH shell script, this runs
 * on Windows too, while retaining real subprocess exit codes, stdin, stdout, and stderr. The
 * redirect is scoped to this test process; Git and all other commands still run normally.
 */
export async function fakeProcess(
  context: TestContext,
  executable: string,
  source: string,
): Promise<{ directory: string; script: string; preload: string; update(source: string): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-fake-process-"));
  const script = path.join(directory, "command.mjs");
  const preload = path.join(directory, "preload.mjs");
  const update = async (body: string): Promise<void> => {
    await writeFile(script, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const command = args.join(" ");',
      "let input = '';",
      // Drain input before exiting so large pull-request bodies exercise the real pipe safely.
      "for await (const chunk of process.stdin) input += chunk;",
      body,
      "",
    ].join("\n"), "utf8");
  };
  await update(source);
  // CLI tests opt in with an explicit Node --import argument. No runtime environment variable or
  // production hook is involved, and only the requested command is redirected in the child.
  await writeFile(preload, [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const originalSpawn = childProcess.spawn;",
    "childProcess.spawn = function (command, ...parameters) {",
    `  if (command !== ${JSON.stringify(executable)}) return Reflect.apply(originalSpawn, this, [command, ...parameters]);`,
    "  const args = Array.isArray(parameters[0]) ? parameters.shift() : [];",
    `  return originalSpawn(process.execPath, [${JSON.stringify(script)}, ...args], ...parameters);`,
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"), "utf8");
  const originalSpawn = childProcess.spawn;
  const replacement = ((
    command: string,
    argsOrOptions?: readonly string[] | SpawnOptions,
    spawnOptions?: SpawnOptions,
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? spawnOptions : argsOrOptions as SpawnOptions | undefined;
    return command === executable
      ? originalSpawn(process.execPath, [script, ...args], options ?? {})
      : originalSpawn(command, args, options ?? {});
  }) as typeof childProcess.spawn;
  const mocked = context.mock.method(childProcess, "spawn", replacement);
  syncBuiltinESMExports();
  context.after(async () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, script, preload, update };
}
