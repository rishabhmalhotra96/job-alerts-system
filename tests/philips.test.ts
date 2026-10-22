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
import { parseWorkdayDetail, parseWorkdayListingPage } from "../src/workday.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "philips-workday")!;

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

test("normalizes Philips jobs and enforces Netherlands and English requirements", async () => {
  const payloads = await fixture("philips-workday-details.json") as unknown[];
  const jobs = payloads.map((payload) => parseWorkdayDetail(
    payload,
    source,
    "2026-09-25T14:00:00Z",
  ));

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    countries: job.countryCodes,
    completeness: job.descriptionCompleteness,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "PH100",
      countries: ["NL"],
      completeness: "FULL",
      status: "STRONG",
      reasons: [
        "title:data-scientist",
        "skill:data-scientist",
        "location:eligible",
        "seniority:senior",
      ],
    },
    {
      id: "PH102",
      countries: ["IN"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "PH103",
      countries: ["NL"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["language:nl:required"],
    },
  ]);
});

test("collects Philips across bounded Workday pages and candidate-only details", async () => {
  const listing = await fixture("philips-workday-listing.json");
  const details = await fixture("philips-workday-details.json") as unknown[];
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    if (calls.length === 1) {
      return [response(listing)];
    }
    if (calls.length === 2) {
      return [response({
        total: 0,
        jobPostings: [{
          title: "Clinical Development Scientist",
          externalPath: "/job/Best/Clinical-Development-Scientist_PH104",
          locationsText: "Best",
        }],
      })];
    }
    return details.map(response);
  };

  const collection = collectShadow(
    [{ ...source, searchTerms: ["ai engineer"], maxPages: 2 }],
    fetchMany,
    () => new Date("2026-09-25T14:00:00Z"),
    1,
    new Map(),
    ["Philips"],
  );

  assert.equal(parseWorkdayListingPage(listing).postings.length, 4);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2).map(([request]) => JSON.parse(request.body!).offset), [0, 20]);
  assert.deepEqual(calls[2].map(({ url }) => url), [
    `${source.endpoint}/job/Best/Senior-Data-Scientist_PH100`,
    `${source.endpoint}/job/Bangalore/Senior-Machine-Learning-Engineer_PH102`,
    `${source.endpoint}/job/Best/Senior-AI-Engineer_PH103`,
  ]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 5);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 4,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});