import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob, type SourceDefinition } from "../src/domain.ts";
import { parseBecDetail, parseBecListing } from "../src/bec.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "bec-test",
  company: "BEC Financial Technology",
  adapter: "BEC",
  endpoint: "https://candidate.hr-manager.net/vacancies/list.aspx?customer=bec",
  allowedHosts: ["candidate.hr-manager.net"],
  maxJobs: 50,
  maxResponseBytes: 1_000_000,
  maxDetailJobs: 30,
  maxPages: 1,
  locationFilters: ["denmark"],
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "bec-vacancies")!;
const listingHtml = await readFile(new URL("./fixtures/bec-listing.html", import.meta.url), "utf8");
const detailHtml = await readFile(new URL("./fixtures/bec-detail.html", import.meta.url), "utf8");

function response(body: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

function denmarkDetail(overrides = ""): string {
  return detailHtml
    .replaceAll("71567", "71600")
    .replaceAll("9752", "9700")
    .replaceAll("AI engineer (senior)", "Senior Data Scientist")
    .replace("Warsaw", "Roskilde")
    .replace("Employment contract", "Permanent")
    .replace("Professional English is required.", overrides || "Professional English is required.");
}

test("parses complete BEC listing identities and prefilters target titles", () => {
  const parsed = parseBecListing(listingHtml, source);

  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.listings.map(({ sourceJobId, departmentId, title }) => ({ sourceJobId, departmentId, title })), [
    { sourceJobId: "71567", departmentId: "9752", title: "AI engineer (senior)" },
    { sourceJobId: "71600", departmentId: "9700", title: "Senior Data Scientist" },
  ]);
});

test("normalizes complete Talentech detail metadata without inferring location", () => {
  const listing = parseBecListing(listingHtml, source).listings[0];
  const job = parseBecDetail(detailHtml, listing, source, "2026-09-25T12:00:00Z");

  assert.equal(job.sourceJobId, "71567");
  assert.equal(job.title, "AI engineer (senior)");
  assert.equal(job.locationText, "Warsaw");
  assert.deepEqual(job.countryCodes, ["PL"]);
  assert.equal(job.employmentType, "Employment contract");
  assert.equal(job.publishedAt, "2026-07-03T07:37:32.000Z");
  assert.equal(job.updatedAt, "2026-09-21T08:42:12.000Z");
  assert.match(job.descriptionText, /generative AI systems/);

  const mixed = parseBecDetail(
    detailHtml.replace("Warsaw", "Roskilde, Warsaw"),
    listing,
    source,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(mixed.countryCodes, ["DK", "PL"]);
});

test("rejects malformed listing and inconsistent detail identity", () => {
  assert.throws(
    () => parseBecListing(listingHtml.replace("candidate.hr-manager.net", "evil.example"), source),
    /invalid entry count|not allowlisted/,
  );
  assert.throws(
    () => parseBecListing(
      listingHtml
        .replace("&quot;Id&quot;:71613", "&quot;Id&quot;:71567")
        .replace("ProjectId=71613", "ProjectId=71567"),
      source,
    ),
    /duplicate job id/,
  );
  assert.throws(
    () => parseBecListing(listingHtml.replace("Bankernes EDB Central", "Other Customer"), source),
    /invalid identity/,
  );
  assert.throws(
    () => parseBecListing(listingHtml.replace("ProjectId=71613", "ProjectId=99999"), source),
    /identity does not match its URL/,
  );
  assert.throws(() => parseBecListing("<html></html>", source), /position payload/);

  const listing = parseBecListing(listingHtml, source).listings[0];
  assert.throws(
    () => parseBecDetail(detailHtml.replace("ProjectId=71567", "ProjectId=99999"), listing, source, "2026-09-25T12:00:00Z"),
    /identity does not match/,
  );
  assert.throws(
    () => parseBecDetail(detailHtml.replace("https://www.bec.dk", "https://other.example"), listing, source, "2026-09-25T12:00:00Z"),
    /unexpected attribution/,
  );
  assert.throws(
    () => parseBecDetail(detailHtml.replace("Warsaw", "Unknown"), listing, source, "2026-09-25T12:00:00Z"),
    /unexpected workplace/,
  );
  assert.throws(
    () => parseBecDetail(detailHtml.replace("2026-09-21T08:42:12Z", "21 September 2026"), listing, source, "2026-09-25T12:00:00Z"),
    /invalid modified timestamp/,
  );
});

test("enforces Denmark, language, and employment rules", () => {
  const listings = parseBecListing(listingHtml, configuredSource).listings;
  const poland = parseBecDetail(detailHtml, listings[0], configuredSource, "2026-09-25T12:00:00Z");
  assert.deepEqual(matchJob(poland, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["employment:contract"],
  });
  const polandWithoutEmployment = parseBecDetail(
    detailHtml.replace("Employment contract", ""),
    listings[0],
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(matchJob(polandWithoutEmployment, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });

  const denmark = parseBecDetail(denmarkDetail(), listings[1], configuredSource, "2026-09-25T12:00:00Z");
  assert.equal(matchJob(denmark, configuredSource.matchingPolicy).status, "STRONG");

  const unknownEmployment = parseBecDetail(
    denmarkDetail().replace("Permanent", ""),
    listings[1],
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.equal(unknownEmployment.employmentType, null);
  assert.equal(matchJob(unknownEmployment, configuredSource.matchingPolicy).status, "REVIEW");

  const language = parseBecDetail(
    denmarkDetail("Fluent Danish is required."),
    listings[1],
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(matchJob(language, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["language:da:required"],
  });
});

test("collects first-party listings and fetches only bounded candidate details", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(listingHtml)]
      : [response(detailHtml), response(denmarkDetail())];
  };

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["BEC Financial Technology"],
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[1].length, 2);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 2,
  });
});

test("marks mixed detail outcomes partial without treating failed details as exclusions", () => {
  let requestBatch = 0;
  const collection = collectShadow(
    [configuredSource],
    () => {
      requestBatch += 1;
      return requestBatch === 1
        ? [response(listingHtml)]
        : [response(detailHtml), response(denmarkDetail().replace("Roskilde", "Unknown"))];
    },
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["BEC Financial Technology"],
  );

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 0,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.sources[0].warnings, ["DETAIL_SCHEMA_INVALID"]);
});

test("quarantines empty listing and enforces response and detail limits", () => {
  const empty = listingHtml
    .replace(/&quot;Items&quot;:\[[\s\S]*\],&quot;CustomerAlias&quot;/, "&quot;Items&quot;:[],&quot;CustomerAlias&quot;")
    .replaceAll("&quot;PositionCountCustomer&quot;:3", "&quot;PositionCountCustomer&quot;:0")
    .replaceAll("&quot;PositionCountSearch&quot;:3", "&quot;PositionCountSearch&quot;:0")
    .replaceAll("&quot;PositionCountList&quot;:3", "&quot;PositionCountList&quot;:0");
  assert.equal(collectShadow([configuredSource], () => [response(empty)])
    .report.sources[0].status, "FAILED");

  const oversized = collectShadow(
    [{ ...configuredSource, maxResponseBytes: 10 }],
    () => [response(listingHtml)],
  );
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const limited = collectShadow(
    [{ ...configuredSource, maxDetailJobs: 1 }],
    (requests) => requests.length === 1 && requests[0].url === configuredSource.endpoint
      ? [response(listingHtml)]
      : [response(detailHtml)],
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});