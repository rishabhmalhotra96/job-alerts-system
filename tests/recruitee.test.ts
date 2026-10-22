import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob, type SourceDefinition } from "../src/domain.ts";
import { parseRecruiteeResponse } from "../src/recruitee.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "example-recruitee",
  company: "PatSnap",
  adapter: "RECRUITEE",
  endpoint: "https://patsnap.recruitee.com/api/offers",
  allowedHosts: ["patsnap.recruitee.com", "careers.patsnap.com"],
  maxJobs: 50,
  maxResponseBytes: 1_000_000,
  maxDetailJobs: 30,
  maxPages: 1,
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "patsnap-recruitee")!;

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL("./fixtures/recruitee.json", import.meta.url),
    "utf8",
  )) as unknown;
}

function response(payload: unknown): ShadowHttpResponse {
  const body = JSON.stringify(payload);
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("normalizes published Recruitee offers with all structured locations", async () => {
  const jobs = parseRecruiteeResponse(await fixture(), source, "2026-09-25T12:00:00Z");

  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    sourceKey: "example-recruitee",
    company: "PatSnap",
    sourceJobId: "2711723",
    title: "Senior Machine Learning Engineer (AI Agent)",
    descriptionText: "Build machine learning and LLM agent systems.\nProfessional English is required.",
    descriptionCompleteness: "FULL",
    locationText: "Singapore",
    countryCodes: ["SG"],
    workplaceType: "On-site",
    employmentType: "fulltime_permanent",
    publishedAt: "2026-08-16T05:50:45.000Z",
    updatedAt: "2026-08-19T02:36:14.000Z",
    canonicalUrl: "https://careers.patsnap.com/o/senior-machine-learning-engineer-ai-agent",
    fetchedAt: "2026-09-25T12:00:00Z",
  });
  assert.deepEqual(jobs[1].workplaceType, "Hybrid");
  assert.deepEqual(jobs[2].locationText, "Toronto | Vancouver");
  assert.deepEqual(jobs[2].countryCodes, ["CA"]);
});

test("normalizes Recruitee offers without the browser URL API", async () => {
  const payload = await fixture();
  const originalUrl = globalThis.URL;
  Object.defineProperty(globalThis, "URL", { configurable: true, value: undefined });
  try {
    assert.doesNotThrow(() => parseRecruiteeResponse(
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

test("rejects malformed Recruitee identities and incomplete records", async () => {
  const payload = await fixture() as { offers: Array<Record<string, unknown>> };
  assert.throws(
    () => parseRecruiteeResponse({ offers: [payload.offers[0], payload.offers[0]] }, source, "2026-09-25T12:00:00Z"),
    /duplicate offer id/,
  );
  assert.throws(
    () => parseRecruiteeResponse({ offers: [{ ...payload.offers[0], status: "draft" }] }, source, "2026-09-25T12:00:00Z"),
    /not published/,
  );
  assert.throws(
    () => parseRecruiteeResponse({ offers: [{ ...payload.offers[0], company_name: "Other" }] }, source, "2026-09-25T12:00:00Z"),
    /unexpected company_name/,
  );
  assert.throws(
    () => parseRecruiteeResponse({ offers: [{ ...payload.offers[0], careers_url: "https:\/\/careers.patsnap.com\/o\/wrong" }] }, source, "2026-09-25T12:00:00Z"),
    /mismatched careers_url/,
  );
  assert.throws(
    () => parseRecruiteeResponse({ offers: [{ ...payload.offers[0], published_at: "2026-08-16" }] }, source, "2026-09-25T12:00:00Z"),
    /invalid published_at/,
  );
  assert.throws(
    () => parseRecruiteeResponse({ offers: [{ ...payload.offers[0], requirements: "" }] }, source, "2026-09-25T12:00:00Z"),
    /invalid requirements/,
  );
  assert.throws(
    () => parseRecruiteeResponse(payload, { ...source, maxJobs: 1 }, "2026-09-25T12:00:00Z"),
    /exceeds maxJobs/,
  );
});

test("enforces PatSnap Singapore geography and language requirements", async () => {
  const jobs = parseRecruiteeResponse(await fixture(), configuredSource, "2026-09-25T12:00:00Z");

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    status: matchJob(job, configuredSource.matchingPolicy).status,
    reasons: matchJob(job, configuredSource.matchingPolicy).reasons,
  })), [
    {
      id: "2711723",
      status: "STRONG",
      reasons: [
        "title:machine-learning-engineer",
        "skill:machine-learning",
        "location:eligible",
        "seniority:senior",
      ],
    },
    {
      id: "2711721",
      status: "EXCLUDED",
      reasons: ["language:zh:required"],
    },
    {
      id: "2758713",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
  ]);
});

test("collects Recruitee from one complete response without detail requests", async () => {
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
    ["PatSnap"],
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

test("fails oversized responses and caps Recruitee target processing", async () => {
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

test("quarantines an empty Recruitee feed", () => {
  const collection = collectShadow([configuredSource], () => [response({ offers: [] })]);

  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.equal(collection.report.sources[0].listedJobs, 0);
  assert.deepEqual(collection.report.sources[0].warnings, ["COUNT_INTEGRITY_PENDING"]);
});

test("preserves Recruitee state on a validated not-modified response", () => {
  const collection = collectShadow(
    [configuredSource],
    () => [{
      status: 304,
      contentType: "",
      body: "",
      byteLength: 0,
      etag: "\"patsnap-v2\"",
    }],
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map([[configuredSource.sourceKey, {
      lastHealthyCount: 41,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: { etag: "\"patsnap-v1\"", lastModified: null },
      httpValidatorUrl: configuredSource.endpoint,
    }]]),
  );

  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 41);
  assert.deepEqual(collection.report.sources[0].warnings, ["NOT_MODIFIED"]);
  assert.deepEqual(collection.candidates, []);
});