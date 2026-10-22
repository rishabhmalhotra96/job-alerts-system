import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import { parseGreenhouseResponse } from "../src/greenhouse.ts";

const source: SourceDefinition = {
  sourceKey: "agoda-greenhouse",
  company: "Agoda",
  adapter: "GREENHOUSE",
  endpoint: "https://boards-api.greenhouse.io/v1/boards/agoda/jobs",
  allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
  maxJobs: 500,
  maxResponseBytes: 500_000,
  maxDetailJobs: 30,
  maxPages: 1,
};

async function fixture(): Promise<{ jobs: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(
    new URL("./fixtures/agoda-greenhouse.json", import.meta.url),
    "utf8",
  )) as { jobs: Array<Record<string, unknown>> };
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

test("normalizes a sanitized Agoda Greenhouse response", async () => {
  const jobs = parseGreenhouseResponse(
    await fixture(),
    source,
    "2026-09-16T09:00:00Z",
  );

  assert.equal(jobs.length, 2);
  assert.deepEqual({
    sourceKey: jobs[0].sourceKey,
    company: jobs[0].company,
    sourceJobId: jobs[0].sourceJobId,
    title: jobs[0].title,
    locationText: jobs[0].locationText,
    canonicalUrl: jobs[0].canonicalUrl,
  }, {
    sourceKey: "agoda-greenhouse",
    company: "Agoda",
    sourceJobId: "9101",
    title: "Senior Machine Learning Engineer",
    locationText: "Singapore",
    canonicalUrl: "https://job-boards.greenhouse.io/agoda/jobs/9101",
  });
});

test("collects Agoda with one compact listing and candidate-only detail request", async () => {
  const payload = await fixture();
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(payload)]
      : [response(payload.jobs[0])];
  };
  const times = [
    new Date("2026-09-16T09:00:00Z"),
    new Date("2026-09-16T09:05:00Z"),
  ];

  const collection = collectShadow(
    [source],
    fetchMany,
    () => times.shift()!,
    29,
    new Map(),
    ["Agoda"],
  );

  assert.deepEqual(calls, [
    [source.endpoint],
    [`${source.endpoint}/9101`],
  ]);
  assert.deepEqual(collection.report.unsupportedTargets, []);
  assert.equal(collection.report.sources[0].listedJobs, 2);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.equal(collection.candidates.length, 1);
  assert.equal(collection.candidates[0].status, "REVIEW");
  assert.match(collection.candidates[0].reasons.join(","), /location:eligible/);
  assert.match(collection.candidates[0].reasons.join(","), /employment:unknown/);
});

test("rejects an Agoda job link outside the static Greenhouse allowlist", async () => {
  const payload = await fixture();
  payload.jobs[0].absolute_url = "https://attacker.example/agoda/jobs/9101";

  assert.throws(
    () => parseGreenhouseResponse(payload, source, "2026-09-16T09:00:00Z"),
    /not allowlisted/,
  );
});
