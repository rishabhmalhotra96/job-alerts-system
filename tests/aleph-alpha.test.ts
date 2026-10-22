import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAshbyResponse } from "../src/ashby.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob } from "../src/domain.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "aleph-alpha-ashby")!;

async function fixture(): Promise<{ jobs: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(
    new URL("./fixtures/aleph-alpha-ashby.json", import.meta.url),
    "utf8",
  )) as { jobs: Array<Record<string, unknown>> };
}

function response(payload: unknown): ShadowHttpResponse {
  const body = JSON.stringify(payload);
  return {
    status: 200,
    contentType: "application/json",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("normalizes Aleph Alpha jobs and enforces Germany and English requirements", async () => {
  const jobs = parseAshbyResponse(
    await fixture(),
    source,
    "2026-09-25T10:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    location: job.locationText,
    countries: job.countryCodes,
    completeness: job.descriptionCompleteness,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "aleph-1",
      location: "Heidelberg | Berlin",
      countries: ["DE"],
      completeness: "FULL",
      status: "STRONG",
      reasons: [
        "title:machine-learning-engineer",
        "skill:machine-learning",
        "location:eligible",
        "seniority:senior",
      ],
    },
    {
      id: "aleph-2",
      location: "London",
      countries: ["GB"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "aleph-3",
      location: "Heidelberg",
      countries: ["DE"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["language:de:required"],
    },
  ]);
});

test("collects Aleph Alpha in one bounded Ashby request", async () => {
  const payload = await fixture();
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return [response(payload)];
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-25T10:00:00Z"),
    1,
    new Map(),
    ["Aleph Alpha"],
  );

  assert.deepEqual(calls, [[source.endpoint]]);
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});