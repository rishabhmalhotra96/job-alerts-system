import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectShadow, type FetchMany, type ShadowHttpResponse } from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import { parseBoltResponse } from "../src/bolt.ts";
import { REQUIRED_TARGET_COUNT } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "bolt-test",
  company: "Bolt",
  adapter: "BOLT",
  endpoint: "https://bolt.eu/en/careers/positions/",
  allowedHosts: ["bolt.eu"],
  maxJobs: 300,
  maxResponseBytes: 800_000,
  maxDetailJobs: 20,
  maxPages: 1,
};

const jobs = [{
  id: "7d12f53d-5be7-4e9a-8abe-ebde906589f3",
  header: {
    roleTitle: "AI / Agent Engineer",
    parentTeamTitle: "People & Workplace",
    locations: [{ city: "Tallinn", country: "Estonia", countryCode: "ee" }],
  },
  body: {
    description: "Build AI agents &amp; LLM-powered machine learning automation.",
    jobPostedDate: "$D2026-08-28T00:00:00.000Z",
  },
}];

const boltFixture = await readFile(
  new URL("./fixtures/bolt-listing.html", import.meta.url),
  "utf8",
);

function page(payload: unknown = jobs): string {
  const flight = `e:["$","article",null,{"children":{"parsedJobs":${JSON.stringify(payload)}}}]`;
  return `<html><body><script>self.__next_f.push(${JSON.stringify([1, flight])})</script></body></html>`;
}

test("normalizes Bolt's bounded embedded jobs payload", () => {
  const parsed = parseBoltResponse(boltFixture, source, "2026-09-16T12:00:00Z");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sourceJobId, jobs[0].id);
  assert.equal(parsed[0].title, "AI / Agent Engineer");
  assert.equal(parsed[0].descriptionText, "Build AI agents & LLM-powered machine learning automation.");
  assert.equal(parsed[0].locationText, "Tallinn, Estonia");
  assert.deepEqual(parsed[0].countryCodes, ["EE"]);
  assert.equal(parsed[0].publishedAt, "2026-08-28T00:00:00.000Z");
  assert.equal(parsed[0].canonicalUrl, `https://bolt.eu/en/careers/positions/${jobs[0].id}/`);
});

test("retains jobs with no declared location for review", () => {
  const payload = [{ ...jobs[0], header: { ...jobs[0].header, locations: [] } }];
  const parsed = parseBoltResponse(page(payload), source, "2026-09-16T12:00:00Z");

  assert.equal(parsed[0].locationText, "Unspecified");
  assert.deepEqual(parsed[0].countryCodes, []);
});

test("rejects duplicate identities and malformed payload wrappers", () => {
  assert.throws(() => parseBoltResponse(page([...jobs, ...jobs]), source, "2026-09-16T12:00:00Z"), /duplicate job id/);
  assert.throws(() => parseBoltResponse(page().replace("self.__next_f.push", "window.push"), source, "2026-09-16T12:00:00Z"), /invalid jobs payload wrapper/);
});

test("accepts browser-tolerated content in script closing tags", () => {
  const parsed = parseBoltResponse(
    page().replace("</script>", "</script\t\n data-ignored>"),
    source,
    "2026-09-16T12:00:00Z",
  );

  assert.equal(parsed.length, 1);
});

test("rejects oversized arrays and non-allowlisted canonical hosts", () => {
  assert.throws(
    () => parseBoltResponse(page(jobs), { ...source, maxJobs: 0 }, "2026-09-16T12:00:00Z"),
    /invalid job count/,
  );
  assert.throws(
    () => parseBoltResponse(page(), { ...source, allowedHosts: ["example.com"] }, "2026-09-16T12:00:00Z"),
    /not allowlisted/,
  );
});

test("collects Bolt from one bounded listing response", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    const body = page();
    return [{
      status: 200,
      contentType: "text/html; charset=UTF-8",
      body,
      byteLength: Buffer.byteLength(body),
    } satisfies ShadowHttpResponse];
  };

  const collection = collectShadow([source], fetchMany);

  assert.deepEqual(calls, [[source.endpoint]]);
  assert.equal(collection.report.requiredTargets, REQUIRED_TARGET_COUNT);
  assert.equal(collection.report.sources[0].listedJobs, 1);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 0,
  });
});