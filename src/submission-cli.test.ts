import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { runCommand } from "./process.js";
import type { SubmissionRecord } from "./types.js";

const source = fileURLToPath(import.meta.url).endsWith(".ts");
const runtime = [
  ...(source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []),
  fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url)),
];
async function directory(context: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "merge-broker-gate-cli-"));
  context.after(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}
async function cli(repo: string, args: string[], json = true) {
  return await runCommand(process.execPath, [...runtime, "--cwd", repo, ...(json ? ["--json"] : []), ...args], {
    cwd: repo, allowFailure: true, timeoutMs: 30_000,
  });
}
async function fixture(context: TestContext, rejected = false) {
  const repo = await directory(context);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Gate CLI Test");
  await git(repo, "config", "user.email", "test@merge-broker.invalid");
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo);
  await (await MergeBroker.open(repo)).setupProvenanceSigning({});
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.validation.authoritative = [{
    name: "candidate-check",
    command: `node -e "console.log('stored validator detail'); process.exit(${rejected ? 7 : 0})"`,
  }];
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`);
  await git(repo, "add", ".merge-broker/config.json");
  await git(repo, "commit", "-m", "protected policy");
  await git(repo, "switch", "-c", "producer/candidate");
  await writeFile(path.join(repo, "candidate.txt"), "candidate\n");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate");
  await git(repo, "switch", "main");
  const broker = await MergeBroker.open(repo);
  await broker.registerCandidateAuthority();
  const record = await broker.adoptCandidate({ ref: "producer/candidate" });
  return { repo, broker, record, publicKey: config.integration.provenance!.publicKey! };
}

test("Gate CLI shows explicit logs, previews archival, and includes archived records only on request", async (context) => {
  const { repo, broker, record } = await fixture(context, true);
  assert.equal(record.status, "rejected");
  const plain = await cli(repo, ["candidate", "show", record.id], false);
  assert.equal(plain.exitCode, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /stored validator detail/);
  const logs = await cli(repo, ["candidate", "show", record.id, "--logs"], false);
  assert.equal(logs.exitCode, 0, logs.stderr);
  assert.match(logs.stdout, /candidate-check \(failed\)/);
  assert.match(logs.stdout, /stored validator detail/);
  const ready = await cli(repo, ["doctor", "--gate"]);
  assert.equal(ready.exitCode, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).gate.baseObservation, "local-only");

  const before = await readFile(path.join(broker.store.directory, "state.json"), "utf8");
  const preview = await cli(repo, ["candidate", "archive", record.id]);
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(await readFile(path.join(broker.store.directory, "state.json"), "utf8"), before);
  const archived = await cli(repo, ["candidate", "archive", record.id, "--apply"]);
  assert.equal(archived.exitCode, 0, archived.stderr);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
  assert.deepEqual(JSON.parse((await cli(repo, ["candidate", "list"])).stdout), []);
  const all = JSON.parse((await cli(repo, ["candidate", "list", "--all"])).stdout) as SubmissionRecord[];
  assert.deepEqual(all.map((item) => item.id), [record.id]);
  const shown = await cli(repo, ["candidate", "show", record.id], false);
  assert.match(shown.stdout, /Archived:/);
  assert.equal(JSON.parse((await cli(repo, ["metrics"])).stdout).submissions.archived, 1);
});

test("Gate CLI signs actual retained evidence and verifies it outside Git without replacing output files", async (context) => {
  const { repo, record, publicKey } = await fixture(context);
  const outside = await directory(context);
  const envelopePath = path.join(outside, "evidence.json");
  const keyPath = path.join(outside, "trusted.pem");
  await writeFile(keyPath, publicKey);
  const signed = await cli(repo, ["candidate", "attest", record.id, "--output", envelopePath]);
  assert.equal(signed.exitCode, 0, signed.stderr);
  const original = await readFile(envelopePath, "utf8");
  const replaced = await cli(repo, ["candidate", "attest", record.id, "--output", envelopePath]);
  assert.equal(replaced.exitCode, 1);
  assert.equal(await readFile(envelopePath, "utf8"), original);
  const args = ["candidate", "verify-attestation", envelopePath, "--public-key", keyPath,
    "--candidate", record.artifact.sha, "--tree", record.artifact.treeSha, "--base", record.base.sha,
    "--policy-digest", record.policy.digest, "--authority-digest", record.authorityDigest,
    "--config-blob", record.policy.configBlobSha, "--evaluator", record.policy.evaluatorVersion];
  const checked = await cli(outside, args);
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).verified, true);
  assert.equal(JSON.parse(checked.stdout).validationPassed, true);
  assert.equal(JSON.parse(checked.stdout).mergeAuthorized, false);
  const mismatch = [...args];
  mismatch[mismatch.indexOf("--candidate") + 1] = "a".repeat(40);
  const refused = await cli(outside, mismatch);
  assert.equal(refused.exitCode, 1);
  assert.equal(JSON.parse(refused.stderr).error.code, "SUBMISSION_ATTESTATION_IDENTITY_MISMATCH");
  await writeFile(envelopePath, "not JSON");
  const malformed = await cli(outside, args);
  assert.equal(malformed.exitCode, 1);
  assert.equal(JSON.parse(malformed.stderr).error.code, "SUBMISSION_ATTESTATION_INVALID");
});

test("Gate CLI reports signed rejection as verified failure, not validation success", async (context) => {
  const { repo, record, publicKey } = await fixture(context, true);
  const outside = await directory(context);
  const envelopePath = path.join(outside, "rejection.json");
  const keyPath = path.join(outside, "trusted.pem");
  await writeFile(keyPath, publicKey);
  const signed = await cli(repo, ["candidate", "attest", record.id]);
  assert.equal(signed.exitCode, 0, signed.stderr);
  await writeFile(envelopePath, signed.stdout);
  const checked = await cli(outside, ["candidate", "verify-attestation", envelopePath,
    "--public-key", keyPath, "--candidate", record.artifact.sha, "--tree", record.artifact.treeSha,
    "--base", record.base.sha, "--policy-digest", record.policy.digest, "--authority-digest", record.authorityDigest]);
  assert.equal(checked.exitCode, 1);
  assert.equal(checked.stderr, "");
  assert.equal(JSON.parse(checked.stdout).verified, true);
  assert.equal(JSON.parse(checked.stdout).validationPassed, false);
  assert.equal(JSON.parse(checked.stdout).outcome, "rejected");
});

test("Gate CLI readiness fails clearly without registered authority", async (context) => {
  const repo = await directory(context);
  await git(repo, "init", "-b", "main");
  await MergeBroker.initialize(repo);
  const result = await cli(repo, ["doctor", "--gate"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).gate.errorCode, "GATE_AUTHORITY_REQUIRED");
});

test("Gate CLI abandons pending work with a reason and explicitly releases its artifact on archival", async (context) => {
  const { repo, broker, record } = await fixture(context);
  // Model a durable intake whose process stopped before validation completed.
  await broker.store.transaction((state) => {
    const pending = state.submissions[record.id]!;
    pending.status = "received";
    pending.validations = [];
    delete pending.finishedAt;
    delete pending.validationStartedAt;
  });
  const abandoned = await cli(repo, ["candidate", "abandon", record.id, "--reason", "Producer withdrew this revision"]);
  assert.equal(abandoned.exitCode, 0, abandoned.stderr);
  assert.equal(JSON.parse(abandoned.stdout).status, "abandoned");
  assert.equal(JSON.parse(abandoned.stdout).abandonReason, "Producer withdrew this revision");
  assert.deepEqual(JSON.parse(abandoned.stdout).validations, []);
  const preview = await cli(repo, ["candidate", "archive", record.id, "--release-artifacts"]);
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).releaseArtifacts, true);
  assert.equal(await git(repo, "rev-parse", record.artifact.retainedRef), record.artifact.sha);
  const applied = await cli(repo, ["candidate", "archive", record.id, "--release-artifacts", "--apply"]);
  assert.equal(applied.exitCode, 0, applied.stderr);
  const ref = await runCommand("git", ["show-ref", "--verify", "--quiet", record.artifact.retainedRef], { cwd: repo, allowFailure: true });
  assert.equal(ref.exitCode, 1);
  const shown = JSON.parse((await cli(repo, ["candidate", "show", record.id])).stdout) as SubmissionRecord;
  assert.ok(shown.archivedAt);
  assert.ok(shown.artifactReleasedAt);
  const recovered = await cli(repo, ["recover"]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout).submissionsRecovered, []);
});
