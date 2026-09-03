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
