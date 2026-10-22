import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob, type SourceDefinition } from "../src/domain.ts";
import { parseJsonFeedResponse } from "../src/json-feed.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "example-json-feed",
  company: "Boozt",
  adapter: "JSON_FEED",
  endpoint: "https://careers.booztgroup.com/jobs.json",
  allowedHosts: ["careers.booztgroup.com"],
  maxJobs: 25,
  maxResponseBytes: 150_000,
  maxDetailJobs: 25,
  maxPages: 1,
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "boozt-json-feed")!;

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL("./fixtures/json-feed.json", import.meta.url),
    "utf8",
  )) as unknown;
}

function response(payload: unknown): ShadowHttpResponse {
  const body = JSON.stringify(payload);
  return {
    status: 200,
    contentType: "application/feed+json; charset=utf-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("normalizes complete JSON Feed items and structured locations", async () => {
  const jobs = parseJsonFeedResponse(await fixture(), source, "2026-09-25T12:00:00Z");

  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    sourceKey: "example-json-feed",
    company: "Boozt",
    sourceJobId: "11111111-1111-4111-8111-111111111111",
    title: "Senior Machine Learning Engineer",
    descriptionText: "Build machine learning ranking systems. Professional English is required.",
    descriptionCompleteness: "FULL",
    locationText: "Copenhagen | Aarhus",
    countryCodes: ["DK"],
    workplaceType: null,
    employmentType: null,
    publishedAt: "2026-09-20T07:45:28.000Z",
    updatedAt: "2026-09-21T08:45:28.000Z",
    canonicalUrl: "https://careers.booztgroup.com/jobs/9000001-senior-machine-learning-engineer",
    fetchedAt: "2026-09-25T12:00:00Z",
  });
});

test("normalizes JSON Feed items without the browser URL API", async () => {
  const payload = await fixture();
  const originalUrl = globalThis.URL;
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    assert.doesNotThrow(() => parseJsonFeedResponse(
      payload,
      source,
      "2026-09-25T12:00:00Z",
    ));
  } finally {
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: originalUrl,
      writable: true,
    });
  }
});

test("rejects pagination, duplicate IDs, inconsistent metadata, and unsafe links", async () => {
  const payload = await fixture() as { items: Array<Record<string, unknown>> };
  assert.throws(
    () => parseJsonFeedResponse({ ...payload, next_url: source.endpoint }, source, "2026-09-25T12:00:00Z"),
    /incomplete or invalid/,
  );
  assert.throws(
    () => parseJsonFeedResponse({ ...payload, items: [payload.items[0], payload.items[0]] }, source, "2026-09-25T12:00:00Z"),
    /duplicate item id/,
  );
  const firstPosting = payload.items[0]._jobposting as Record<string, unknown>;
  assert.throws(
    () => parseJsonFeedResponse({ ...payload, items: [{
      ...payload.items[0],
      _jobposting: { ...firstPosting, title: "Other" },
    }] }, source, "2026-09-25T12:00:00Z"),
    /inconsistent JobPosting/,
  );
  assert.throws(
    () => parseJsonFeedResponse({ ...payload, items: [{
      ...payload.items[0],
      url: "https://evil.example/jobs/9000001-senior-machine-learning-engineer",
    }] }, source, "2026-09-25T12:00:00Z"),
    /not allowlisted/,
  );
  assert.throws(
    () => parseJsonFeedResponse({ ...payload, items: [{
      ...payload.items[0],
      url: "https://careers.booztgroup.com/jobs/9999999-wrong",
    }] }, source, "2026-09-25T12:00:00Z"),
    /mismatched url/,
  );
  assert.throws(
    () => parseJsonFeedResponse(payload, { ...source, maxJobs: 1 }, "2026-09-25T12:00:00Z"),
    /exceeds maxJobs/,
  );
});

test("enforces Boozt Denmark geography and language requirements", async () => {
  const jobs = parseJsonFeedResponse(await fixture(), configuredSource, "2026-09-25T12:00:00Z");

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    status: matchJob(job, configuredSource.matchingPolicy).status,
    reasons: matchJob(job, configuredSource.matchingPolicy).reasons,
  })), [
    {
      id: "11111111-1111-4111-8111-111111111111",
      status: "REVIEW",
      reasons: [
        "title:machine-learning-engineer",
        "skill:machine-learning",
        "location:eligible",
        "employment:unknown",
      ],
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      status: "EXCLUDED",
      reasons: ["language:da:required"],
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
  ]);
});

test("collects JSON Feed in one request without detail fetches", async () => {
  const payload = await fixture();
  let calls = 0;
  const fetchMany: FetchMany = (requests) => {
    calls += 1;
    assert.deepEqual(requests, [{ url: configuredSource.endpoint, method: "get" }]);
    return [response(payload)];
  };

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Boozt"],
  );

  assert.equal(calls, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});

test("fails oversized responses and caps JSON Feed target processing", async () => {
  const payload = await fixture();
  const oversized = collectShadow(
    [{ ...configuredSource, maxResponseBytes: 10 }],
    () => [response(payload)],
  );
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const limited = collectShadow(
    [{ ...configuredSource, maxDetailJobs: 1 }],
    () => [response(payload)],
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.equal(limited.report.sources[0].detailedJobs, 1);
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});

test("quarantines an empty JSON Feed", () => {
  const collection = collectShadow([configuredSource], () => [response({
    version: "https://jsonfeed.org/version/1.1",
    title: "Boozt",
    home_page_url: "https://careers.booztgroup.com/jobs",
    feed_url: configuredSource.endpoint,
    items: [],
  })]);

  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.equal(collection.report.sources[0].listedJobs, 0);
  assert.deepEqual(collection.report.sources[0].warnings, ["COUNT_INTEGRITY_PENDING"]);
});

test("preserves JSON Feed state on a validated not-modified response", () => {
  const requests: unknown[] = [];
  const collection = collectShadow(
    [configuredSource],
    (batch) => {
      requests.push(...batch);
      return [{
        status: 304,
        contentType: "",
        body: "",
        byteLength: 0,
        etag: "W/\"boozt-v2\"",
      }];
    },
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map([[configuredSource.sourceKey, {
      lastHealthyCount: 6,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: { etag: "W/\"boozt-v1\"", lastModified: null },
      httpValidatorUrl: configuredSource.endpoint,
    }]]),
  );

  assert.deepEqual(requests, [{
    url: configuredSource.endpoint,
    method: "get",
    ifNoneMatch: "W/\"boozt-v1\"",
  }]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 6);
  assert.deepEqual(collection.report.sources[0].warnings, ["NOT_MODIFIED"]);
  assert.deepEqual(collection.candidates, []);
});