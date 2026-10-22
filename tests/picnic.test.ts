import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import { parsePicnicDetail, parsePicnicSitemap } from "../src/picnic.ts";

const source: SourceDefinition = {
  sourceKey: "picnic-test",
  company: "Picnic",
  adapter: "PICNIC",
  endpoint: "https://jobs.picnic.app/sitemap/vacancies.xml",
  allowedHosts: ["jobs.picnic.app"],
  maxJobs: 150,
  maxResponseBytes: 400_000,
  maxDetailJobs: 20,
  maxPages: 1,
  locationFilters: ["netherlands"],
};

const detailUrl = "https://jobs.picnic.app/en/vacancies/JW43HSLV/engineering/senior-machine-learning-engineer/amsterdam/north-holland/netherlands";
const sitemap = await readFile(new URL("./fixtures/picnic-sitemap.xml", import.meta.url), "utf8");

const listing = {
  sourceJobId: "JW43HSLV",
  title: "senior machine learning engineer",
  detailUrl,
  updatedAt: "2026-09-16T10:24:57.916Z",
};

const detailHtml = `<html><head><link rel="canonical" href="${detailUrl}"/></head><body>
<h1 class="job-title"><strong>Senior Machine Learning Engineer</strong></h1>
<a class="location" href="https://jobs.picnic.app/amsterdam">📍Amsterdam</a>
<h1>In a nutshell&nbsp;</h1>
<p>As a Machine Learning Engineer at Picnic, build and productionize models.</p>
<h1>Tricks of the trade</h1><p>Develop recommendation, forecasting, and ranking systems with strong monitoring.</p>
<h1>We’re looking for</h1><p>Five years of applied machine learning experience.</p>
<h1>Picnic Perks&nbsp;</h1><p>Benefits.</p>
</body></html>`;

function response(body: string, contentType: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType,
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("parses only structured Netherlands jobs from the Picnic sitemap", () => {
  assert.deepEqual(parsePicnicSitemap(sitemap, source), [listing]);
});

test("normalizes bounded semantic Picnic detail content", () => {
  const job = parsePicnicDetail(detailHtml, listing, source, "2026-09-16T12:00:00Z");
  assert.equal(job.title, "Senior Machine Learning Engineer");
  assert.match(job.descriptionText, /recommendation, forecasting, and ranking/);
  assert.doesNotMatch(job.descriptionText, /Benefits/);
  assert.deepEqual(job.countryCodes, ["NL"]);
  assert.equal(job.employmentType, null);
});

test("rejects mismatched and ambiguous Picnic details", () => {
  assert.throws(
    () => parsePicnicDetail(
      detailHtml.replace("Senior Machine Learning Engineer</strong>", "Staff AI Engineer</strong>"),
      listing,
      source,
      "2026-09-16T12:00:00Z",
    ),
    /title does not match/,
  );
  assert.throws(
    () => parsePicnicDetail(
      detailHtml.replace("<h1>Picnic Perks&nbsp;</h1>", ""),
      listing,
      source,
      "2026-09-16T12:00:00Z",
    ),
    /content boundary/,
  );
});

test("rejects unsafe, duplicate, and malformed sitemap entries", () => {
  assert.throws(
    () => parsePicnicSitemap(sitemap.replace("https://jobs.picnic.app/en/", "https://attacker.example/en/"), source),
    /not allowlisted/,
  );
  assert.throws(
    () => parsePicnicSitemap(sitemap.replace("</urlset>", `<url><loc>${detailUrl}</loc><lastmod>2026-09-16T10:24:57.916Z</lastmod></url></urlset>`), source),
    /duplicate job id/,
  );
  assert.throws(() => parsePicnicSitemap("<html></html>", source), /document root/);
});

test("collects Picnic sitemap listings and fetches only candidate details", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map((request) => request.url));
    return calls.length === 1
      ? [response(sitemap, "application/xml")]
      : [response(detailHtml, "text/html; charset=utf-8")];
  };
  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [source.endpoint]);
  assert.deepEqual(calls[1], [detailUrl]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 0,
  });
});

test("fails Picnic closed on a non-XML listing response", () => {
  const fetchMany: FetchMany = () => [response(sitemap, "text/html")];
  const collection = collectShadow([source], fetchMany);

  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.deepEqual(collection.report.sources[0].warnings, ["CONTENT_TYPE"]);
});