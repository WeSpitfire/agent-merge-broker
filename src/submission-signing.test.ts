import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MergeBroker } from "./broker.js";
import { configPath, loadConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { provenanceKeyId } from "./provenance.js";
import { verifySubmissionAttestation } from "./submission-attestation.js";
import type { SubmissionRecord } from "./types.js";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd: repo })).stdout.trim();
}

async function fixture(context: TestContext, options: { register?: boolean; refresh?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "merge-broker-submission-signing-"));
  context.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const repo = path.join(root, "repo");
  const validationLog = path.join(root, "validator-runs.txt");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Gate signing test");
  await git(repo, "config", "user.email", "gate-signing@example.invalid");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "commit.gpgSign", "false");
  await writeFile(path.join(repo, "README.md"), "# Gate signing fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  await MergeBroker.initialize(repo, { detect: false });
  await writeFile(path.join(repo, "validate.mjs"), [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(validationLog)}, "run\\n");`,
    'console.log("protected validator completed");',
    "",
  ].join("\n"));
  const config = await loadConfig(repo);
  config.integration.refreshBase = options.refresh ?? false;
  config.validation.authoritative = [{ name: "protected validator", command: "node validate.mjs" }];
  const publicKey = config.integration.provenance?.publicKey;
  assert.ok(publicKey, "Initialization must provision a real Ed25519 identity.");
  await writeFile(configPath(repo), `${JSON.stringify(config, null, 2)}\n`);
  await git(repo, "add", ".merge-broker/config.json", "validate.mjs");
  await git(repo, "commit", "-m", "protect Gate policy");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  if (options.refresh) {
    const remote = path.join(root, "remote.git");
    await git(repo, "init", "--bare", remote);
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "origin", "main");
  }
  const broker = await MergeBroker.open(repo);
  if (options.register !== false) await broker.registerCandidateAuthority();
  return { repo, broker, baseSha, publicKey, validationLog };
}

async function adopt(repo: string, broker: MergeBroker): Promise<SubmissionRecord> {
  await git(repo, "switch", "-c", "producer/candidate", "main");
  await writeFile(path.join(repo, "candidate.txt"), "accepted candidate\n");
  await git(repo, "add", "candidate.txt");
  await git(repo, "commit", "-m", "candidate");
  await git(repo, "switch", "main");
  const submission = await broker.adoptCandidate({ ref: "producer/candidate" });
  assert.equal(submission.status, "validated");
  return submission;
}

function verificationOptions(submission: SubmissionRecord, publicKey: string) {
  return {
    publicKey,
    expected: {
      candidateSha: submission.artifact.sha,
      treeSha: submission.artifact.treeSha,
      baseSha: submission.base.sha,
      policyDigest: submission.policy.digest,
      authorityDigest: submission.authorityDigest,
      configBlobSha: submission.policy.configBlobSha,
      evaluatorVersion: submission.policy.evaluatorVersion,
    },
  };
}

test("broker signs retained Gate evidence with the protected key without rerunning validators or changing commits", async (context) => {
  const { repo, broker, publicKey, validationLog } = await fixture(context);
  const submission = await adopt(repo, broker);
  const refs = await git(repo, "show-ref");
  const validationRuns = await readFile(validationLog, "utf8");
  const signed = await broker.attestSubmission(submission.id);
  const result = verifySubmissionAttestation(signed, verificationOptions(submission, publicKey));
  assert.equal(result.validationPassed, true);
  assert.equal(result.mergeAuthorized, false);
  assert.equal(result.keyId, provenanceKeyId(publicKey));
  assert.deepEqual(await broker.submission(submission.id), submission);
  assert.equal(await git(repo, "show-ref"), refs);
  assert.equal(await readFile(validationLog, "utf8"), validationRuns);
  const events = (await broker.store.readAudit()).filter((event) => event.event === "submission.attested");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.submissionId, submission.id);
  assert.doesNotMatch(JSON.stringify(signed), /PRIVATE KEY/u);
});

test("rotating the current signing identity still signs older submissions with their recorded protected-base key", async (context) => {
  const { repo, broker, publicKey } = await fixture(context);
  const submission = await adopt(repo, broker);
  const rotated = await broker.setupProvenanceSigning({ rotate: true });
  assert.notEqual(rotated.keyId, provenanceKeyId(publicKey));
  const result = verifySubmissionAttestation(await broker.attestSubmission(submission.id), verificationOptions(submission, publicKey));
  assert.equal(result.keyId, provenanceKeyId(publicKey));
  assert.equal(result.validationPassed, true);
});

test("Gate signing reports unavailable protected keys and rejects a fallback key for a different policy", async (context) => {
  const { repo, broker, publicKey } = await fixture(context);
  const submission = await adopt(repo, broker);
  await broker.setupProvenanceSigning({ rotate: true });
  const originalKey = path.join(broker.store.provenanceKeysDirectory, `${provenanceKeyId(publicKey)}.pem`);
  await rename(originalKey, `${originalKey}.unavailable`);
  await assert.rejects(broker.attestSubmission(submission.id),
    (error: unknown) => error instanceof BrokerError && error.code === "SIGNING_KEY_MISMATCH");
  await rename(broker.store.provenanceSigningKeyFile, `${broker.store.provenanceSigningKeyFile}.unavailable`);
  await assert.rejects(broker.attestSubmission(submission.id),
    (error: unknown) => error instanceof BrokerError && error.code === "PROVENANCE_KEY_MISSING");
  assert.equal((await broker.store.readAudit()).some((event) => event.event === "submission.attested"), false);
  assert.deepEqual(await broker.submission(submission.id), submission);
});

test("Gate readiness inspects local policy without fetching, running validators, pinning refs, or writing state", async (context) => {
  const { repo, broker, baseSha, validationLog } = await fixture(context, { refresh: true });
  const state = await readFile(path.join(broker.store.directory, "state.json"), "utf8");
  const audit = await broker.store.readAudit();
  const refs = await git(repo, "show-ref");
  const worktrees = await git(repo, "worktree", "list", "--porcelain");
  const fail = async () => { throw new Error("Readiness must not perform this operation."); };
  const fetch = context.mock.method(broker.repo, "fetchBranchHead", fail);
  const pin = context.mock.method(broker.repo, "pinLocalRef", fail);
  const worktree = context.mock.method(broker.repo, "addRawDetachedWorktree", fail);
  const readiness = await broker.candidateReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.baseSha, baseSha);
  assert.equal(readiness.baseObservation, "local-only");
  assert.equal(readiness.refreshBeforeAdoption, true);
  assert.deepEqual(readiness.validators, ["protected validator"]);
  assert.deepEqual(readiness.pending, []);
  assert.deepEqual(readiness.warnings, []);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(pin.mock.callCount(), 0);
  assert.equal(worktree.mock.callCount(), 0);
  await assert.rejects(access(validationLog), { code: "ENOENT" });
  assert.equal(await readFile(path.join(broker.store.directory, "state.json"), "utf8"), state);
  assert.deepEqual(await broker.store.readAudit(), audit);
  assert.equal(await git(repo, "show-ref"), refs);
  assert.equal(await git(repo, "worktree", "list", "--porcelain"), worktrees);
});

test("Gate readiness reports missing authority as an actionable diagnostic", async (context) => {
  const { broker } = await fixture(context, { register: false });
  const readiness = await broker.candidateReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.errorCode, "GATE_AUTHORITY_REQUIRED");
  assert.match(JSON.stringify(readiness.warnings), /candidate authority setup/u);
});

test("Gate readiness surfaces unfinished validation and archive operations without recovering them", async (context) => {
  const { repo, broker, validationLog } = await fixture(context);
  const submission = await adopt(repo, broker);
  await broker.store.transaction((state) => {
    const active = state.submissions[submission.id];
    assert.ok(active);
    active.archiveIntent = { requestedAt: new Date().toISOString(), releaseArtifact: false };
    state.submissions["pending-validation"] = { ...structuredClone(submission), id: "pending-validation", status: "received" };
  });
  const before = await broker.state();
  const validationRuns = await readFile(validationLog, "utf8");
  const readiness = await broker.candidateReadiness();
  assert.deepEqual((readiness.pending as string[]).sort(), ["pending-validation", submission.id].sort());
  assert.match(JSON.stringify(readiness.warnings), /pending.*recover/u);
  assert.deepEqual(await broker.state(), before);
  assert.equal(await readFile(validationLog, "utf8"), validationRuns);
});
