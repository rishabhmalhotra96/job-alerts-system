import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { buildSeaSearchUrl, parseSeaSearchPage } from "../src/sea.ts";
import type { SourceDefinition } from "../src/domain.ts";

const source: SourceDefinition = {
  sourceKey: "sea-test",
  company: "Sea Group / Shopee",
  adapter: "SEA",
  endpoint: "https://career.sea.com/api/user/job/list",
  allowedHosts: ["career.sea.com"],
  maxJobs: 100,
  maxResponseBytes: 250_000,
  maxDetailJobs: 30,
  maxPages: 8,
  searchTerms: ["ai engineer"],
  locationFilters: ["25"],
};

const seaFixture = JSON.parse(await readFile(
  new URL("./fixtures/sea-search.json", import.meta.url),
  "utf8",
)) as unknown;

const payload = {
  code: 0,
  message: "success",
  data: {
    total_count: 1,
    job_list: [{
      id: 136441,
      job_id: "J02185923",
      job_name: "Senior AI Engineer",
      city_id: 25,
      employment_id: 1,
      sub_team_description: "<p>Build AI products.</p>",
      job_description: "<ul><li>Deploy machine learning systems.</li></ul>",
      requirements: "<p>Production experience &amp; Python.</p>",
    }],
  },
};

function response(value: unknown): ShadowHttpResponse {
  const body = JSON.stringify(value);
  return {
    status: 200,
    contentType: "application/json",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("builds a bounded Sea search with an explicit Singapore city filter", () => {
  const url = buildSeaSearchUrl(source, "ai engineer");
  assert.match(url, /limit=100&offset=0&post_type=1/);
  assert.match(url, /search_content=ai%20engineer/);
  assert.match(url, /city_ids=25/);
  assert.throws(() => buildSeaSearchUrl(source, ""), /must not be empty/);
});

test("normalizes a Sea job and strips all description HTML", () => {
  const page = parseSeaSearchPage(seaFixture, source, "2026-09-16T12:00:00Z");
  assert.equal(page.total, 1);
  assert.equal(page.jobs[0].sourceJobId, "136441");
  assert.equal(page.jobs[0].title, "Senior AI Engineer");
  assert.equal(page.jobs[0].locationText, "Singapore");
  assert.deepEqual(page.jobs[0].countryCodes, ["SG"]);
  assert.equal(page.jobs[0].employmentType, null);
  assert.equal(
    page.jobs[0].descriptionText,
    "Build AI products. Deploy machine learning systems. Production experience & Python.",
  );
  assert.equal(page.jobs[0].canonicalUrl, "https://career.sea.com/position/J02185923");
});

test("normalizes Sea's null job list only for a zero-result search", () => {
  assert.deepEqual(parseSeaSearchPage({
    code: 0,
    data: { total_count: 0, job_list: null },
  }, source, "2026-09-16T12:00:00Z"), { total: 0, jobs: [] });
  assert.throws(
    () => parseSeaSearchPage({
      code: 0,
      data: { total_count: 1, job_list: null },
    }, source, "2026-09-16T12:00:00Z"),
    /invalid count or jobs/,
  );
});

test("rejects malformed, duplicate, and unexpected-city Sea jobs", () => {
  assert.throws(
    () => parseSeaSearchPage({ ...payload, code: 1 }, source, "2026-09-16T12:00:00Z"),
    /invalid shape/,
  );
  assert.throws(
    () => parseSeaSearchPage({
      ...payload,
      data: { ...payload.data, job_list: [payload.data.job_list[0], payload.data.job_list[0]] },
    }, source, "2026-09-16T12:00:00Z"),
    /duplicate job id/,
  );
  assert.throws(
    () => parseSeaSearchPage({
      ...payload,
      data: { ...payload.data, job_list: [{ ...payload.data.job_list[0], city_id: 999 }] },
    }, source, "2026-09-16T12:00:00Z"),
    /unexpected city/,
  );
});

test("collects overlapping Sea searches once without detail requests", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map((request) => request.url));
    return requests.map(() => response(payload));
  };
  const collection = collectShadow([{
    ...source,
    searchTerms: ["ai engineer", "machine learning engineer"],
  }], fetchMany);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(collection.report.sources[0].listedJobs, 1);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 0,
  });
  assert.deepEqual(collection.report.sources[0].warnings, []);
});

test("marks Sea partial when the API reports more jobs than it returns", () => {
  const fetchMany: FetchMany = () => [response({
    ...payload,
    data: { ...payload.data, total_count: 101 },
  })];
  const collection = collectShadow([source], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});