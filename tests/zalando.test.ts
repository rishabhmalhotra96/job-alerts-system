import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { type SourceDefinition } from "../src/domain.ts";
import { MVP_SOURCES } from "../src/sources.ts";
import {
  buildZalandoDetailUrl,
  buildZalandoListingUrl,
  parseZalandoDetail,
  parseZalandoListingPage,
} from "../src/zalando.ts";

const source: SourceDefinition = {
  sourceKey: "zalando-test",
  company: "Zalando",
  adapter: "ZALANDO",
  endpoint: "https://jobs-api.corptech.zalan.do/workday",
  allowedHosts: ["jobs-api.corptech.zalan.do", "jobs.zalando.com"],
  maxJobs: 250,
  maxResponseBytes: 250_000,
  maxDetailJobs: 30,
  maxPages: 3,
};
const listingPayload = JSON.parse(await readFile(
  new URL("./fixtures/zalando-listing.json", import.meta.url),
  "utf8",
)) as unknown;
const detailPayload = JSON.parse(await readFile(
  new URL("./fixtures/zalando-detail.json", import.meta.url),
  "utf8",
)) as unknown;
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "zalando-public-json")!;

function response(body: unknown): ShadowHttpResponse {
  const serialized = JSON.stringify(body);
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: serialized,
    byteLength: Buffer.byteLength(serialized),
  };
}

function listing(id: number, title = "Retail Operations Manager"): Record<string, unknown> {
  return {
    title,
    id: String(id),
    entity: "Zalando SE",
    job_categories: ["Engineering"],
    offices: ["Berlin"],
    experience_level: "Professional Level",
    updated_at: "2026-09-25T02:49:41.643-07:00",
  };
}

function listingPage(data: Record<string, unknown>[], total: number, offset: number) {
  const lastOffset = Math.floor((total - 1) / 100) * 100;
  return {
    data,
    total,
    facets: {},
    first: "/search?q=&filters=%7B%7D&limit=100&offset=0",
    last: `/search?q=&filters=%7B%7D&limit=100&offset=${lastOffset}`,
    ...(offset > 0
      ? { previous: `/search?q=&filters=%7B%7D&limit=100&offset=${offset - 100}` }
      : {}),
    ...(offset < lastOffset
      ? { next: `/search?q=&filters=%7B%7D&limit=100&offset=${offset + 100}` }
      : {}),
  };
}

test("builds bounded Zalando listing and detail URLs", () => {
  assert.equal(
    buildZalandoListingUrl(source, 100),
    "https://jobs-api.corptech.zalan.do/workday/search?q=&filters=%7B%7D&limit=100&offset=100",
  );
  const listing = parseZalandoListingPage(listingPayload, source, 0).listings[0];
  assert.equal(
    buildZalandoDetailUrl(source, listing),
    "https://jobs-api.corptech.zalan.do/workday/jobs/2725175",
  );
  assert.throws(() => buildZalandoListingUrl(source, 1), /offset is invalid/);
});

test("parses a complete Zalando listing page", () => {
  const page = parseZalandoListingPage(listingPayload, source, 0);
  assert.equal(page.total, 2);
  assert.deepEqual(page.listings[0], {
    sourceJobId: "2725175",
    title: "Senior Applied Scientist (all genders)",
    entity: "Zalando SE",
    offices: ["Berlin"],
    updatedAt: "2026-09-25T09:49:41.643Z",
  });

  const payload = structuredClone(listingPayload) as { data: Array<Record<string, unknown>> };
  delete payload.data[1].entity;
  assert.equal(parseZalandoListingPage(payload, source, 0).listings[1].entity, null);
  payload.data[1].entity = 42;
  assert.throws(() => parseZalandoListingPage(payload, source, 0), /invalid entity/);
});

test("normalizes a complete Zalando detail without retaining application fields", () => {
  const listing = parseZalandoListingPage(listingPayload, source, 0).listings[0];
  const job = parseZalandoDetail(detailPayload, listing, source, "2026-09-26T12:00:00Z");

  assert.equal(job.sourceJobId, "2725175");
  assert.equal(job.title, "Senior Applied Scientist (all genders)");
  assert.deepEqual(job.countryCodes, ["DE"]);
  assert.equal(job.employmentType, "Full time");
  assert.equal(job.publishedAt, "2026-09-10T00:00:00.000Z");
  assert.equal(job.updatedAt, "2026-09-25T09:49:41.643Z");
  assert.equal(job.canonicalUrl, "https://jobs.zalando.com/en/jobs/2725175");
  assert.match(job.descriptionText, /machine learning ranking systems/);
  assert.equal("email" in job, false);
});

test("rejects incomplete pagination and mismatched or closed details", () => {
  const page = listingPayload as Record<string, unknown>;
  assert.throws(
    () => parseZalandoListingPage({ ...page, total: 3 }, source, 0),
    /page is incomplete/,
  );
  const listing = parseZalandoListingPage(listingPayload, source, 0).listings[0];
  const detail = detailPayload as Record<string, unknown>;
  assert.throws(
    () => parseZalandoDetail({ ...detail, title: "Other" }, listing, source, "2026-09-26T12:00:00Z"),
    /identity does not match/,
  );
  assert.throws(
    () => parseZalandoDetail({ ...detail, closed: true }, listing, source, "2026-09-26T12:00:00Z"),
    /invalid or closed/,
  );
});

test("collects complete Zalando pages and fetches only candidate details", () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => listing(2_700_000 + index));
  const candidate = listing(2_725_175, "Senior Applied Scientist (all genders)");
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    if (calls.length === 1) {
      return [response(listingPage(firstPage, 101, 0))];
    }
    if (calls.length === 2) {
      return [response(listingPage([candidate], 101, 100))];
    }
    return [response(detailPayload)];
  };

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-26T12:00:00Z"),
    1,
    new Map(),
    ["Zalando"],
  );

  assert.equal(calls.length, 3);
  assert.match(calls[0][0], /offset=0$/);
  assert.match(calls[1][0], /offset=100$/);
  assert.equal(calls[2][0], "https://jobs-api.corptech.zalan.do/workday/jobs/2725175");
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 101);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.equal(collection.candidates.length, 1);
});