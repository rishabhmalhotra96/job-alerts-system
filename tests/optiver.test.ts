import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import {
  buildOptiverListingUrl,
  parseOptiverDetail,
  parseOptiverListingPage,
} from "../src/optiver.ts";

const source: SourceDefinition = {
  sourceKey: "optiver-test",
  company: "Optiver",
  adapter: "OPTIVER",
  endpoint: "https://www.optiver.com/en/api/v1/jobs",
  allowedHosts: ["www.optiver.com"],
  maxJobs: 48,
  maxResponseBytes: 150_000,
  maxDetailJobs: 20,
  maxPages: 3,
  locationFilters: ["amsterdam"],
};

const optiverFixture = JSON.parse(await readFile(
  new URL("./fixtures/optiver-listing.json", import.meta.url),
  "utf8",
)) as unknown;

const listingPage = {
  totalCount: 1,
  items: [{
    componentID: 13705,
    title: "AI Engineer",
    location: "Amsterdam",
    experience: "Experienced",
    href: "/join-us/jobs/technology/amsterdam/ai-engineer/",
  }],
};

const detailHtml = `
<script type="application/ld+json">{
  "@context":"https://schema.org",
  "@type":"JobPosting",
  "title":"AI Engineer",
  "url":"https://www.optiver.com/join-us/jobs/technology/amsterdam/ai-engineer/",
  "datePosted":"2026-02-13",
  "hiringOrganization":{"@type":"Organization","name":"Optiver"},
  "jobLocation":{"@type":"Place","name":"Amsterdam"}
}</script>
<script>React.createElement(Components.RichText,{"text":"<p>Build AI agents &amp; machine learning systems.</p>"}));</script>`;

function response(body: string, contentType: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType,
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("builds a bounded Optiver Amsterdam experienced listing URL", () => {
  assert.equal(
    buildOptiverListingUrl(source, 16),
    "https://www.optiver.com/en/api/v1/jobs?from=16&size=16&location=amsterdam&level=experienced",
  );
  assert.throws(() => buildOptiverListingUrl(source, 1), /page boundary/);
});

test("parses Optiver listings and enforces server filters", () => {
  assert.deepEqual(parseOptiverListingPage(optiverFixture, source), {
    total: 1,
    listings: [{
      sourceJobId: "13705",
      title: "AI Engineer",
      detailPath: "/join-us/jobs/technology/amsterdam/ai-engineer/",
    }],
  });
  assert.throws(
    () => parseOptiverListingPage({
      ...listingPage,
      items: [{ ...listingPage.items[0], location: "Sydney" }],
    }, source),
    /escaped configured filters/,
  );
});

test("normalizes matching Optiver structured detail content", () => {
  const listing = parseOptiverListingPage(listingPage, source).listings[0];
  const job = parseOptiverDetail(detailHtml, listing, source, "2026-09-16T12:00:00Z");
  assert.equal(job.sourceJobId, "13705");
  assert.equal(job.descriptionText, "Build AI agents & machine learning systems.");
  assert.deepEqual(job.countryCodes, ["NL"]);
  assert.equal(job.publishedAt, "2026-02-13");
});

test("rejects ambiguous and mismatched Optiver structured content", () => {
  const listing = parseOptiverListingPage(listingPage, source).listings[0];
  assert.throws(
    () => parseOptiverDetail(detailHtml.replace("AI Engineer", "Data Scientist"), listing, source, "2026-09-16T12:00:00Z"),
    /title does not match listing/,
  );
  assert.throws(
    () => parseOptiverDetail(detailHtml.replace("</script>", "</script>" + detailHtml), listing, source, "2026-09-16T12:00:00Z"),
    /ambiguous structured content/,
  );
});

test("collects Optiver listings and fetches only candidate detail HTML", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map((request) => request.url));
    return calls.length === 1
      ? [response(JSON.stringify(listingPage), "application/json")]
      : [response(detailHtml, "text/html; charset=utf-8")];
  };
  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /location=amsterdam&level=experienced/);
  assert.equal(calls[1][0], "https://www.optiver.com/join-us/jobs/technology/amsterdam/ai-engineer/");
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 0,
  });
});

test("marks Optiver partial when pagination exceeds its cap", () => {
  const page = {
    totalCount: 17,
    items: [{
      ...listingPage.items[0],
      componentID: 16881,
      title: "RF Systems Engineer",
      href: "/join-us/jobs/technology/amsterdam/rf-systems-engineer/",
    }],
  };
  const fetchMany: FetchMany = () => [response(JSON.stringify(page), "application/json")];
  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});