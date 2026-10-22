import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedJob } from "../src/domain.ts";
import { serializeJobContent } from "../src/job-metadata.ts";

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    sourceKey: "example",
    company: "Example",
    sourceJobId: "1",
    title: "Senior Machine Learning Engineer",
    descriptionText: "Build ranking systems.",
    descriptionCompleteness: "FULL",
    locationText: "Berlin, Germany",
    countryCodes: ["DE", "nl", "DE"],
    workplaceType: "Hybrid",
    employmentType: "Full-time",
    publishedAt: "2026-09-15T08:00:00.000Z",
    updatedAt: null,
    canonicalUrl: "https://example.com/jobs/1",
    fetchedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

test("serializes content deterministically while ignoring poll time and set order", () => {
  const first = serializeJobContent(
    job(),
    "STRONG",
    ["location:eligible", "title:machine-learning-engineer"],
    { sponsorship: "unknown", relocation: "unknown" },
  );
  const second = serializeJobContent(
    job({
      countryCodes: ["NL", "de"],
      fetchedAt: "2026-09-16T12:00:00.000Z",
    }),
    "STRONG",
    ["title:machine-learning-engineer", "location:eligible"],
    { sponsorship: "unknown", relocation: "unknown" },
  );

  assert.equal(first, second);
});

test("material fields and ordinary description edits change serialized content", () => {
  const original = serializeJobContent(
    job(),
    "STRONG",
    ["location:eligible"],
    { sponsorship: "unknown", relocation: "unknown" },
  );
  const descriptionEdit = serializeJobContent(
    job({ descriptionText: "Build ranking and forecasting systems." }),
    "STRONG",
    ["location:eligible"],
    { sponsorship: "unknown", relocation: "unknown" },
  );
  const materialEdit = serializeJobContent(
    job({ employmentType: "Contract" }),
    "EXCLUDED",
    ["employment:contract"],
    { sponsorship: "unknown", relocation: "unknown" },
  );

  assert.notEqual(descriptionEdit, original);
  assert.notEqual(materialEdit, original);
});