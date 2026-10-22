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

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "shell-workday")!;

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

test("normalizes Shell jobs and enforces Netherlands and English requirements", async () => {
  const payloads = await fixture("shell-workday-details.json") as unknown[];
  const jobs = payloads.map((payload) => parseWorkdayDetail(
    payload,
    source,
    "2026-09-25T12:00:00Z",
  ));

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    countries: job.countryCodes,
    completeness: job.descriptionCompleteness,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "SH100",
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
      id: "SH102",
      countries: ["IN"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "SH103",
      countries: ["NL"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["language:nl:required"],
    },
  ]);
});

test("collects Shell across Workday pages with zeroed later-page totals", async () => {
  const listing = await fixture("shell-workday-listing.json");
  const details = await fixture("shell-workday-details.json") as unknown[];
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
          title: "Marine Technical Advisor",
          externalPath: "/job/Rotterdam/Marine-Technical-Advisor_SH104",
          locationsText: "Rotterdam",
        }],
      })];
    }
    return details.map(response);
  };

  const collection = collectShadow(
    [{ ...source, searchTerms: ["ai engineer"], maxPages: 2 }],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Shell"],
  );

  assert.equal(parseWorkdayListingPage(listing).postings.length, 4);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2).map(([request]) => JSON.parse(request.body!).offset), [0, 20]);
  assert.deepEqual(calls[2].map(({ url }) => url), [
    `${source.endpoint}/job/Rotterdam/Senior-Data-Scientist_SH100`,
    `${source.endpoint}/job/Bangalore/Senior-Machine-Learning-Engineer_SH102`,
    `${source.endpoint}/job/Rotterdam/Senior-AI-Engineer_SH103`,
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