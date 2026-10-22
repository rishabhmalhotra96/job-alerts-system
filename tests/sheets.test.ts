import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceMissingJob,
  advanceSourceFailure,
  escapeSheetCell,
  shouldRetainJob,
  validateLatestCompletedRun,
} from "../src/sheets.ts";

test("neutralizes spreadsheet formula prefixes", () => {
  assert.equal(escapeSheetCell("=IMPORTXML(\"https://attacker.example\")"), "'=IMPORTXML(\"https://attacker.example\")");
  assert.equal(escapeSheetCell("+1+1"), "'+1+1");
  assert.equal(escapeSheetCell("-2+3"), "'-2+3");
  assert.equal(escapeSheetCell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(escapeSheetCell("Senior Data Scientist"), "Senior Data Scientist");
});

test("closes a job only after three validated misses spanning 24 hours", () => {
  const first = advanceMissingJob("2026-09-15T09:00:00Z", {
    missingRunCount: 0,
    closedAt: "",
  }, "2026-09-15T12:00:00Z");
  const second = advanceMissingJob("2026-09-15T09:00:00Z", first, "2026-09-15T18:00:00Z");
  const thirdTooSoon = advanceMissingJob(
    "2026-09-15T09:00:00Z",
    second,
    "2026-09-16T08:59:59Z",
  );
  assert.deepEqual(thirdTooSoon, { missingRunCount: 3, closedAt: "" });

  const fourth = advanceMissingJob(
    "2026-09-15T09:00:00Z",
    thirdTooSoon,
    "2026-09-16T09:00:00Z",
  );
  assert.deepEqual(fourth, {
    missingRunCount: 4,
    closedAt: "2026-09-16T09:00:00Z",
  });
});

test("retains active and recent closed jobs but prunes after 90 days", () => {
  assert.equal(shouldRetainJob("", "2026-09-16T00:00:00Z"), true);
  assert.equal(
    shouldRetainJob("2026-06-18T00:00:00Z", "2026-09-16T00:00:00Z"),
    true,
  );
  assert.equal(
    shouldRetainJob("2026-06-17T23:59:59Z", "2026-09-16T00:00:00Z"),
    false,
  );
  assert.equal(shouldRetainJob("invalid", "2026-09-16T00:00:00Z"), true);
});

test("opens a circuit after three failures and restarts cooldown after a failed probe", () => {
  const secondFailure = {
    consecutiveFailures: 2,
    circuitOpenedAt: "",
  };
  assert.deepEqual(advanceSourceFailure(
    secondFailure,
    "FAILED",
    false,
    "2026-09-16T00:00:00Z",
  ), {
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00Z",
  });
  assert.deepEqual(advanceSourceFailure({
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00Z",
  }, "FAILED", false, "2026-09-16T12:00:00Z"), {
    consecutiveFailures: 4,
    circuitOpenedAt: "2026-09-16T12:00:00Z",
  });
  assert.deepEqual(advanceSourceFailure({
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00Z",
  }, "FAILED", true, "2026-09-16T03:00:00Z"), {
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00Z",
  });
  assert.deepEqual(advanceSourceFailure({
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00Z",
  }, "PARTIAL", false, "2026-09-16T12:00:00Z"), {
    consecutiveFailures: 0,
    circuitOpenedAt: "",
  });
});

test("watchdog accepts recent runs and rejects missing, stale, or future timestamps", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  assert.equal(
    validateLatestCompletedRun("2026-09-16T06:00:00Z", now),
    "2026-09-16T06:00:00Z",
  );
  assert.throws(() => validateLatestCompletedRun("", now), /WATCHDOG_NO_COMPLETED_RUN/);
  assert.throws(
    () => validateLatestCompletedRun("2026-09-16T05:59:59Z", now),
    /WATCHDOG_COLLECTION_STALE/,
  );
  assert.throws(
    () => validateLatestCompletedRun("2026-09-16T12:00:01Z", now),
    /WATCHDOG_COLLECTION_STALE/,
  );
});