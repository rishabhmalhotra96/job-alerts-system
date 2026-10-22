import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpRequest,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob } from "../src/domain.ts";
import { MVP_SOURCES } from "../src/sources.ts";
import { hasRequiredWorkdayAttribution, parseWorkdayDetail } from "../src/workday.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "bbva-ai-factory-workday")!;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    "utf8",
  )) as unknown;
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

test("normalizes only explicitly attributed BBVA AI Factory details", async () => {
  const details = await fixture("bbva-workday-details.json") as unknown[];
  const jobs = details.map((detail) => parseWorkdayDetail(
    detail,
    source,
    "2026-09-25T23:30:00Z",
  ));

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    countries: job.countryCodes,
    attributed: hasRequiredWorkdayAttribution(job, source),
  })), [
    { id: "JR100", countries: ["ES"], attributed: true },
    { id: "JR101", countries: ["ES"], attributed: false },
  ]);
  assert.deepEqual(matchJob(jobs[0], source.matchingPolicy), {
    status: "STRONG",
    reasons: [
      "title:data-scientist",
      "skill:data-scientist",
      "location:eligible",
      "seniority:senior",
    ],
  });
});

test("collects the complete Spain facet and excludes generic BBVA details", async () => {
  const listings = await fixture("bbva-workday-listings.json") as unknown[];
  const details = await fixture("bbva-workday-details.json") as unknown[];
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    if (calls.length === 1) {
      return [response(listings[0])];
    }
    if (calls.length === 2) {
      return [response(listings[1])];
    }
    return details.map(response);
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-25T23:30:00Z"),
    1,
    new Map(),
    ["BBVA AI Factory"],
  );

  assert.deepEqual(calls.slice(0, 2).map(([request]) => {
    const body = JSON.parse(request.body!);
    return { offset: body.offset, appliedFacets: body.appliedFacets };
  }), [
    { offset: 0, appliedFacets: source.workdayAppliedFacets },
    { offset: 20, appliedFacets: source.workdayAppliedFacets },
  ]);
  assert.deepEqual(calls[2].map(({ url }) => url), [
    `${source.endpoint}/job/28050-MADRID-Madrid/Senior-Data-Scientist_JR100`,
    `${source.endpoint}/job/28050-MADRID-Madrid/Senior-Machine-Learning-Engineer_JR101`,
  ]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.candidates.map(({ job }) => job.sourceJobId), ["JR100"]);
  assert.deepEqual(collection.report.unsupportedTargets, []);
});