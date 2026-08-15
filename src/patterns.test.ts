import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesPattern,
  patternSetsMayOverlap,
  patternsMayOverlap,
  unexpectedPaths,
} from "./patterns.js";

test("matches Git-style path globs", () => {
  assert.equal(matchesPattern("src/customers/view.ts", "src/customers/**"), true);
  assert.equal(matchesPattern("src/orders/view.ts", "src/customers/**"), false);
  assert.equal(matchesPattern(".github/workflows/ci.yml", "**/*.yml"), true);
});

test("reports files outside an expected task scope", () => {
  assert.deepEqual(
    unexpectedPaths(["src/a.ts", "test/a.test.ts", "package-lock.json"], ["src/**", "test/**"]),
    ["package-lock.json"],
  );
});

test("conservatively detects glob overlap without serializing unrelated literals", () => {
  assert.equal(patternsMayOverlap("src/a/**", "src/a/file.ts"), true);
  assert.equal(patternsMayOverlap("src/a/**", "src/b/**"), false);
  assert.equal(patternsMayOverlap("src/a/**", "package-lock.json"), false);
  assert.equal(patternSetsMayOverlap(["src/**"], ["src/api/**"]), true);
});

test("treats escaped Next.js dynamic route segments as literal paths", () => {
  const dynamicRoute = "src/app/crm-v2/jobs/\\[jobId\\]/page.tsx/**";
  const staticRoute = "src/app/crm-v2/jobs/new/page.tsx/**";

  assert.equal(
    matchesPattern(
      "src/app/crm-v2/jobs/[jobId]/page.tsx/child",
      dynamicRoute,
    ),
    true,
  );
  assert.equal(patternsMayOverlap(dynamicRoute, staticRoute), false);
});
