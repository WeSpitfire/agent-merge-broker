import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MergeBroker } from "./broker.js";
import { GitRepository } from "./git.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { policyFromBase, verifyProvenance } from "./verify.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

interface Fixture {
  repo: string;
  repository: GitRepository;
  branch: string;
  head: string;
  base: string;
}

/** A repository holding one real integration branch, as a pull request would present it. */
async function integrated(context: TestContext): Promise<Fixture> {
  const repo = await mkdtemp(path.join(tmpdir(), "merge-broker-verify-"));
  context.after(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Merge Broker Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  await git(repo, "add", ".merge-broker");
  await git(repo, "commit", "-m", "add broker policy");

  const broker = await MergeBroker.open(repo);
  const claim = await broker.claimTask({ id: "FEATURE", holder: "agent", expectedPaths: ["src/**"] });
  await git(repo, "switch", "-c", "agent/feature", "main");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = 1;\n", "utf8");
  await git(repo, "add", "src/feature.ts");
  await git(repo, "commit", "-m", "add feature");
  const commit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  await broker.submitTask("FEATURE", [commit], claim.token);

  const result = await broker.integrate();
  const branch = result.batch.branchName ?? "";
  return {
    repo,
    repository: await GitRepository.discover(repo),
    branch,
    head: await git(repo, "rev-parse", branch),
    base: await git(repo, "rev-parse", "main"),
  };
}

async function verify(fixture: Fixture, overrides: Partial<Fixture> = {}): Promise<unknown> {
  const base = overrides.base ?? fixture.base;
  const policy = await policyFromBase(fixture.repository, base);
  return await verifyProvenance({
    repo: fixture.repository,
    branch: overrides.branch ?? fixture.branch,
    headSha: overrides.head ?? fixture.head,
    baseSha: base,
    baseBranch: "main",
    ...(policy.publicKey ? { publicKey: policy.publicKey } : {}),
    requireSignature: policy.requireSignature ?? false,
  });
}

const rejected = (pattern: RegExp) => (error: unknown) =>
  error instanceof BrokerError && error.code === "PROVENANCE_INVALID" && pattern.test(error.message);

test("accepts an unaltered integration branch", async (context) => {
  const fixture = await integrated(context);
  const result = await verify(fixture) as { taskIds: string[]; authenticated: boolean };
  assert.deepEqual(result.taskIds, ["FEATURE"]);
  assert.equal(result.authenticated, true);

  // Policy is read from the base branch, not from the change under review.
  const policy = await policyFromBase(fixture.repository, fixture.base);
  assert.equal(policy.baseBranch, "main");
  assert.equal(policy.branchPrefix, "merge-broker/");
  assert.equal(policy.provenanceDirectory, ".merge-broker/attestations");
  assert.equal(policy.requireSignature, true);
  assert.equal(policy.validationAuthority, "broker");
  assert.match(policy.publicKey ?? "", /BEGIN PUBLIC KEY/u);
});

test("rejects a branch that never went through the broker", async (context) => {
  const fixture = await integrated(context);
  await assert.rejects(
    verify(fixture, { branch: "agent/feature" }),
    rejected(/Expected a merge-broker\/<batch-id> branch/u),
  );
});

test("rejects a commit pushed onto the branch after assembly", async (context) => {
  const fixture = await integrated(context);
  await git(fixture.repo, "switch", fixture.branch);
  await writeFile(path.join(fixture.repo, "src", "sneaked.ts"), "export const sneaked = true;\n", "utf8");
  await git(fixture.repo, "add", "src/sneaked.ts");
  await git(fixture.repo, "commit", "-m", "sneak in a change");
  const head = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(verify(fixture, { head }), rejected(/not the final provenance-only commit/u));
});

test("rejects a change smuggled into the provenance commit itself", async (context) => {
  const fixture = await integrated(context);
  await git(fixture.repo, "switch", fixture.branch);
  await writeFile(path.join(fixture.repo, "src", "smuggled.ts"), "export const smuggled = true;\n", "utf8");
  await git(fixture.repo, "add", "src/smuggled.ts");
  await git(fixture.repo, "commit", "--amend", "--no-edit");
  const head = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(verify(fixture, { head }), rejected(/must change only its provenance manifest/u));
});

test("rejects a tampered signed manifest", async (context) => {
  const fixture = await integrated(context);
  await git(fixture.repo, "switch", fixture.branch);
  const manifestPath = (await git(fixture.repo, "show", "--name-only", "--format=", "HEAD")).trim();
  const manifest = JSON.parse(await readFile(path.join(fixture.repo, manifestPath), "utf8")) as {
    tasks: Array<{ actualPaths: string[] }>;
  };
  // Claim the batch touched nothing, which would hide the change from a paths-based reviewer.
  manifest.tasks[0]!.actualPaths = [];
  await writeFile(path.join(fixture.repo, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await git(fixture.repo, "add", manifestPath);
  await git(fixture.repo, "commit", "--amend", "--no-edit");
  const head = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(verify(fixture, { head }), rejected(/signature is invalid/u));
});

test("rejects every base-branch update merge and requires a re-cut", async (context) => {
  const fixture = await integrated(context);

  // What GitHub creates when a protected base requires branches to be up to date.
  await writeFile(path.join(fixture.repo, "CHANGELOG.md"), "# Changes\n", "utf8");
  await git(fixture.repo, "add", "CHANGELOG.md");
  await git(fixture.repo, "commit", "-m", "unrelated work on main");
  const movedBase = await git(fixture.repo, "rev-parse", "main");
  await git(fixture.repo, "switch", fixture.branch);
  await git(fixture.repo, "merge", "--no-edit", "main");
  const updatedHead = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(
    verify(fixture, { head: updatedHead, base: movedBase }),
    rejected(/No merge may be added.*batch refresh/u),
  );

  // A merge of anything that is not already in the base branch is not a branch update.
  await git(fixture.repo, "switch", "-c", "rogue", movedBase);
  await mkdir(path.join(fixture.repo, "src"), { recursive: true });
  await writeFile(path.join(fixture.repo, "src", "rogue.ts"), "export const rogue = true;\n", "utf8");
  await git(fixture.repo, "add", "src/rogue.ts");
  await git(fixture.repo, "commit", "-m", "rogue change");
  await git(fixture.repo, "switch", fixture.branch);
  await git(fixture.repo, "merge", "--no-edit", "rogue");
  const smuggledHead = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(verify(fixture, { head: smuggledHead, base: movedBase }), rejected(/No merge may be added/u));
});

test("rejects malicious conflict resolution in a path also changed by the base", async (context) => {
  const fixture = await integrated(context);

  // This was the dangerous edge case in the former path-only update-merge allowance: because both
  // sides changed src/feature.ts, arbitrary conflict resolution in that same path looked explained.
  await mkdir(path.join(fixture.repo, "src"), { recursive: true });
  await writeFile(path.join(fixture.repo, "src", "feature.ts"), "export const base = true;\n", "utf8");
  await git(fixture.repo, "add", "src/feature.ts");
  await git(fixture.repo, "commit", "-m", "base changes the broker path too");
  const movedBase = await git(fixture.repo, "rev-parse", "main");

  await git(fixture.repo, "switch", fixture.branch);
  await runCommand("git", ["merge", "--no-edit", "main"], { cwd: fixture.repo, allowFailure: true });
  await writeFile(
    path.join(fixture.repo, "src", "feature.ts"),
    "export const backdoor = 'conflict resolution';\n",
    "utf8",
  );
  await git(fixture.repo, "add", "src/feature.ts");
  await git(fixture.repo, "commit", "--no-edit");
  const maliciousHead = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(
    verify(fixture, { head: maliciousHead, base: movedBase }),
    rejected(/No merge may be added.*batch refresh/u),
  );
});

test("rejects an unsigned manifest when protected-base policy requires authentication", async (context) => {
  const fixture = await integrated(context);
  await git(fixture.repo, "switch", fixture.branch);
  const manifestPath = (await git(fixture.repo, "show", "--name-only", "--format=", "HEAD")).trim();
  const manifest = JSON.parse(await readFile(path.join(fixture.repo, manifestPath), "utf8")) as {
    signature?: unknown;
  };
  delete manifest.signature;
  await writeFile(path.join(fixture.repo, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await git(fixture.repo, "add", manifestPath);
  await git(fixture.repo, "commit", "--amend", "--no-edit");
  const unsignedHead = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(
    verify(fixture, { head: unsignedHead }),
    rejected(/requires an authenticated provenance signature/u),
  );
});

test("labels a deliberately unsigned legacy batch as structural-only", async (context) => {
  const fixture = await integrated(context);

  // Protected-base policy explicitly opts into the legacy mode.
  const configPath = path.join(fixture.repo, ".merge-broker", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    integration: { provenance: { requireSignature?: boolean; publicKey?: string } };
  };
  config.integration.provenance.requireSignature = false;
  delete config.integration.provenance.publicKey;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await git(fixture.repo, "add", ".merge-broker/config.json");
  await git(fixture.repo, "commit", "-m", "explicitly allow legacy unsigned provenance");
  const legacyBase = await git(fixture.repo, "rev-parse", "main");

  await git(fixture.repo, "switch", fixture.branch);
  const manifestPath = (await git(fixture.repo, "show", "--name-only", "--format=", "HEAD")).trim();
  const manifest = JSON.parse(await readFile(path.join(fixture.repo, manifestPath), "utf8")) as {
    signature?: unknown;
  };
  delete manifest.signature;
  await writeFile(path.join(fixture.repo, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await git(fixture.repo, "add", manifestPath);
  await git(fixture.repo, "commit", "--amend", "--no-edit");
  const legacyHead = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  const result = await verify(fixture, { base: legacyBase, head: legacyHead }) as { authenticated: boolean };
  assert.equal(result.authenticated, false);
});

test("rejects a batch assembled on history the base branch does not contain", async (context) => {
  const fixture = await integrated(context);
  // A base branch that was rewritten out from under the batch.
  await git(fixture.repo, "switch", "-c", "rewritten", "HEAD~1");
  await writeFile(path.join(fixture.repo, "README.md"), "# Rewritten\n", "utf8");
  await git(fixture.repo, "add", "README.md");
  await git(fixture.repo, "commit", "-m", "rewrite history");
  const unrelatedBase = await git(fixture.repo, "rev-parse", "HEAD");
  await git(fixture.repo, "switch", "main");

  await assert.rejects(
    verify(fixture, { base: unrelatedBase }),
    rejected(/Re-integrate the batch|does not trust a public key/u),
  );
});
