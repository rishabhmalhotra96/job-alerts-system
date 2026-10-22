import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverOldestDigest,
  sendDigestWithMailApp,
  type DigestDeliveryDependencies,
} from "../src/delivery.ts";
import type { DigestInput } from "../src/digest.ts";

const input: DigestInput = {
  batchId: "notification:shadow:2026-09-16T09:00:00.000Z",
  createdAt: "2026-09-16T09:00:00.000Z",
  jobs: [{
    sourceKey: "example",
    sourceJobId: "1",
    title: "Senior Machine Learning Engineer",
    company: "Example",
    location: "Berlin, Germany",
    workplaceType: "Hybrid",
    firstSeenAt: "2026-09-16T09:00:00.000Z",
    matchStatus: "STRONG",
    matchReasons: ["location:eligible"],
    sponsorshipSignal: "unknown",
    relocationSignal: "unknown",
    canonicalUrl: "https://jobs.example.com/1",
  }],
  sourceWarnings: [],
  reviewSheetUrl: "https://docs.google.com/spreadsheets/d/private_sheet_id/edit",
};

function dependencies(overrides: Partial<DigestDeliveryDependencies> = {}) {
  const calls: string[] = [];
  let timestampIndex = 0;
  const timestamps = [
    "2026-09-16T12:00:00.000Z",
    "2026-09-16T12:00:01.000Z",
    "2026-09-16T12:00:02.000Z",
  ];
  const value: DigestDeliveryDependencies = {
    notificationsEnabled: () => true,
    now: () => timestamps[timestampIndex++] ?? timestamps.at(-1)!,
    prepareOldest: (at) => {
      calls.push(`prepare:${at}`);
      return { batchId: input.batchId, input };
    },
    reserveRecipient: (at) => {
      calls.push(`reserve:${at}`);
      return "owner@example.com";
    },
    send: (recipient, digest) => {
      calls.push(`send:${recipient}:${digest.jobCount}`);
    },
    markFailed: (batchId, at) => calls.push(`failed:${batchId}:${at}`),
    markSent: (batchId, at) => calls.push(`sent:${batchId}:${at}`),
    ...overrides,
  };
  return { calls, value };
}

test("disabled and empty delivery paths perform no send or quota reservation", () => {
  const disabled = dependencies({ notificationsEnabled: () => false });
  assert.deepEqual(deliverOldestDigest(disabled.value), { status: "DISABLED" });
  assert.deepEqual(disabled.calls, []);

  const empty = dependencies({
    prepareOldest: (at) => {
      empty.calls.push(`prepare:${at}`);
      return null;
    },
  });
  assert.deepEqual(deliverOldestDigest(empty.value), { status: "NO_PENDING_BATCH" });
  assert.deepEqual(empty.calls, ["prepare:2026-09-16T12:00:00.000Z"]);
});

test("reserves, sends, and only then marks the deterministic batch sent", () => {
  const delivery = dependencies();
  assert.deepEqual(deliverOldestDigest(delivery.value), {
    status: "SENT",
    batchId: input.batchId,
    jobCount: 1,
    overflowed: false,
  });
  assert.deepEqual(delivery.calls, [
    "prepare:2026-09-16T12:00:00.000Z",
    "reserve:2026-09-16T12:00:01.000Z",
    "send:owner@example.com:1",
    `sent:${input.batchId}:2026-09-16T12:00:02.000Z`,
  ]);
});

test("send or render failure returns the same batch to pending", () => {
  const delivery = dependencies({
    send: () => {
      throw new Error("provider details must not escape");
    },
  });
  assert.throws(() => deliverOldestDigest(delivery.value), /^Error: DIGEST_DELIVERY_FAILED$/);
  assert.equal(delivery.calls.at(-1), `failed:${input.batchId}:2026-09-16T12:00:02.000Z`);
  assert.equal(delivery.calls.some((call) => call.startsWith("sent:")), false);

  const invalid = dependencies({
    prepareOldest: () => ({
      batchId: input.batchId,
      input: { ...input, reviewSheetUrl: "https://attacker.example" },
    }),
  });
  assert.throws(() => deliverOldestDigest(invalid.value), /^Error: DIGEST_DELIVERY_FAILED$/);
  assert.equal(invalid.calls.some((call) => call.startsWith("reserve:")), false);
});

test("post-send state failure is unconfirmed and never rewritten as a send failure", () => {
  const delivery = dependencies({
    markSent: () => {
      throw new Error("sheet unavailable");
    },
  });
  assert.throws(
    () => deliverOldestDigest(delivery.value),
    /^Error: DIGEST_SENT_STATE_UNCONFIRMED$/,
  );
  assert.equal(delivery.calls.some((call) => call.startsWith("failed:")), false);
});

test("failed recovery remains visibly unresolved", () => {
  const delivery = dependencies({
    send: () => {
      throw new Error("send failed");
    },
    markFailed: () => {
      throw new Error("state failed");
    },
  });
  assert.throws(
    () => deliverOldestDigest(delivery.value),
    /^Error: DIGEST_DELIVERY_RECOVERY_FAILED$/,
  );
});

test("MailApp adapter sends one owner-addressed HTML and plain-text message", () => {
  const original = globalThis.MailApp;
  const messages: GoogleAppsScript.Mail.MailAdvancedParameters[] = [];
  globalThis.MailApp = {
    getRemainingDailyQuota: () => 100,
    sendEmail: (message: GoogleAppsScript.Mail.MailAdvancedParameters) => {
      messages.push(message);
    },
  } as GoogleAppsScript.Mail.MailApp;
  try {
    sendDigestWithMailApp("Owner@Example.com", {
      subject: "Bounded subject",
      plainTextBody: "Plain body",
      htmlBody: "<p>HTML body</p>",
      overflowed: false,
      jobCount: 1,
    });
    assert.deepEqual(messages, [{
      to: "owner@example.com",
      subject: "Bounded subject",
      body: "Plain body",
      htmlBody: "<p>HTML body</p>",
      name: "Job Alerts",
    }]);
  } finally {
    globalThis.MailApp = original;
  }
});