import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverHealthSummary,
  renderHealthSummary,
  shouldSendHealthSummary,
  type HealthSummaryInput,
} from "../src/health-summary.ts";

function input(overrides: Partial<HealthSummaryInput> = {}): HealthSummaryInput {
  return {
    generatedAt: "2026-09-16T12:00:00.000Z",
    collectionIssue: null,
    latestRun: {
      startedAt: "2026-09-16T09:00:00.000Z",
      completedAt: "2026-09-16T09:05:00.000Z",
      durationMs: 300_000,
      status: "PARTIAL",
      configuredTargets: 22,
      requiredTargets: 28,
      unsupportedTargets: ["Waived Company"],
    },
    sourceHealth: [{
      sourceKey: "source-a",
      status: "FAILING",
      lastCount: 12,
      lastAttemptAt: "2026-09-16T09:05:00.000Z",
      lastVerifiedAt: "2026-09-16T06:05:00.000Z",
      lastErrorCategory: "HTTP_STATUS",
      circuitOpen: true,
    }],
    localRemainingQuota: 8,
    providerRemainingQuota: 49,
    ...overrides,
  };
}

test("sends only for stale collection, failing or stale sources, or open circuits", () => {
  assert.equal(shouldSendHealthSummary(input()), true);
  assert.equal(shouldSendHealthSummary(input({
    collectionIssue: "WATCHDOG_COLLECTION_STALE",
    sourceHealth: [{ ...input().sourceHealth[0], status: "HEALTHY", circuitOpen: false }],
  })), true);
  assert.equal(shouldSendHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], status: "HEALTHY", circuitOpen: true }],
  })), true);
  assert.equal(shouldSendHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], status: "DISABLED", circuitOpen: false }],
  })), false);
  assert.equal(shouldSendHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], status: "HEALTHY", circuitOpen: false }],
  })), false);
});

test("renders bounded source, run, coverage, circuit, and remaining quota details", () => {
  const rendered = renderHealthSummary(input());
  assert.match(rendered.subject, /PARTIAL/);
  assert.match(rendered.plainTextBody, /duration 300000 ms/);
  assert.match(rendered.plainTextBody, /targets 22\/28/);
  assert.match(rendered.plainTextBody, /degraded pilot/);
  assert.match(rendered.plainTextBody, /count=12/);
  assert.match(rendered.plainTextBody, /last_success=2026-09-16T06:05:00.000Z/);
  assert.match(rendered.plainTextBody, /error=HTTP_STATUS/);
  assert.match(rendered.plainTextBody, /circuit=OPEN/);
  assert.match(rendered.plainTextBody, /Remaining recipient quota: 8/);
});

test("escapes source-controlled HTML and rejects healthy or corrupt reports", () => {
  const rendered = renderHealthSummary(input({
    latestRun: { ...input().latestRun!, unsupportedTargets: ["A & B"] },
  }));
  assert.match(rendered.htmlBody, /A &amp; B/);
  assert.doesNotMatch(rendered.htmlBody, /A & B/);
  assert.throws(() => renderHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], status: "HEALTHY", circuitOpen: false }],
  })), /NOT_REQUIRED/);
  assert.throws(() => renderHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], sourceKey: "unsafe\nsource" }],
  })), /SOURCE_KEY_INVALID/);
});

test("validates, reserves, and sends in order only for an eligible report", () => {
  const calls: string[] = [];
  assert.deepEqual(deliverHealthSummary(input(), {
    notificationsEnabled: () => true,
    reserveRecipient: () => {
      calls.push("reserve");
      return {
        recipient: "owner@example.com",
        localRemainingQuota: 7,
        providerRemainingQuota: 48,
      };
    },
    send: (recipient, summary) => {
      calls.push(`send:${recipient}`);
      assert.match(summary.plainTextBody, /Remaining recipient quota: 7/);
    },
  }), { status: "SENT" });
  assert.deepEqual(calls, ["reserve", "send:owner@example.com"]);

  calls.length = 0;
  assert.deepEqual(deliverHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], status: "HEALTHY", circuitOpen: false }],
  }), {
    notificationsEnabled: () => true,
    reserveRecipient: () => {
      calls.push("reserve");
      throw new Error("unexpected");
    },
    send: () => calls.push("send"),
  }), { status: "NOT_REQUIRED" });
  assert.deepEqual(calls, []);
});

test("disabled or invalid health reports cannot consume quota", () => {
  let reservations = 0;
  const dependencies = {
    notificationsEnabled: () => false,
    reserveRecipient: () => {
      reservations += 1;
      throw new Error("unexpected");
    },
    send: () => undefined,
  };
  assert.deepEqual(deliverHealthSummary(input(), dependencies), { status: "DISABLED" });
  assert.equal(reservations, 0);

  assert.throws(() => deliverHealthSummary(input({
    sourceHealth: [{ ...input().sourceHealth[0], sourceKey: "unsafe\nsource" }],
  }), { ...dependencies, notificationsEnabled: () => true }), /SOURCE_KEY_INVALID/);
  assert.equal(reservations, 0);
});