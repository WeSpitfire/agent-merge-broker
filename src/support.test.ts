import assert from "node:assert/strict";
import test from "node:test";
import { createSupportBundle, sanitizeSupportData } from "./support.js";

test("support diagnostics redact paths, URLs, and secret-bearing fields", () => {
  const sanitized = sanitizeSupportData({
    repository: "/Users/dev/project",
    remote: { url: "https://github.com/owner/private" },
    message: "failed in /Users/dev/project/src/index.ts; see https://ci.example/run/4",
    leaseToken: "do-not-share",
    publicKeyId: "safe-fingerprint",
  }, { repositoryRoot: "/Users/dev/project", homeDirectory: "/Users/dev" });

  assert.deepEqual(sanitized, {
    repository: "<repository>",
    remote: { url: "<redacted-url>" },
    message: "failed in <repository>/src/index.ts; see <redacted-url>",
    leaseToken: "<redacted-secret>",
    publicKeyId: "safe-fingerprint",
  });
});

test("support bundle identifies its version and warns users to review it", () => {
  const bundle = createSupportBundle({
    brokerVersion: "1.2.3",
    repositoryRoot: "/repo",
    diagnostics: { repository: "/repo" },
    recentEvents: [],
    at: new Date("2026-09-03T12:00:00.000Z"),
    platform: { platform: "test", release: "1", architecture: "x64" },
  });
  assert.equal(bundle.version, 1);
  assert.equal(bundle.generatedAt, "2026-09-03T12:00:00.000Z");
  assert.match(bundle.redaction, /Review before sharing/u);
});

test("Gate support bundles omit operator abandonment prose while retaining machine diagnostics", () => {
  const operatorNote = "cancelled while rotating a credential: example-private-value";
  const bundle = createSupportBundle({
    brokerVersion: "0.13.0", repositoryRoot: "/repo",
    diagnostics: {
      repository: "/repo", operational: false,
      gate: { ready: false, errorCode: "GATE_AUTHORITY_REQUIRED", pending: ["submission-one"],
        authorityDigest: "safe-authority-fingerprint", policyDigest: "safe-policy-fingerprint" },
      abandoned: { status: "abandoned", abandonReason: operatorNote, error: operatorNote, errorCode: "SUBMISSION_ABANDONED" },
    },
    recentEvents: [
      { sequence: 1, at: "2026-09-06T12:00:00.000Z", event: "submission.abandoned", submissionId: "submission-one",
        details: { reason: operatorNote, errorCode: "SUBMISSION_ABANDONED" } },
      { sequence: 2, at: "2026-09-06T12:00:01.000Z", event: "batch.recovered", batchId: "batch-one",
        details: { reason: "abandoned integration transaction" } },
    ],
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes(operatorNote), false);
  assert.equal(serialized.includes("example-private-value"), false);
  assert.match(serialized, /redacted-operator-text/u);
  assert.match(serialized, /GATE_AUTHORITY_REQUIRED/u);
  assert.match(serialized, /SUBMISSION_ABANDONED/u);
  assert.match(serialized, /safe-authority-fingerprint/u);
  assert.match(serialized, /safe-policy-fingerprint/u);
  assert.match(serialized, /abandoned integration transaction/u);
});
