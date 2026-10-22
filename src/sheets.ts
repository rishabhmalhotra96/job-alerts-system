import type {
  ShadowCollection,
  ShadowReport,
  SourceIntegrityState,
} from "./collector.ts";
import type { AcceptanceRunEvidence, AcceptanceSourceIssue } from "./acceptance.ts";
import type { DigestInput, DigestJob } from "./digest.ts";
import type { SourceDefinition, SupportSignal } from "./domain.ts";
import { assertAllowedHttpsUrl } from "./greenhouse.ts";
import {
  parseRunCheckpoint,
  serializeRunCheckpoint,
  validateCheckpointSourceResult,
  type RunCheckpoint,
} from "./checkpoint.ts";
import {
  isSourceWarningCategory,
  normalizeSourceWarning,
  normalizeSourceWarnings,
  type SourceWarningCategory,
} from "./operations.ts";
import { buildPersistedJobMetadata } from "./job-metadata.ts";
import {
  applyJobOverride,
  jobOverrideKey,
  shouldNotifyRepost,
  validateJobOverride,
  type JobOverride,
  type JobOverrideDecision,
} from "./job-overrides.ts";
import {
  appendPendingNotificationJobs,
  completeNotificationBatch,
  createPendingNotificationBatch,
  failNotificationBatch,
  notificationBatchId,
  oldestPendingNotificationBatch,
  recoverStaleNotificationBatch,
  startNotificationBatch,
  validateNotificationBatch,
  validateNotificationJobIdentity,
  type NotificationBatch,
  type NotificationJobIdentity,
} from "./outbox.ts";
import { normalizeHttpValidators } from "./transport.ts";
import { assertMvpOwnerFingerprint } from "./runtime.ts";
import { REQUIRED_TARGET_COUNT } from "./sources.ts";

const JOBS_SHEET = "Jobs";
const SOURCES_SHEET = "SourceState";
const RUNS_SHEET = "Runs";
const CHECKPOINT_SHEET = "RunCheckpoint";
const NOTIFICATION_BATCHES_SHEET = "NotificationBatches";
const JOB_OVERRIDES_SHEET = "JobOverrides";
const RULE_VERSION = "mvp-1";

const JOB_HEADERS = [
  "source_key",
  "source_job_id",
  "company",
  "title",
  "location",
  "canonical_url",
  "first_seen_at",
  "last_seen_at",
  "match_status",
  "match_reasons",
  "rule_version",
  "baseline",
  "missing_run_count",
  "closed_at",
  "last_applied_run_id",
  "notification_batch_id",
  "notification_status",
  "notified_at",
  "workplace_type",
  "employment_type",
  "published_at",
  "updated_at",
  "content_hash",
  "sponsorship_signal",
  "relocation_signal",
  "last_reopened_at",
  "repost_count",
];

const SOURCE_HEADERS = [
  "source_key",
  "initialized_at",
  "last_success_at",
  "last_count",
  "last_status",
  "warnings",
  "pending_count",
  "pending_confirmations",
  "consecutive_failures",
  "circuit_opened_at",
  "last_applied_run_id",
  "last_run_result",
  "last_run_initialized_sources",
  "last_run_new_candidates",
  "etag",
  "last_modified",
  "http_validator_url",
  "last_attempt_at",
  "last_verified_at",
  "last_error_category",
  "operationally_disabled",
];

const RUN_HEADERS = [
  "started_at",
  "completed_at",
  "mode",
  "status",
  "configured_targets",
  "required_targets",
  "source_summary",
  "unsupported_targets",
  "run_id",
  "request_attempts",
  "initialized_sources",
  "new_candidates",
  "response_bytes",
];

const CHECKPOINT_HEADERS = [
  "run_id",
  "started_at",
  "remaining_source_keys",
  "completed_sources",
  "initialized_sources",
  "new_candidates",
  "remaining_request_attempts",
  "updated_at",
  "response_bytes",
];

const NOTIFICATION_BATCH_HEADERS = [
  "batch_id",
  "created_at",
  "status",
  "job_identity",
  "first_attempt_at",
  "last_attempt_at",
  "attempt_count",
  "sent_at",
  "outcome",
  "updated_at",
];

const JOB_OVERRIDE_HEADERS = [
  "source_key",
  "source_job_id",
  "decision",
  "actor_fingerprint",
  "updated_at",
];

export function escapeSheetCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function activeSpreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("This MVP must run from its container-bound Google Sheet");
  }
  return spreadsheet;
}

function ensureSheet(
  spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet,
  name: string,
  headers: string[],
  warningOnly = true,
): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = spreadsheet.getSheetByName(name) ?? spreadsheet.insertSheet(name);
  const currentHeaders = sheet.getLastColumn() === 0
    ? []
    : sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  if (currentHeaders.length === 0 || currentHeaders.every((value) => value === "")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.protect().setDescription(`System-owned ${name} data`).setWarningOnly(warningOnly);
    return sheet;
  }

  const isKnownOlderSchema = currentHeaders.length < headers.length
    && currentHeaders.every((value, index) => value === headers[index]);
  if (isKnownOlderSchema) {
    const missingHeaders = headers.slice(currentHeaders.length);
    sheet.getRange(1, currentHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
    return sheet;
  }

  if (currentHeaders.length !== headers.length
    || currentHeaders.some((value, index) => value !== headers[index])) {
    throw new Error(`Unexpected ${name} sheet schema; refusing to overwrite it`);
  }
  return sheet;
}

export function setupMvpSheets(): void {
  const spreadsheet = activeSpreadsheet();
  ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  ensureSheet(spreadsheet, SOURCES_SHEET, SOURCE_HEADERS);
  ensureSheet(spreadsheet, RUNS_SHEET, RUN_HEADERS);
  ensureSheet(spreadsheet, CHECKPOINT_SHEET, CHECKPOINT_HEADERS);
  ensureSheet(spreadsheet, NOTIFICATION_BATCHES_SHEET, NOTIFICATION_BATCH_HEADERS);
  ensureSheet(spreadsheet, JOB_OVERRIDES_SHEET, JOB_OVERRIDE_HEADERS, false);
}

function readJobOverridesFromSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  ownerFingerprint?: string,
): Map<string, JobOverride> {
  const overrides = new Map<string, JobOverride>();
  for (const row of readBody(sheet, JOB_OVERRIDE_HEADERS.length)) {
    let override: JobOverride;
    try {
      override = validateJobOverride({
        sourceKey: row[0],
        sourceJobId: row[1],
        decision: row[2],
        actorFingerprint: row[3],
        updatedAt: row[4],
      });
    } catch {
      throw new Error("JOB_OVERRIDE_STATE_INVALID");
    }
    if (ownerFingerprint !== undefined && override.actorFingerprint !== ownerFingerprint) {
      throw new Error("JOB_OVERRIDE_OWNER_MISMATCH");
    }
    const key = jobOverrideKey(override.sourceKey, override.sourceJobId);
    if (overrides.has(key)) {
      throw new Error("JOB_OVERRIDE_STATE_INVALID");
    }
    overrides.set(key, override);
  }
  return overrides;
}

export function readJobOverrides(ownerFingerprint?: string): JobOverride[] {
  const sheet = ensureSheet(activeSpreadsheet(), JOB_OVERRIDES_SHEET, JOB_OVERRIDE_HEADERS);
  return [...readJobOverridesFromSheet(sheet, ownerFingerprint).values()];
}

export function upsertJobOverride(
  sourceKey: string,
  sourceJobId: string,
  decision: JobOverrideDecision,
  ownerFingerprint: string,
  updatedAt: string,
  allowedSourceKeys: ReadonlySet<string>,
): JobOverride {
  if (!allowedSourceKeys.has(sourceKey)) {
    throw new Error("JOB_OVERRIDE_SOURCE_INVALID");
  }
  const override = validateJobOverride({
    sourceKey,
    sourceJobId,
    decision,
    actorFingerprint: ownerFingerprint,
    updatedAt,
  });
  const sheet = ensureSheet(activeSpreadsheet(), JOB_OVERRIDES_SHEET, JOB_OVERRIDE_HEADERS);
  const overrides = readJobOverridesFromSheet(sheet, ownerFingerprint);
  overrides.set(jobOverrideKey(sourceKey, sourceJobId), override);
  if (decision === "EXCLUDE") {
    assertNotificationIdentityNotSending(sourceKey, sourceJobId);
  }
  replaceBody(sheet, JOB_OVERRIDE_HEADERS.length, [...overrides.values()].map((entry) => [
    entry.sourceKey,
    entry.sourceJobId,
    entry.decision,
    entry.actorFingerprint,
    entry.updatedAt,
  ]));
  if (decision === "EXCLUDE") {
    removePendingNotificationIdentity(sourceKey, sourceJobId, updatedAt);
  }
  return override;
}

export function deleteJobOverride(
  sourceKey: string,
  sourceJobId: string,
  ownerFingerprint: string,
  allowedSourceKeys: ReadonlySet<string>,
): boolean {
  if (!allowedSourceKeys.has(sourceKey)) {
    throw new Error("JOB_OVERRIDE_SOURCE_INVALID");
  }
  const key = jobOverrideKey(sourceKey, sourceJobId);
  const sheet = ensureSheet(activeSpreadsheet(), JOB_OVERRIDES_SHEET, JOB_OVERRIDE_HEADERS);
  const overrides = readJobOverridesFromSheet(sheet, ownerFingerprint);
  const deleted = overrides.delete(key);
  replaceBody(sheet, JOB_OVERRIDE_HEADERS.length, [...overrides.values()].map((entry) => [
    entry.sourceKey,
    entry.sourceJobId,
    entry.decision,
    entry.actorFingerprint,
    entry.updatedAt,
  ]));
  return deleted;
}

export function readRunCheckpoint(expectedSourceKeys: readonly string[]): RunCheckpoint | null {
  const sheet = ensureSheet(activeSpreadsheet(), CHECKPOINT_SHEET, CHECKPOINT_HEADERS);
  const rows = readBody(sheet, CHECKPOINT_HEADERS.length);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Unexpected checkpoint row count");
  }
  const row = rows[0];
  return parseRunCheckpoint(JSON.stringify({
    version: 1,
    runId: String(row[0] ?? ""),
    startedAt: String(row[1] ?? ""),
    remainingSourceKeys: JSON.parse(String(row[2] ?? "[]")) as unknown,
    completedSources: JSON.parse(String(row[3] ?? "[]")) as unknown,
    persistence: {
      initializedSources: Number(row[4]),
      newCandidates: Number(row[5]),
    },
    remainingRequestAttempts: Number(row[6]),
    responseBytes: row[8] === "" || row[8] === undefined ? 0 : Number(row[8]),
  }), expectedSourceKeys);
}

export function writeRunCheckpoint(checkpoint: RunCheckpoint, updatedAt: string): void {
  const serialized = serializeRunCheckpoint(checkpoint);
  if (serialized.length > 45_000) {
    throw new Error("Checkpoint exceeds the bounded storage size");
  }
  const sheet = ensureSheet(activeSpreadsheet(), CHECKPOINT_SHEET, CHECKPOINT_HEADERS);
  replaceBody(sheet, CHECKPOINT_HEADERS.length, [[
    checkpoint.runId,
    checkpoint.startedAt,
    JSON.stringify(checkpoint.remainingSourceKeys),
    JSON.stringify(checkpoint.completedSources),
    checkpoint.persistence.initializedSources,
    checkpoint.persistence.newCandidates,
    checkpoint.remainingRequestAttempts,
    updatedAt,
    checkpoint.responseBytes,
  ]]);
}

export function clearRunCheckpoint(): void {
  const sheet = ensureSheet(activeSpreadsheet(), CHECKPOINT_SHEET, CHECKPOINT_HEADERS);
  replaceBody(sheet, CHECKPOINT_HEADERS.length, []);
}

export function assertRecentCompletedRun(
  now: Date,
  maximumAgeMs = 6 * 60 * 60 * 1_000,
): string {
  const runsSheet = ensureSheet(activeSpreadsheet(), RUNS_SHEET, RUN_HEADERS);
  const rows = readBody(runsSheet, RUN_HEADERS.length)
    .filter((row) => ["FULL_SUCCESS", "PARTIAL", "FAILED"].includes(String(row[3] ?? "")));
  const latestCompletedAt = rows.length > 0 ? String(rows[rows.length - 1][1] ?? "") : "";
  return validateLatestCompletedRun(latestCompletedAt, now, maximumAgeMs);
}

export interface LatestCompletedRunHealth {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "FULL_SUCCESS" | "PARTIAL" | "FAILED";
  configuredTargets: number;
  requiredTargets: number;
  unsupportedTargets: string[];
}

function parseAcceptanceSourceIssues(value: unknown): AcceptanceSourceIssue[] {
  const sources = JSON.parse(String(value ?? "")) as unknown;
  if (!Array.isArray(sources) || sources.length > 100) {
    throw new Error("invalid source summary");
  }
  return sources.flatMap((source) => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new Error("invalid source summary");
    }
    const record = source as Record<string, unknown>;
    if (typeof record.sourceKey !== "string"
      || record.sourceKey.length === 0
      || record.sourceKey.length > 100
      || !["SUCCESS", "PARTIAL", "FAILED"].includes(String(record.status))
      || !Array.isArray(record.warnings)
      || record.warnings.length > 100
      || !record.warnings.every(isSourceWarningCategory)) {
      throw new Error("invalid source summary");
    }
    return record.status === "SUCCESS" ? [] : [{
      sourceKey: record.sourceKey,
      status: record.status as AcceptanceSourceIssue["status"],
      warnings: [...record.warnings],
    }];
  });
}

export function readAcceptanceRunEvidence(
  startedAt: string,
  evaluatedAt: string,
): AcceptanceRunEvidence[] {
  const startedAtMs = Date.parse(startedAt);
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(evaluatedAtMs) || evaluatedAtMs < startedAtMs) {
    throw new Error("ACCEPTANCE_WINDOW_INVALID");
  }
  const rows = readBody(
    ensureSheet(activeSpreadsheet(), RUNS_SHEET, RUN_HEADERS),
    RUN_HEADERS.length,
  ).filter((row) => {
    const completedAtMs = Date.parse(String(row[1] ?? ""));
    return ["FULL_SUCCESS", "PARTIAL", "FAILED"].includes(String(row[3] ?? ""))
      && completedAtMs >= startedAtMs
      && completedAtMs <= evaluatedAtMs;
  });
  try {
    return rows.map((row) => {
      const runStartedAt = String(row[0] ?? "");
      const completedAt = String(row[1] ?? "");
      const status = String(row[3] ?? "") as AcceptanceRunEvidence["status"];
      const configuredTargets = Number(row[4]);
      const requiredTargets = Number(row[5]);
      const unsupportedTargets = JSON.parse(String(row[7] ?? "")) as unknown;
      const requestAttempts = Number(row[9]);
      const initializedSources = Number(row[10]);
      const newCandidates = Number(row[11]);
      const responseBytes = row[12] === "" || row[12] === undefined ? 0 : Number(row[12]);
      const durationMs = Date.parse(completedAt) - Date.parse(runStartedAt);
      if (!Number.isFinite(Date.parse(runStartedAt))
        || !Number.isSafeInteger(durationMs)
        || durationMs < 0
        || durationMs > 24 * 60 * 60 * 1_000
        || !Number.isSafeInteger(configuredTargets)
        || configuredTargets < 0
        || configuredTargets > 1_000
        || !Number.isSafeInteger(requiredTargets)
        || requiredTargets < 0
        || requiredTargets > 1_000
        || !Array.isArray(unsupportedTargets)
        || unsupportedTargets.length > 100
        || !unsupportedTargets.every((value) =>
          typeof value === "string" && value.length > 0 && value.length <= 100)
        || !Number.isSafeInteger(requestAttempts)
        || requestAttempts < 0
        || requestAttempts > 500
        || !Number.isSafeInteger(initializedSources)
        || initializedSources < 0
        || initializedSources > 1_000
        || !Number.isSafeInteger(newCandidates)
        || newCandidates < 0
        || newCandidates > 100_000
        || !Number.isSafeInteger(responseBytes)
        || responseBytes < 0) {
        throw new Error("invalid run evidence");
      }
      return {
        startedAt: runStartedAt,
        completedAt,
        status,
        configuredTargets,
        requiredTargets,
        unsupportedTargets: unsupportedTargets as string[],
        requestAttempts,
        responseBytes,
        initializedSources,
        newCandidates,
        sourceIssues: parseAcceptanceSourceIssues(row[6]),
      };
    });
  } catch {
    throw new Error("ACCEPTANCE_RUN_STATE_INVALID");
  }
}

export function readLatestCompletedRunHealth(): LatestCompletedRunHealth | null {
  const rows = readBody(
    ensureSheet(activeSpreadsheet(), RUNS_SHEET, RUN_HEADERS),
    RUN_HEADERS.length,
  ).filter((row) => ["FULL_SUCCESS", "PARTIAL", "FAILED"].includes(String(row[3] ?? "")));
  const row = rows.at(-1);
  if (row === undefined) {
    return null;
  }
  try {
    const status = String(row[3]) as LatestCompletedRunHealth["status"];
    const startedAt = String(row[0] ?? "");
    const completedAt = String(row[1] ?? "");
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    const configuredTargets = Number(row[4]);
    const requiredTargets = Number(row[5]);
    const unsupportedTargets = JSON.parse(String(row[7] ?? "")) as unknown;
    if (!Number.isFinite(Date.parse(startedAt))
      || !Number.isFinite(Date.parse(completedAt))
      || !Number.isSafeInteger(durationMs)
      || durationMs < 0
      || durationMs > 24 * 60 * 60 * 1_000
      || !Number.isSafeInteger(configuredTargets)
      || configuredTargets < 0
      || configuredTargets > 1_000
      || !Number.isSafeInteger(requiredTargets)
      || requiredTargets < 0
      || requiredTargets > 1_000
      || !Array.isArray(unsupportedTargets)
      || unsupportedTargets.length > 100
      || !unsupportedTargets.every((value) =>
        typeof value === "string"
        && value.length > 0
        && value.length <= 100
        && !/[\u0000-\u001f\u007f]/.test(value))) {
      throw new Error("invalid targets");
    }
    return {
      startedAt,
      completedAt,
      durationMs,
      status,
      configuredTargets,
      requiredTargets,
      unsupportedTargets,
    };
  } catch {
    throw new Error("WATCHDOG_RUN_STATE_INVALID");
  }
}

export function validateLatestCompletedRun(
  latestCompletedAt: string,
  now: Date,
  maximumAgeMs = 6 * 60 * 60 * 1_000,
): string {
  const latestTime = Date.parse(latestCompletedAt);
  if (!Number.isFinite(latestTime)) {
    throw new Error("WATCHDOG_NO_COMPLETED_RUN");
  }
  const age = now.getTime() - latestTime;
  if (age < 0 || age > maximumAgeMs) {
    throw new Error("WATCHDOG_COLLECTION_STALE");
  }
  return latestCompletedAt;
}

export function readSourceIntegrityStates(): Map<string, SourceIntegrityState> {
  const spreadsheet = activeSpreadsheet();
  const sourcesSheet = ensureSheet(spreadsheet, SOURCES_SHEET, SOURCE_HEADERS);
  const rows = readBody(sourcesSheet, SOURCE_HEADERS.length);
  return new Map(rows.map((row) => {
    const initialized = String(row[1] ?? "") !== "";
    const lastCount = Number(row[3]);
    const pendingCountValue = row[6];
    const pendingCount = pendingCountValue === "" || pendingCountValue === null
      ? null
      : Number(pendingCountValue);
    return [String(row[0]), {
      lastHealthyCount: initialized && Number.isFinite(lastCount) ? lastCount : null,
      pendingCount: pendingCount !== null && Number.isFinite(pendingCount) ? pendingCount : null,
      pendingConfirmations: Number.isFinite(Number(row[7])) ? Number(row[7]) : 0,
      consecutiveFailures: Number.isFinite(Number(row[8])) ? Number(row[8]) : 0,
      circuitOpenedAt: typeof row[9] === "string" && row[9] !== "" ? row[9] : null,
      httpValidators: normalizeHttpValidators(
        typeof row[14] === "string" ? row[14] : null,
        typeof row[15] === "string" ? row[15] : null,
      ),
      httpValidatorUrl: typeof row[16] === "string" && row[16] !== "" ? row[16] : null,
    }];
  }));
}

export type SourceHealthStatus = "HEALTHY" | "FAILING" | "STALE" | "DISABLED";

export interface SourceHealth {
  sourceKey: string;
  status: SourceHealthStatus;
  lastCount: number | null;
  lastAttemptAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCategory: SourceWarningCategory | null;
  circuitOpen: boolean;
}

export function readSourceHealth(
  now: Date,
  expectedSourceKeys: readonly string[],
  maximumAgeMs = 12 * 60 * 60 * 1_000,
): SourceHealth[] {
  const rows = readBody(
    ensureSheet(activeSpreadsheet(), SOURCES_SHEET, SOURCE_HEADERS),
    SOURCE_HEADERS.length,
  );
  const rowsBySource = new Map(rows.map((row) => [String(row[0] ?? ""), row]));
  return expectedSourceKeys.map((sourceKey) => {
    const row = rowsBySource.get(sourceKey);
    const storedAttemptAt = String(row?.[17] ?? "");
    const storedVerifiedAt = String(row?.[18] ?? "");
    const lastAttemptAt = storedAttemptAt || String(row?.[2] ?? "") || null;
    const lastVerifiedAt = storedVerifiedAt || String(row?.[2] ?? "") || null;
    const latestStatus = String(row?.[4] ?? "");
    const fallbackWarning = String(row?.[5] ?? "").split(",")[0];
    const storedCategory = row?.[19];
    const lastErrorCategory = latestStatus === "SUCCESS"
      ? null
      : isSourceWarningCategory(storedCategory)
        ? storedCategory
        : fallbackWarning === ""
          ? null
          : normalizeSourceWarning(fallbackWarning);
    const disabled = row?.[20] === true || fallbackWarning === "SOURCE_DISABLED";
    const storedCount = Number(row?.[3]);
    const initialized = String(row?.[1] ?? "") !== "";
    const lastCount = !initialized || !Number.isSafeInteger(storedCount) || storedCount < 0
      ? null
      : storedCount;
    const circuitOpen = String(row?.[9] ?? "") !== "";
    const verifiedTime = Date.parse(lastVerifiedAt ?? "");
    const verifiedAge = now.getTime() - verifiedTime;
    const stale = !Number.isFinite(verifiedTime)
      || verifiedAge < 0
      || verifiedAge > maximumAgeMs;
    const status: SourceHealthStatus = disabled
      ? "DISABLED"
      : stale
        ? "STALE"
        : latestStatus === "FAILED" || latestStatus === "PARTIAL"
          ? "FAILING"
          : "HEALTHY";
    return {
      sourceKey,
      status,
      lastCount,
      lastAttemptAt,
      lastVerifiedAt,
      lastErrorCategory,
      circuitOpen,
    };
  });
}

export function resetSourceCircuit(
  sourceKey: string,
  allowedSourceKeys: ReadonlySet<string>,
): boolean {
  if (!allowedSourceKeys.has(sourceKey)) {
    throw new Error("CIRCUIT_RESET_SOURCE_INVALID");
  }
  const sourceSheet = ensureSheet(activeSpreadsheet(), SOURCES_SHEET, SOURCE_HEADERS);
  const rows = readBody(sourceSheet, SOURCE_HEADERS.length);
  const matchingIndexes = rows
    .map((row, index) => String(row[0] ?? "") === sourceKey ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length > 1) {
    throw new Error("CIRCUIT_RESET_SOURCE_AMBIGUOUS");
  }
  if (matchingIndexes.length === 0) {
    return false;
  }
  sourceSheet.getRange(matchingIndexes[0] + 2, 9, 1, 2).setValues([[0, ""]]);
  return true;
}

export interface AppliedSourceProgress {
  source: ShadowReport["sources"][number];
  persistence: PersistenceResult;
}

export function readAppliedRunProgress(runId: string): AppliedSourceProgress[] {
  const sourcesSheet = ensureSheet(activeSpreadsheet(), SOURCES_SHEET, SOURCE_HEADERS);
  const rows = readBody(sourcesSheet, SOURCE_HEADERS.length)
    .filter((row) => String(row[10] ?? "") === runId);
  const allowedSourceKeys = new Set(rows.map((row) => String(row[0] ?? "")));
  return rows.map((row) => {
      let value: unknown;
      try {
        value = JSON.parse(String(row[11] ?? "")) as unknown;
      } catch {
        throw new Error("Applied source result is not valid JSON");
      }
      const source = validateCheckpointSourceResult(value, allowedSourceKeys);
      if (source.sourceKey !== String(row[0] ?? "")) {
        throw new Error("Applied source result does not match its source row");
      }
      return {
        source,
        persistence: {
          initializedSources: Number(row[12] ?? 0),
          newCandidates: Number(row[13] ?? 0),
        },
      };
    });
}

function readBody(sheet: GoogleAppsScript.Spreadsheet.Sheet, width: number): unknown[][] {
  const rowCount = sheet.getLastRow() - 1;
  return rowCount > 0 ? sheet.getRange(2, 1, rowCount, width).getValues() : [];
}

function replaceBody(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  width: number,
  rows: Array<Array<string | number | boolean>>,
): void {
  const existingRows = Math.max(sheet.getLastRow() - 1, 0);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
  if (existingRows > rows.length) {
    sheet.getRange(2 + rows.length, 1, existingRows - rows.length, width).clearContent();
  }
}

function parseNotificationJobIdentity(value: unknown): NotificationJobIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "")) as unknown;
  } catch {
    throw new Error("NOTIFICATION_JOB_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("NOTIFICATION_JOB_IDENTITY_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.sourceKey !== "string" || typeof record.sourceJobId !== "string") {
    throw new Error("NOTIFICATION_JOB_IDENTITY_INVALID");
  }
  return { sourceKey: record.sourceKey, sourceJobId: record.sourceJobId };
}

function notificationBatchRows(batch: NotificationBatch): Array<Array<string | number | boolean>> {
  return batch.jobs.map((identity) => [
    batch.batchId,
    batch.createdAt,
    batch.status,
    JSON.stringify(identity),
    batch.firstAttemptAt ?? "",
    batch.lastAttemptAt ?? "",
    batch.attemptCount,
    batch.sentAt ?? "",
    batch.outcome,
    batch.updatedAt,
  ]);
}

function readNotificationBatchesFromSheet(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
): NotificationBatch[] {
  const grouped = new Map<string, { metadata: string[]; jobs: NotificationJobIdentity[] }>();
  for (const row of readBody(sheet, NOTIFICATION_BATCH_HEADERS.length)) {
    const batchId = String(row[0] ?? "");
    const metadata = [
      String(row[1] ?? ""),
      String(row[2] ?? ""),
      String(row[4] ?? ""),
      String(row[5] ?? ""),
      String(row[6] ?? ""),
      String(row[7] ?? ""),
      String(row[8] ?? ""),
      String(row[9] ?? ""),
    ];
    const existing = grouped.get(batchId);
    if (existing && existing.metadata.some((value, index) => value !== metadata[index])) {
      throw new Error("NOTIFICATION_BATCH_ROWS_INCONSISTENT");
    }
    const group = existing ?? { metadata, jobs: [] };
    group.jobs.push(parseNotificationJobIdentity(row[3]));
    grouped.set(batchId, group);
  }
  return [...grouped.entries()].map(([batchId, { metadata, jobs }]) =>
    validateNotificationBatch({
      batchId,
      createdAt: metadata[0],
      status: metadata[1],
      jobs,
      firstAttemptAt: metadata[2] || null,
      lastAttemptAt: metadata[3] || null,
      attemptCount: Number(metadata[4]),
      sentAt: metadata[5] || null,
      outcome: metadata[6],
      updatedAt: metadata[7],
    }));
}

function batchContainsIdentity(
  batch: NotificationBatch,
  sourceKey: string,
  sourceJobId: string,
): boolean {
  return batch.jobs.some((identity) =>
    identity.sourceKey === sourceKey && identity.sourceJobId === sourceJobId);
}

function assertNotificationIdentityNotSending(sourceKey: string, sourceJobId: string): void {
  const sheet = ensureSheet(
    activeSpreadsheet(),
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  if (readNotificationBatchesFromSheet(sheet).some((batch) =>
    batch.status === "SENDING" && batchContainsIdentity(batch, sourceKey, sourceJobId))) {
    throw new Error("JOB_OVERRIDE_NOTIFICATION_SENDING");
  }
}

function removePendingNotificationIdentity(
  sourceKey: string,
  sourceJobId: string,
  updatedAt: string,
): void {
  const spreadsheet = activeSpreadsheet();
  const batchSheet = ensureSheet(
    spreadsheet,
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const batches = readNotificationBatchesFromSheet(batchSheet);
  const removedBatchIds = new Set<string>();
  const nextBatches = batches.flatMap((batch) => {
    if (batch.status !== "PENDING" || !batchContainsIdentity(batch, sourceKey, sourceJobId)) {
      return [batch];
    }
    removedBatchIds.add(batch.batchId);
    const jobs = batch.jobs.filter((identity) =>
      identity.sourceKey !== sourceKey || identity.sourceJobId !== sourceJobId);
    return jobs.length === 0
      ? []
      : [validateNotificationBatch({ ...batch, jobs, updatedAt })];
  });
  if (removedBatchIds.size === 0) {
    return;
  }
  const jobRows = readBody(jobsSheet, JOB_HEADERS.length) as Array<
    Array<string | number | boolean>
  >;
  for (const row of jobRows) {
    if (String(row[0] ?? "") === sourceKey
      && String(row[1] ?? "") === sourceJobId
      && removedBatchIds.has(String(row[15] ?? ""))
      && String(row[16] ?? "") === "PENDING") {
      row[15] = "";
      row[16] = "";
      row[17] = "";
    }
  }
  writeNotificationBatches(batchSheet, nextBatches);
  replaceBody(jobsSheet, JOB_HEADERS.length, jobRows);
}

function writeNotificationBatches(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  batches: readonly NotificationBatch[],
): void {
  replaceBody(
    sheet,
    NOTIFICATION_BATCH_HEADERS.length,
    batches.flatMap(notificationBatchRows),
  );
}

export function readNotificationBatches(): NotificationBatch[] {
  const sheet = ensureSheet(
    activeSpreadsheet(),
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  return readNotificationBatchesFromSheet(sheet);
}

function parseJson(value: unknown, failureCode: string): unknown {
  try {
    return JSON.parse(String(value ?? "")) as unknown;
  } catch {
    throw new Error(failureCode);
  }
}

function notificationSourceWarnings(
  runsSheet: GoogleAppsScript.Spreadsheet.Sheet,
  batch: NotificationBatch,
  sourceKeys: ReadonlySet<string>,
): string[] {
  const runId = batch.batchId.slice("notification:".length);
  const matchingRuns = readBody(runsSheet, RUN_HEADERS.length)
    .filter((row) => String(row[8] ?? "") === runId);
  if (matchingRuns.length !== 1) {
    throw new Error("NOTIFICATION_DIGEST_RUN_MISSING");
  }
  const run = matchingRuns[0];
  if (!["FULL_SUCCESS", "PARTIAL", "FAILED"].includes(String(run[3] ?? ""))) {
    throw new Error("NOTIFICATION_DIGEST_RUN_INVALID");
  }
  const sourceSummary = parseJson(run[6], "NOTIFICATION_DIGEST_RUN_INVALID");
  if (!Array.isArray(sourceSummary) || sourceSummary.length !== sourceKeys.size) {
    throw new Error("NOTIFICATION_DIGEST_RUN_INVALID");
  }
  const sources = sourceSummary.map((source) => {
    try {
      return validateCheckpointSourceResult(source, sourceKeys);
    } catch {
      throw new Error("NOTIFICATION_DIGEST_RUN_INVALID");
    }
  });
  if (new Set(sources.map(({ sourceKey }) => sourceKey)).size !== sources.length) {
    throw new Error("NOTIFICATION_DIGEST_RUN_INVALID");
  }
  const warnings = sources
    .filter((source) => source.status !== "SUCCESS")
    .map((source) => `${source.sourceKey}: ${source.status}${
      source.warnings.length > 0 ? ` (${source.warnings.join(",")})` : ""
    }`);
  const unsupported = parseJson(run[7], "NOTIFICATION_DIGEST_RUN_INVALID");
  if (!Array.isArray(unsupported)
    || unsupported.length > REQUIRED_TARGET_COUNT
    || unsupported.some((company) => typeof company !== "string"
      || company.length === 0
      || company.length > 100
      || /[\u0000-\u001f\u007f]/.test(company))) {
    throw new Error("NOTIFICATION_DIGEST_RUN_INVALID");
  }
  if (unsupported.length > 0) {
    warnings.push(`Unsupported targets: ${unsupported.join(", ")}`);
  }
  return warnings;
}

function supportSignal(value: unknown): SupportSignal {
  const signal = String(value ?? "");
  if (!(["yes", "unknown", "no"] as const).includes(signal as SupportSignal)) {
    throw new Error("NOTIFICATION_DIGEST_JOB_INVALID");
  }
  return signal as SupportSignal;
}

export function readNotificationDigestInput(
  batch: NotificationBatch,
  sourceDefinitions: readonly SourceDefinition[],
): DigestInput {
  validateNotificationBatch(batch);
  if (batch.status !== "SENDING") {
    throw new Error("NOTIFICATION_DIGEST_BATCH_NOT_SENDING");
  }
  const spreadsheet = activeSpreadsheet();
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const runsSheet = ensureSheet(spreadsheet, RUNS_SHEET, RUN_HEADERS);
  const overridesSheet = ensureSheet(
    spreadsheet,
    JOB_OVERRIDES_SHEET,
    JOB_OVERRIDE_HEADERS,
  );
  const overrides = overridesSheet.getLastRow() <= 1
    ? new Map<string, JobOverride>()
    : readJobOverridesFromSheet(overridesSheet, assertMvpOwnerFingerprint());
  const sourceByKey = new Map(sourceDefinitions.map((source) => [source.sourceKey, source]));
  if (sourceByKey.size !== sourceDefinitions.length) {
    throw new Error("NOTIFICATION_DIGEST_SOURCE_REGISTRY_INVALID");
  }
  const jobRows = readBody(jobsSheet, JOB_HEADERS.length) as Array<
    Array<string | number | boolean>
  >;
  const rowsByIdentity = new Map<string, Array<Array<string | number | boolean>>>();
  for (const row of jobRows) {
    const identity = jobIdentityKey(row[0], row[1]);
    rowsByIdentity.set(identity, [...(rowsByIdentity.get(identity) ?? []), row]);
  }
  const jobs: DigestJob[] = batch.jobs.map((identity) => {
    if (overrides.get(jobOverrideKey(identity.sourceKey, identity.sourceJobId))?.decision
      === "EXCLUDE") {
      throw new Error("NOTIFICATION_DIGEST_JOB_EXCLUDED");
    }
    const source = sourceByKey.get(identity.sourceKey);
    const rows = rowsByIdentity.get(jobIdentityKey(identity.sourceKey, identity.sourceJobId)) ?? [];
    if (!source || rows.length !== 1) {
      throw new Error("NOTIFICATION_DIGEST_JOB_INVALID");
    }
    const row = rows[0];
    if (String(row[2] ?? "") !== escapeSheetCell(source.company)
      || String(row[15] ?? "") !== batch.batchId
      || String(row[16] ?? "") !== "SENDING") {
      throw new Error("NOTIFICATION_DIGEST_JOB_INVALID");
    }
    const matchStatus = String(row[8] ?? "");
    if (matchStatus !== "STRONG" && matchStatus !== "REVIEW") {
      throw new Error("NOTIFICATION_DIGEST_JOB_INVALID");
    }
    const matchReasons = String(row[9] ?? "").split(",").filter(Boolean);
    if (matchReasons.length === 0) {
      throw new Error("NOTIFICATION_DIGEST_JOB_INVALID");
    }
    return {
      sourceKey: identity.sourceKey,
      sourceJobId: identity.sourceJobId,
      company: source.company,
      title: String(row[3] ?? ""),
      location: String(row[4] ?? ""),
      canonicalUrl: assertAllowedHttpsUrl(String(row[5] ?? ""), source.allowedHosts),
      firstSeenAt: String(row[6] ?? ""),
      lastReopenedAt: String(row[25] ?? ""),
      repostCount: Number(row[26] ?? 0),
      matchStatus,
      matchReasons,
      workplaceType: String(row[18] ?? ""),
      sponsorshipSignal: supportSignal(row[23]),
      relocationSignal: supportSignal(row[24]),
    };
  });
  return {
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    jobs,
    sourceWarnings: notificationSourceWarnings(
      runsSheet,
      batch,
      new Set(sourceByKey.keys()),
    ),
    reviewSheetUrl: spreadsheet.getUrl(),
  };
}

function jobIdentityKey(sourceKey: unknown, sourceJobId: unknown): string {
  return `${String(sourceKey ?? "")}\u001f${String(sourceJobId ?? "")}`;
}

function mirrorBatchStateToJobRows(
  jobRows: Array<Array<string | number | boolean>>,
  batch: NotificationBatch,
): Array<Array<string | number | boolean>> {
  const indexes = new Map(jobRows.map((row, index) => [jobIdentityKey(row[0], row[1]), index]));
  for (const identity of batch.jobs) {
    const index = indexes.get(jobIdentityKey(identity.sourceKey, identity.sourceJobId));
    if (index === undefined || String(jobRows[index][15] ?? "") !== batch.batchId) {
      throw new Error("NOTIFICATION_BATCH_JOB_MISSING");
    }
    jobRows[index][16] = batch.status;
    jobRows[index][17] = batch.sentAt ?? "";
  }
  return jobRows;
}

function replaceNotificationBatch(
  batches: readonly NotificationBatch[],
  updated: NotificationBatch,
): NotificationBatch[] {
  let found = false;
  const next = batches.map((batch) => {
    if (batch.batchId !== updated.batchId) {
      return batch;
    }
    found = true;
    return updated;
  });
  if (!found) {
    throw new Error("NOTIFICATION_BATCH_NOT_FOUND");
  }
  return next;
}

export function recoverStaleNotificationBatches(now: string): number {
  const spreadsheet = activeSpreadsheet();
  const batchSheet = ensureSheet(
    spreadsheet,
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const batches = readNotificationBatchesFromSheet(batchSheet);
  const recovered = batches.map((batch) => recoverStaleNotificationBatch(batch, now));
  const changed = recovered.filter((batch, index) => batch !== batches[index]);
  if (changed.length === 0) {
    return 0;
  }
  const changedJobRows = changed.reduce(
    (rows, batch) => mirrorBatchStateToJobRows(rows, batch),
    readBody(jobsSheet, JOB_HEADERS.length) as Array<Array<string | number | boolean>>,
  );
  writeNotificationBatches(batchSheet, recovered);
  replaceBody(jobsSheet, JOB_HEADERS.length, changedJobRows);
  return changed.length;
}

export function startOldestPendingNotificationBatch(attemptedAt: string): NotificationBatch | null {
  const spreadsheet = activeSpreadsheet();
  const batchSheet = ensureSheet(
    spreadsheet,
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const batches = readNotificationBatchesFromSheet(batchSheet);
  const oldest = oldestPendingNotificationBatch(batches);
  if (!oldest) {
    return null;
  }
  const sending = startNotificationBatch(oldest, attemptedAt);
  const jobRows = mirrorBatchStateToJobRows(
    readBody(jobsSheet, JOB_HEADERS.length) as Array<Array<string | number | boolean>>,
    sending,
  );
  writeNotificationBatches(batchSheet, replaceNotificationBatch(batches, sending));
  replaceBody(jobsSheet, JOB_HEADERS.length, jobRows);
  return sending;
}

function updateNotificationBatchState(
  batchId: string,
  updatedAt: string,
  transition: (batch: NotificationBatch, at: string) => NotificationBatch,
): NotificationBatch {
  const spreadsheet = activeSpreadsheet();
  const batchSheet = ensureSheet(
    spreadsheet,
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const batches = readNotificationBatchesFromSheet(batchSheet);
  const current = batches.find((batch) => batch.batchId === batchId);
  if (!current) {
    throw new Error("NOTIFICATION_BATCH_NOT_FOUND");
  }
  const updated = transition(current, updatedAt);
  const jobRows = mirrorBatchStateToJobRows(
    readBody(jobsSheet, JOB_HEADERS.length) as Array<Array<string | number | boolean>>,
    updated,
  );
  writeNotificationBatches(batchSheet, replaceNotificationBatch(batches, updated));
  replaceBody(jobsSheet, JOB_HEADERS.length, jobRows);
  return updated;
}

export function markNotificationBatchSendFailed(batchId: string, failedAt: string): NotificationBatch {
  return updateNotificationBatchState(batchId, failedAt, failNotificationBatch);
}

export function markNotificationBatchSent(batchId: string, sentAt: string): NotificationBatch {
  return updateNotificationBatchState(batchId, sentAt, completeNotificationBatch);
}

export interface PersistenceResult {
  initializedSources: number;
  newCandidates: number;
}

export interface MissingJobState {
  missingRunCount: number;
  closedAt: string;
}

export interface SourceFailureState {
  consecutiveFailures: number;
  circuitOpenedAt: string;
}

const MINIMUM_CLOSURE_AGE_MS = 24 * 60 * 60 * 1_000;
const CLOSED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export function advanceMissingJob(
  lastSeenAt: string,
  previous: MissingJobState,
  completedAt: string,
): MissingJobState {
  if (previous.closedAt !== "") {
    return previous;
  }
  const missingRunCount = previous.missingRunCount + 1;
  const lastSeenTime = Date.parse(lastSeenAt);
  const completedTime = Date.parse(completedAt);
  const canClose = missingRunCount >= 3
    && Number.isFinite(lastSeenTime)
    && Number.isFinite(completedTime)
    && completedTime - lastSeenTime >= MINIMUM_CLOSURE_AGE_MS;
  return {
    missingRunCount,
    closedAt: canClose ? completedAt : "",
  };
}

export function shouldRetainJob(closedAt: string, completedAt: string): boolean {
  if (closedAt === "") {
    return true;
  }
  const closedTime = Date.parse(closedAt);
  const completedTime = Date.parse(completedAt);
  return !Number.isFinite(closedTime)
    || !Number.isFinite(completedTime)
    || completedTime - closedTime <= CLOSED_RETENTION_MS;
}

function jobRowTimestamp(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareJobRowsForDisplay(
  left: Array<string | number | boolean>,
  right: Array<string | number | boolean>,
): number {
  const leftClosedAt = String(left[13] ?? "");
  const rightClosedAt = String(right[13] ?? "");
  const leftActive = leftClosedAt === "";
  const rightActive = rightClosedAt === "";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  const leftActivity = leftActive ? left[25] || left[6] : leftClosedAt;
  const rightActivity = rightActive ? right[25] || right[6] : rightClosedAt;
  const timestampDifference = jobRowTimestamp(rightActivity) - jobRowTimestamp(leftActivity);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  const sourceDifference = String(left[0] ?? "").localeCompare(String(right[0] ?? ""));
  return sourceDifference !== 0
    ? sourceDifference
    : String(left[1] ?? "").localeCompare(String(right[1] ?? ""));
}

export function advanceSourceFailure(
  previous: SourceFailureState,
  status: "SUCCESS" | "PARTIAL" | "FAILED",
  circuitSkipped: boolean,
  completedAt: string,
): SourceFailureState {
  if (circuitSkipped) {
    return previous;
  }
  if (status !== "FAILED") {
    return { consecutiveFailures: 0, circuitOpenedAt: "" };
  }
  const consecutiveFailures = previous.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    circuitOpenedAt: consecutiveFailures >= 3 ? completedAt : previous.circuitOpenedAt,
  };
}

export interface PersistenceOptions {
  appendRun?: boolean;
  runId?: string;
  logicalStartedAt?: string;
}

export function persistShadowCollection(
  collection: ShadowCollection,
  options: PersistenceOptions = {},
): PersistenceResult {
  const spreadsheet = activeSpreadsheet();
  const jobsSheet = ensureSheet(spreadsheet, JOBS_SHEET, JOB_HEADERS);
  const sourcesSheet = ensureSheet(spreadsheet, SOURCES_SHEET, SOURCE_HEADERS);
  const runsSheet = ensureSheet(spreadsheet, RUNS_SHEET, RUN_HEADERS);
  const notificationBatchesSheet = ensureSheet(
    spreadsheet,
    NOTIFICATION_BATCHES_SHEET,
    NOTIFICATION_BATCH_HEADERS,
  );
  const jobOverridesSheet = ensureSheet(
    spreadsheet,
    JOB_OVERRIDES_SHEET,
    JOB_OVERRIDE_HEADERS,
  );

  const jobRows = readBody(jobsSheet, JOB_HEADERS.length) as Array<Array<string | number | boolean>>;
  const sourceRows = readBody(sourcesSheet, SOURCE_HEADERS.length) as Array<Array<string | number | boolean>>;
  const jobIndexes = new Map(jobRows.map((row, index) => [`${row[0]}\u001f${row[1]}`, index]));
  const sourceIndexes = new Map(sourceRows.map((row, index) => [String(row[0]), index]));
  const runId = options.runId ?? "";
  const logicalStartedAt = options.logicalStartedAt ?? collection.report.startedAt;
  const logicalRunId = runId || `shadow:${logicalStartedAt}`;
  const batchId = notificationBatchId(logicalRunId);
  const alreadyAppliedSources = new Set(
    runId === ""
      ? []
      : sourceRows
        .filter((row) => String(row[10] ?? "") === runId)
        .map((row) => String(row[0])),
  );
  const sourceResultsToApply = collection.report.sources
    .map((source) => ({ ...source, warnings: normalizeSourceWarnings(source.warnings) }))
    .filter((source) => !alreadyAppliedSources.has(source.sourceKey));
  const successfulSources = new Set(
    sourceResultsToApply
      .filter((source) => source.status === "SUCCESS")
      .map((source) => source.sourceKey),
  );
  const closureEligibleSources = new Set(
    sourceResultsToApply
      .filter((source) => source.status === "SUCCESS" && source.unchanged !== true)
      .map((source) => source.sourceKey),
  );

  let initializedSources = 0;
  let newCandidates = 0;
  const initializedBySource = new Map<string, number>();
  const newCandidatesBySource = new Map<string, number>();
  const seenJobIdentities = new Set<string>();
  const newNotificationIdentities: NotificationJobIdentity[] = [];
  const overrides = jobOverridesSheet.getLastRow() <= 1
    ? new Map<string, JobOverride>()
    : readJobOverridesFromSheet(jobOverridesSheet, assertMvpOwnerFingerprint());

  for (const sourceResult of sourceResultsToApply) {
    const existingIndex = sourceIndexes.get(sourceResult.sourceKey);
    const existing = existingIndex === undefined ? undefined : sourceRows[existingIndex];
    const initializedAt = String(existing?.[1] ?? "");
    const isSuccessful = sourceResult.status === "SUCCESS";
    const circuitSkipped = sourceResult.warnings.includes("CIRCUIT_OPEN")
      || sourceResult.warnings.includes("SOURCE_DISABLED");
    const failureState = advanceSourceFailure({
      consecutiveFailures: Number(existing?.[8] ?? 0),
      circuitOpenedAt: String(existing?.[9] ?? ""),
    }, sourceResult.status, circuitSkipped, collection.report.completedAt);
    const nextInitializedAt = initializedAt || (isSuccessful ? collection.report.completedAt : "");
    const previousValidators = normalizeHttpValidators(
      typeof existing?.[14] === "string" ? existing[14] : null,
      typeof existing?.[15] === "string" ? existing[15] : null,
    );
    const previousValidatorUrl = typeof existing?.[16] === "string" ? existing[16] : "";
    const resultValidators = sourceResult.httpValidators
      ? normalizeHttpValidators(
        sourceResult.httpValidators.etag,
        sourceResult.httpValidators.lastModified,
      )
      : previousValidators;
    const nextValidators = isSuccessful ? resultValidators : previousValidators;
    const nextValidatorUrl = isSuccessful && sourceResult.httpValidators
      ? sourceResult.httpValidatorUrl ?? ""
      : previousValidatorUrl;
    const previousVerifiedAt = String(existing?.[18] ?? "")
      || String(existing?.[2] ?? "");
    if (!initializedAt && nextInitializedAt) {
      initializedSources += 1;
      initializedBySource.set(sourceResult.sourceKey, 1);
    }
    const row: Array<string | number | boolean> = [
      sourceResult.sourceKey,
      nextInitializedAt,
      isSuccessful ? collection.report.completedAt : String(existing?.[2] ?? ""),
      isSuccessful ? sourceResult.listedJobs : Number(existing?.[3] ?? 0),
      sourceResult.status,
      sourceResult.warnings.join(","),
      sourceResult.integrity.pendingCount ?? "",
      sourceResult.integrity.pendingConfirmations,
      failureState.consecutiveFailures,
      failureState.circuitOpenedAt,
      runId,
      JSON.stringify(sourceResult),
      0,
      0,
      nextValidators.etag ?? "",
      nextValidators.lastModified ?? "",
      nextValidators.etag !== null || nextValidators.lastModified !== null
        ? nextValidatorUrl
        : "",
      collection.report.completedAt,
      isSuccessful
        ? collection.report.completedAt
        : previousVerifiedAt,
      isSuccessful ? "" : sourceResult.warnings[0] ?? "SCHEMA_INVALID",
      sourceResult.warnings.includes("SOURCE_DISABLED"),
    ];
    if (existingIndex === undefined) {
      sourceIndexes.set(sourceResult.sourceKey, sourceRows.length);
      sourceRows.push(row);
    } else {
      sourceRows[existingIndex] = row;
    }
  }

  for (const candidate of collection.candidates) {
    if (!successfulSources.has(candidate.job.sourceKey)) {
      continue;
    }
    const safeIdentity = validateNotificationJobIdentity({
      sourceKey: candidate.job.sourceKey,
      sourceJobId: candidate.job.sourceJobId,
    });
    const identity = `${safeIdentity.sourceKey}\u001f${safeIdentity.sourceJobId}`;
    seenJobIdentities.add(identity);
    const existingIndex = jobIndexes.get(identity);
    const existingRow = existingIndex === undefined ? undefined : jobRows[existingIndex];
    const effectiveDecision = applyJobOverride(
      { status: candidate.status, reasons: candidate.reasons },
      overrides.get(identity) ?? null,
    );
    if (effectiveDecision.status === "EXCLUDED" && existingIndex === undefined) {
      continue;
    }
    if (runId !== "" && String(existingRow?.[14] ?? "") === runId) {
      if (String(existingRow?.[6] ?? "") === logicalStartedAt && existingRow?.[11] !== true) {
        newCandidates += 1;
        newCandidatesBySource.set(
          candidate.job.sourceKey,
          (newCandidatesBySource.get(candidate.job.sourceKey) ?? 0) + 1,
        );
      }
      continue;
    }
    const sourceIndex = sourceIndexes.get(candidate.job.sourceKey);
    const sourceInitializedAt = sourceIndex === undefined ? "" : String(sourceRows[sourceIndex][1]);
    const isBaseline = existingIndex === undefined
      && sourceInitializedAt === collection.report.completedAt;
    const isNewCandidate = existingIndex === undefined && !isBaseline;
    const isReopened = existingRow !== undefined
      && shouldNotifyRepost(
        String(existingRow[13] ?? ""),
        collection.report.completedAt,
      );
    const isRepost = isReopened && effectiveDecision.status !== "EXCLUDED";
    const isManualInclude = existingRow !== undefined
      && String(existingRow[8] ?? "") === "EXCLUDED"
      && overrides.get(identity)?.decision === "INCLUDE";
    const hasOutstandingNotification = existingRow !== undefined
      && ["PENDING", "SENDING"].includes(String(existingRow[16] ?? ""));
    const shouldNotify = (isNewCandidate || isRepost || isManualInclude)
      && !hasOutstandingNotification;
    if (shouldNotify) {
      newCandidates += 1;
      newCandidatesBySource.set(
        candidate.job.sourceKey,
        (newCandidatesBySource.get(candidate.job.sourceKey) ?? 0) + 1,
      );
      newNotificationIdentities.push({
        sourceKey: safeIdentity.sourceKey,
        sourceJobId: safeIdentity.sourceJobId,
      });
    }
    const firstSeenAt = existingIndex === undefined
      ? logicalStartedAt
      : String(jobRows[existingIndex][6]);
    const previousRepostCount = Number(existingRow?.[26] ?? 0);
    if (!Number.isSafeInteger(previousRepostCount) || previousRepostCount < 0) {
      throw new Error("JOB_REPOST_COUNT_INVALID");
    }
    const metadata = buildPersistedJobMetadata(
      candidate.job,
      effectiveDecision.status,
      effectiveDecision.reasons,
    );
    const row: Array<string | number | boolean> = [
      candidate.job.sourceKey,
      candidate.job.sourceJobId,
      escapeSheetCell(candidate.job.company),
      escapeSheetCell(candidate.job.title),
      escapeSheetCell(candidate.job.locationText),
      escapeSheetCell(candidate.job.canonicalUrl),
      firstSeenAt,
      collection.report.completedAt,
      effectiveDecision.status,
      effectiveDecision.reasons.join(","),
      RULE_VERSION,
      isBaseline,
      0,
      "",
      runId,
      shouldNotify ? batchId : String(existingRow?.[15] ?? ""),
      shouldNotify ? "PENDING" : String(existingRow?.[16] ?? ""),
      shouldNotify ? "" : String(existingRow?.[17] ?? ""),
      escapeSheetCell(metadata.workplaceType),
      escapeSheetCell(metadata.employmentType),
      escapeSheetCell(metadata.publishedAt),
      escapeSheetCell(metadata.updatedAt),
      metadata.contentHash,
      metadata.mobilitySignals.sponsorship,
      metadata.mobilitySignals.relocation,
      isReopened ? collection.report.completedAt : String(existingRow?.[25] ?? ""),
      isReopened ? previousRepostCount + 1 : previousRepostCount,
    ];
    if (existingIndex === undefined) {
      jobIndexes.set(identity, jobRows.length);
      jobRows.push(row);
    } else {
      jobRows[existingIndex] = row;
    }
  }

  for (const row of jobRows) {
    const sourceKey = String(row[0]);
    const identity = `${sourceKey}\u001f${row[1]}`;
    if (!closureEligibleSources.has(sourceKey) || seenJobIdentities.has(identity)) {
      continue;
    }
    if (runId !== "" && String(row[14] ?? "") === runId) {
      continue;
    }
    const previousMissingCount = Number(row[12]);
    const next = advanceMissingJob(
      String(row[7] ?? ""),
      {
        missingRunCount: Number.isFinite(previousMissingCount) ? previousMissingCount : 0,
        closedAt: String(row[13] ?? ""),
      },
      collection.report.completedAt,
    );
    row[12] = next.missingRunCount;
    row[13] = next.closedAt;
    row[14] = runId;
  }

  for (const sourceResult of sourceResultsToApply) {
    const sourceIndex = sourceIndexes.get(sourceResult.sourceKey);
    if (sourceIndex === undefined) {
      throw new Error("Applied source state is missing");
    }
    sourceRows[sourceIndex][12] = initializedBySource.get(sourceResult.sourceKey) ?? 0;
    sourceRows[sourceIndex][13] = newCandidatesBySource.get(sourceResult.sourceKey) ?? 0;
  }

  const retainedJobRows = jobRows
    .filter((row) => shouldRetainJob(String(row[13] ?? ""), collection.report.completedAt))
    .sort(compareJobRowsForDisplay);

  if (newNotificationIdentities.length > 0) {
    const batches = readNotificationBatchesFromSheet(notificationBatchesSheet);
    const existingBatch = batches.find((batch) => batch.batchId === batchId);
    const pendingBatch = existingBatch
      ? appendPendingNotificationJobs(
        existingBatch,
        newNotificationIdentities,
        collection.report.completedAt,
      )
      : createPendingNotificationBatch(
        batchId,
        logicalStartedAt,
        newNotificationIdentities,
      );
    // Persist the authoritative outbox before Jobs. If the second write fails,
    // replaying this run restores Jobs; transitions fail closed while rows are orphaned.
    writeNotificationBatches(
      notificationBatchesSheet,
      existingBatch
        ? replaceNotificationBatch(batches, pendingBatch)
        : [...batches, pendingBatch],
    );
  }

  replaceBody(jobsSheet, JOB_HEADERS.length, retainedJobRows);
  replaceBody(sourcesSheet, SOURCE_HEADERS.length, sourceRows);

  if (options.appendRun !== false) {
    appendShadowRun(collection.report);
  }

  return { initializedSources, newCandidates };
}

export interface ShadowRunMetrics {
  requestAttempts: number;
  responseBytes: number;
  initializedSources: number;
  newCandidates: number;
}

function validateShadowRunMetrics(metrics: ShadowRunMetrics): ShadowRunMetrics {
  if (!Number.isSafeInteger(metrics.requestAttempts)
    || metrics.requestAttempts < 0
    || metrics.requestAttempts > 500
      || !Number.isSafeInteger(metrics.responseBytes)
      || metrics.responseBytes < 0
    || !Number.isSafeInteger(metrics.initializedSources)
    || metrics.initializedSources < 0
    || metrics.initializedSources > 1_000
    || !Number.isSafeInteger(metrics.newCandidates)
    || metrics.newCandidates < 0
    || metrics.newCandidates > 100_000) {
    throw new Error("RUN_METRICS_INVALID");
  }
  return metrics;
}

export function appendShadowRun(
  report: ShadowReport,
  runId = `shadow:${report.startedAt}`,
  metrics?: ShadowRunMetrics,
): boolean {
  const runsSheet = ensureSheet(activeSpreadsheet(), RUNS_SHEET, RUN_HEADERS);
  const existingRunIds = new Set(
    readBody(runsSheet, RUN_HEADERS.length).map((row) => String(row[8] ?? "")),
  );
  if (existingRunIds.has(runId)) {
    return false;
  }
  const sources = report.sources.map((source) => ({
    ...source,
    warnings: normalizeSourceWarnings(source.warnings),
  }));
  const runStatus = sources.every((source) => source.status === "SUCCESS")
    ? "FULL_SUCCESS"
    : sources.some((source) => source.status !== "FAILED")
      ? "PARTIAL"
      : "FAILED";
  const validatedMetrics = metrics ? validateShadowRunMetrics(metrics) : null;
  runsSheet.appendRow([
    report.startedAt,
    report.completedAt,
    report.mode,
    runStatus,
    report.configuredTargets,
    report.requiredTargets,
    JSON.stringify(sources),
    JSON.stringify(report.unsupportedTargets),
    runId,
    validatedMetrics?.requestAttempts ?? "",
    validatedMetrics?.initializedSources ?? "",
    validatedMetrics?.newCandidates ?? "",
    validatedMetrics?.responseBytes ?? "",
  ]);
  return true;
}

export function appendSkippedLockedRun(
  occurredAt: string,
  configuredTargets: number,
  requiredTargets: number,
  unsupportedTargets: string[],
): boolean {
  const runsSheet = ensureSheet(activeSpreadsheet(), RUNS_SHEET, RUN_HEADERS);
  const runId = `skipped-locked:${occurredAt}`;
  const existingRunIds = new Set(
    readBody(runsSheet, RUN_HEADERS.length).map((row) => String(row[8] ?? "")),
  );
  if (existingRunIds.has(runId)) {
    return false;
  }
  runsSheet.appendRow([
    occurredAt,
    occurredAt,
    "DEGRADED_SHADOW",
    "SKIPPED_LOCKED",
    configuredTargets,
    requiredTargets,
    "[]",
    JSON.stringify(unsupportedTargets),
    runId,
    0,
    0,
    0,
    0,
  ]);
  return true;
}