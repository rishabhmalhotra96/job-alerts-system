import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAmdResponse } from "../src/amd.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob, type SourceDefinition } from "../src/domain.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "example-amd",
  company: "AMD",
  adapter: "AMD",
  endpoint: "https://careers.amd.com/api/jobs?country=Finland&page=1&sortBy=relevance&descending=false&internal=false",
  allowedHosts: ["careers.amd.com"],
  maxJobs: 10,
  maxResponseBytes: 250_000,
  maxDetailJobs: 10,
  maxPages: 1,
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "amd-finland-json")!;

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL("./fixtures/amd.json", import.meta.url),
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

test("normalizes active AMD jobs and first-party canonical URLs", async () => {
  const jobs = parseAmdResponse(await fixture(), source, "2026-09-25T23:55:00Z");

  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    sourceKey: "example-amd",
    company: "AMD",
    sourceJobId: "92001",
    title: "Senior AI Engineer",
    descriptionText: "Build machine learning systems. Professional English is required.",
    descriptionCompleteness: "FULL",
    locationText: "Helsinki, Finland",
    countryCodes: ["FI"],
    workplaceType: null,
    employmentType: "FULL_TIME",
    publishedAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-21T09:30:00.000Z",
    canonicalUrl: "https://careers.amd.com/careers-home/jobs/92001",
    fetchedAt: "2026-09-25T23:55:00Z",
  });
});

test("normalizes AMD jobs without the browser URL API", async () => {
  const payload = await fixture();
  const originalUrl = globalThis.URL;
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    assert.doesNotThrow(() => parseAmdResponse(
      payload,
      source,
      "2026-09-25T23:55:00Z",
    ));
  } finally {
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: originalUrl,
      writable: true,
    });
  }
});

test("rejects incomplete pagination, duplicate IDs, and mismatched slugs", async () => {
  const payload = await fixture() as {
    jobs: Array<{ data: Record<string, unknown> }>;
    totalCount: number;
    count: number;
  };
  assert.throws(
    () => parseAmdResponse({ ...payload, totalCount: 5 }, source, "2026-09-25T23:55:00Z"),
    /incomplete or invalid pagination/,
  );
  assert.throws(
    () => parseAmdResponse({
      ...payload,
      jobs: [payload.jobs[0], payload.jobs[0]],
      totalCount: 2,
      count: 2,
    }, source, "2026-09-25T23:55:00Z"),
    /duplicate job id/,
  );
  assert.throws(
    () => parseAmdResponse({
      jobs: [{ data: { ...payload.jobs[0].data, slug: "99999" } }],
      totalCount: 1,
      count: 1,
    }, source, "2026-09-25T23:55:00Z"),
    /mismatched slug/,
  );
  assert.throws(
    () => parseAmdResponse(payload, { ...source, maxJobs: 1 }, "2026-09-25T23:55:00Z"),
    /exceeds maxJobs/,
  );
  assert.throws(
    () => parseAmdResponse({
      jobs: [{ data: { ...payload.jobs[0].data, update_date: "2026-09-21" } }],
      totalCount: 1,
      count: 1,
    }, source, "2026-09-25T23:55:00Z"),
    /invalid update_date/,
  );
  assert.throws(
    () => parseAmdResponse({
      jobs: [{ data: { ...payload.jobs[0].data, description: "" } }],
      totalCount: 1,
      count: 1,
    }, source, "2026-09-25T23:55:00Z"),
    /invalid description/,
  );
});

test("enforces AMD Finland geography and language requirements", async () => {
  const jobs = parseAmdResponse(
    await fixture(),
    configuredSource,
    "2026-09-25T23:55:00Z",
  );

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    status: matchJob(job, configuredSource.matchingPolicy).status,
    reasons: matchJob(job, configuredSource.matchingPolicy).reasons,
  })), [
    {
      id: "92001",
      status: "STRONG",
      reasons: [
        "title:ai-engineer",
        "skill:machine-learning",
        "location:eligible",
        "seniority:senior",
      ],
    },
    {
      id: "92002",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "92003",
      status: "EXCLUDED",
      reasons: ["language:fi:required"],
    },
  ]);
});

test("collects AMD from one complete response without detail requests", async () => {
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
    () => new Date("2026-09-25T23:55:00Z"),
    1,
    new Map(),
    ["AMD"],
  );

  assert.equal(calls, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});

test("fails oversized responses and caps AMD target processing", async () => {
  const payload = await fixture();
  const oversized = collectShadow(
    [{ ...configuredSource, maxResponseBytes: 10 }],
    () => [response(payload)],
  );
  assert.equal(oversized.report.sources[0].status, "FAILED");
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const limited = collectShadow(
    [{ ...configuredSource, maxDetailJobs: 1 }],
    () => [response(payload)],
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.equal(limited.report.sources[0].detailedJobs, 1);
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});

test("quarantines an empty AMD feed", () => {
  const collection = collectShadow([configuredSource], () => [response({
    jobs: [],
    locations: [],
    totalCount: 0,
    count: 0,
  })]);

  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.equal(collection.report.sources[0].listedJobs, 0);
  assert.deepEqual(collection.report.sources[0].warnings, ["COUNT_INTEGRITY_PENDING"]);
});

test("preserves AMD state on a validated not-modified response", () => {
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
        etag: "\"amd-v2\"",
      }];
    },
    () => new Date("2026-09-25T23:55:00Z"),
    1,
    new Map([[configuredSource.sourceKey, {
      lastHealthyCount: 4,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: { etag: "\"amd-v1\"", lastModified: null },
      httpValidatorUrl: configuredSource.endpoint,
    }]]),
  );

  assert.deepEqual(requests, [{
    url: configuredSource.endpoint,
    method: "get",
    ifNoneMatch: "\"amd-v1\"",
  }]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 4);
  assert.deepEqual(collection.report.sources[0].warnings, ["NOT_MODIFIED"]);
  assert.deepEqual(collection.candidates, []);
});