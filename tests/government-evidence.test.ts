import assert from "node:assert/strict";
import test from "node:test";

import type { MatchDecision, NormalizedJob } from "../src/domain.ts";
import {
  applyGovernmentEvidence,
  DETE_CURRENT_YEAR_REASON,
  DETE_EVIDENCE_SNAPSHOT,
  type DeteEvidenceSnapshot,
} from "../src/government-evidence.ts";

const strong: MatchDecision = {
  status: "STRONG",
  reasons: ["title:machine-learning-engineer", "location:eligible"],
};

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    sourceKey: "amazon-public-json",
    company: "Amazon",
    sourceJobId: "1",
    title: "Senior Machine Learning Engineer",
    descriptionText: "Build machine learning systems.",
    descriptionCompleteness: "FULL",
    locationText: "Dublin, Ireland",
    countryCodes: ["IE"],
    workplaceType: null,
    employmentType: "Full-time",
    publishedAt: null,
    updatedAt: null,
    canonicalUrl: "https://www.amazon.jobs/en/jobs/1/example",
    fetchedAt: "2026-09-25T10:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<DeteEvidenceSnapshot>): DeteEvidenceSnapshot {
  return { ...DETE_EVIDENCE_SNAPSHOT, ...overrides };
}

test("adds only current-year permit history to an exact reviewed Ireland target", () => {
  assert.deepEqual(applyGovernmentEvidence(job(), strong), {
    status: "STRONG",
    reasons: [...strong.reasons, DETE_CURRENT_YEAR_REASON],
  });
});

test("does not apply DETE evidence outside Ireland or the six reviewed targets", () => {
  assert.equal(applyGovernmentEvidence(job({ countryCodes: ["LU"] }), strong), strong);
  assert.equal(applyGovernmentEvidence(job({ company: "Amazon Web Services" }), strong), strong);
  assert.equal(applyGovernmentEvidence(
    job({ countryCodes: [], locationText: "Remote, Europe" }),
    strong,
    job().fetchedAt,
    DETE_EVIDENCE_SNAPSHOT,
    { eligibleCountryCodes: ["IE"] },
  ), strong);
});

test("applies DETE evidence to a concrete Dublin location under an explicit Ireland policy", () => {
  assert.deepEqual(applyGovernmentEvidence(
    job({ countryCodes: [], locationText: "Dublin, Ireland" }),
    strong,
    job().fetchedAt,
    DETE_EVIDENCE_SNAPSHOT,
    { eligibleCountryCodes: ["IE"] },
  ), {
    status: "STRONG",
    reasons: [...strong.reasons, DETE_CURRENT_YEAR_REASON],
  });
});

test("missing, stale, and ambiguous evidence routes a strong role to review", () => {
  const withoutAmazon = snapshot({
    entities: DETE_EVIDENCE_SNAPSHOT.entities.filter((entity) => entity.company !== "Amazon"),
  });
  assert.deepEqual(applyGovernmentEvidence(job(), strong, job().fetchedAt, withoutAmazon), {
    status: "REVIEW",
    reasons: [...strong.reasons, "permit_history:dete:missing"],
  });

  const stale = snapshot({ publicationMonth: "2026-06", evidenceThroughMonth: "2026-05" });
  assert.deepEqual(applyGovernmentEvidence(job(), strong, job().fetchedAt, stale), {
    status: "REVIEW",
    reasons: [...strong.reasons, "permit_history:dete:stale"],
  });

  const ambiguous = snapshot({
    entities: [...DETE_EVIDENCE_SNAPSHOT.entities, DETE_EVIDENCE_SNAPSHOT.entities[1]],
  });
  assert.deepEqual(applyGovernmentEvidence(job(), strong, job().fetchedAt, ambiguous), {
    status: "REVIEW",
    reasons: [...strong.reasons, "permit_history:dete:ambiguous"],
  });
});

test("government evidence never overrides an eligibility exclusion", () => {
  const excluded: MatchDecision = { status: "EXCLUDED", reasons: ["employment:contract"] };
  const stale = snapshot({ publicationMonth: "2025-12", evidenceThroughMonth: "2025-11" });
  assert.deepEqual(applyGovernmentEvidence(job(), excluded, job().fetchedAt, stale), {
    status: "EXCLUDED",
    reasons: ["employment:contract", "permit_history:dete:stale"],
  });
});