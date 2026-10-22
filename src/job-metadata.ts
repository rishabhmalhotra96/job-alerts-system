import {
  detectMobilitySignals,
  type MatchStatus,
  type MobilitySignals,
  type NormalizedJob,
} from "./domain.ts";

export interface PersistedJobMetadata {
  workplaceType: string;
  employmentType: string;
  publishedAt: string;
  updatedAt: string;
  contentHash: string;
  mobilitySignals: MobilitySignals;
}

function sha256Hex(value: string): string {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  ).map((byte) => ((byte + 256) % 256).toString(16).padStart(2, "0")).join("");
}

export function serializeJobContent(
  job: NormalizedJob,
  matchStatus: MatchStatus,
  matchReasons: readonly string[],
  mobilitySignals: MobilitySignals,
): string {
  return JSON.stringify({
    version: 1,
    company: job.company,
    title: job.title,
    descriptionText: job.descriptionText,
    descriptionCompleteness: job.descriptionCompleteness,
    locationText: job.locationText,
    countryCodes: [...new Set(job.countryCodes.map((code) => code.toUpperCase()))].sort(),
    workplaceType: job.workplaceType,
    employmentType: job.employmentType,
    publishedAt: job.publishedAt,
    updatedAt: job.updatedAt,
    canonicalUrl: job.canonicalUrl,
    matchStatus,
    matchReasons: [...matchReasons].sort(),
    mobilitySignals,
  });
}

export function buildPersistedJobMetadata(
  job: NormalizedJob,
  matchStatus: MatchStatus,
  matchReasons: readonly string[],
): PersistedJobMetadata {
  const mobilitySignals = detectMobilitySignals(job.descriptionText);
  return {
    workplaceType: job.workplaceType ?? "",
    employmentType: job.employmentType ?? "",
    publishedAt: job.publishedAt ?? "",
    updatedAt: job.updatedAt ?? "",
    contentHash: sha256Hex(serializeJobContent(
      job,
      matchStatus,
      matchReasons,
      mobilitySignals,
    )),
    mobilitySignals,
  };
}