#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "cli.js");
const demo = mkdtempSync(path.join(os.tmpdir(), "merge-broker-demo-"));
const repo = path.join(demo, "shop");
const agents = ["checkout", "search"];
const createdWorktrees = [];

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.status ?? "signal"})\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function git(args, cwd = repo) {
  return run("git", args, { cwd });
}

function broker(args, cwd = repo, options = {}) {
  return run(process.execPath, [cli, "-C", cwd, ...args], { cwd, ...options });
}

function say(message) {
  process.stdout.write(`\n── ${message}\n`);
}

function show(result) {
  const value = `${result.stdout}${result.stderr}`.trim();
  if (value) process.stdout.write(`${value.split(/\r?\n/u).map((line) => `   ${line}`).join("\n")}\n`);
}

function cleanup() {
  if (process.env.KEEP === "1") {
    process.stdout.write(`\nDemo repository kept at: ${repo}\n`);
    return;
  }
  for (const worktree of createdWorktrees) {
    run("git", ["worktree", "remove", "--force", worktree], { cwd: repo, allowFailure: true });
  }
  rmSync(demo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

try {
  readFileSync(cli, "utf8");

  say("Creating a repository with two independent areas");
  mkdirSync(path.join(repo, "src", "checkout"), { recursive: true });
  mkdirSync(path.join(repo, "src", "search"), { recursive: true });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  writeFileSync(path.join(repo, "src", "checkout", "total.ts"), "export const total = 0;\n");
  writeFileSync(path.join(repo, "src", "search", "query.ts"), "export const query = '';\n");
  writeFileSync(path.join(repo, "README.md"), "# Shop\n");
  writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
    name: "merge-broker-demo",
    private: true,
    type: "module",
    scripts: { verify: "node scripts/verify.mjs" },
  }, null, 2)}\n`);
  writeFileSync(path.join(repo, "scripts", "verify.mjs"), [
    'import { readdirSync, readFileSync } from "node:fs";',
    'import path from "node:path";',
    'function files(directory) {',
    '  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {',
    '    const target = path.join(directory, entry.name);',
    '    return entry.isDirectory() ? files(target) : [target];',
    '  });',
    '}',
    'const invalid = files("src").filter((file) => readFileSync(file, "utf8").includes("FIXME"));',
    'if (invalid.length) { console.error(`FIXME markers: ${invalid.join(", ")}`); process.exit(1); }',
    '',
  ].join("\n"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Demo"]);
  git(["config", "user.email", "demo@merge-broker.invalid"]);
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);

  say("Initializing the broker and committing its detected policy");
  broker(["init", "--base", "main", "--base-ref", "main"]);
  const configPath = path.join(repo, ".merge-broker", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.leases.serializedPatterns = ["package-lock.json"];
  config.integration.refreshBase = false;
  config.publish.autoMerge = false;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  git(["add", ".merge-broker", "AGENTS.md"]);
  git(["commit", "-qm", "add broker policy"]);

  say("Two agents claim disjoint scopes in separate worktrees");
  for (const agent of agents) {
    const worktree = path.join(demo, `agent-${agent}`);
    git(["worktree", "add", "-q", worktree, "-b", `agent/${agent}`, "main"]);
    createdWorktrees.push(worktree);
    show(broker(["task", "claim", agent, "--holder", `agent-${agent}`, "--path", `src/${agent}/**`], worktree));
  }

  say("An overlapping third claim is rejected");
  const conflict = broker(
    ["task", "claim", "latecomer", "--holder", "agent-latecomer", "--path", "src/checkout/**"],
    repo,
    { allowFailure: true },
  );
  show(conflict);
  if (conflict.status === 0) throw new Error("The overlapping claim was unexpectedly allowed.");

  say("Each agent commits and nominates its immutable candidate");
  for (const agent of agents) {
    const worktree = path.join(demo, `agent-${agent}`);
    const feature = path.join(worktree, "src", agent, "feature.ts");
    writeFileSync(feature, `export const ${agent} = true;\n`);
    git(["add", `src/${agent}/feature.ts`], worktree);
    git(["commit", "-qm", `add ${agent} feature`], worktree);
    writeFileSync(feature, `export const ${agent} = true;\nexport const ${agent}Version = 2;\n`);
    git(["add", `src/${agent}/feature.ts`], worktree);
    git(["commit", "-qm", `version ${agent} feature`], worktree);
    show(broker(["task", "candidate", agent, "--since-base"], worktree));
  }

  say("The broker plans one non-conflicting batch");
  show(broker(["plan"]));

  say("Integrating: cherry-pick, validate, and retain one branch");
  show(broker(["integrate"]));
  const branch = git(["branch", "--list", "merge-broker/*", "--format=%(refname:short)"]).stdout.trim();
  say(`Result: ${branch}`);
  show(git(["log", "--oneline", `main..${branch}`]));
  process.stdout.write("\nFour commits from two agents became one validated branch, with no agent pushing anything.\n");
} finally {
  cleanup();
}
