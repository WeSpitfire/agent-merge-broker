#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MergeBroker, loadConfig, verifySubmissionAttestation } from "../../dist/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");
const demo = await mkdtemp(path.join(tmpdir(), "merge-broker-local-gate-"));
const repo = path.join(demo, "repository");
const remote = path.join(demo, "origin.git");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed (${result.status ?? result.signal})\n${result.stderr || result.stdout}`);
  }
  return result;
}
function git(...args) { return run("git", args).stdout.trim(); }
function brokerCli(args, options = {}) {
  return run(process.execPath, [cli, "-C", repo, "--json", ...args], options);
}
function say(message) { process.stdout.write(`\n${message}\n`); }

try {
  await mkdir(repo);
  run("git", ["init", "--bare", "-q", remote], { cwd: demo });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Gate Demo");
  git("config", "user.email", "gate-demo@merge-broker.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgSign", "false");
  git("remote", "add", "origin", remote);
  await writeFile(path.join(repo, "answer.txt"), "baseline\n");
  await writeFile(path.join(repo, "verify.mjs"), [
    'import { readFileSync } from "node:fs";',
    'const accepted = readFileSync("answer.txt", "utf8").trim() === "accepted";',
    'console.log(accepted ? "Candidate accepted." : "Candidate rejected: expected accepted.");',
    'process.exit(accepted ? 0 : 7);',
    "",
  ].join("\n"));
  git("add", ".");
  git("commit", "-qm", "initial trusted repository");

  say("Registering a reviewed, local protected base and its signed public-key policy.");
  await MergeBroker.initialize(repo, { baseBranch: "main", baseRef: "main", remote: "origin", detect: false });
  const config = await loadConfig(repo);
  config.integration.refreshBase = false;
  config.validation.focused = [];
  config.validation.authority = "broker";
  config.validation.authoritative = [{ name: "candidate contract", command: "node verify.mjs" }];
  config.publish.mode = "none";
  config.publish.autoMerge = false;
  const publicKey = config.integration.provenance?.publicKey;
  assert.ok(publicKey, "Initialization must create the local signing identity.");
  await writeFile(path.join(repo, ".merge-broker", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  git("add", ".merge-broker", "AGENTS.md");
  git("commit", "-qm", "commit reviewed Gate policy");
  git("push", "-q", "origin", "main");
  const baseSha = git("rev-parse", "main");
  const broker = await MergeBroker.open(repo);
  await broker.registerCandidateAuthority();
  const readiness = JSON.parse(brokerCli(["doctor", "--gate"]).stdout);
  assert.ok(readiness, "Readiness command must return machine-readable output.");

  for (const [branch, answer] of [["producer/accepted", "accepted"], ["producer/rejected", "rejected"]]) {
    git("switch", "-q", "-c", branch, "main");
    await writeFile(path.join(repo, "answer.txt"), `${answer}\n`);
    git("add", "answer.txt");
    git("commit", "-qm", `submit ${answer} candidate`);
    git("switch", "-q", "main");
  }
  say("Validating two immutable candidates under the same protected policy.");
  const accepted = await broker.adoptCandidate({ ref: "refs/heads/producer/accepted" });
  assert.equal(accepted.status, "validated");
  const rejectedCommand = brokerCli(["candidate", "adopt", "--ref", "refs/heads/producer/rejected"], { allowFailure: true });
  assert.notEqual(rejectedCommand.status, 0, "A rejected candidate must exit unsuccessfully.");
  const rejected = JSON.parse(rejectedCommand.stdout);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.validations[0].exitCode, 7);
  process.stdout.write(`Accepted: ${accepted.id}\nRejected: ${rejected.id} (validator exit 7)\n`);

  say("Signing the accepted result and verifying its detached evidence offline.");
  const envelopePath = path.join(demo, "candidate.dsse.json");
  brokerCli(["candidate", "attest", accepted.id, "--output", envelopePath]);
  const signed = JSON.parse(await readFile(envelopePath, "utf8"));
  const expected = {
    candidateSha: accepted.artifact.sha,
    treeSha: accepted.artifact.treeSha,
    baseSha,
    policyDigest: accepted.policy.digest,
    authorityDigest: accepted.authorityDigest,
    configBlobSha: accepted.policy.configBlobSha,
    evaluatorVersion: accepted.policy.evaluatorVersion,
  };
  const verified = verifySubmissionAttestation(signed, { publicKey, expected });
  assert.equal(verified.validationPassed, true);
  assert.equal(verified.mergeAuthorized, false);
  assert.equal(git("rev-parse", "producer/accepted"), accepted.artifact.sha, "Signing must not modify the candidate.");
  const publicKeyPath = path.join(demo, "trusted-public.pem");
  await writeFile(publicKeyPath, publicKey);
  // Run outside the fixture repository: verification needs only the envelope, trust key, and IDs.
  const verifiedCli = run(process.execPath, [cli, "--json", "candidate", "verify-attestation", envelopePath,
    "--public-key", publicKeyPath, "--candidate", expected.candidateSha, "--tree", expected.treeSha,
    "--base", expected.baseSha, "--policy-digest", expected.policyDigest,
    "--authority-digest", expected.authorityDigest], { cwd: demo });
  assert.equal(JSON.parse(verifiedCli.stdout).validationPassed, true);
  process.stdout.write("Signature verified; validation passed; mergeAuthorized=false.\n");

  say("Previewing retirement while preserving both records and retained Git refs.");
  const preview = await broker.archiveSubmissions({ ids: [accepted.id, rejected.id] });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.releaseArtifacts, false);
  assert.deepEqual(new Set(preview.submissions), new Set([accepted.id, rejected.id]));
  assert.equal((await broker.submissions()).length, 2);
  for (const record of [accepted, rejected]) assert.equal(git("rev-parse", record.artifact.retainedRef), record.artifact.sha);
  process.stdout.write(`Would archive ${preview.submissions.length} terminal records; no archive or ref deletion applied.\n`);
  process.stdout.write("\nGate validation, detached verification, and retirement preview completed.\n");
} finally {
  if (process.env.KEEP === "1") process.stdout.write(`\nDemo retained at ${demo}\n`);
  else await rm(demo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
