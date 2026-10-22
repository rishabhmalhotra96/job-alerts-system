import { renderDigest, type DigestInput, type RenderedDigest } from "./digest.ts";
import { normalizeEffectiveOwnerEmail } from "./delivery-policy.ts";

export interface RenderedMail {
  subject: string;
  plainTextBody: string;
  htmlBody: string;
}

export interface PreparedDigest {
  batchId: string;
  input: DigestInput;
}

export interface DigestDeliveryDependencies {
  notificationsEnabled: () => boolean;
  now: () => string;
  prepareOldest: (attemptedAt: string) => PreparedDigest | null;
  reserveRecipient: (attemptedAt: string) => string;
  send: (recipient: string, digest: RenderedDigest) => void;
  markFailed: (batchId: string, failedAt: string) => void;
  markSent: (batchId: string, sentAt: string) => void;
}

export type DigestDeliveryResult =
  | { status: "DISABLED" }
  | { status: "NO_PENDING_BATCH" }
  | { status: "SENT"; batchId: string; jobCount: number; overflowed: boolean };

export function sendDigestWithMailApp(
  recipient: string,
  digest: RenderedDigest,
): void {
  sendWithMailApp(recipient, digest);
}

export function sendWithMailApp(
  recipient: string,
  message: RenderedMail,
): void {
  const normalizedRecipient = normalizeEffectiveOwnerEmail(recipient);
  MailApp.sendEmail({
    to: normalizedRecipient,
    subject: message.subject,
    body: message.plainTextBody,
    htmlBody: message.htmlBody,
    name: "Job Alerts",
  });
}

function recoverPending(
  dependencies: DigestDeliveryDependencies,
  batchId: string,
): never {
  try {
    dependencies.markFailed(batchId, dependencies.now());
  } catch {
    throw new Error("DIGEST_DELIVERY_RECOVERY_FAILED");
  }
  throw new Error("DIGEST_DELIVERY_FAILED");
}

export function deliverOldestDigest(
  dependencies: DigestDeliveryDependencies,
): DigestDeliveryResult {
  if (!dependencies.notificationsEnabled()) {
    return { status: "DISABLED" };
  }
  const prepared = dependencies.prepareOldest(dependencies.now());
  if (prepared === null) {
    return { status: "NO_PENDING_BATCH" };
  }
  let digest: RenderedDigest;
  let recipient: string;
  try {
    digest = renderDigest(prepared.input);
    recipient = dependencies.reserveRecipient(dependencies.now());
    dependencies.send(recipient, digest);
  } catch {
    return recoverPending(dependencies, prepared.batchId);
  }
  try {
    dependencies.markSent(prepared.batchId, dependencies.now());
  } catch {
    throw new Error("DIGEST_SENT_STATE_UNCONFIRMED");
  }
  return {
    status: "SENT",
    batchId: prepared.batchId,
    jobCount: digest.jobCount,
    overflowed: digest.overflowed,
  };
}