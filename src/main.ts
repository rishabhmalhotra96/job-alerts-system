import {
  collectShadow,
  type FetchMany,
  type ShadowReport,
  type ShadowHttpRequest,
  type ShadowHttpResponse,
  type SourceShadowResult,
} from "./collector.ts";
import {
  checkpointIsExpired,
  completeCheckpointSources,
  createRunCheckpoint,
  processCheckpointChunks,
  type RunCheckpoint,
} from "./checkpoint.ts";
import { evaluateAcceptanceWindow } from "./acceptance.ts";
import {
  deliverOldestDigest,
  sendDigestWithMailApp,
  sendWithMailApp,
  type PreparedDigest,
} from "./delivery.ts";
import {
  deliverHealthSummary,
  type CollectionHealthIssue,
  type HealthSummaryInput,
} from "./health-summary.ts";
import {
  ACTIVE_MVP_SOURCES,
  ACTIVE_REQUIRED_TARGET_COUNT,
  ACTIVE_ROLLOUT_WAVE_ID,
  ACTIVE_TARGET_COMPANIES,
  getUnsupportedTargets,
} from "./sources.ts";
import {
  appendSkippedLockedRun,
  appendShadowRun,
  assertRecentCompletedRun,
  clearRunCheckpoint,
  persistShadowCollection,
  readAcceptanceRunEvidence,
  readAppliedRunProgress,
  readLatestCompletedRunHealth,
  readNotificationDigestInput,
    deleteJobOverride,
    upsertJobOverride,
  readRunCheckpoint,
  readSourceHealth,
  readSourceIntegrityStates,
  recoverStaleNotificationBatches,
  resetSourceCircuit,
  setupMvpSheets,
  startOldestPendingNotificationBatch,
  markNotificationBatchSendFailed,
  markNotificationBatchSent,
  writeRunCheckpoint,
} from "./sheets.ts";
import { MAX_DAILY_RECIPIENT_SENDS, requireManualInvocation } from "./delivery-policy.ts";
import {
  assertMvpNotificationOwner,
    assertMvpOwnerFingerprint,
  authorizeMvpNotificationOwner,
  enableMvpNotifications as enableNotifications,
  getMvpMode,
  reserveMvpRecipientSend,
  setMvpMode,
  verifyMvpNotificationInstallation,
} from "./runtime.ts";
import {
  deleteMvpContinuationTriggers,
  deleteMvpTriggers,
  ensureMvpContinuationTrigger,
  ensureMvpTriggers,
} from "./triggers.ts";
import { normalizeEtag, normalizeLastModified } from "./transport.ts";

function getHeader(response: GoogleAppsScript.URL_Fetch.HTTPResponse, headerName: string): string {
  const headers = response.getAllHeaders();
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === headerName);
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

const MAX_RUN_REQUEST_ATTEMPTS = 500;
const MAX_TRANSPORT_RESPONSE_BYTES = 2_000_000;
const RUN_FETCH_WINDOW_MS = 270_000;
const MAX_RETRY_DELAY_MS = 2_000;
const SOURCE_CHUNK_SIZE = 4;
const MAX_CHECKPOINT_AGE_MS = 12 * 60 * 60 * 1_000;
const USER_AGENT = "JobAlertsSystem/0.1 (Google Apps Script; owner-operated)";
const CIRCUIT_RESET_SOURCE_PROPERTY = "JOB_ALERTS_CIRCUIT_RESET_SOURCE_KEY";
const OVERRIDE_SOURCE_PROPERTY = "JOB_ALERTS_OVERRIDE_SOURCE_KEY";
const OVERRIDE_JOB_PROPERTY = "JOB_ALERTS_OVERRIDE_JOB_ID";
const OVERRIDE_DECISION_PROPERTY = "JOB_ALERTS_OVERRIDE_DECISION";
const ACCEPTANCE_STARTED_AT_PROPERTY = "JOB_ALERTS_ACCEPTANCE_STARTED_AT";

export interface FetchManyOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  maxRequestAttempts?: number;
  deadlineAt?: number;
}

export type FetchStopReason = "DEADLINE" | "REQUEST_BUDGET";

export interface FetchController {
  fetchMany: FetchMany;
  getRemainingRequestAttempts(): number;
  getResponseBytes(): number;
  getStopReason(): FetchStopReason | null;
}

function toShadowResponse(
  response: GoogleAppsScript.URL_Fetch.HTTPResponse,
): ShadowHttpResponse {
  const byteLength = response.getBlob().getBytes().length;
  return {
    status: response.getResponseCode(),
    contentType: getHeader(response, "content-type"),
    location: getHeader(response, "location") || undefined,
    retryAfter: getHeader(response, "retry-after") || undefined,
    etag: getHeader(response, "etag") || undefined,
    lastModified: getHeader(response, "last-modified") || undefined,
    body: byteLength <= MAX_TRANSPORT_RESPONSE_BYTES ? response.getContentText() : "",
    byteLength,
  };
}

function unavailableResponse(status = 599): ShadowHttpResponse {
  return {
    status,
    contentType: "",
    body: "",
    byteLength: 0,
  };
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(response: ShadowHttpResponse): number {
  const retryAfter = response.retryAfter;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay) && delay > 0) {
      return Math.min(delay, MAX_RETRY_DELAY_MS);
    }
  }
  return 100 + Math.floor(Math.random() * 201);
}

export function createFetchController(options: FetchManyOptions = {}): FetchController {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds) => Utilities.sleep(milliseconds));
  const deadlineAt = options.deadlineAt ?? now() + RUN_FETCH_WINDOW_MS;
  let remainingAttempts = options.maxRequestAttempts ?? MAX_RUN_REQUEST_ATTEMPTS;
  let responseBytes = 0;
  let stopReason: FetchStopReason | null = null;

  function materializeResponse(
    response: GoogleAppsScript.URL_Fetch.HTTPResponse,
  ): ShadowHttpResponse {
    const materialized = toShadowResponse(response);
    responseBytes += materialized.byteLength;
    return materialized;
  }

  function canAttempt(count = 1): boolean {
    if (now() >= deadlineAt) {
      if (stopReason === null) {
        stopReason = "DEADLINE";
      }
      return false;
    }
    if (count > remainingAttempts) {
      if (stopReason === null) {
        stopReason = "REQUEST_BUDGET";
      }
      return false;
    }
    return true;
  }

  function fetchSingle(
    request: GoogleAppsScript.URL_Fetch.URLFetchRequest,
    attemptsUsed: number,
  ): ShadowHttpResponse {
    let response = unavailableResponse();
    for (let attempt = attemptsUsed; attempt < 3; attempt += 1) {
      if (!canAttempt()) {
        return unavailableResponse(598);
      }
      remainingAttempts -= 1;
      try {
        response = materializeResponse(UrlFetchApp.fetchAll([request])[0]);
      } catch {
        response = unavailableResponse();
      }
      if (!isTransientStatus(response.status) || attempt === 2) {
        return response;
      }
      sleep(retryDelay(response));
    }
    return response;
  }

  function fetchMany(requests: ShadowHttpRequest[]): ShadowHttpResponse[] {
    if (requests.length === 0) {
      return [];
    }
    const prepared = requests.map((request) => {
      const ifNoneMatch = normalizeEtag(request.ifNoneMatch);
      const ifModifiedSince = normalizeLastModified(request.ifModifiedSince);
      return {
        url: request.url,
        method: request.method,
        followRedirects: false,
        muteHttpExceptions: true,
        contentType: request.method === "post"
          ? request.contentType ?? "application/json"
          : undefined,
        payload: request.body,
        headers: {
          Accept: "application/json, text/html;q=0.9, application/xml;q=0.8, text/xml;q=0.8",
          "User-Agent": USER_AGENT,
          ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
          ...(ifModifiedSince ? { "If-Modified-Since": ifModifiedSince } : {}),
        },
      };
    });
    if (!canAttempt(prepared.length)) {
      return prepared.map(() => unavailableResponse(598));
    }

    remainingAttempts -= prepared.length;
    let responses: ShadowHttpResponse[];
    try {
      responses = UrlFetchApp.fetchAll(prepared).map(materializeResponse);
    } catch {
      return prepared.map((request) => fetchSingle(request, 1));
    }
    return responses.map((response, index) =>
      isTransientStatus(response.status)
        ? fetchSingle(prepared[index], 1)
        : response);
  }

  return {
    fetchMany,
    getRemainingRequestAttempts: () => remainingAttempts,
    getResponseBytes: () => responseBytes,
    getStopReason: () => stopReason,
  };
}

export function createFetchMany(options: FetchManyOptions = {}): FetchMany {
  return createFetchController(options).fetchMany;
}

export const fetchMany: FetchMany = createFetchMany();

function unfinishedSourceResult(sourceKey: string, warning: string): SourceShadowResult {
  return {
    sourceKey,
    status: "FAILED",
    listedJobs: 0,
    detailedJobs: 0,
    matches: { STRONG: 0, REVIEW: 0, EXCLUDED: 0 },
    warnings: [warning],
    integrity: { accepted: false, pendingCount: null, pendingConfirmations: 0 },
  };
}

function logicalRunReport(
  checkpoint: RunCheckpoint,
  completedAt: string,
  unfinishedWarning?: string,
): ShadowReport {
  const results = new Map(
    checkpoint.completedSources.map((sourceResult) => [sourceResult.sourceKey, sourceResult]),
  );
  if (unfinishedWarning) {
    for (const sourceKey of checkpoint.remainingSourceKeys) {
      results.set(sourceKey, unfinishedSourceResult(sourceKey, unfinishedWarning));
    }
  }
  const sources = ACTIVE_MVP_SOURCES.map(({ sourceKey }) => results.get(sourceKey));
  if (sources.some((sourceResult) => sourceResult === undefined)) {
    throw new Error("Logical run is missing a source result");
  }
  return {
    mode: "DEGRADED_SHADOW",
    requiredTargets: ACTIVE_REQUIRED_TARGET_COUNT,
    configuredTargets: new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company)).size,
    unsupportedTargets: getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES),
    startedAt: checkpoint.startedAt,
    completedAt,
    sources: sources as SourceShadowResult[],
  };
}

function checkpointRunMetrics(checkpoint: RunCheckpoint): {
  requestAttempts: number;
  responseBytes: number;
  initializedSources: number;
  newCandidates: number;
} {
  return {
    requestAttempts: MAX_RUN_REQUEST_ATTEMPTS - checkpoint.remainingRequestAttempts,
    responseBytes: checkpoint.responseBytes,
    initializedSources: checkpoint.persistence.initializedSources,
    newCandidates: checkpoint.persistence.newCandidates,
  };
}

function continuationResponse(checkpoint: RunCheckpoint): string {
  const trigger = ensureMvpContinuationTrigger();
  return JSON.stringify({
    mode: "DEGRADED_SHADOW",
    status: "CONTINUATION_SCHEDULED",
    runId: checkpoint.runId,
    remainingSources: checkpoint.remainingSourceKeys.length,
    remainingRequestAttempts: checkpoint.remainingRequestAttempts,
    trigger,
  });
}

function clearContinuationState(): void {
  clearRunCheckpoint();
  deleteMvpContinuationTriggers();
}

function runMvpCollection(): string {
  if (getMvpMode() === "PAUSED") {
    clearContinuationState();
    return JSON.stringify({ mode: "PAUSED", status: "NO_FETCH" });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    const occurredAt = new Date().toISOString();
    appendSkippedLockedRun(
      occurredAt,
      new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company)).size,
      ACTIVE_REQUIRED_TARGET_COUNT,
      getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES),
    );
    return JSON.stringify({ mode: "DEGRADED_SHADOW", status: "SKIPPED_LOCKED" });
  }

  try {
    recoverStaleNotificationBatches(new Date().toISOString());
    deleteMvpContinuationTriggers();
    const invocationStartedAt = Date.now();
    const deadlineAt = invocationStartedAt + RUN_FETCH_WINDOW_MS;
    const sourceKeys = ACTIVE_MVP_SOURCES.map(({ sourceKey }) => sourceKey);
    let storedCheckpoint: RunCheckpoint | null;
    try {
      storedCheckpoint = readRunCheckpoint(sourceKeys);
    } catch {
      clearContinuationState();
      throw new Error("RUN_CHECKPOINT_INVALID");
    }
    if (storedCheckpoint
      && checkpointIsExpired(storedCheckpoint, invocationStartedAt, MAX_CHECKPOINT_AGE_MS)) {
      clearRunCheckpoint();
      storedCheckpoint = null;
    }
    let checkpoint: RunCheckpoint = storedCheckpoint ?? createRunCheckpoint(
      sourceKeys,
      new Date(invocationStartedAt).toISOString(),
      MAX_RUN_REQUEST_ATTEMPTS,
    );
    writeRunCheckpoint(checkpoint, new Date().toISOString());

    const appliedProgress = readAppliedRunProgress(checkpoint.runId);
    const recovered = appliedProgress.filter(({ source }) =>
      checkpoint.remainingSourceKeys.includes(source.sourceKey));
    if (recovered.length > 0) {
      checkpoint = completeCheckpointSources(
        checkpoint,
        recovered.map(({ source }) => source),
        {
          initializedSources: recovered.reduce(
            (total, entry) => total + entry.persistence.initializedSources,
            0,
          ),
          newCandidates: recovered.reduce(
            (total, entry) => total + entry.persistence.newCandidates,
            0,
          ),
        },
        checkpoint.remainingRequestAttempts,
      );
      writeRunCheckpoint(checkpoint, new Date().toISOString());
    }

    const sourceIntegrityStates = readSourceIntegrityStates();
    const coordinated = processCheckpointChunks(checkpoint, {
      deadlineAt,
      chunkSize: SOURCE_CHUNK_SIZE,
      now: Date.now,
      saveCheckpoint: (value) => writeRunCheckpoint(value, new Date().toISOString()),
      processChunk: (chunkKeys, remainingRequestAttempts) => {
        const chunkKeySet = new Set(chunkKeys);
        const chunkSources = ACTIVE_MVP_SOURCES.filter(({ sourceKey }) => chunkKeySet.has(sourceKey));
        const controller = createFetchController({ deadlineAt, maxRequestAttempts: remainingRequestAttempts });
        const collection = collectShadow(
          chunkSources,
          controller.fetchMany,
          () => new Date(),
          ACTIVE_REQUIRED_TARGET_COUNT,
          sourceIntegrityStates,
          ACTIVE_TARGET_COMPANIES,
          (retryRound) => Utilities.sleep(retryRound * 1_000),
        );
        const stopReason = controller.getStopReason();
        if (stopReason) {
          return {
            status: stopReason,
            remainingRequestAttempts: controller.getRemainingRequestAttempts(),
            responseBytes: controller.getResponseBytes(),
          };
        }
        return {
          status: "COMPLETE",
          sourceResults: collection.report.sources,
          persistence: persistShadowCollection(collection, {
            appendRun: false,
            runId: checkpoint.runId,
            logicalStartedAt: checkpoint.startedAt,
          }),
          remainingRequestAttempts: controller.getRemainingRequestAttempts(),
          responseBytes: controller.getResponseBytes(),
        };
      },
    });
    checkpoint = coordinated.checkpoint;

    if (coordinated.status === "DEADLINE") {
      return continuationResponse(checkpoint);
    }
    if (coordinated.status === "REQUEST_BUDGET") {
      const report = logicalRunReport(
        checkpoint,
        new Date().toISOString(),
        "RUN_REQUEST_BUDGET_EXHAUSTED",
      );
      const metrics = checkpointRunMetrics(checkpoint);
      appendShadowRun(report, checkpoint.runId, metrics);
      const output = { ...report, persistence: checkpoint.persistence, requestAttempts: metrics.requestAttempts };
      clearContinuationState();
      console.log(JSON.stringify(output));
      return JSON.stringify(output);
    }

    const report = logicalRunReport(checkpoint, new Date().toISOString());
    const metrics = checkpointRunMetrics(checkpoint);
    appendShadowRun(report, checkpoint.runId, metrics);
    const output = { ...report, persistence: checkpoint.persistence, requestAttempts: metrics.requestAttempts };
    clearContinuationState();
    console.log(JSON.stringify(output));
    return JSON.stringify(output);
  } finally {
    lock.releaseLock();
  }
}

export function withDigestScriptLock<T>(operation: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    throw new Error("DIGEST_DELIVERY_LOCKED");
  }
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function prepareOldestDigest(attemptedAt: string): PreparedDigest | null {
  return withDigestScriptLock(() => {
    recoverStaleNotificationBatches(attemptedAt);
    const batch = startOldestPendingNotificationBatch(attemptedAt);
    if (batch === null) {
      return null;
    }
    try {
      return {
        batchId: batch.batchId,
        input: readNotificationDigestInput(batch, ACTIVE_MVP_SOURCES),
      };
    } catch {
      markNotificationBatchSendFailed(batch.batchId, new Date().toISOString());
      throw new Error("DIGEST_PREPARATION_FAILED");
    }
  });
}

export function runMvpDigestDelivery(): string {
  try {
    const result = deliverOldestDigest({
      notificationsEnabled: () => getMvpMode() === "NOTIFY",
      now: () => new Date().toISOString(),
      prepareOldest: prepareOldestDigest,
      reserveRecipient: (attemptedAt) =>
        reserveMvpRecipientSend("DIGEST", new Date(attemptedAt)).recipient,
      send: sendDigestWithMailApp,
      markFailed: (batchId, failedAt) => withDigestScriptLock(() => {
        markNotificationBatchSendFailed(batchId, failedAt);
      }),
      markSent: (batchId, sentAt) => withDigestScriptLock(() => {
        markNotificationBatchSent(batchId, sentAt);
      }),
    });
    return JSON.stringify(result);
  } catch (error) {
    const category = error instanceof Error
      && [
        "DIGEST_PREPARATION_FAILED",
        "DIGEST_DELIVERY_FAILED",
        "DIGEST_DELIVERY_RECOVERY_FAILED",
        "DIGEST_SENT_STATE_UNCONFIRMED",
        "DIGEST_DELIVERY_LOCKED",
      ].includes(error.message)
      ? error.message
      : "DIGEST_DELIVERY_FAILED";
    console.log(JSON.stringify({ status: category }));
    throw new Error(category);
  }
}

export function runMvpShadow(): string {
  const collectionResult = runMvpCollection();
  if (getMvpMode() !== "NOTIFY") {
    return collectionResult;
  }
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(collectionResult) as Record<string, unknown>;
  } catch {
    throw new Error("COLLECTION_RESULT_INVALID");
  }
  if (["CONTINUATION_SCHEDULED", "NO_FETCH", "SKIPPED_LOCKED"].includes(
    String(output.status ?? ""),
  )) {
    return collectionResult;
  }
  output.delivery = JSON.parse(runMvpDigestDelivery()) as unknown;
  return JSON.stringify(output);
}

function readAcceptanceStartedAt(): string {
  const startedAt = PropertiesService.getScriptProperties()
    .getProperty(ACCEPTANCE_STARTED_AT_PROPERTY);
  if (startedAt === null || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error("ACCEPTANCE_NOT_STARTED");
  }
  return startedAt;
}

function acceptanceSourceHealth(now: Date) {
  return readSourceHealth(now, ACTIVE_MVP_SOURCES.map(({ sourceKey }) => sourceKey)).map((source) => ({
    sourceKey: source.sourceKey,
    status: source.status,
    initialized: source.lastCount !== null,
    circuitOpen: source.circuitOpen,
  }));
}

function acceptanceBaseline(now: Date) {
  const sourceHealth = acceptanceSourceHealth(now);
  return {
    label: "DEGRADED_PILOT",
    rolloutWave: ACTIVE_ROLLOUT_WAVE_ID,
    generatedAt: now.toISOString(),
    configuredSources: ACTIVE_MVP_SOURCES.length,
    initializedSources: sourceHealth.filter((source) => source.initialized).length,
    uninitializedSourceKeys: sourceHealth
      .filter((source) => !source.initialized)
      .map((source) => source.sourceKey),
    unhealthySourceKeys: sourceHealth
      .filter((source) => source.status !== "HEALTHY")
      .map((source) => source.sourceKey),
    openCircuitSourceKeys: sourceHealth
      .filter((source) => source.circuitOpen)
      .map((source) => source.sourceKey),
    configuredTargets: new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company)).size,
    requiredTargets: ACTIVE_REQUIRED_TARGET_COUNT,
    unsupportedTargets: getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES),
  };
}

function acceptanceReport(now: Date) {
  const startedAt = readAcceptanceStartedAt();
  const evaluatedAt = now.toISOString();
  return evaluateAcceptanceWindow({
    startedAt,
    evaluatedAt,
    runs: readAcceptanceRunEvidence(startedAt, evaluatedAt),
    sourceHealth: acceptanceSourceHealth(now),
    expectedSourceCount: ACTIVE_MVP_SOURCES.length,
    expectedConfiguredTargets: new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company)).size,
    expectedRequiredTargets: ACTIVE_REQUIRED_TARGET_COUNT,
    expectedUnsupportedTargets: getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES),
    maximumDailyRecipientSends: MAX_DAILY_RECIPIENT_SENDS,
  });
}

function startAcceptanceWindow(event: unknown, restart: boolean): string {
  requireManualInvocation(event);
  assertMvpNotificationOwner();
  if (getMvpMode() !== "SHADOW") {
    throw new Error("ACCEPTANCE_REQUIRES_SHADOW");
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    throw new Error("ACCEPTANCE_SETUP_LOCKED");
  }
  try {
    const properties = PropertiesService.getScriptProperties();
    if (!restart && properties.getProperty(ACCEPTANCE_STARTED_AT_PROPERTY) !== null) {
      return JSON.stringify({ status: "ACCEPTANCE_ALREADY_STARTED", report: acceptanceReport(new Date()) });
    }
    const now = new Date();
    const sourceHealth = acceptanceSourceHealth(now);
    if (sourceHealth.length !== ACTIVE_MVP_SOURCES.length
      || sourceHealth.some((source) => !source.initialized)) {
      console.log(JSON.stringify({ status: "ACCEPTANCE_BASELINE_INCOMPLETE", ...acceptanceBaseline(now) }));
      throw new Error("ACCEPTANCE_BASELINE_INCOMPLETE");
    }
    properties.setProperty(ACCEPTANCE_STARTED_AT_PROPERTY, now.toISOString());
    return JSON.stringify({
      status: restart ? "ACCEPTANCE_RESTARTED" : "ACCEPTANCE_STARTED",
      report: acceptanceReport(now),
    });
  } finally {
    lock.releaseLock();
  }
}

export function beginMvpAcceptance(event?: unknown): string {
  return startAcceptanceWindow(event, false);
}

export function restartMvpAcceptance(event?: unknown): string {
  return startAcceptanceWindow(event, true);
}

export function runMvpAcceptanceReport(event?: unknown): string {
  requireManualInvocation(event);
  assertMvpNotificationOwner();
  return JSON.stringify(acceptanceReport(new Date()));
}

export function runMvpAcceptanceBaselineReport(event?: unknown): string {
  requireManualInvocation(event);
  assertMvpNotificationOwner();
  const output = JSON.stringify(acceptanceBaseline(new Date()));
  console.log(output);
  return output;
}

export function continueMvpShadow(): string {
  return runMvpShadow();
}

export function setupMvp(): void {
  setupMvpSheets();
  clearContinuationState();
  setMvpMode("SHADOW");
}

export function installMvpTrigger(event?: unknown): string {
  verifyMvpNotificationInstallation(event);
  setupMvpSheets();
  clearContinuationState();
  setMvpMode("SHADOW");
  return JSON.stringify(ensureMvpTriggers());
}

export function authorizeMvpNotifications(event?: unknown): string {
  return authorizeMvpNotificationOwner(event);
}

export function enableMvpNotifications(event?: unknown): string {
  return enableNotifications(event);
}

export function runMvpWatchdog(): string {
  const mode = getMvpMode();
  if (mode === "PAUSED") {
    return JSON.stringify({ mode: "PAUSED", status: "NO_CHECK" });
  }
  const now = new Date();
  let latestCompletedAt: string | null = null;
  let collectionIssue: CollectionHealthIssue | null = null;
  try {
    latestCompletedAt = assertRecentCompletedRun(now);
  } catch (error) {
    if (error instanceof Error
      && ["WATCHDOG_NO_COMPLETED_RUN", "WATCHDOG_COLLECTION_STALE"].includes(error.message)) {
      collectionIssue = error.message as CollectionHealthIssue;
    } else {
      throw error;
    }
  }
  const sourceHealth = readSourceHealth(
    now,
    ACTIVE_MVP_SOURCES.map(({ sourceKey }) => sourceKey),
  );
  let latestRun = null;
  let latestRunStateInvalid = false;
  try {
    latestRun = readLatestCompletedRunHealth();
  } catch (error) {
    if (error instanceof Error && error.message === "WATCHDOG_RUN_STATE_INVALID") {
      latestRunStateInvalid = true;
      console.log(JSON.stringify({ status: "WATCHDOG_RUN_STATE_INVALID" }));
    } else {
      throw error;
    }
  }
  const healthInput: HealthSummaryInput = {
    generatedAt: now.toISOString(),
    collectionIssue,
    latestRun,
    sourceHealth,
    localRemainingQuota: 0,
    providerRemainingQuota: 0,
  };
  let delivery: "DISABLED" | "NOT_REQUIRED" | "SENT";
  try {
    delivery = deliverHealthSummary(healthInput, {
      notificationsEnabled: () => mode === "NOTIFY",
      reserveRecipient: () => {
        const reservation = reserveMvpRecipientSend("HEALTH", now);
        return {
          recipient: reservation.recipient,
          localRemainingQuota: MAX_DAILY_RECIPIENT_SENDS
            - reservation.quota.digestSends
            - reservation.quota.healthSends,
          providerRemainingQuota: reservation.providerRemainingQuota - 1,
        };
      },
      send: sendWithMailApp,
    }).status;
  } catch {
    if (collectionIssue !== null) {
      console.log(JSON.stringify({ status: "HEALTH_SUMMARY_DELIVERY_FAILED" }));
      throw new Error(collectionIssue);
    }
    throw new Error("HEALTH_SUMMARY_DELIVERY_FAILED");
  }
  const output = JSON.stringify({
    mode: "DEGRADED_SHADOW",
    status: sourceHealth.every(({ status }) => status === "HEALTHY")
      ? "HEALTHY"
      : "SOURCES_UNHEALTHY",
    latestCompletedAt,
    sourceHealth,
    delivery,
  });
  if (collectionIssue !== null) {
    throw new Error(collectionIssue);
  }
  if (latestRunStateInvalid) {
    throw new Error("WATCHDOG_RUN_STATE_INVALID");
  }
  return output;
}

export function resetMvpSourceCircuit(): string {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    return JSON.stringify({ mode: "DEGRADED_SHADOW", status: "SKIPPED_LOCKED" });
  }
  try {
    const properties = PropertiesService.getScriptProperties();
    const sourceKey = properties.getProperty(CIRCUIT_RESET_SOURCE_PROPERTY)?.trim() ?? "";
    if (sourceKey === "") {
      throw new Error("CIRCUIT_RESET_NOT_CONFIGURED");
    }
    const reset = resetSourceCircuit(
      sourceKey,
      new Set(ACTIVE_MVP_SOURCES.map((source) => source.sourceKey)),
    );
    properties.deleteProperty(CIRCUIT_RESET_SOURCE_PROPERTY);
    return JSON.stringify({ mode: "DEGRADED_SHADOW", status: "CIRCUIT_RESET", sourceKey, reset });
  } finally {
    lock.releaseLock();
  }
}

function withOverrideScriptLock<T>(operation: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    throw new Error("JOB_OVERRIDE_LOCKED");
  }
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function configuredOverrideIdentity(): {
  sourceKey: string;
  sourceJobId: string;
  properties: GoogleAppsScript.Properties.Properties;
} {
  const properties = PropertiesService.getScriptProperties();
  return {
    sourceKey: properties.getProperty(OVERRIDE_SOURCE_PROPERTY)?.trim() ?? "",
    sourceJobId: properties.getProperty(OVERRIDE_JOB_PROPERTY)?.trim() ?? "",
    properties,
  };
}

function clearOverrideConfiguration(properties: GoogleAppsScript.Properties.Properties): void {
  properties.deleteProperty(OVERRIDE_SOURCE_PROPERTY);
  properties.deleteProperty(OVERRIDE_JOB_PROPERTY);
  properties.deleteProperty(OVERRIDE_DECISION_PROPERTY);
}

export function applyMvpJobOverride(): string {
  return withOverrideScriptLock(() => {
    const ownerFingerprint = assertMvpOwnerFingerprint();
    const { sourceKey, sourceJobId, properties } = configuredOverrideIdentity();
    try {
      const decision = properties.getProperty(OVERRIDE_DECISION_PROPERTY)?.trim() ?? "";
      if (decision !== "INCLUDE" && decision !== "EXCLUDE") {
        throw new Error("JOB_OVERRIDE_DECISION_INVALID");
      }
      const override = upsertJobOverride(
        sourceKey,
        sourceJobId,
        decision,
        ownerFingerprint,
        new Date().toISOString(),
        new Set(ACTIVE_MVP_SOURCES.map((source) => source.sourceKey)),
      );
      return JSON.stringify({
        status: "JOB_OVERRIDE_APPLIED",
        sourceKey: override.sourceKey,
        sourceJobId: override.sourceJobId,
        decision: override.decision,
        updatedAt: override.updatedAt,
      });
    } finally {
      clearOverrideConfiguration(properties);
    }
  });
}

export function clearMvpJobOverride(): string {
  return withOverrideScriptLock(() => {
    const ownerFingerprint = assertMvpOwnerFingerprint();
    const { sourceKey, sourceJobId, properties } = configuredOverrideIdentity();
    try {
      const deleted = deleteJobOverride(
        sourceKey,
        sourceJobId,
        ownerFingerprint,
        new Set(ACTIVE_MVP_SOURCES.map((source) => source.sourceKey)),
      );
      return JSON.stringify({ status: "JOB_OVERRIDE_CLEARED", sourceKey, sourceJobId, deleted });
    } finally {
      clearOverrideConfiguration(properties);
    }
  });
}

export function pauseMvp(): string {
  setMvpMode("PAUSED");
  clearContinuationState();
  return JSON.stringify({ mode: "PAUSED" });
}

export function resumeMvpShadow(): string {
  setupMvpSheets();
  clearContinuationState();
  setMvpMode("SHADOW");
  return JSON.stringify({ mode: "SHADOW" });
}

export function removeMvpTrigger(): string {
  setMvpMode("PAUSED");
  clearRunCheckpoint();
  return JSON.stringify({ mode: "PAUSED", removed: deleteMvpTriggers() });
}