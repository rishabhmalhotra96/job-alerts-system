import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAcceptanceWindow,
  type AcceptanceRunEvidence,
} from "../src/acceptance.ts";

const STARTED_AT = "2026-09-17T00:00:00.000Z";

function healthyRun(index: number): AcceptanceRunEvidence {
  const startedAt = new Date(Date.parse(STARTED_AT) + index * 2 * 60 * 60 * 1_000);
  return {
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + 3 * 60 * 1_000).toISOString(),
    status: "FULL_SUCCESS",
    configuredTargets: 2,
    requiredTargets: 3,
    unsupportedTargets: ["Waived"],
    requestAttempts: 20,
    responseBytes: 2_000_000,
    initializedSources: 0,
    newCandidates: index % 12 === 0 ? 1 : 0,
    sourceIssues: [],
  };
}

function report(runs: AcceptanceRunEvidence[], evaluatedAt: string) {
  return evaluateAcceptanceWindow({
    startedAt: STARTED_AT,
    evaluatedAt,
    runs,
    sourceHealth: [
      { sourceKey: "one", status: "HEALTHY", initialized: true, circuitOpen: false },
      { sourceKey: "two", status: "HEALTHY", initialized: true, circuitOpen: false },
    ],
    expectedSourceCount: 2,
    expectedConfiguredTargets: 2,
    expectedRequiredTargets: 3,
    expectedUnsupportedTargets: ["Waived"],
    maximumDailyRecipientSends: 9,
  });
}

test("three complete days at a twelve-per-day cadence satisfy aggregate acceptance", () => {
  const runs = Array.from({ length: 37 }, (_, index) => healthyRun(index));
  const result = report(runs, "2026-09-20T00:05:00.000Z");

  assert.equal(result.observationWindowComplete, true);
  assert.equal(result.minimumRolling24HourNonFailedRuns, 12);
  assert.equal(result.rolling24HourObjectiveMet, true);
  assert.equal(result.coverageStable, true);
  assert.equal(result.maximumRuntimeMs, 180_000);
  assert.equal(result.p95RuntimeMs, 180_000);
  assert.equal(result.maximumRequestAttempts, 20);
  assert.equal(result.p95RequestAttempts, 20);
  assert.equal(result.p95ResponseBytes, 2_000_000);
  assert.equal(result.maximumProjectedDailyRequestAttempts, 240);
  assert.equal(result.rolloutCapacityGateMet, true);
  assert.equal(result.maximumProjectedDailyRecipientSends, 1);
  assert.equal(result.passed, true);
});

test("one missed two-hour run still satisfies the rolling cadence objective", () => {
  const runs = Array.from({ length: 37 }, (_, index) => healthyRun(index))
    .filter((_run, index) => index !== 20);
  const result = report(runs, "2026-09-20T00:05:00.000Z");

  assert.equal(result.minimumRolling24HourNonFailedRuns, 11);
  assert.equal(result.rolling24HourObjectiveMet, true);
  assert.equal(result.passed, true);
});

test("elapsed time and every rolling-day cadence boundary fail closed", () => {
  const fullCadence = Array.from({ length: 37 }, (_, index) => healthyRun(index));
  assert.equal(report(fullCadence, "2026-09-19T23:59:59.999Z").passed, false);

  const cadenceGap = fullCadence.filter((_run, index) => index !== 30 && index !== 31);
  const result = report(cadenceGap, "2026-09-20T00:05:00.000Z");
  assert.equal(result.minimumRolling24HourNonFailedRuns, 10);
  assert.equal(result.rolling24HourObjectiveMet, false);
  assert.equal(result.passed, false);

  const weakFirstDay = fullCadence.filter((_run, index) => index !== 1 && index !== 2);
  weakFirstDay.push(healthyRun(37), healthyRun(38));
  const firstDayResult = report(weakFirstDay, "2026-09-20T08:05:00.000Z");
  assert.equal(firstDayResult.minimumRolling24HourNonFailedRuns, 10);
  assert.equal(firstDayResult.passed, false);
});

test("coverage, runtime, and projected recipient caps are launch blockers", () => {
  const runs = Array.from({ length: 37 }, (_, index) => ({
    ...healthyRun(index),
    newCandidates: 1,
  }));
  runs.push(
    {
      ...healthyRun(0),
      startedAt: "2026-09-17T01:00:00.000Z",
      completedAt: "2026-09-17T01:05:00.000Z",
      newCandidates: 1,
    },
    {
      ...healthyRun(0),
      startedAt: "2026-09-17T02:00:00.000Z",
      completedAt: "2026-09-17T02:05:00.000Z",
      newCandidates: 1,
    },
  );
  runs[0] = { ...runs[0], unsupportedTargets: ["Drifted"] };
  runs[1] = {
    ...runs[1],
    completedAt: new Date(Date.parse(runs[1].startedAt) + 361_000).toISOString(),
  };
  const result = report(runs, "2026-09-20T00:05:00.000Z");

  assert.equal(result.coverageStable, false);
  assert.equal(result.maximumRuntimeMs, 361_000);
  assert.equal(result.maximumProjectedDailyRecipientSends, 14);
  assert.equal(result.quotaProjectionWithinCap, false);
  assert.equal(result.passed, false);
});

test("partial runs remain non-failed and project one daily health recipient", () => {
  const runs = Array.from({ length: 37 }, (_, index) => healthyRun(index));
  runs[10] = {
    ...runs[10],
    status: "PARTIAL",
    sourceIssues: [{ sourceKey: "two", status: "PARTIAL", warnings: ["HTTP_STATUS"] }],
  };
  const result = report(runs, "2026-09-20T00:05:00.000Z");

  assert.equal(result.nonFailedRunCount, 37);
  assert.equal(result.sourceIssueCount, 1);
  assert.deepEqual(result.sourceIssueSummary, [{
    sourceKey: "two",
    status: "PARTIAL",
    warnings: ["HTTP_STATUS"],
    count: 1,
  }]);
  assert.equal(result.projectedHealthSends, 1);
  assert.equal(result.maximumProjectedDailyRecipientSends, 2);
  assert.equal(result.passed, false);
});

test("p95 request and runtime utilization above seventy percent blocks rollout", () => {
  const runs = Array.from({ length: 37 }, (_, index) => healthyRun(index));
  for (let index = 0; index < 4; index += 1) {
    runs[index] = {
      ...runs[index],
      completedAt: new Date(Date.parse(runs[index].startedAt) + 190_000).toISOString(),
      requestAttempts: 351,
    };
  }
  const result = report(runs, "2026-09-20T00:05:00.000Z");

  assert.equal(result.p95RuntimeMs, 190_000);
  assert.equal(result.p95RequestAttempts, 351);
  assert.equal(result.rolloutCapacityGateMet, false);
  assert.equal(result.passed, false);
});