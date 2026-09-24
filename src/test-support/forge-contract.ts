import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ForgePublisher } from "../publisher.js";

/** Development-only adapter conformance tests. Implement the fixture controls for another forge's
 * local transport model, then call runForgePublisherContract from that adapter's test file.
 * Controls arrange remote observations and effects; they must not replace publisher methods.
 * These cases do not certify a live forge, network protocol, or broker crash recovery. */
export interface ContractPullRequest {
  url: string;
  repository: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  autoMerge: boolean | "unknown";
  mergeState: "CLEAN" | "BLOCKED";
  mergeable: "MERGEABLE" | "CONFLICTING";
  reviewDecision: string;
  mergeCommitSha: string;
  checks: Array<{ name: string; status: string; conclusion?: string }>;
  comments: string[];
  body: string;
}

export interface ForgeContractFaults {
  discovery?: "unavailable" | "invalid-json";
  create?: "response-lost";
  inspection?: "unavailable" | "head-changes-between-reads" | "missing-head";
  enable?: "rejected" | "response-lost";
  directMerge?: "head-changed";
  disable?: "rejected" | "response-lost";
  close?: "rejected" | "response-lost";
  body?: "rejected";
}

export interface ForgeContractFixture {
  publisher: ForgePublisher;
  publication: Parameters<ForgePublisher["publishBatch"]>[0];
  pullRequestUrl: string;
  alternateHead: string;
  /** Seed or update request fields. A supplied faults object replaces all previous faults. */
  arrange(input: { request?: Partial<ContractPullRequest>; faults?: ForgeContractFaults }): Promise<void>;
  /** Independent observation of actual transport effects, not adapter return values. */
  snapshot(): Promise<{
    branchHead: string | undefined;
    ambientBranchHead: string | undefined;
    requests: ContractPullRequest[];
    acceptedMergeHeads: string[];
  }>;
  replaceRemoteHead(sha: string): Promise<void>;
  redirectRecordedRemote(): Promise<void>;
}

/** Each case needs isolated resources, no published branch or PR, and distinct batch/ambient
 * remotes. Set local HEAD and the named integration branch to alternateHead, not batch.headSha;
 * configure ambient remote/base/repository values that differ from the batch's recorded target.
 * Register all cleanup with the supplied context. */
export type ForgeContractFactory = (context: TestContext) => Promise<ForgeContractFixture>;

/** A definite rejected mutation may return false or throw; neither may be reported as accepted. */
async function notAccepted(operation: Promise<boolean>): Promise<void> {
  let accepted: boolean;
  try {
    accepted = await operation;
  } catch {
    return;
  }
  assert.equal(accepted, false);
}

export async function runForgePublisherContract(context: TestContext, create: ForgeContractFactory): Promise<void> {
  const inspect = (fixture: ForgeContractFixture) => fixture.publisher.inspectPullRequest(fixture.publication.repo.root, fixture.pullRequestUrl);
  const enable = (fixture: ForgeContractFixture) => fixture.publisher.enableAutoMerge(
    fixture.publication.repo.root, fixture.pullRequestUrl, fixture.publication.config, fixture.publication.batch.headSha,
  );
  const disable = (fixture: ForgeContractFixture) => fixture.publisher.disableAutoMerge(fixture.publication.repo.root, fixture.pullRequestUrl);

  await context.test("publication binds exact head and target despite ambient drift, and a same-head retry reuses one PR", async (test) => {
    const fixture = await create(test);
    const first = await fixture.publisher.publishBatch(fixture.publication);
    const retry = await fixture.publisher.publishBatch(fixture.publication);
    const remote = await fixture.snapshot();
    assert.equal(first.mode, "pull-request");
    assert.equal(first.branchName, fixture.publication.batch.branchName);
    assert.equal(first.pullRequestUrl, fixture.pullRequestUrl);
    assert.equal(retry.pullRequestUrl, first.pullRequestUrl);
    assert.equal(retry.reusedPullRequest, true);
    assert.equal(remote.branchHead, fixture.publication.batch.headSha);
    assert.equal(remote.ambientBranchHead, undefined);
    assert.equal(remote.requests.length, 1);
    assert.equal(remote.requests[0]!.repository, fixture.publication.batch.forgeRepository);
    assert.equal(remote.requests[0]!.baseBranch, fixture.publication.batch.baseBranch);
    assert.equal(remote.requests[0]!.branch, fixture.publication.batch.branchName);
  });

  await context.test("branch publication is idempotent and refuses a different existing remote head", async (test) => {
    const fixture = await create(test);
    fixture.publication.config.publish.mode = "branch";
    const result = await fixture.publisher.publishBatch(fixture.publication);
    assert.deepEqual(result, { mode: "branch", branchName: fixture.publication.batch.branchName });
    await fixture.publisher.publishBatch(fixture.publication);
    await fixture.replaceRemoteHead(fixture.alternateHead);
    await assert.rejects(fixture.publisher.publishBatch(fixture.publication));
    assert.equal((await fixture.snapshot()).branchHead, fixture.alternateHead);
    assert.equal((await fixture.snapshot()).requests.length, 0);
  });

  await context.test("changed recorded remote is refused before publication", async (test) => {
    const fixture = await create(test);
    await fixture.redirectRecordedRemote();
    await assert.rejects(fixture.publisher.publishBatch(fixture.publication));
    const remote = await fixture.snapshot();
    assert.equal(remote.branchHead, undefined);
    assert.equal(remote.ambientBranchHead, undefined);
    assert.equal(remote.requests.length, 0);
  });

  for (const state of ["OPEN", "CLOSED", "MERGED"] as const) {
    await context.test(`a lost create response recovers the same ${state} PR without duplicating it`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ faults: { create: "response-lost" } });
      await assert.rejects(fixture.publisher.publishBatch(fixture.publication));
      assert.equal((await fixture.snapshot()).requests.length, 1, "remote creation happened before its response was lost");
      await fixture.arrange({ request: { state }, faults: {} });
      const recovered = await fixture.publisher.publishBatch(fixture.publication);
      assert.equal(recovered.pullRequestUrl, fixture.pullRequestUrl);
      assert.equal(recovered.reusedPullRequest, true);
      assert.equal((await fixture.snapshot()).requests.length, 1);
    });
  }

  for (const discovery of ["unavailable", "invalid-json"] as const) {
    await context.test(`PR discovery ${discovery} never permits creation`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ faults: { discovery } });
      await assert.rejects(fixture.publisher.publishBatch(fixture.publication));
      assert.equal((await fixture.snapshot()).requests.length, 0);
    });
  }

  await context.test("inspection preserves identities, policy checks, review decisions, and tri-state auto-merge", async (test) => {
    const fixture = await create(test);
    for (const autoMerge of [true, false, "unknown"] as const) {
      await fixture.arrange({ request: {
        autoMerge, reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING",
        checks: [{ name: "required-suite", status: "COMPLETED", conclusion: "FAILURE" }],
      } });
      const observed = await inspect(fixture);
      assert.equal(observed.state, "OPEN");
      assert.equal(observed.headRefOid, fixture.publication.batch.headSha);
      assert.equal(observed.baseRefOid, fixture.publication.batch.baseSha);
      assert.equal(observed.baseRefName, fixture.publication.batch.baseBranch);
      assert.equal(observed.reviewDecision, "CHANGES_REQUESTED");
      assert.equal(observed.mergeable, "CONFLICTING");
      assert.deepEqual(observed.checks.map(({ name, status, conclusion }) => ({ name, status, conclusion })), [
        { name: "required-suite", status: "COMPLETED", conclusion: "FAILURE" },
      ]);
      assert.ok(Object.hasOwn(observed, "autoMergeEnabled"));
      assert.equal(observed.autoMergeEnabled, autoMerge === "unknown" ? undefined : autoMerge);
    }
    await fixture.arrange({ request: { state: "MERGED", mergeCommitSha: fixture.alternateHead } });
    assert.equal((await inspect(fixture)).mergeCommitSha, fixture.alternateHead);
  });

  for (const inspection of ["head-changes-between-reads", "missing-head"] as const) {
    await context.test(`inspection fails closed for ${inspection}`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ request: {}, faults: { inspection } });
      await assert.rejects(inspect(fixture));
    });
  }

  await context.test("enable accepts the expected head and recovers its lost accepted response", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: {} });
    assert.equal(await enable(fixture), true);
    assert.deepEqual((await fixture.snapshot()).acceptedMergeHeads, [fixture.publication.batch.headSha]);
    await fixture.arrange({ request: { autoMerge: false }, faults: { enable: "response-lost" } });
    assert.equal(await enable(fixture), true);
    assert.equal((await fixture.snapshot()).requests[0]!.autoMerge, true);
  });

  for (const autoMerge of [false, true] as const) {
    await context.test(`expected-head guard rejects another head even when its queue is ${autoMerge ? "enabled" : "disabled"}`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ request: { headSha: fixture.alternateHead, autoMerge, mergeState: "CLEAN" } });
      await notAccepted(enable(fixture));
      const remote = await fixture.snapshot();
      assert.deepEqual(remote.acceptedMergeHeads, []);
      assert.equal(remote.requests[0]!.state, "OPEN");
    });
  }

  for (const inspection of ["unavailable", "missing-head"] as const) {
    await context.test(`enable recovery cannot report acceptance when inspection is ${inspection}`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ request: { autoMerge: true }, faults: { enable: "rejected", inspection } });
      await assert.rejects(enable(fixture));
      assert.deepEqual((await fixture.snapshot()).acceptedMergeHeads, []);
    });
  }

  await context.test("already-merged enable recovery still requires the expected head", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: { state: "MERGED" } });
    assert.equal(await enable(fixture), true);
    await fixture.arrange({ request: { headSha: fixture.alternateHead } });
    await notAccepted(enable(fixture));
    assert.deepEqual((await fixture.snapshot()).acceptedMergeHeads, []);
  });

  await context.test("clean direct-merge fallback remains guarded by the expected head", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: { mergeState: "CLEAN" }, faults: { enable: "rejected" } });
    assert.equal(await enable(fixture), true);
    const remote = await fixture.snapshot();
    assert.equal(remote.requests[0]!.state, "MERGED");
    assert.deepEqual(remote.acceptedMergeHeads, [fixture.publication.batch.headSha]);
  });

  await context.test("direct-merge fallback refuses a head that moves after the clean observation", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: { mergeState: "CLEAN" }, faults: { enable: "rejected", directMerge: "head-changed" } });
    await notAccepted(enable(fixture));
    const remote = await fixture.snapshot();
    assert.equal(remote.requests[0]!.state, "OPEN");
    assert.deepEqual(remote.acceptedMergeHeads, []);
  });

  await context.test("disable succeeds only for a disabled queue or closed PR and returns false for merged", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: { autoMerge: true }, faults: { disable: "response-lost" } });
    assert.equal(await disable(fixture), true);
    assert.equal((await fixture.snapshot()).requests[0]!.autoMerge, false);
    for (const state of ["OPEN", "CLOSED", "MERGED"] as const) {
      await fixture.arrange({ request: { state, autoMerge: false }, faults: { disable: "rejected" } });
      assert.equal(await disable(fixture), state !== "MERGED");
    }
  });

  for (const autoMerge of [true, "unknown"] as const) {
    await context.test(`disable cannot turn ${autoMerge === true ? "enabled" : "unknown"} into confirmed disabled`, async (test) => {
      const fixture = await create(test);
      await fixture.arrange({ request: { autoMerge }, faults: { disable: "rejected" } });
      await assert.rejects(disable(fixture));
    });
  }

  await context.test("close retries require this operation's marker and distinguish unrelated closure", async (test) => {
    const fixture = await create(test);
    const close = (comment: string) => fixture.publisher.closePullRequest(fixture.publication.repo.root, fixture.pullRequestUrl, comment);
    const comment = "superseded <!-- merge-broker-refresh:contract-own -->";
    await fixture.arrange({ request: {}, faults: { close: "response-lost" } });
    assert.equal(await close(comment), true);
    assert.equal(await close(comment), true);
    assert.equal((await fixture.snapshot()).requests[0]!.comments.length, 1);
    await assert.rejects(close("superseded <!-- merge-broker-refresh:contract-other -->"));
    await fixture.arrange({ request: { state: "OPEN", comments: [] }, faults: { close: "rejected" } });
    assert.equal(await close(comment), false, "a confirmed non-close remains retryable");
  });

  await context.test("body replacement is repeatable and failures propagate", async (test) => {
    const fixture = await create(test);
    await fixture.arrange({ request: {} });
    const update = () => fixture.publisher.updatePullRequestBody(
      fixture.publication.repo.root, fixture.pullRequestUrl, fixture.publication.batch, fixture.publication.tasks,
    );
    await update();
    const body = (await fixture.snapshot()).requests[0]!.body;
    assert.match(body, new RegExp(fixture.publication.batch.id, "u"));
    assert.ok(body.includes(fixture.publication.tasks[0]!.title!));
    await update();
    assert.equal((await fixture.snapshot()).requests[0]!.body, body);
    await fixture.arrange({ faults: { body: "rejected" } });
    await assert.rejects(update());
    assert.equal((await fixture.snapshot()).requests[0]!.body, body);
  });
}
