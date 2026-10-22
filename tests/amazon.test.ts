import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAmazonSearchRequest,
  parseAmazonSearchPage,
} from "../src/amazon.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpRequest,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";

const source: SourceDefinition = {
  sourceKey: "amazon-test",
  company: "Amazon",
  adapter: "AMAZON",
  endpoint: "https://www.amazon.jobs/en/search.json",
  allowedHosts: ["www.amazon.jobs"],
  maxJobs: 100,
  maxResponseBytes: 100_000,
  maxDetailJobs: 20,
  maxPages: 2,
  searchTerms: ["applied scientist"],
  locationFilters: ["Germany", "Ireland"],
};

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL("./fixtures/amazon-search.json", import.meta.url), "utf8"),
  ) as unknown;
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

test("builds Amazon search with explicit location filters", () => {
  const request = buildAmazonSearchRequest(source, "applied scientist", 10);
  assert.match(request.url, /base_query=applied%20scientist/);
  assert.match(request.url, /location\[\]=Germany/);
  assert.match(request.url, /location\[\]=Ireland/);
  assert.match(request.url, /offset=10/);
  assert.throws(() => buildAmazonSearchRequest(source, "test", 1), /page boundary/);
});

test("normalizes Amazon JSON jobs and eligible ISO-3 countries", async () => {
  const page = parseAmazonSearchPage(await fixture(), source, "2026-09-16T12:00:00Z");
  assert.equal(page.total, 2);
  assert.deepEqual(page.jobs[0].countryCodes, ["DE"]);
  assert.equal(page.jobs[0].descriptionText, "Build machine learning ranking systems.");
  assert.equal(page.jobs[0].canonicalUrl, "https://www.amazon.jobs/en/jobs/101/senior-applied-scientist");
});

test("collects and classifies Amazon jobs without detail requests", async () => {
  const payload = await fixture();
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    return [response(payload)];
  };

  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 1,
  });
});

test("marks Amazon partial when pagination exceeds its cap", () => {
  const fetchMany: FetchMany = () => [response({
    hits: 11,
    jobs: [{
      id: "amazon-101",
      title: "Account Executive",
      description: "Manage accounts.",
      location: "DE, Berlin",
      country_code: "DEU",
      job_path: "/en/jobs/101/account-executive",
      job_schedule_type: "full-time",
    }],
  })];

  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);
  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});

test("rejects unsafe paths and oversized pages", async () => {
  const payload = await fixture() as { hits: number; jobs: Array<Record<string, unknown>> };
  payload.jobs[0].job_path = "https://attacker.example/jobs/101";
  assert.throws(
    () => parseAmazonSearchPage(payload, source, "2026-09-16T12:00:00Z"),
    /unsafe job_path/,
  );
  assert.throws(
    () => parseAmazonSearchPage({ hits: 11, jobs: Array(11).fill({}) }, source, "2026-09-16T12:00:00Z"),
    /exceeds page size/,
  );
});