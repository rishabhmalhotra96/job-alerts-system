import type { MatchDecision } from "./domain.ts";
import { validateNotificationJobIdentity } from "./outbox.ts";

export type JobOverrideDecision = "INCLUDE" | "EXCLUDE";

export interface JobOverride {
  sourceKey: string;
  sourceJobId: string;
  decision: JobOverrideDecision;
  actorFingerprint: string;
  updatedAt: string;
}

const OWNER_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export function jobOverrideKey(sourceKey: string, sourceJobId: string): string {
  const identity = validateNotificationJobIdentity({ sourceKey, sourceJobId });
  return `${identity.sourceKey}\u001f${identity.sourceJobId}`;
}

export function validateJobOverride(value: unknown): JobOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JOB_OVERRIDE_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  let identity;
  try {
    identity = validateNotificationJobIdentity({
      sourceKey: String(candidate.sourceKey ?? ""),
      sourceJobId: String(candidate.sourceJobId ?? ""),
    });
  } catch {
    throw new Error("JOB_OVERRIDE_INVALID");
  }
  if ((candidate.decision !== "INCLUDE" && candidate.decision !== "EXCLUDE")
    || typeof candidate.actorFingerprint !== "string"
    || !OWNER_FINGERPRINT_PATTERN.test(candidate.actorFingerprint)
    || typeof candidate.updatedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("JOB_OVERRIDE_INVALID");
  }
  return {
    ...identity,
    decision: candidate.decision,
    actorFingerprint: candidate.actorFingerprint,
    updatedAt: candidate.updatedAt,
  };
}

export function applyJobOverride(
  decision: MatchDecision,
  override: JobOverride | null,
): MatchDecision {
  if (override === null) {
    return decision;
  }
  validateJobOverride(override);
  return override.decision === "EXCLUDE"
    ? { status: "EXCLUDED", reasons: ["manual:exclude"] }
    : decision.status === "EXCLUDED"
      ? { status: "REVIEW", reasons: ["manual:include"] }
      : { ...decision, reasons: [...decision.reasons, "manual:include"] };
}

export function shouldNotifyRepost(
  closedAt: string,
  reappearedAt: string,
): boolean {
  const closedTime = Date.parse(closedAt);
  const reappearedTime = Date.parse(reappearedAt);
  if (!Number.isFinite(closedTime)
    || !Number.isFinite(reappearedTime)
    || reappearedTime < closedTime) {
    return false;
  }
  return true;
}