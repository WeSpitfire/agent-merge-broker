import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StateStore } from "./store.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { GitRepository } from "./git.js";
import { createValidationCacheDirectory, removeValidationCacheDirectory } from "./validation.js";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Validator process did not become ready.");
}

async function runningValidator(context: TestContext): Promise<{
  store: StateStore; broker: ReturnType<typeof spawn>; exited: Promise<unknown>;
  validatorPid: number; supervisorPid: number; directory: string; guardFile: string; guardNonce: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-execution-"));
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const storeModule = new URL(`./store${extension}`, import.meta.url).href;
  const processModule = new URL(`./process${extension}`, import.meta.url).href;
  const marker = path.join(directory, "active-validator.json");
  const validator = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`;
  const script = `
    import { StateStore } from ${JSON.stringify(storeModule)};
    import { runCommand } from ${JSON.stringify(processModule)};
    const store = new StateStore(${JSON.stringify(directory)}, "state", 10);
    await store.withIntegrationLock(async () => {
      await runCommand(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(validator)}], {
        cwd: ${JSON.stringify(directory)}, killProcessTree: true, timeoutMs: 60000,
      });
    });
  `;
  const runtime = extension === ".ts" ? ["--import", "tsx"] : [];
  const broker = spawn(process.execPath, [...runtime, "--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let errors = "";
  broker.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const exited = once(broker, "exit");
  let supervisorPid: number | undefined;
  context.after(async () => {
    if (supervisorPid && process.platform !== "win32") {
      try { process.kill(-supervisorPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const validatorPid = await until(async () => {
    if (broker.exitCode !== null || broker.signalCode !== null) throw new Error(errors);
    return await readFile(marker, "utf8").then((value) => (JSON.parse(value) as { pid: number }).pid, () => undefined);
  });
  const guards = path.join(directory, "state", "validator-executions");
  const name = (await readdir(guards)).find((entry) => entry.endsWith(".json"));
  assert.ok(name);
  const guardFile = path.join(guards, name);
  const guard = JSON.parse(await readFile(guardFile, "utf8")) as { pid: number; nonce: string };
  supervisorPid = guard.pid;
  return { store: new StateStore(directory, "state", 0.2), broker, exited, validatorPid, supervisorPid,
    directory, guardFile, guardNonce: guard.nonce };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("a broker killed during an active validator cannot overlap the next integration", { timeout: 60_000 }, async (context) => {
  const fixture = await runningValidator(context);
  fixture.broker.kill("SIGKILL");
  await fixture.exited;
  await fixture.store.releaseLock("integration");
  // Use a fresh store, as recovery does. The lock can be released before the supervisor handles
  // disconnect; the execution barrier, not a presumed shutdown delay, must make the callback safe.
  const recovered = new StateStore(fixture.directory, "state", 10);
  await recovered.withIntegrationLock(async () => {
    assert.equal(alive(fixture.validatorPid), false);
  });
  assert.deepEqual(await readdir(path.join(fixture.directory, "state", "validator-executions")), []);
});

test("recovery waits for a stopped supervisor and fails closed if it dies with a surviving group", {
  skip: process.platform === "win32" ? "POSIX process-group failure; Windows uses a kill-on-close kernel job" : false,
  timeout: 60_000,
}, async (context) => {
  const fixture = await runningValidator(context);
  process.kill(fixture.supervisorPid, "SIGSTOP");
  fixture.broker.kill("SIGKILL");
  await fixture.exited;
  await fixture.store.releaseLock("integration");
  let entered = false;
  const attempt = async (): Promise<void> => {
    await assert.rejects(fixture.store.withIntegrationLock(async () => { entered = true; }),
      (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD" &&
        /previous validator execution/iu.test(error.message));
    assert.equal(entered, false);
    assert.equal(alive(fixture.validatorPid), true);
  };
  await attempt();
  process.kill(fixture.supervisorPid, "SIGKILL");
  await attempt();
  // Test-owned group only. Production recovery never kills a PID obtained from a saved record.
  process.kill(-fixture.supervisorPid, "SIGKILL");
  await until(async () => !alive(fixture.validatorPid) ? true : undefined);
  await fixture.store.withIntegrationLock(async () => { entered = true; });
  assert.equal(entered, true);
});

test("Windows relay death kills its job and recovery requires completion proof or inspection", {
  skip: process.platform !== "win32" ? "Windows kernel job lifecycle" : false,
  timeout: 60_000,
}, async (context) => {
  const fixture = await runningValidator(context);
  process.kill(fixture.supervisorPid, "SIGKILL");
  await fixture.exited;
  await until(async () => !alive(fixture.validatorPid) ? true : undefined);
  const guardRemains = await access(fixture.guardFile).then(() => true, () => false);
  const completion = await readFile(`${fixture.guardFile}.done`, "utf8").catch(() => undefined);
  if (guardRemains && completion !== fixture.guardNonce) {
    await assert.rejects(fixture.store.withIntegrationLock(async () => assert.fail("missing completion proof")),
      (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
    await fixture.store.releaseLock("integration", { force: true });
  }
  await fixture.store.withIntegrationLock(async () => {});
});

test("Windows execution guard without empty-job proof requires inspected force unlock", {
  skip: process.platform !== "win32" ? "Windows kernel job completion proof" : false,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-windows-unproven-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory, "state", 0.2);
  await store.initialize();
  const guards = path.join(directory, "state", "validator-executions");
  await mkdir(guards);
  const nonce = randomUUID();
  const guard = path.join(guards, `${nonce}.json`);
  await writeFile(guard, `${JSON.stringify({
    version: 1, nonce, pid: process.pid, host: hostname(), platform: `${process.platform}-${process.arch}`,
    kind: "windows-job", cwd: directory,
  })}\n`);
  await assert.rejects(store.withIntegrationLock(async () => assert.fail("missing completion proof")),
    (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
  await store.releaseLock("integration", { force: true });
  await store.withIntegrationLock(async () => {});
});

test("Node preloads execute only inside a durably registered validator, including Unicode paths", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-exécution-日本語-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 1);
  const preload = `const fs=require('node:fs'); const path=require('node:path'); const guards=fs.readdirSync(path.join(process.cwd(),'state','validator-executions')); fs.appendFileSync('preload.log',JSON.stringify({registered:guards.some(name=>name.endsWith('.json')),pid:process.pid})+'\\n');`;
  await writeFile(path.join(directory, "preload.cjs"), preload);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require ./preload.cjs";
  try {
    await store.withIntegrationLock(async () => {
      const result = await runCommand(process.execPath, ["--input-type=commonjs", "-e", "console.log(process.cwd())"], {
        cwd: directory, killProcessTree: true, env: { ...process.env },
      });
      assert.equal(await realpath(result.stdout.trim()), await realpath(directory));
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  const entries = (await readFile(path.join(directory, "preload.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1, "only the final validator may load the preload");
  assert.equal(entries[0].registered, true);
});

test("invalid execution records block recovery and cleanup until an explicit force unlock", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-execution-corrupt-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 0.01);
  await store.initialize();
  const guards = path.join(store.directory, "validator-executions");
  await mkdir(guards);
  const file = path.join(guards, `${randomUUID()}.json`);
  for (const source of ["null", "x".repeat(8192)]) {
    await writeFile(file, source);
    await assert.rejects(store.withIntegrationLock(async () => assert.fail("recovery must not begin")),
      (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
    // An ordinary unlock must never bypass execution proof, even when integration.lock is absent.
    await store.releaseLock("integration");
    await access(file);
    await store.releaseLock("integration", { force: true });
    await assert.rejects(access(file));
  }
  await store.withIntegrationLock(async () => {});
});

test("execution recovery and force unlock refuse a redirected guard directory", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-execution-link-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new StateStore(directory, "state", 0.01);
  await store.initialize();
  const external = path.join(directory, "unrelated");
  await mkdir(external);
  const retained = path.join(external, `${randomUUID()}.json`);
  await writeFile(retained, "must remain");
  await symlink(external, path.join(store.directory, "validator-executions"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.withIntegrationLock(async () => assert.fail("recovery must not begin")),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH");
  await assert.rejects(store.releaseLock("integration", { force: true }),
    (error: unknown) => error instanceof BrokerError && error.code === "UNSAFE_PATH");
  assert.equal(await readFile(retained, "utf8"), "must remain");
});

test("the original broker preserves worktree and cache while execution completion is unknown", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-execution-cleanup-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const git = async (...args: string[]): Promise<void> => { await runCommand("git", args, { cwd: directory }); };
  await git("init", "-b", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
  const repo = await GitRepository.discover(directory);
  const worktree = path.join(directory, "retained-worktree");
  await repo.addDetachedWorktree(worktree, "HEAD");
  const cache = await createValidationCacheDirectory();
  context.after(async () => { await removeValidationCacheDirectory(cache); });
  const store = new StateStore(repo.commonGitDir, "state", 0.01);
  await store.withIntegrationLock(async () => {
    const guards = path.join(store.directory, "validator-executions");
    await mkdir(guards);
    await writeFile(path.join(guards, `${randomUUID()}.json`), "null");
    for (const cleanup of [() => repo.removeWorktree(worktree), () => removeValidationCacheDirectory(cache)]) {
      await assert.rejects(cleanup(), (error: unknown) => error instanceof BrokerError && error.code === "LOCK_HELD");
    }
    await access(worktree);
    await access(cache);
  });
  await store.releaseLock("integration", { force: true });
  await store.withIntegrationLock(async () => await repo.removeWorktree(worktree));
});
