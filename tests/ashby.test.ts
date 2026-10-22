import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAshbyResponse } from "../src/ashby.ts";
import { collectShadow, type FetchMany } from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";

const source: SourceDefinition = {
  sourceKey: "example-ashby",
  company: "Example",
  adapter: "ASHBY",
  endpoint: "https://api.ashbyhq.com/posting-api/job-board/example",
  allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
  maxJobs: 100,
  maxResponseBytes: 100_000,
  maxDetailJobs: 10,
  maxPages: 1,
};

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL("./fixtures/ashby.json", import.meta.url), "utf8"),
  ) as unknown;
}

test("normalizes Ashby employment and secondary locations", async () => {
  const jobs = parseAshbyResponse(await fixture(), source, "2026-09-16T12:00:00Z");

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].locationText, "London | Munich");
  assert.deepEqual(jobs[0].countryCodes, ["GB", "DE"]);
  assert.equal(jobs[0].employmentType, "FullTime");
  assert.equal(jobs[0].workplaceType, "Hybrid");
  assert.equal(jobs[0].publishedAt, "2026-09-10T08:00:00Z");
  assert.equal(jobs[0].updatedAt, "2026-09-15T10:30:00Z");
});

test("canonicalizes valid Ashby timestamps with numeric UTC offsets", () => {
  const jobs = parseAshbyResponse({ jobs: [{
    id: "job-offset",
    title: "Senior Data Scientist",
    location: "Berlin",
    descriptionPlain: "Build machine learning systems.",
    jobUrl: "https://jobs.ashbyhq.com/example/job-offset",
    publishedAt: "2026-08-28T21:20:40.792+00:00",
  }] }, source, "2026-09-16T12:00:00Z");

  assert.equal(jobs[0].publishedAt, "2026-08-28T21:20:40.792Z");
});

test("uses a configured first-party canonical URL with the stable Ashby ID", () => {
  const supercellSource: SourceDefinition = {
    ...source,
    sourceKey: "supercell-ashby",
    company: "Supercell",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/supercell",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com", "supercell.com"],
    ashbyCanonicalBaseUrl: "https://supercell.com/en/careers",
  };
  const jobs = parseAshbyResponse({ jobs: [
    {
      id: "12cea05e-dcd6-40ac-b218-98e4edc0b9c9",
      title: "AI/ML Engineer",
      location: "Helsinki",
      descriptionPlain: "Build production machine learning and LLM systems.",
      jobUrl: "https://jobs.ashbyhq.com/supercell/12cea05e-dcd6-40ac-b218-98e4edc0b9c9",
    },
    {
      id: "d0b5451c-4d57-4d4b-81da-7330c83f90e7",
      title: "Senior Match-3 Designer, New Game",
      location: "London",
      descriptionPlain: "Design and improve production game systems.",
      jobUrl: "https://jobs.ashbyhq.com/supercell/d0b5451c-4d57-4d4b-81da-7330c83f90e7",
    },
  ] }, supercellSource, "2026-10-14T06:03:45.852Z");

  assert.equal(
    jobs[0].canonicalUrl,
    "https://supercell.com/en/careers/aiml-engineer/12cea05e-dcd6-40ac-b218-98e4edc0b9c9/",
  );
  assert.equal(
    jobs[1].canonicalUrl,
    "https://supercell.com/en/careers/senior-match-3-designer-new-game/d0b5451c-4d57-4d4b-81da-7330c83f90e7/",
  );
});

test("collects Ashby in one request and produces a strong eligible match", async () => {
  const payload = await fixture();
  let calls = 0;
  const fetchMany: FetchMany = () => {
    calls += 1;
    const body = JSON.stringify(payload);
    return [{
      status: 200,
      contentType: "application/json",
      body,
      byteLength: Buffer.byteLength(body),
    }];
  };

  const collection = collectShadow([source], fetchMany);

  assert.equal(calls, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 1,
  });
  assert.equal(collection.candidates.length, 1);
});

test("rejects malformed locations and non-allowlisted links", () => {
  const baseJob = {
    id: "job-1",
    title: "Senior Data Scientist",
    location: "Berlin",
    descriptionPlain: "Data science and machine learning.",
    jobUrl: "https://jobs.ashbyhq.com/example/job-1",
  };
  assert.throws(
    () => parseAshbyResponse({ jobs: [{ ...baseJob, secondaryLocations: {} }] }, source, "2026-09-16T12:00:00Z"),
    /invalid secondaryLocations/,
  );
  assert.throws(
    () => parseAshbyResponse({ jobs: [{ ...baseJob, jobUrl: "https://attacker.example/job-1" }] }, source, "2026-09-16T12:00:00Z"),
    /not allowlisted/,
  );
  assert.throws(
    () => parseAshbyResponse({ jobs: [{ ...baseJob, jobUrl: "https://jobs.ashbyhq.com/example/other-job" }] }, source, "2026-09-16T12:00:00Z"),
    /inconsistent jobUrl/,
  );
  assert.throws(
    () => parseAshbyResponse({ jobs: [{ ...baseJob, updatedAt: "=NOW()" }] }, source, "2026-09-16T12:00:00Z"),
    /invalid updatedAt/,
  );
  assert.throws(
    () => parseAshbyResponse({ jobs: [{ ...baseJob, updatedAt: "2026-09-16" }] }, source, "2026-09-16T12:00:00Z"),
    /invalid updatedAt/,
  );
});