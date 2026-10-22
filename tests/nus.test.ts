import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import { parseNusDetail, parseNusRedirect, parseNusSitemap } from "../src/nus.ts";

const source: SourceDefinition = {
  sourceKey: "nus-test",
  company: "NUS",
  adapter: "NUS",
  endpoint: "https://careers.nus.edu.sg/sitemap.xml",
  allowedHosts: ["careers.nus.edu.sg"],
  maxJobs: 1_200,
  maxResponseBytes: 300_000,
  maxDetailJobs: 20,
  maxPages: 1,
  locationFilters: ["singapore"],
};

const sitemapDetailUrl = "https://careers.nus.edu.sg/NUS/job/COLLEGE-OF-DESIGN-&amp;-ENG-Research-Engineer-%28LLM-for-Construction-Safety%29-Kent/55088744/";
const decodedSitemapDetailUrl = sitemapDetailUrl.replace("&amp;", "&");
const firstRedirectUrl = "https://careers.nus.edu.sg/NUS/job/COLLEGE-OF-DESIGN-&-ENG-Research-Engineer-(LLM-for-Construction-Safety)-Kent/32519-en_GB/";
const finalUrl = "https://careers.nus.edu.sg/job/Research-Engineer-%28LLM-for-Construction-Safety%29/32519-en_GB/";
const sitemap = await readFile(new URL("./fixtures/nus-sitemap.xml", import.meta.url), "utf8");
const listing = {
  sourceJobId: "55088744",
  titleHint: "COLLEGE OF DESIGN & ENG Research Engineer (LLM for Construction Safety) Kent",
  detailUrl: decodedSitemapDetailUrl,
};
const detailHtml = `<html><head><link rel="canonical" href="${finalUrl}"></head><body>
<span class="joblayouttoken-label">Job Title: </span><span>Research Engineer (LLM for Construction Safety)</span>
<span class="joblayouttoken-label">University-Level Unit: </span><span>College of Design and Engineering</span>
<span class="joblayouttoken-label">Employee Category: </span><span>Research Staff</span>
<span class="joblayouttoken-label">Location_ONB: </span><span>Kent Ridge Campus</span>
<span class="joblayouttoken-label">Posting Start Date: </span><span>16/04/2026</span>
<h2><b>Job Purpose</b></h2>
<p>Build an AI-driven construction safety platform using large language models, retrieval-augmented generation, and machine learning evaluation.</p>
<p>Develop reliable ranking and experimentation systems with the National University of Singapore research team.</p>
<span class="joblayouttoken-label">Req ID: </span><span>32519</span>
</body></html>`;

function response(
  status: number,
  body: string,
  contentType: string,
  location?: string,
): ShadowHttpResponse {
  return {
    status,
    contentType,
    location,
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("parses NUS sitemap entries and keeps only explicit ML title candidates", () => {
  assert.deepEqual(parseNusSitemap(sitemap, source), {
    total: 3,
    listings: [listing],
  });
});

test("validates each same-host NUS redirect", () => {
  assert.equal(
    parseNusRedirect(302, new URL(firstRedirectUrl).pathname, listing.detailUrl, source),
    firstRedirectUrl,
  );
  assert.equal(parseNusRedirect(302, finalUrl, firstRedirectUrl, source), finalUrl);
  assert.throws(
    () => parseNusRedirect(302, "https://attacker.example/job/x/1-en_GB/", firstRedirectUrl, source),
    /not allowlisted/,
  );
});

test("normalizes bounded semantic NUS detail content", () => {
  const job = parseNusDetail(detailHtml, listing, finalUrl, source, "2026-09-16T12:00:00Z");

  assert.equal(job.sourceJobId, "32519");
  assert.equal(job.title, "Research Engineer (LLM for Construction Safety)");
  assert.equal(job.locationText, "Kent Ridge Campus, Singapore");
  assert.deepEqual(job.countryCodes, ["SG"]);
  assert.equal(job.publishedAt, "2026-04-16");
  assert.match(job.descriptionText, /retrieval-augmented generation/);
});

test("rejects malformed NUS sitemap and mismatched detail identity", () => {
  assert.throws(
    () => parseNusSitemap(sitemap.replace("careers.nus.edu.sg/NUS/job", "attacker.example/NUS/job"), source),
    /not allowlisted/,
  );
  assert.throws(
    () => parseNusDetail(detailHtml.replace("32519-en_GB", "99999-en_GB"), listing, finalUrl, source, "2026-09-16T12:00:00Z"),
    /canonical URL does not match/,
  );
});

test("collects NUS through two validated redirects", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    if (calls.length === 1) {
      return [response(200, sitemap, "text/xml; charset=UTF-8")];
    }
    if (calls.length === 2) {
      return [response(302, "", "", new URL(firstRedirectUrl).pathname)];
    }
    if (calls.length === 3) {
      return [response(302, "", "text/html", finalUrl)];
    }
    return [response(200, detailHtml, "text/html; charset=UTF-8")];
  };

  const collection = collectShadow([source], fetchMany);

  assert.deepEqual(calls, [
    [source.endpoint],
    [decodedSitemapDetailUrl],
    [firstRedirectUrl],
    [finalUrl],
  ]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
});

test("isolates an invalid NUS redirect as a partial source", () => {
  let callCount = 0;
  const fetchMany: FetchMany = () => {
    callCount += 1;
    return callCount === 1
      ? [response(200, sitemap, "text/xml")]
      : [response(302, "", "", "https://attacker.example/job/x/1-en_GB/")];
  };

  const collection = collectShadow([source], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.equal(collection.report.sources[0].warnings[0], "DETAIL_URL_INVALID");
  assert.equal(collection.report.sources[0].detailedJobs, 0);
});