import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob } from "../src/domain.ts";
import { parseGreenhouseResponse } from "../src/greenhouse.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "talkdesk-greenhouse")!;

async function fixture(): Promise<{ jobs: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(
    new URL("./fixtures/talkdesk-greenhouse.json", import.meta.url),
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

test("normalizes Talkdesk jobs and enforces Portugal and English requirements", async () => {
  const jobs = parseGreenhouseResponse(
    await fixture(),
    source,
    "2026-09-25T10:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => ({
    id: job.sourceJobId,
    location: job.locationText,
    status: matchJob(job, source.matchingPolicy).status,
    reasons: matchJob(job, source.matchingPolicy).reasons,
  })), [
    {
      id: "9301",
      location: "Porto",
      status: "REVIEW",
      reasons: [
        "title:ai-engineer",
        "skill:machine-learning",
        "location:eligible",
        "employment:unknown",
      ],
    },
    {
      id: "9302",
      location: "Berlin, Germany",
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    },
    {
      id: "9303",
      location: "Portugal",
      status: "EXCLUDED",
      reasons: ["language:pt:required"],
    },
  ]);
});

test("collects Talkdesk from one compact listing and bounded candidate details", async () => {
  const payload = await fixture();
  const listing = {
    jobs: payload.jobs.map(({ content: _content, ...job }) => job),
  };
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(listing)]
      : requests.map(({ url }) => {
          const id = url.split("/").at(-1);
          return response(payload.jobs.find((job) => String(job.id) === id));
        });
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-25T10:00:00Z"),
    1,
    new Map(),
    ["Talkdesk"],
  );

  assert.deepEqual(calls, [
    [source.endpoint],
    [
      `${source.endpoint}/9301`,
      `${source.endpoint}/9302`,
      `${source.endpoint}/9303`,
    ],
  ]);
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 3);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.unsupportedTargets, []);
});