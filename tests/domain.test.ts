import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedJob, SourceMatchingPolicy } from "../src/domain.ts";
import {
  classifyLanguageRequirement,
  detectMobilitySignals,
  matchJob,
} from "../src/domain.ts";

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    sourceKey: "example",
    company: "Example",
    sourceJobId: "1",
    title: "Senior Machine Learning Engineer",
    descriptionText: "Build machine learning ranking systems.",
    descriptionCompleteness: "FULL",
    locationText: "Berlin, Germany",
    countryCodes: ["DE"],
    workplaceType: "Hybrid",
    employmentType: "Full-time",
    publishedAt: null,
    updatedAt: null,
    canonicalUrl: "https://boards.greenhouse.io/example/jobs/1",
    fetchedAt: "2026-09-16T09:00:00Z",
    ...overrides,
  };
}

test("includes an eligible senior ML role as a strong match", () => {
  const decision = matchJob(job());
  assert.equal(decision.status, "STRONG");
  assert.ok(decision.reasons.includes("location:eligible"));
});

test("recognizes EEA country names without structured country codes", () => {
  const decision = matchJob(job({
    locationText: "Vilnius, Lithuania",
    countryCodes: [],
  }));
  assert.equal(decision.status, "STRONG");
  assert.ok(decision.reasons.includes("location:eligible"));
});

test("includes an eligible Malaysia role", () => {
  const decision = matchJob(job({
    sourceKey: "grab-malaysia-smartrecruiters",
    company: "Grab",
    locationText: "Petaling Jaya, Malaysia",
    countryCodes: ["MY"],
  }));
  assert.equal(decision.status, "STRONG");
  assert.ok(decision.reasons.includes("location:eligible"));
});

test("does not widen Malaysia eligibility beyond the dedicated Grab source", () => {
  const decision = matchJob(job({
    locationText: "Kuala Lumpur, Malaysia",
    countryCodes: ["MY"],
  }));
  assert.deepEqual(decision, {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
});

test("source policy restricts an otherwise eligible EEA role to approved countries", () => {
  const irelandOnly: SourceMatchingPolicy = { eligibleCountryCodes: ["IE"] };

  assert.deepEqual(matchJob(job(), irelandOnly), {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
  assert.equal(matchJob(job({
    locationText: "Dublin, Ireland",
    countryCodes: ["IE"],
  }), irelandOnly).status, "STRONG");
});

test("source policy can explicitly ignore location without changing legacy defaults", () => {
  const ignoredLocation = matchJob(job({
    locationText: "Remote - Global",
    countryCodes: [],
  }), { locationMode: "IGNORE" });

  assert.equal(ignoredLocation.status, "STRONG");
  assert.ok(ignoredLocation.reasons.includes("location:source-exception"));
  assert.equal(matchJob(job({
    locationText: "Remote - Global",
    countryCodes: [],
  })).status, "EXCLUDED");
});

test("classifies explicit mandatory non-English language requirements", () => {
  assert.deepEqual(classifyLanguageRequirement(
    "Requirements: Fluent Danish and professional proficiency in written and spoken English.",
  ), {
    status: "NON_ENGLISH_REQUIRED",
    reason: "language:da:required",
  });
  assert.deepEqual(classifyLanguageRequirement(
    "You must speak English and German to work with our customers.",
  ), {
    status: "NON_ENGLISH_REQUIRED",
    reason: "language:de:required",
  });
  assert.deepEqual(classifyLanguageRequirement(
    "German is required and French is preferred.",
  ), {
    status: "NON_ENGLISH_REQUIRED",
    reason: "language:de:required",
  });
});

test("does not reject optional, negated, or incidental language mentions", () => {
  for (const descriptionText of [
    "German is preferred but not required.",
    "Danish would be a plus.",
    "Danish is not required for this role.",
    "Join Danish Refugee Council and build machine learning systems.",
  ]) {
    assert.deepEqual(classifyLanguageRequirement(descriptionText), {
      status: "CLEAR",
      reason: null,
    });
  }
});

test("routes ambiguous language wording and incomplete descriptions to review", () => {
  assert.deepEqual(classifyLanguageRequirement(
    "Your spoken German language skills will support the regional team.",
  ), {
    status: "AMBIGUOUS",
    reason: "language:ambiguous",
  });

  const policy: SourceMatchingPolicy = {
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  };
  assert.deepEqual(matchJob(job({ descriptionCompleteness: "TEASER" }), policy), {
    status: "REVIEW",
    reasons: ["language:description-incomplete"],
  });
  assert.deepEqual(matchJob(job({
    descriptionText: "Build machine learning systems. Fluent Spanish is required.",
  }), policy), {
    status: "EXCLUDED",
    reasons: ["language:es:required"],
  });
});

test("excludes disallowed seniority and role families", () => {
  assert.equal(matchJob(job({ title: "Staff Machine Learning Engineer" })).status, "EXCLUDED");
  assert.equal(matchJob(job({ title: "Senior Data Engineer" })).status, "EXCLUDED");
  assert.equal(matchJob(job({ title: "Senior Data Analyst" })).status, "EXCLUDED");
});

test("recognizes AI-qualified software engineer titles without widening generic software roles", () => {
  assert.equal(matchJob(job({
    title: "Software Engineer, AI",
    descriptionText: "Build AI-powered social products.",
  })).status, "REVIEW");
  assert.equal(matchJob(job({ title: "Senior AI Software Engineer" })).status, "STRONG");
  assert.equal(matchJob(job({
    title: "Senior Software Engineer",
    descriptionText: "Build AI-powered social products.",
  })).status, "EXCLUDED");
});

test("excludes broad remote locations without an eligible office", () => {
  const decision = matchJob(job({ locationText: "Remote - EMEA", countryCodes: [] }));
  assert.deepEqual(decision, {
    status: "EXCLUDED",
    reasons: ["location:broad-or-remote-only"],
  });
});

test("excludes a role with only an explicitly ineligible country", () => {
  const decision = matchJob(job({
    locationText: "London, United Kingdom",
    countryCodes: ["GB"],
  }));
  assert.deepEqual(decision, {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
});

test("excludes a known ineligible city but accepts mixed eligible offices", () => {
  assert.equal(matchJob(job({
    locationText: "San Francisco",
    countryCodes: [],
  })).status, "EXCLUDED");
  assert.notEqual(matchJob(job({
    locationText: "San Francisco | Dublin",
    countryCodes: [],
  })).status, "EXCLUDED");
});

test("routes ambiguous seniority and location to review", () => {
  assert.equal(matchJob(job({ title: "Data Scientist" })).status, "REVIEW");
  assert.equal(matchJob(job({
    title: "AI Engineer",
    descriptionText: "Design and deploy AI agents across enterprise workflows.",
    locationText: "Amsterdam, Netherlands",
    countryCodes: ["NL"],
    employmentType: null,
  })).status, "REVIEW");
  assert.equal(
    matchJob(job({ locationText: "Flexible office", countryCodes: [] })).status,
    "REVIEW",
  );
});

test("does not interpret BI inside another word as business intelligence", () => {
  const decision = matchJob(job({
    title: "Senior Data Scientist - Biostatistics",
    descriptionText: "Develop machine learning methods for clinical studies.",
  }));
  assert.equal(decision.status, "STRONG");
});

test("excludes standalone BI and reviews unknown employment types", () => {
  assert.equal(
    matchJob(job({ title: "Senior BI Data Scientist" })).status,
    "EXCLUDED",
  );
  assert.equal(
    matchJob(job({ employmentType: null })).status,
    "REVIEW",
  );
});

test("detects explicit sponsorship and relocation support", () => {
  assert.deepEqual(detectMobilitySignals(
    "Visa sponsorship is available. Relocation assistance is provided.",
  ), {
    sponsorship: "yes",
    relocation: "yes",
  });
});

test("detects explicit sponsorship and relocation refusal", () => {
  assert.deepEqual(detectMobilitySignals(
    "You must already have the right to work. No relocation support.",
  ), {
    sponsorship: "no",
    relocation: "no",
  });
});

test("keeps absent or ambiguous mobility wording unknown", () => {
  assert.deepEqual(detectMobilitySignals(
    "Join our global mobility team and help sponsor community events.",
  ), {
    sponsorship: "unknown",
    relocation: "unknown",
  });
});

test("mobility signals do not change match status", () => {
  const baseJob = job({ descriptionText: "Build machine learning ranking systems." });
  const unknownDecision = matchJob(baseJob);
  const noDecision = matchJob({
    ...baseJob,
    descriptionText: `${baseJob.descriptionText} No visa sponsorship is available.`,
  });

  assert.equal(unknownDecision.status, "STRONG");
  assert.equal(noDecision.status, "STRONG");
});

test("source policy can require explicit affirmative visa sponsorship", () => {
  const policy: SourceMatchingPolicy = {
    requireCompleteDescription: true,
    requireVisaSponsorship: true,
  };

  assert.equal(matchJob(job({
    descriptionText: "Build machine learning ranking systems. We can sponsor visas.",
  }), policy).status, "STRONG");
  assert.deepEqual(matchJob(job({
    descriptionText: "Build machine learning ranking systems. Relocation support is available.",
  }), policy), {
    status: "EXCLUDED",
    reasons: ["sponsorship:not-explicit"],
  });
  assert.deepEqual(matchJob(job({
    descriptionText: "Build machine learning ranking systems. No visa sponsorship is available.",
  }), policy), {
    status: "EXCLUDED",
    reasons: ["sponsorship:not-offered"],
  });
  assert.deepEqual(matchJob(job({
    descriptionText: "We can sponsor visas. No visa sponsorship is available for this role.",
  }), policy), {
    status: "EXCLUDED",
    reasons: ["sponsorship:not-offered"],
  });
  assert.deepEqual(matchJob(job({
    descriptionCompleteness: "TEASER",
    descriptionText: "We can sponsor visas.",
  }), policy), {
    status: "REVIEW",
    reasons: ["language:description-incomplete"],
  });
});