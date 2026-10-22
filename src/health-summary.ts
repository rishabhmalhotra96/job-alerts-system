import type { LatestCompletedRunHealth, SourceHealth } from "./sheets.ts";

export type CollectionHealthIssue =
  | "WATCHDOG_NO_COMPLETED_RUN"
  | "WATCHDOG_COLLECTION_STALE";

export interface HealthSummaryInput {
  generatedAt: string;
  collectionIssue: CollectionHealthIssue | null;
  latestRun: LatestCompletedRunHealth | null;
  sourceHealth: SourceHealth[];
  localRemainingQuota: number;
  providerRemainingQuota: number;
}

export interface RenderedHealthSummary {
  subject: string;
  plainTextBody: string;
  htmlBody: string;
}

export interface HealthSummaryReservation {
  recipient: string;
  localRemainingQuota: number;
  providerRemainingQuota: number;
}

export interface HealthSummaryDeliveryDependencies {
  notificationsEnabled: () => boolean;
  reserveRecipient: () => HealthSummaryReservation;
  send: (recipient: string, summary: RenderedHealthSummary) => void;
}

export type HealthSummaryDeliveryResult =
  | { status: "DISABLED" }
  | { status: "NOT_REQUIRED" }
  | { status: "SENT" };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bounded(value: string, field: string, maximum: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`HEALTH_${field}_INVALID`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  bounded(value, field, 40);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`HEALTH_${field}_INVALID`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`HEALTH_${field}_INVALID`);
  }
  return value;
}

function validateSourceHealth(source: SourceHealth): SourceHealth {
  bounded(source.sourceKey, "SOURCE_KEY", 200);
  if (!(["HEALTHY", "FAILING", "STALE", "DISABLED"] as const).includes(source.status)) {
    throw new Error("HEALTH_SOURCE_STATUS_INVALID");
  }
  if (source.lastCount !== null) {
    nonNegativeInteger(source.lastCount, "SOURCE_COUNT");
  }
  for (const [field, value] of [
    ["LAST_ATTEMPT", source.lastAttemptAt],
    ["LAST_SUCCESS", source.lastVerifiedAt],
  ] as const) {
    if (value !== null) {
      timestamp(value, field);
    }
  }
  if (source.lastErrorCategory !== null) {
    bounded(source.lastErrorCategory, "ERROR_CATEGORY", 100);
  }
  if (typeof source.circuitOpen !== "boolean") {
    throw new Error("HEALTH_CIRCUIT_STATE_INVALID");
  }
  return source;
}

function validateLatestRun(run: LatestCompletedRunHealth): LatestCompletedRunHealth {
  timestamp(run.startedAt, "RUN_STARTED_AT");
  timestamp(run.completedAt, "RUN_COMPLETED_AT");
  nonNegativeInteger(run.durationMs, "RUN_DURATION", 24 * 60 * 60 * 1_000);
  if (!(["FULL_SUCCESS", "PARTIAL", "FAILED"] as const).includes(run.status)) {
    throw new Error("HEALTH_RUN_STATUS_INVALID");
  }
  nonNegativeInteger(run.configuredTargets, "CONFIGURED_TARGETS", 1_000);
  nonNegativeInteger(run.requiredTargets, "REQUIRED_TARGETS", 1_000);
  if (!Array.isArray(run.unsupportedTargets) || run.unsupportedTargets.length > 100) {
    throw new Error("HEALTH_UNSUPPORTED_TARGETS_INVALID");
  }
  run.unsupportedTargets.forEach((company) => bounded(company, "UNSUPPORTED_TARGET", 100));
  return run;
}

export function shouldSendHealthSummary(input: HealthSummaryInput): boolean {
  return input.collectionIssue !== null
    || input.sourceHealth.some((source) =>
      source.status === "FAILING" || source.status === "STALE" || source.circuitOpen);
}

export function deliverHealthSummary(
  input: HealthSummaryInput,
  dependencies: HealthSummaryDeliveryDependencies,
): HealthSummaryDeliveryResult {
  if (!dependencies.notificationsEnabled()) {
    return { status: "DISABLED" };
  }
  if (!shouldSendHealthSummary(input)) {
    return { status: "NOT_REQUIRED" };
  }
  renderHealthSummary(input);
  const reservation = dependencies.reserveRecipient();
  const summary = renderHealthSummary({
    ...input,
    localRemainingQuota: reservation.localRemainingQuota,
    providerRemainingQuota: reservation.providerRemainingQuota,
  });
  dependencies.send(reservation.recipient, summary);
  return { status: "SENT" };
}

export function renderHealthSummary(input: HealthSummaryInput): RenderedHealthSummary {
  timestamp(input.generatedAt, "GENERATED_AT");
  if (input.collectionIssue !== null
    && !(["WATCHDOG_NO_COMPLETED_RUN", "WATCHDOG_COLLECTION_STALE"] as const)
      .includes(input.collectionIssue)) {
    throw new Error("HEALTH_COLLECTION_ISSUE_INVALID");
  }
  const run = input.latestRun === null ? null : validateLatestRun(input.latestRun);
  if (input.sourceHealth.length === 0 || input.sourceHealth.length > 100) {
    throw new Error("HEALTH_SOURCES_INVALID");
  }
  const sources = input.sourceHealth.map(validateSourceHealth);
  if (new Set(sources.map(({ sourceKey }) => sourceKey)).size !== sources.length) {
    throw new Error("HEALTH_SOURCE_DUPLICATE");
  }
  nonNegativeInteger(input.localRemainingQuota, "LOCAL_QUOTA", 9);
  nonNegativeInteger(input.providerRemainingQuota, "PROVIDER_QUOTA");
  if (!shouldSendHealthSummary(input)) {
    throw new Error("HEALTH_SUMMARY_NOT_REQUIRED");
  }
  const problematic = sources
    .filter((source) => source.status !== "HEALTHY" || source.circuitOpen)
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  const effectiveRemainingQuota = Math.min(
    input.localRemainingQuota,
    input.providerRemainingQuota,
  );
  const collectionStatus = input.collectionIssue ?? run?.status ?? "UNKNOWN";
  const runLine = run === null
    ? "Latest run: unavailable"
    : `Latest run: ${run.status} | ${run.completedAt} | duration ${run.durationMs} ms | targets ${run.configuredTargets}/${run.requiredTargets}`;
  const unsupported = run?.unsupportedTargets.length
    ? `Unsupported targets (degraded pilot): ${run.unsupportedTargets.join(", ")}`
    : "Unsupported targets: none";
  const sourceLines = problematic.map((source) => [
    `- ${source.sourceKey}: ${source.status}`,
    `count=${source.lastCount ?? "unknown"}`,
    `last_success=${source.lastVerifiedAt ?? "unknown"}`,
    `error=${source.lastErrorCategory ?? "none"}`,
    `circuit=${source.circuitOpen ? "OPEN" : "CLOSED"}`,
  ].join(" | "));
  const plainTextBody = [
    `Job alerts health: ${collectionStatus}`,
    runLine,
    unsupported,
    `Remaining recipient quota: ${effectiveRemainingQuota} (local ${input.localRemainingQuota}, provider ${input.providerRemainingQuota})`,
    "Sources requiring attention:",
    ...sourceLines,
  ].join("\n");
  const htmlRows = problematic.map((source) => `<tr><td>${escapeHtml(source.sourceKey)}</td><td>${escapeHtml(source.status)}</td><td>${source.lastCount ?? "unknown"}</td><td>${escapeHtml(source.lastVerifiedAt ?? "unknown")}</td><td>${escapeHtml(source.lastErrorCategory ?? "none")}</td><td>${source.circuitOpen ? "OPEN" : "CLOSED"}</td></tr>`).join("");
  const htmlBody = [
    "<!doctype html><html><body>",
    `<h2>Job alerts health: ${escapeHtml(collectionStatus)}</h2>`,
    `<p>${escapeHtml(runLine)}<br>${escapeHtml(unsupported)}<br>Remaining recipient quota: ${effectiveRemainingQuota} (local ${input.localRemainingQuota}, provider ${input.providerRemainingQuota})</p>`,
    "<table><thead><tr><th>Source</th><th>Status</th><th>Count</th><th>Last success</th><th>Error</th><th>Circuit</th></tr></thead>",
    `<tbody>${htmlRows}</tbody></table></body></html>`,
  ].join("");
  if (htmlBody.length > 50_000 || plainTextBody.length > 50_000) {
    throw new Error("HEALTH_SUMMARY_TOO_LARGE");
  }
  return {
    subject: `Job alerts health - ${collectionStatus} - ${input.generatedAt}`,
    plainTextBody,
    htmlBody,
  };
}