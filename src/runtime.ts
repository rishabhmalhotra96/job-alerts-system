import {
  normalizeEffectiveOwnerEmail,
  ownerFingerprintMaterial,
  requireManualInvocation,
  reserveDailyRecipientSend,
  validateDailySendQuota,
  type DailySendQuota,
  type RecipientSendKind,
} from "./delivery-policy.ts";

export type MvpMode = "SHADOW" | "NOTIFY" | "PAUSED";

const MODE_PROPERTY = "JOB_ALERTS_MODE";
const OWNER_FINGERPRINT_PROPERTY = "JOB_ALERTS_OWNER_FINGERPRINT";
const DAILY_SEND_QUOTA_PROPERTY = "JOB_ALERTS_DAILY_SEND_QUOTA";
const NOTIFICATION_RELEASE_READY = false;

export const REQUIRED_NOTIFICATION_SCOPES = [
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/spreadsheets.currentonly",
  "https://www.googleapis.com/auth/script.scriptapp",
  "https://www.googleapis.com/auth/script.send_mail",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

function sha256Hex(value: string): string {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  ).map((byte) => ((byte + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function effectiveOwner(): { email: string; fingerprint: string } {
  const email = normalizeEffectiveOwnerEmail(Session.getEffectiveUser().getEmail());
  return {
    email,
    fingerprint: sha256Hex(ownerFingerprintMaterial(email, ScriptApp.getScriptId())),
  };
}

function requireNotificationScopes(): void {
  ScriptApp.requireScopes(
    ScriptApp.AuthMode.FULL,
    [...REQUIRED_NOTIFICATION_SCOPES],
  );
  if (ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizationStatus()
    !== ScriptApp.AuthorizationStatus.NOT_REQUIRED) {
    throw new Error("NOTIFICATION_SCOPES_NOT_AUTHORIZED");
  }
}

function providerRemainingDailyQuota(): number {
  const quota = MailApp.getRemainingDailyQuota();
  if (!Number.isSafeInteger(quota) || quota < 0) {
    throw new Error("NOTIFICATION_PROVIDER_QUOTA_INVALID");
  }
  return quota;
}

function withScriptLock<T>(failureCode: string, operation: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1_000)) {
    throw new Error(failureCode);
  }
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

export function getMvpMode(): MvpMode {
  const stored = PropertiesService.getScriptProperties().getProperty(MODE_PROPERTY);
  if (stored === "NOTIFY") {
    return NOTIFICATION_RELEASE_READY ? "NOTIFY" : "SHADOW";
  }
  return stored === "SHADOW" ? "SHADOW" : "PAUSED";
}

export function setMvpMode(mode: Exclude<MvpMode, "NOTIFY">): void {
  PropertiesService.getScriptProperties().setProperty(MODE_PROPERTY, mode);
}

export function authorizeMvpNotificationOwner(event?: unknown): string {
  requireManualInvocation(event);
  requireNotificationScopes();
  return withScriptLock("NOTIFICATION_SETUP_LOCKED", () => {
    const properties = PropertiesService.getScriptProperties();
    const owner = effectiveOwner();
    const existingFingerprint = properties.getProperty(OWNER_FINGERPRINT_PROPERTY);
    if (existingFingerprint !== null && existingFingerprint !== owner.fingerprint) {
      throw new Error("NOTIFICATION_OWNER_MISMATCH");
    }
    properties.setProperty(OWNER_FINGERPRINT_PROPERTY, owner.fingerprint);
    return JSON.stringify({ mode: getMvpMode(), status: "OWNER_AUTHORIZED" });
  });
}

export function assertMvpNotificationOwner(): string {
  const installedFingerprint = PropertiesService.getScriptProperties()
    .getProperty(OWNER_FINGERPRINT_PROPERTY);
  if (installedFingerprint === null || !/^[a-f0-9]{64}$/.test(installedFingerprint)) {
    throw new Error("NOTIFICATION_OWNER_NOT_AUTHORIZED");
  }
  const owner = effectiveOwner();
  if (owner.fingerprint !== installedFingerprint) {
    throw new Error("NOTIFICATION_OWNER_MISMATCH");
  }
  return owner.email;
}

export function assertMvpOwnerFingerprint(): string {
  assertMvpNotificationOwner();
  const fingerprint = PropertiesService.getScriptProperties()
    .getProperty(OWNER_FINGERPRINT_PROPERTY);
  if (fingerprint === null || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("NOTIFICATION_OWNER_NOT_AUTHORIZED");
  }
  return fingerprint;
}

export function verifyMvpNotificationInstallation(event?: unknown): void {
  requireManualInvocation(event);
  requireNotificationScopes();
  assertMvpNotificationOwner();
  providerRemainingDailyQuota();
}

export function enableMvpNotifications(event?: unknown): string {
  requireManualInvocation(event);
  requireNotificationScopes();
  return withScriptLock("NOTIFICATION_SETUP_LOCKED", () => {
    assertMvpNotificationOwner();
    if (!NOTIFICATION_RELEASE_READY) {
      throw new Error("NOTIFICATION_RELEASE_NOT_READY");
    }
    PropertiesService.getScriptProperties().setProperty(MODE_PROPERTY, "NOTIFY");
    return JSON.stringify({ mode: "NOTIFY", status: "NOTIFICATIONS_ENABLED" });
  });
}

export interface RecipientSendReservation {
  recipient: string;
  quota: DailySendQuota;
  providerRemainingQuota: number;
}

function parseStoredDailySendQuota(value: string | null): DailySendQuota | null {
  if (value === null) {
    return null;
  }
  try {
    return validateDailySendQuota(JSON.parse(value) as unknown);
  } catch {
    throw new Error("NOTIFICATION_QUOTA_STATE_INVALID");
  }
}

export function reserveMvpRecipientSend(
  kind: RecipientSendKind,
  now = new Date(),
): RecipientSendReservation {
  if (getMvpMode() !== "NOTIFY") {
    throw new Error("NOTIFICATION_MODE_DISABLED");
  }
  return reserveAuthorizedMvpRecipientSend(kind, now);
}

export function reserveAuthorizedMvpRecipientSend(
  kind: RecipientSendKind,
  now = new Date(),
): RecipientSendReservation {
  return withScriptLock("NOTIFICATION_QUOTA_LOCKED", () => {
    const recipient = assertMvpNotificationOwner();
    const properties = PropertiesService.getScriptProperties();
    const previous = parseStoredDailySendQuota(
      properties.getProperty(DAILY_SEND_QUOTA_PROPERTY),
    );
    const providerRemainingQuota = providerRemainingDailyQuota();
    const quota = reserveDailyRecipientSend(
      previous,
      now.toISOString().slice(0, 10),
      kind,
      providerRemainingQuota,
    );
    properties.setProperty(DAILY_SEND_QUOTA_PROPERTY, JSON.stringify(quota));
    return { recipient, quota, providerRemainingQuota };
  });
}