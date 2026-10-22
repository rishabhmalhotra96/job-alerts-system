export type NotificationBatchStatus = "PENDING" | "SENDING" | "SENT";
export type NotificationBatchOutcome = "" | "ATTEMPT_STARTED" | "SEND_FAILED" | "STALE_RECOVERED" | "SENT";

export interface NotificationJobIdentity {
  sourceKey: string;
  sourceJobId: string;
}

export interface NotificationBatch {
  batchId: string;
  createdAt: string;
  status: NotificationBatchStatus;
  jobs: NotificationJobIdentity[];
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  sentAt: string | null;
  outcome: NotificationBatchOutcome;
  updatedAt: string;
}

export const STALE_SENDING_AGE_MS = 15 * 60 * 1_000;
export const MAX_NOTIFICATION_BATCH_JOBS = 1_000;
const BATCH_STATUSES = new Set<NotificationBatchStatus>(["PENDING", "SENDING", "SENT"]);
const BATCH_OUTCOMES = new Set<NotificationBatchOutcome>([
  "",
  "ATTEMPT_STARTED",
  "SEND_FAILED",
  "STALE_RECOVERED",
  "SENT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`NOTIFICATION_${field}_INVALID`);
  }
}

function identityKey(identity: NotificationJobIdentity): string {
  return `${identity.sourceKey}\u001f${identity.sourceJobId}`;
}

function normalizeIdentities(identities: readonly NotificationJobIdentity[]): NotificationJobIdentity[] {
  const normalized = identities.map(({ sourceKey, sourceJobId }) => ({
    sourceKey: sourceKey.trim(),
    sourceJobId: sourceJobId.trim(),
  }));
  if (normalized.some(({ sourceKey, sourceJobId }, index) =>
    sourceKey !== identities[index].sourceKey
      || sourceJobId !== identities[index].sourceJobId
      || sourceKey === ""
      || sourceKey.length > 200
      || sourceJobId === ""
      || sourceJobId.length > 1_000
      || /[\u0000-\u001f\u007f]/.test(sourceKey)
      || /[\u0000-\u001f\u007f]/.test(sourceJobId)
      || /^[=+@-]/.test(sourceKey)
      || /^[=+@-]/.test(sourceJobId))) {
    throw new Error("NOTIFICATION_JOB_IDENTITY_INVALID");
  }
  const keys = normalized.map(identityKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("NOTIFICATION_JOB_IDENTITY_DUPLICATE");
  }
  return normalized;
}

export function validateNotificationJobIdentity(
  identity: NotificationJobIdentity,
): NotificationJobIdentity {
  return normalizeIdentities([identity])[0];
}

export function validateNotificationBatch(value: unknown): NotificationBatch {
  if (!isRecord(value)
    || typeof value.batchId !== "string"
    || !value.batchId.startsWith("notification:")
    || value.batchId.length > 220
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || !BATCH_STATUSES.has(value.status as NotificationBatchStatus)
    || !Array.isArray(value.jobs)
    || value.jobs.length === 0
    || value.jobs.length > MAX_NOTIFICATION_BATCH_JOBS
    || !Number.isSafeInteger(value.attemptCount)
    || Number(value.attemptCount) < 0
    || !(value.firstAttemptAt === null
      || (typeof value.firstAttemptAt === "string" && Number.isFinite(Date.parse(value.firstAttemptAt))))
    || !(value.lastAttemptAt === null
      || (typeof value.lastAttemptAt === "string" && Number.isFinite(Date.parse(value.lastAttemptAt))))
    || !(value.sentAt === null
      || (typeof value.sentAt === "string" && Number.isFinite(Date.parse(value.sentAt))))
    || !BATCH_OUTCOMES.has(value.outcome as NotificationBatchOutcome)
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("NOTIFICATION_BATCH_INVALID");
  }
  let jobs: NotificationJobIdentity[];
  try {
    jobs = normalizeIdentities(value.jobs as NotificationJobIdentity[]);
  } catch {
    throw new Error("NOTIFICATION_BATCH_INVALID");
  }
  const attemptCount = Number(value.attemptCount);
  const status = value.status as NotificationBatchStatus;
  const outcome = value.outcome as NotificationBatchOutcome;
  const attemptStateInvalid = attemptCount === 0
    ? value.firstAttemptAt !== null || value.lastAttemptAt !== null || status !== "PENDING" || outcome !== ""
    : value.firstAttemptAt === null
      || value.lastAttemptAt === null
      || (status === "SENDING" && outcome !== "ATTEMPT_STARTED")
      || (status === "SENT" && (outcome !== "SENT" || value.sentAt === null))
      || (status === "PENDING" && !["SEND_FAILED", "STALE_RECOVERED"].includes(outcome));
  if (attemptStateInvalid || (status !== "SENT" && value.sentAt !== null)) {
    throw new Error("NOTIFICATION_BATCH_INVALID");
  }
  return {
    batchId: value.batchId,
    createdAt: value.createdAt,
    status,
    jobs,
    firstAttemptAt: value.firstAttemptAt as string | null,
    lastAttemptAt: value.lastAttemptAt as string | null,
    attemptCount,
    sentAt: value.sentAt as string | null,
    outcome,
    updatedAt: value.updatedAt,
  };
}

export function notificationBatchId(runId: string): string {
  const normalized = runId.trim();
  if (normalized === "" || normalized.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(normalized)) {
    throw new Error("NOTIFICATION_RUN_ID_INVALID");
  }
  return `notification:${normalized}`;
}

export function createPendingNotificationBatch(
  batchId: string,
  createdAt: string,
  jobs: readonly NotificationJobIdentity[],
): NotificationBatch {
  if (!batchId.startsWith("notification:") || batchId.length > 220) {
    throw new Error("NOTIFICATION_BATCH_ID_INVALID");
  }
  assertTimestamp(createdAt, "CREATED_AT");
  const normalizedJobs = normalizeIdentities(jobs);
  if (normalizedJobs.length === 0) {
    throw new Error("NOTIFICATION_BATCH_EMPTY");
  }
  if (normalizedJobs.length > MAX_NOTIFICATION_BATCH_JOBS) {
    throw new Error("NOTIFICATION_BATCH_TOO_LARGE");
  }
  return {
    batchId,
    createdAt,
    status: "PENDING",
    jobs: normalizedJobs,
    firstAttemptAt: null,
    lastAttemptAt: null,
    attemptCount: 0,
    sentAt: null,
    outcome: "",
    updatedAt: createdAt,
  };
}

export function appendPendingNotificationJobs(
  batch: NotificationBatch,
  jobs: readonly NotificationJobIdentity[],
  updatedAt: string,
): NotificationBatch {
  validateNotificationBatch(batch);
  assertTimestamp(updatedAt, "UPDATED_AT");
  const additions = normalizeIdentities(jobs);
  const existingKeys = new Set(batch.jobs.map(identityKey));
  const newJobs = additions.filter((identity) => !existingKeys.has(identityKey(identity)));
  if (newJobs.length === 0) {
    return batch;
  }
  if (batch.status !== "PENDING" || batch.attemptCount !== 0 || batch.firstAttemptAt !== null) {
    throw new Error("NOTIFICATION_BATCH_FROZEN");
  }
  if (batch.jobs.length + newJobs.length > MAX_NOTIFICATION_BATCH_JOBS) {
    throw new Error("NOTIFICATION_BATCH_TOO_LARGE");
  }
  return { ...batch, jobs: [...batch.jobs, ...newJobs], updatedAt };
}

export function startNotificationBatch(batch: NotificationBatch, attemptedAt: string): NotificationBatch {
  validateNotificationBatch(batch);
  assertTimestamp(attemptedAt, "ATTEMPT_AT");
  if (batch.status !== "PENDING") {
    throw new Error("NOTIFICATION_BATCH_NOT_PENDING");
  }
  return {
    ...batch,
    status: "SENDING",
    firstAttemptAt: batch.firstAttemptAt ?? attemptedAt,
    lastAttemptAt: attemptedAt,
    attemptCount: batch.attemptCount + 1,
    outcome: "ATTEMPT_STARTED",
    updatedAt: attemptedAt,
  };
}

export function failNotificationBatch(batch: NotificationBatch, failedAt: string): NotificationBatch {
  validateNotificationBatch(batch);
  assertTimestamp(failedAt, "FAILED_AT");
  if (batch.status !== "SENDING") {
    throw new Error("NOTIFICATION_BATCH_NOT_SENDING");
  }
  return {
    ...batch,
    status: "PENDING",
    outcome: "SEND_FAILED",
    updatedAt: failedAt,
  };
}

export function completeNotificationBatch(batch: NotificationBatch, sentAt: string): NotificationBatch {
  validateNotificationBatch(batch);
  assertTimestamp(sentAt, "SENT_AT");
  if (batch.status !== "SENDING") {
    throw new Error("NOTIFICATION_BATCH_NOT_SENDING");
  }
  return {
    ...batch,
    status: "SENT",
    sentAt,
    outcome: "SENT",
    updatedAt: sentAt,
  };
}

export function recoverStaleNotificationBatch(
  batch: NotificationBatch,
  now: string,
  staleAgeMs = STALE_SENDING_AGE_MS,
): NotificationBatch {
  validateNotificationBatch(batch);
  assertTimestamp(now, "RECOVERY_AT");
  if (!Number.isFinite(staleAgeMs) || staleAgeMs < 0) {
    throw new Error("NOTIFICATION_STALE_AGE_INVALID");
  }
  if (batch.status !== "SENDING" || batch.lastAttemptAt === null) {
    return batch;
  }
  const age = Date.parse(now) - Date.parse(batch.lastAttemptAt);
  if (!Number.isFinite(age) || age <= staleAgeMs) {
    return batch;
  }
  return {
    ...batch,
    status: "PENDING",
    outcome: "STALE_RECOVERED",
    updatedAt: now,
  };
}

export function oldestPendingNotificationBatch(
  batches: readonly NotificationBatch[],
): NotificationBatch | null {
  return batches
    .filter(({ status }) => status === "PENDING")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
}
