import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SourceDefinition } from "../src/domain.ts";
import { parseLeverResponse } from "../src/lever.ts";

const source: SourceDefinition = {
  sourceKey: "example-lever",
  company: "Example",
  adapter: "LEVER",
  endpoint: "https://api.lever.co/v0/postings/example?mode=json",
  allowedHosts: ["api.lever.co", "jobs.lever.co"],
  maxJobs: 100,
  maxResponseBytes: 750_000,
  maxDetailJobs: 30,
  maxPages: 1,
};

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL("./fixtures/lever.json", import.meta.url),
    "utf8",
  )) as unknown;
}

test("normalizes complete Lever postings", async () => {
  const jobs = parseLeverResponse(await fixture(), source, "2026-09-25T23:45:00Z");

  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs[0], {
    sourceKey: "example-lever",
    company: "Example",
    sourceJobId: "farfetch-data-scientist",
    title: "Senior Data Scientist",
    descriptionText: "Join our Porto data team.\nWHAT YOU WILL DO Build machine learning products.\nWHO YOU ARE Professional English is required.",
    descriptionCompleteness: "FULL",
    locationText: "Porto",
    countryCodes: ["PT"],
    workplaceType: "hybrid",
    employmentType: "Full-time",
    publishedAt: "2026-09-19T12:00:00.000Z",
    updatedAt: null,
    canonicalUrl: "https://jobs.lever.co/farfetch/farfetch-data-scientist",
    fetchedAt: "2026-09-25T23:45:00Z",
  });
});

test("rejects duplicate IDs, malformed locations, and unsafe URLs", async () => {
  const payload = await fixture() as Array<Record<string, unknown>>;
  assert.throws(
    () => parseLeverResponse({}, source, "2026-09-25T23:45:00Z"),
    /must be an array/,
  );
  assert.throws(
    () => parseLeverResponse([payload[0], payload[0]], source, "2026-09-25T23:45:00Z"),
    /duplicate job id/,
  );
  assert.throws(
    () => parseLeverResponse([{ ...payload[0], categories: {} }], source, "2026-09-25T23:45:00Z"),
    /invalid allLocations/,
  );
  assert.throws(
    () => parseLeverResponse([{
      ...payload[0],
      hostedUrl: "https://attacker.example/farfetch-data-scientist",
    }], source, "2026-09-25T23:45:00Z"),
    /not allowlisted/,
  );
});

test("rejects over-limit and empty-description Lever responses", async () => {
  const payload = await fixture() as Array<Record<string, unknown>>;
  assert.throws(
    () => parseLeverResponse(payload, { ...source, maxJobs: 1 }, "2026-09-25T23:45:00Z"),
    /exceeds maxJobs/,
  );
  assert.throws(
    () => parseLeverResponse([{
      ...payload[0],
      descriptionPlain: "",
      descriptionBodyPlain: "",
      lists: [],
    }], source, "2026-09-25T23:45:00Z"),
    /no complete description/,
  );
});

test("uses complete Lever HTML when generated plain text is empty", async () => {
  const payload = await fixture() as Array<Record<string, unknown>>;
  const jobs = parseLeverResponse([{
    ...payload[0],
    descriptionPlain: "",
    descriptionBodyPlain: "",
    description: "<p>Build machine learning systems.</p>",
    lists: [],
  }], source, "2026-09-25T23:45:00Z");

  assert.equal(jobs[0].descriptionText, "Build machine learning systems.");
});

test("uses an exact source-configured country fallback for a regional location", async () => {
  const payload = await fixture() as Array<Record<string, unknown>>;
  const europeJob = {
    ...payload[0],
    country: null,
    categories: {
      ...(payload[0].categories as Record<string, unknown>),
      location: "Europe",
      allLocations: ["Europe"],
    },
  };
  const quantCoSource: SourceDefinition = {
    ...source,
    leverLocationCountryCodes: { Europe: ["DE", "GB", "CH"] },
  };

  const jobs = parseLeverResponse([europeJob], quantCoSource, "2026-09-25T23:45:00Z");

  assert.equal(jobs[0].locationText, "Europe");
  assert.deepEqual(jobs[0].countryCodes, ["DE", "GB", "CH"]);
  assert.throws(
    () => parseLeverResponse([europeJob], source, "2026-09-25T23:45:00Z"),
    /invalid country/,
  );
});