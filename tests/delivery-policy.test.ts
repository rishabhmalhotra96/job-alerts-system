import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyDailySendQuota,
  normalizeEffectiveOwnerEmail,
  ownerFingerprintMaterial,
  requireManualInvocation,
  reserveDailyRecipientSend,
  validateDailySendQuota,
} from "../src/delivery-policy.ts";

test("accepts a normalized effective owner but never embeds it outside fingerprint material", () => {
  assert.equal(normalizeEffectiveOwnerEmail("Owner.Example+alerts@gmail.com"), "owner.example+alerts@gmail.com");
  assert.equal(
    ownerFingerprintMaterial("Owner.Example+alerts@gmail.com", "script_ID-1"),
    "owner-v1\u0000script_ID-1\u0000owner.example+alerts@gmail.com",
  );
});

test("rejects blank, malformed, non-ASCII, and invalid script identities", () => {
  for (const email of ["", "owner", "owner@example", "owner @example.com", "ownér@example.com"]) {
    assert.throws(() => normalizeEffectiveOwnerEmail(email), /OWNER_IDENTITY_UNAVAILABLE/);
  }
  assert.throws(
    () => ownerFingerprintMaterial("owner@example.com", "unsafe script id"),
    /SCRIPT_ID_INVALID/,
  );
});

test("notification setup rejects trigger event objects", () => {
  assert.doesNotThrow(() => requireManualInvocation(undefined));
  assert.throws(() => requireManualInvocation({ triggerUid: "123" }), /MANUAL_ONLY/);
  assert.throws(() => requireManualInvocation(null), /MANUAL_ONLY/);
});

test("reserves at most eight digests and keeps one health send available", () => {
  let quota = emptyDailySendQuota("2026-09-16");
  for (let index = 0; index < 8; index += 1) {
    quota = reserveDailyRecipientSend(quota, "2026-09-16", "DIGEST", 100 - index);
  }
  assert.deepEqual(quota, { day: "2026-09-16", digestSends: 8, healthSends: 0 });
  assert.throws(
    () => reserveDailyRecipientSend(quota, "2026-09-16", "DIGEST", 92),
    /DIGEST_CAP_REACHED/,
  );
  quota = reserveDailyRecipientSend(quota, "2026-09-16", "HEALTH", 92);
  assert.equal(quota.digestSends + quota.healthSends, 9);
  assert.throws(
    () => reserveDailyRecipientSend(quota, "2026-09-16", "HEALTH", 91),
    /DAILY_CAP_REACHED/,
  );
});

test("resets only on a later UTC day and rejects clock rollback or provider exhaustion", () => {
  const previous = { day: "2026-09-16", digestSends: 8, healthSends: 1 };
  assert.deepEqual(
    reserveDailyRecipientSend(previous, "2026-09-17", "DIGEST", 100),
    { day: "2026-09-17", digestSends: 1, healthSends: 0 },
  );
  assert.throws(
    () => reserveDailyRecipientSend(previous, "2026-09-15", "DIGEST", 100),
    /CLOCK_ROLLBACK/,
  );
  assert.throws(
    () => reserveDailyRecipientSend(null, "2026-09-16", "DIGEST", 0),
    /PROVIDER_QUOTA_EXHAUSTED/,
  );
});

test("rejects corrupted or over-cap persisted quota state", () => {
  for (const value of [
    null,
    { day: "2026-09-16", digestSends: 9, healthSends: 0 },
    { day: "2026-09-16", digestSends: 7, healthSends: 2 },
    { day: "not-a-day", digestSends: 0, healthSends: 0 },
    { day: "2026-09-16", digestSends: "1", healthSends: 0 },
  ]) {
    assert.throws(() => validateDailySendQuota(value), /QUOTA_STATE_INVALID/);
  }
});