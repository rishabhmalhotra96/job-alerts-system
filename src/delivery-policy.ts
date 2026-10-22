export type RecipientSendKind = "DIGEST" | "HEALTH";

export interface DailySendQuota {
  day: string;
  digestSends: number;
  healthSends: number;
}

export const MAX_DAILY_RECIPIENT_SENDS = 9;
export const MAX_DAILY_DIGEST_SENDS = 8;
export const MAX_DAILY_HEALTH_SENDS = 1;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function requireManualInvocation(event: unknown): void {
  if (event !== undefined) {
    throw new Error("NOTIFICATION_SETUP_MANUAL_ONLY");
  }
}

export function normalizeEffectiveOwnerEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === ""
    || normalized.length > 254
    || /[^\x21-\x7e]/.test(normalized)
    || !EMAIL_PATTERN.test(normalized)) {
    throw new Error("NOTIFICATION_OWNER_IDENTITY_UNAVAILABLE");
  }
  return normalized;
}

export function ownerFingerprintMaterial(email: string, scriptId: string): string {
  const normalizedEmail = normalizeEffectiveOwnerEmail(email);
  const normalizedScriptId = scriptId.trim();
  if (normalizedScriptId === ""
    || normalizedScriptId.length > 200
    || !/^[A-Za-z0-9_-]+$/.test(normalizedScriptId)) {
    throw new Error("NOTIFICATION_SCRIPT_ID_INVALID");
  }
  return `owner-v1\u0000${normalizedScriptId}\u0000${normalizedEmail}`;
}

export function emptyDailySendQuota(day: string): DailySendQuota {
  if (!DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new Error("NOTIFICATION_QUOTA_DAY_INVALID");
  }
  return { day, digestSends: 0, healthSends: 0 };
}

export function validateDailySendQuota(value: unknown): DailySendQuota {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("NOTIFICATION_QUOTA_STATE_INVALID");
  }
  const quota = value as Record<string, unknown>;
  if (typeof quota.day !== "string"
    || !DAY_PATTERN.test(quota.day)
    || Number.isNaN(Date.parse(`${quota.day}T00:00:00.000Z`))
    || !Number.isSafeInteger(quota.digestSends)
    || !Number.isSafeInteger(quota.healthSends)
    || Number(quota.digestSends) < 0
    || Number(quota.digestSends) > MAX_DAILY_DIGEST_SENDS
    || Number(quota.healthSends) < 0
    || Number(quota.healthSends) > MAX_DAILY_HEALTH_SENDS
    || Number(quota.digestSends) + Number(quota.healthSends) > MAX_DAILY_RECIPIENT_SENDS) {
    throw new Error("NOTIFICATION_QUOTA_STATE_INVALID");
  }
  return {
    day: quota.day,
    digestSends: Number(quota.digestSends),
    healthSends: Number(quota.healthSends),
  };
}

export function reserveDailyRecipientSend(
  previous: DailySendQuota | null,
  day: string,
  kind: RecipientSendKind,
  providerRemainingQuota: number,
): DailySendQuota {
  const empty = emptyDailySendQuota(day);
  if (!Number.isSafeInteger(providerRemainingQuota) || providerRemainingQuota < 1) {
    throw new Error("NOTIFICATION_PROVIDER_QUOTA_EXHAUSTED");
  }
  let current = previous === null ? empty : validateDailySendQuota(previous);
  if (current.day > day) {
    throw new Error("NOTIFICATION_QUOTA_CLOCK_ROLLBACK");
  }
  if (current.day < day) {
    current = empty;
  }
  if (current.digestSends + current.healthSends >= MAX_DAILY_RECIPIENT_SENDS) {
    throw new Error("NOTIFICATION_DAILY_CAP_REACHED");
  }
  if (kind === "DIGEST") {
    if (current.digestSends >= MAX_DAILY_DIGEST_SENDS) {
      throw new Error("NOTIFICATION_DIGEST_CAP_REACHED");
    }
    return { ...current, digestSends: current.digestSends + 1 };
  }
  if (kind === "HEALTH") {
    if (current.healthSends >= MAX_DAILY_HEALTH_SENDS) {
      throw new Error("NOTIFICATION_HEALTH_CAP_REACHED");
    }
    return { ...current, healthSends: current.healthSends + 1 };
  }
  throw new Error("NOTIFICATION_SEND_KIND_INVALID");
}