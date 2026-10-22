export const ACCEPTANCE_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;
export const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;
export const EXPECTED_COLLECTION_INTERVAL_MS = 2 * 60 * 60 * 1_000;
export const MINIMUM_ROLLING_24_HOUR_RUNS = 11;
export const MAX_ACCEPTANCE_RUNTIME_MS = 6 * 60 * 1_000;
export const MAX_ROLLOUT_P95_RUNTIME_MS = Math.floor(4.5 * 60 * 1_000 * 0.7);
export const MAX_ROLLOUT_P95_REQUEST_ATTEMPTS = Math.floor(500 * 0.7);
export const MAX_DAILY_URL_FETCH_CALLS = 20_000;

export interface AcceptanceSourceIssue {
  sourceKey: string;
  status: "PARTIAL" | "FAILED";
  warnings: string[];
}

export interface AcceptanceRunEvidence {
  startedAt: string;
  completedAt: string;
  status: "FULL_SUCCESS" | "PARTIAL" | "FAILED";
  configuredTargets: number;
  requiredTargets: number;
  unsupportedTargets: string[];
  requestAttempts: number;
  responseBytes: number;
  initializedSources: number;
  newCandidates: number;
  sourceIssues: AcceptanceSourceIssue[];
}

export interface AcceptanceSourceHealth {
  sourceKey: string;
  status: "HEALTHY" | "FAILING" | "STALE" | "DISABLED";
  initialized: boolean;
  circuitOpen: boolean;
}

export interface AcceptanceReport {
  label: "DEGRADED_PILOT";
  startedAt: string;
  evaluatedAt: string;
  earliestCompletionAt: string;
  elapsedDays: number;
  observationWindowComplete: boolean;
  baselineInitialized: boolean;
  coverageStable: boolean;
  runCount: number;
  nonFailedRunCount: number;
  failedRunCount: number;
  minimumRolling24HourNonFailedRuns: number;
  rolling24HourObjectiveMet: boolean;
  averageSchedulerJitterMs: number;
  maximumSchedulerJitterMs: number;
  averageRuntimeMs: number;
  maximumRuntimeMs: number;
  p95RuntimeMs: number;
  totalRequestAttempts: number;
  maximumRequestAttempts: number;
  p95RequestAttempts: number;
  totalResponseBytes: number;
  maximumResponseBytes: number;
  p95ResponseBytes: number;
  maximumProjectedDailyRequestAttempts: number;
  fetchQuotaProjectionWithinCap: boolean;
  rolloutCapacityGateMet: boolean;
  sourceIssueCount: number;
  sourceIssueSummary: Array<AcceptanceSourceIssue & { count: number }>;
  openCircuitSources: string[];
  unhealthySources: string[];
  projectedDigestSends: number;
  projectedHealthSends: number;
  maximumProjectedDailyRecipientSends: number;
  quotaProjectionWithinCap: boolean;
  passed: boolean;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function utcDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function minimumRollingRunCount(
  runs: readonly AcceptanceRunEvidence[],
  startedAtMs: number,
  evaluatedAtMs: number,
): number {
  if (evaluatedAtMs < startedAtMs + ROLLING_DAY_MS) {
    return 0;
  }
  const nonFailedTimes = runs
    .filter((run) => run.status !== "FAILED")
    .map((run) => Date.parse(run.completedAt));
  const boundaries = [
    startedAtMs + ROLLING_DAY_MS,
    ...nonFailedTimes
      .map((completedAt) => completedAt + ROLLING_DAY_MS)
      .filter((boundary) => boundary >= startedAtMs + ROLLING_DAY_MS && boundary <= evaluatedAtMs),
    evaluatedAtMs,
  ];
  return Math.min(...boundaries.map((boundary) => nonFailedTimes.filter((completedAt) =>
    completedAt > boundary - ROLLING_DAY_MS && completedAt <= boundary).length));
}

export function evaluateAcceptanceWindow(input: {
  startedAt: string;
  evaluatedAt: string;
  runs: readonly AcceptanceRunEvidence[];
  sourceHealth: readonly AcceptanceSourceHealth[];
  expectedSourceCount: number;
  expectedConfiguredTargets: number;
  expectedRequiredTargets: number;
  expectedUnsupportedTargets: readonly string[];
  maximumDailyRecipientSends: number;
}): AcceptanceReport {
  const startedAtMs = Date.parse(input.startedAt);
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(evaluatedAtMs) || evaluatedAtMs < startedAtMs) {
    throw new Error("ACCEPTANCE_WINDOW_INVALID");
  }
  const earliestCompletionAt = new Date(startedAtMs + ACCEPTANCE_WINDOW_MS).toISOString();
  const runs = [...input.runs]
    .filter((run) => Date.parse(run.completedAt) >= startedAtMs && Date.parse(run.completedAt) <= evaluatedAtMs)
    .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const unsupported = [...input.expectedUnsupportedTargets].sort();
  const coverageStable = runs.length > 0 && runs.every((run) =>
    run.configuredTargets === input.expectedConfiguredTargets
    && run.requiredTargets === input.expectedRequiredTargets
    && JSON.stringify([...run.unsupportedTargets].sort()) === JSON.stringify(unsupported));
  const baselineInitialized = input.sourceHealth.length === input.expectedSourceCount
    && input.sourceHealth.every((source) => source.initialized);
  const nonFailedRuns = runs.filter((run) => run.status !== "FAILED");
  const failedRuns = runs.filter((run) => run.status === "FAILED");
  const minimumRolling24HourNonFailedRuns = minimumRollingRunCount(
    runs,
    startedAtMs,
    evaluatedAtMs,
  );
  const startedTimes = nonFailedRuns.map((run) => Date.parse(run.startedAt));
  const schedulerJitters = startedTimes.slice(1).map((startedAt, index) =>
    Math.abs(startedAt - startedTimes[index] - EXPECTED_COLLECTION_INTERVAL_MS));
  const runtimes = runs.map((run) => Date.parse(run.completedAt) - Date.parse(run.startedAt));
  const sourceIssueCount = runs.reduce((total, run) => total + run.sourceIssues.length, 0);
  const sourceIssueCounts = new Map<string, AcceptanceSourceIssue & { count: number }>();
  for (const issue of runs.flatMap((run) => run.sourceIssues)) {
    const key = JSON.stringify([issue.sourceKey, issue.status, issue.warnings]);
    const previous = sourceIssueCounts.get(key);
    sourceIssueCounts.set(key, { ...issue, count: (previous?.count ?? 0) + 1 });
  }
  const sourceIssueSummary = [...sourceIssueCounts.values()].sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey) || left.status.localeCompare(right.status));
  const unhealthySources = input.sourceHealth
    .filter((source) => source.status !== "HEALTHY")
    .map((source) => source.sourceKey)
    .sort();
  const openCircuitSources = input.sourceHealth
    .filter((source) => source.circuitOpen)
    .map((source) => source.sourceKey)
    .sort();
  const projectedByDay = new Map<string, {
    digest: number;
    health: boolean;
    requestAttempts: number;
  }>();
  for (const run of runs) {
    const day = utcDay(run.completedAt);
    const projected = projectedByDay.get(day) ?? {
      digest: 0,
      health: false,
      requestAttempts: 0,
    };
    projected.digest += run.newCandidates > 0 ? 1 : 0;
    projected.health = projected.health || run.sourceIssues.length > 0;
    projected.requestAttempts += run.requestAttempts;
    projectedByDay.set(day, projected);
  }
  const projectedDigestSends = [...projectedByDay.values()]
    .reduce((total, projected) => total + projected.digest, 0);
  const projectedHealthSends = [...projectedByDay.values()]
    .filter((projected) => projected.health).length;
  const maximumProjectedDailyRecipientSends = Math.max(
    0,
    ...[...projectedByDay.values()].map((projected) => projected.digest + (projected.health ? 1 : 0)),
  );
  const observationWindowComplete = evaluatedAtMs >= startedAtMs + ACCEPTANCE_WINDOW_MS;
  const rolling24HourObjectiveMet = observationWindowComplete
    && minimumRolling24HourNonFailedRuns >= MINIMUM_ROLLING_24_HOUR_RUNS;
  const quotaProjectionWithinCap = maximumProjectedDailyRecipientSends
    <= input.maximumDailyRecipientSends;
  const maximumRuntimeMs = Math.max(0, ...runtimes);
  const maximumRequestAttempts = Math.max(0, ...runs.map((run) => run.requestAttempts));
  const responseBytes = runs.map((run) => run.responseBytes);
  const p95RuntimeMs = percentile95(runtimes);
  const p95RequestAttempts = percentile95(runs.map((run) => run.requestAttempts));
  const p95ResponseBytes = percentile95(responseBytes);
  const maximumProjectedDailyRequestAttempts = Math.max(
    0,
    ...[...projectedByDay.values()].map((projected) => projected.requestAttempts),
  );
  const fetchQuotaProjectionWithinCap = maximumProjectedDailyRequestAttempts
    <= MAX_DAILY_URL_FETCH_CALLS;
  const rolloutCapacityGateMet = p95RuntimeMs <= MAX_ROLLOUT_P95_RUNTIME_MS
    && p95RequestAttempts <= MAX_ROLLOUT_P95_REQUEST_ATTEMPTS;
  const passed = observationWindowComplete
    && baselineInitialized
    && coverageStable
    && rolling24HourObjectiveMet
    && maximumRuntimeMs <= MAX_ACCEPTANCE_RUNTIME_MS
    && maximumRequestAttempts <= 500
    && rolloutCapacityGateMet
    && fetchQuotaProjectionWithinCap
    && quotaProjectionWithinCap
    && failedRuns.length === 0
    && sourceIssueCount === 0
    && unhealthySources.length === 0
    && openCircuitSources.length === 0;
  return {
    label: "DEGRADED_PILOT",
    startedAt: input.startedAt,
    evaluatedAt: input.evaluatedAt,
    earliestCompletionAt,
    elapsedDays: Math.floor((evaluatedAtMs - startedAtMs) / ROLLING_DAY_MS),
    observationWindowComplete,
    baselineInitialized,
    coverageStable,
    runCount: runs.length,
    nonFailedRunCount: nonFailedRuns.length,
    failedRunCount: failedRuns.length,
    minimumRolling24HourNonFailedRuns,
    rolling24HourObjectiveMet,
    averageSchedulerJitterMs: mean(schedulerJitters),
    maximumSchedulerJitterMs: Math.max(0, ...schedulerJitters),
    averageRuntimeMs: mean(runtimes),
    maximumRuntimeMs,
    p95RuntimeMs,
    totalRequestAttempts: runs.reduce((total, run) => total + run.requestAttempts, 0),
    maximumRequestAttempts,
    p95RequestAttempts,
    totalResponseBytes: responseBytes.reduce((total, bytes) => total + bytes, 0),
    maximumResponseBytes: Math.max(0, ...responseBytes),
    p95ResponseBytes,
    maximumProjectedDailyRequestAttempts,
    fetchQuotaProjectionWithinCap,
    rolloutCapacityGateMet,
    sourceIssueCount,
    sourceIssueSummary,
    openCircuitSources,
    unhealthySources,
    projectedDigestSends,
    projectedHealthSends,
    maximumProjectedDailyRecipientSends,
    quotaProjectionWithinCap,
    passed,
  };
}