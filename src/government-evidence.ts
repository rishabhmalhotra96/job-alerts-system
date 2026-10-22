import snapshotData from "../data/dete-permit-history.json" with { type: "json" };

import type {
  MatchDecision,
  NormalizedJob,
  SourceMatchingPolicy,
} from "./domain.ts";

export const DETE_CURRENT_YEAR_REASON = "permit_history:dete:current_year";

const DETE_REVIEW_REASONS = {
  ambiguous: "permit_history:dete:ambiguous",
  missing: "permit_history:dete:missing",
  stale: "permit_history:dete:stale",
} as const;

export const DETE_TARGET_COMPANIES = [
  "Google",
  "Amazon",
  "Mastercard",
  "Microsoft",
  "Meta",
  "Stripe",
] as const;

type DeteTargetCompany = typeof DETE_TARGET_COMPANIES[number];

export interface DeteEvidenceEntity {
  company: DeteTargetCompany;
  legalEntities: readonly string[];
}

export interface DeteEvidenceSnapshot {
  schemaVersion: 1;
  provider: "DETE";
  sourceUrl: string;
  publicationMonth: string;
  evidenceThroughMonth: string;
  sourceFileSha256: string;
  entities: readonly DeteEvidenceEntity[];
}

const TARGET_COMPANY_SET = new Set<string>(DETE_TARGET_COMPANIES);

function normalizedLegalEntity(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function monthIndex(value: string): number | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

function snapshotProblem(
  snapshot: DeteEvidenceSnapshot,
  company: string,
  asOf: string,
): keyof typeof DETE_REVIEW_REASONS | null {
  const entityMatches = snapshot.entities.filter((entity) => entity.company === company);
  if (entityMatches.length === 0) {
    return "missing";
  }
  if (entityMatches.length !== 1
    || snapshot.schemaVersion !== 1
    || snapshot.provider !== "DETE"
    || snapshot.sourceUrl !== "https://enterprise.gov.ie/en/publications/publication-files/employment-permits-issued-to-companies-2026.xlsx"
    || !/^[a-f0-9]{64}$/.test(snapshot.sourceFileSha256)) {
    return "ambiguous";
  }

  const publication = monthIndex(snapshot.publicationMonth);
  const evidenceThrough = monthIndex(snapshot.evidenceThroughMonth);
  const asOfDate = new Date(asOf);
  if (publication === null
    || evidenceThrough === null
    || evidenceThrough !== publication - 1
    || !Number.isFinite(asOfDate.getTime())) {
    return "ambiguous";
  }
  const asOfMonth = asOfDate.getUTCFullYear() * 12 + asOfDate.getUTCMonth();
  if (publication > asOfMonth) {
    return "ambiguous";
  }
  if (asOfDate.getUTCFullYear() !== Math.floor(publication / 12)
    || asOfMonth - publication > 1) {
    return "stale";
  }

  const reviewedAliases = entityMatches[0].legalEntities;
  const allAliases = snapshot.entities.flatMap((entity) => entity.legalEntities);
  if (reviewedAliases.length === 0
    || reviewedAliases.some((alias) => alias !== normalizedLegalEntity(alias))
    || new Set(allAliases).size !== allAliases.length) {
    return "ambiguous";
  }
  return null;
}

export const DETE_EVIDENCE_SNAPSHOT = snapshotData as DeteEvidenceSnapshot;

export function applyGovernmentEvidence(
  job: NormalizedJob,
  decision: MatchDecision,
  asOf = job.fetchedAt,
  snapshot: DeteEvidenceSnapshot = DETE_EVIDENCE_SNAPSHOT,
  policy?: SourceMatchingPolicy,
): MatchDecision {
  const explicitIrelandLocation = job.countryCodes.some((code) => code.toUpperCase() === "IE")
    || (policy?.eligibleCountryCodes?.some((code) => code.toUpperCase() === "IE") === true
      && /(?:^|\W)(?:dublin|ireland)(?:\W|$)/i.test(job.locationText));
  if (!explicitIrelandLocation
    || !TARGET_COMPANY_SET.has(job.company)) {
    return decision;
  }

  const problem = snapshotProblem(snapshot, job.company, asOf);
  const reason = problem === null
    ? DETE_CURRENT_YEAR_REASON
    : DETE_REVIEW_REASONS[problem];
  return {
    status: problem !== null && decision.status === "STRONG" ? "REVIEW" : decision.status,
    reasons: decision.reasons.includes(reason)
      ? [...decision.reasons]
      : [...decision.reasons, reason],
  };
}