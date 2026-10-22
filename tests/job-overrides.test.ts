import assert from "node:assert/strict";
import test from "node:test";

import {
  applyJobOverride,
  jobOverrideKey,
  shouldNotifyRepost,
  validateJobOverride,
  type JobOverride,
} from "../src/job-overrides.ts";

const override: JobOverride = {
  sourceKey: "source-a",
  sourceJobId: "job-1",
  decision: "INCLUDE",
  actorFingerprint: "a".repeat(64),
  updatedAt: "2026-09-16T12:00:00.000Z",
};

test("a valid closed job becomes eligible immediately when it reappears", () => {
  const closedAt = "2026-08-01T12:00:00.000Z";
  assert.equal(shouldNotifyRepost(
    closedAt,
    new Date(Date.parse(closedAt) + 1).toISOString(),
  ), true);
  assert.equal(shouldNotifyRepost(closedAt, closedAt), true);
  assert.equal(shouldNotifyRepost("invalid", override.updatedAt), false);
  assert.equal(shouldNotifyRepost(override.updatedAt, "2026-09-15T12:00:00.000Z"), false);
});

test("validates stable identities, owner fingerprints, decisions, and timestamps", () => {
  assert.deepEqual(validateJobOverride(override), override);
  assert.equal(jobOverrideKey(override.sourceKey, override.sourceJobId), "source-a\u001fjob-1");
  for (const invalid of [
    { ...override, sourceJobId: "=unsafe" },
    { ...override, decision: "ALLOW" },
    { ...override, actorFingerprint: "owner@example.com" },
    { ...override, updatedAt: "not-a-time" },
  ]) {
    assert.throws(() => validateJobOverride(invalid), /JOB_OVERRIDE_INVALID/);
  }
});

test("exclude wins and include promotes only excluded matches to review", () => {
  assert.deepEqual(applyJobOverride({ status: "STRONG", reasons: ["match"] }, {
    ...override,
    decision: "EXCLUDE",
  }), { status: "EXCLUDED", reasons: ["manual:exclude"] });
  assert.deepEqual(applyJobOverride({ status: "EXCLUDED", reasons: ["rule"] }, override), {
    status: "REVIEW",
    reasons: ["manual:include"],
  });
  assert.deepEqual(applyJobOverride({ status: "STRONG", reasons: ["match"] }, override), {
    status: "STRONG",
    reasons: ["match", "manual:include"],
  });
});