import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob } from "../src/domain.ts";
import { parseLeverResponse } from "../src/lever.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "farfetch-lever")!;

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL("./fixtures/lever.json", import.meta.url),
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

test("normalizes Farfetch Lever jobs and enforces Portugal eligibility", async () => {
  const jobs = parseLeverResponse(await fixture(), source, "2026-09-25T23:50:00Z");

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    countries: job.countryCodes,
    completeness: job.descriptionCompleteness,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "farfetch-data-scientist",
      countries: ["PT"],
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
      id: "farfetch-london-ml",
      countries: ["GB"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "farfetch-portuguese-ai",
      countries: ["PT"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["language:pt:required"],
    },
    {
      id: "farfetch-operations",
      countries: ["PT"],
      completeness: "FULL",
      status: "EXCLUDED",
      reasons: ["title:not-target-family"],
    },
  ]);
});

test("collects Farfetch from one complete Lever response", async () => {
  const payload = await fixture();
  let calls = 0;
  const fetchMany: FetchMany = (requests) => {
    calls += 1;
    assert.deepEqual(requests, [{ url: source.endpoint, method: "get" }]);
    return [response(payload)];
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-25T23:50:00Z"),
    1,
    new Map(),
    ["Farfetch"],
  );

  assert.equal(calls, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 4);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 3,
  });
  assert.deepEqual(collection.candidates.map(({ job, status }) => ({
    id: job.sourceJobId,
    status,
  })), [
    { id: "farfetch-data-scientist", status: "STRONG" },
    { id: "farfetch-london-ml", status: "EXCLUDED" },
    { id: "farfetch-portuguese-ai", status: "EXCLUDED" },
  ]);
  assert.deepEqual(collection.report.unsupportedTargets, []);
});

test("fails oversized responses and caps Lever target processing", async () => {
  const payload = await fixture();
  const oversized = collectShadow(
    [{ ...source, maxResponseBytes: 10 }],
    () => [response(payload)],
  );
  assert.equal(oversized.report.sources[0].status, "FAILED");
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const limited = collectShadow(
    [{ ...source, maxDetailJobs: 1 }],
    () => [response(payload)],
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.equal(limited.report.sources[0].detailedJobs, 1);
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});

test("quarantines an empty Lever feed", () => {
  const collection = collectShadow([source], () => [response([])]);

  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.equal(collection.report.sources[0].listedJobs, 0);
  assert.deepEqual(collection.report.sources[0].warnings, ["COUNT_INTEGRITY_PENDING"]);
});

test("preserves Farfetch state on a validated not-modified response", () => {
  const requests: unknown[] = [];
  const collection = collectShadow(
    [source],
    (batch) => {
      requests.push(...batch);
      return [{
        status: 304,
        contentType: "",
        body: "",
        byteLength: 0,
        etag: "\"farfetch-v2\"",
      }];
    },
    () => new Date("2026-09-25T23:50:00Z"),
    1,
    new Map([[source.sourceKey, {
      lastHealthyCount: 43,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: { etag: "\"farfetch-v1\"", lastModified: null },
      httpValidatorUrl: source.endpoint,
    }]]),
  );

  assert.deepEqual(requests, [{
    url: source.endpoint,
    method: "get",
    ifNoneMatch: "\"farfetch-v1\"",
  }]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 43);
  assert.deepEqual(collection.report.sources[0].warnings, ["NOT_MODIFIED"]);
  assert.deepEqual(collection.candidates, []);
});