import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob } from "../src/domain.ts";
import { parseGreenhouseResponse } from "../src/greenhouse.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "relex-greenhouse")!;

async function fixture(): Promise<{ jobs: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(
    new URL("./fixtures/relex-greenhouse.json", import.meta.url),
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

test("normalizes RELEX jobs and enforces Finland and English requirements", async () => {
  const jobs = parseGreenhouseResponse(
    await fixture(),
    source,
    "2026-09-25T23:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    location: job.locationText,
    completeness: job.descriptionCompleteness,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "9701",
      location: "Helsinki, Finland",
      completeness: "FULL",
      status: "REVIEW",
      reasons: [
        "title:machine-learning-engineer",
        "skill:machine-learning",
        "location:eligible",
        "employment:unknown",
      ],
    },
    {
      id: "9702",
      location: "Berlin, Germany",
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "9703",
      location: "Helsinki, Finland",
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["language:fi:required"],
    },
  ]);
});

test("collects RELEX from one compact listing and bounded candidate details", async () => {
  const payload = await fixture();
  const listing = {
    jobs: payload.jobs.map(({ content: _content, ...job }) => job),
  };
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(listing)]
      : requests.map(({ url }) => {
          const id = url.split("/").at(-1);
          return response(payload.jobs.find((job) => String(job.id) === id));
        });
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-25T23:00:00Z"),
    1,
    new Map(),
    ["RELEX"],
  );

  assert.deepEqual(calls, [
    [source.endpoint],
    [
      `${source.endpoint}/9701`,
      `${source.endpoint}/9702`,
      `${source.endpoint}/9703`,
    ],
  ]);
  assert.equal(source.maxDetailJobs, 30);
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});