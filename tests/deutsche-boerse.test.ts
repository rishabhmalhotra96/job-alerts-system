import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { matchJob, type SourceDefinition } from "../src/domain.ts";
import {
  parseDeutscheBoerseDetail,
  parseDeutscheBoerseSitemap,
} from "../src/deutsche-boerse.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "deutsche-boerse-test",
  company: "Deutsche Boerse",
  adapter: "DEUTSCHE_BOERSE",
  endpoint: "https://careers.deutsche-boerse.com/sitemap.xml",
  allowedHosts: ["careers.deutsche-boerse.com"],
  maxJobs: 250,
  maxResponseBytes: 200_000,
  maxDetailJobs: 30,
  maxPages: 1,
  locationFilters: ["luxembourg"],
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "deutsche-boerse-sitemap")!;
const sitemap = await readFile(new URL("./fixtures/deutsche-boerse-sitemap.xml", import.meta.url), "utf8");
const detailHtml = await readFile(new URL("./fixtures/deutsche-boerse-detail.html", import.meta.url), "utf8");

function response(body: string, contentType: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType,
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("counts only offer URLs and prefilters target title slugs", () => {
  const parsed = parseDeutscheBoerseSitemap(sitemap, source);

  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.listings.map(({ sourceJobId, titleHint }) => ({ sourceJobId, titleHint })), [
    { sourceJobId: "f0a15422-df58-43e8-ba95-7263973bd670", titleHint: "data scientist f m d" },
    { sourceJobId: "104407ef-7436-48c2-85e3-2e46c9893ce7", titleHint: "senior machine learning engineer" },
  ]);
});

test("normalizes a complete attributed JobPosting without inferring employment", () => {
  const listing = parseDeutscheBoerseSitemap(sitemap, source).listings[0];
  const job = parseDeutscheBoerseDetail(detailHtml, listing, source, "2026-09-25T12:00:00Z");

  assert.equal(job.title, "Data Scientist (f/m/d)");
  assert.deepEqual(job.countryCodes, ["LU"]);
  assert.equal(job.locationText, "Luxemburg, LU");
  assert.equal(job.employmentType, null);
  assert.equal(job.publishedAt, "2026-09-06T22:00:00.000Z");
  assert.equal(job.updatedAt, null);
  assert.match(job.descriptionText, /Clearstream Fund Services/);
});

test("accepts a provider-truncated title slug with exact URL and UUID identity", () => {
  const listing = {
    sourceJobId: "ef2cf9af-0535-4d43-a9df-20763657c0a4",
    titleHint: "student security it ai engineer f m",
    detailUrl: "https://careers.deutsche-boerse.com/offer/student-security-it-ai-engineer-f-m/ef2cf9af-0535-4d43-a9df-20763657c0a4",
  };
  const truncatedSlugDetail = detailHtml
    .replaceAll("f0a15422-df58-43e8-ba95-7263973bd670", listing.sourceJobId)
    .replaceAll("data-scientist-f-m-d", "student-security-it-ai-engineer-f-m")
    .replaceAll("Data Scientist (f/m/d)", "Student - Security IT - AI Engineer (f/m/d)");

  const job = parseDeutscheBoerseDetail(
    truncatedSlugDetail,
    listing,
    source,
    "2026-10-15T17:00:00Z",
  );

  assert.equal(job.title, "Student - Security IT - AI Engineer (f/m/d)");
  assert.equal(job.sourceJobId, listing.sourceJobId);
});

test("rejects malformed sitemap and mismatched detail identities", () => {
  assert.throws(
    () => parseDeutscheBoerseSitemap(sitemap.replace("careers.deutsche-boerse.com/offer", "evil.example/offer"), source),
    /not allowlisted/,
  );
  assert.throws(
    () => parseDeutscheBoerseSitemap(sitemap.replace("</urlset>", `<url><loc>https://careers.deutsche-boerse.com/offer/other/f0a15422-df58-43e8-ba95-7263973bd670</loc></url></urlset>`), source),
    /duplicate job id/,
  );
  assert.throws(() => parseDeutscheBoerseSitemap("<html></html>", source), /document root/);
  assert.throws(() => parseDeutscheBoerseSitemap(sitemap.replace("</urlset>", ""), source), /incomplete/);

  const listing = parseDeutscheBoerseSitemap(sitemap, source).listings[0];
  assert.throws(
    () => parseDeutscheBoerseDetail(
      detailHtml.replaceAll("Data Scientist (f/m/d)", "Different Title"),
      listing,
      source,
      "2026-09-25T12:00:00Z",
    ),
    /identity does not match/,
  );
  assert.throws(
    () => parseDeutscheBoerseDetail(
      detailHtml.replace("CFC S.A. (CFCL)", "Other Company"),
      listing,
      source,
      "2026-09-25T12:00:00Z",
    ),
    /unexpected organization/,
  );
  assert.throws(
    () => parseDeutscheBoerseDetail(
      detailHtml.replace("Deutsche B\\u00f6rse Group", "Other Group"),
      listing,
      source,
      "2026-09-25T12:00:00Z",
    ),
    /invalid description/,
  );
});

test("enforces Luxembourg, language, and unknown-employment policy", () => {
  const listing = parseDeutscheBoerseSitemap(sitemap, configuredSource).listings[0];
  const positive = parseDeutscheBoerseDetail(detailHtml, listing, configuredSource, "2026-09-25T12:00:00Z");
  assert.equal(matchJob(positive, configuredSource.matchingPolicy).status, "REVIEW");

  const language = parseDeutscheBoerseDetail(
    detailHtml.replace("Fluent in English is required.", "Fluent German is required."),
    listing,
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(matchJob(language, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["language:de:required"],
  });

  const germany = parseDeutscheBoerseDetail(
    detailHtml.replace('"addressLocality": "Luxemburg", "addressCountry": "LU"', '"addressLocality": "Frankfurt", "addressCountry": "DE"'),
    listing,
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(matchJob(germany, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
});

test("collects one sitemap and fetches only bounded candidate details", () => {
  const calls: string[][] = [];
  const otherDetail = detailHtml
    .replaceAll("f0a15422-df58-43e8-ba95-7263973bd670", "104407ef-7436-48c2-85e3-2e46c9893ce7")
    .replaceAll("data-scientist-f-m-d", "senior-machine-learning-engineer")
    .replaceAll("Data Scientist (f/m/d)", "Senior Machine Learning Engineer")
    .replace('"addressLocality": "Luxemburg", "addressCountry": "LU"', '"addressLocality": "Frankfurt", "addressCountry": "DE"');
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(sitemap, "text/xml; charset=utf-8")]
      : [
        response(detailHtml, "text/html; charset=utf-8"),
        response(otherDetail, "text/html; charset=utf-8"),
      ];
  };

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Deutsche Boerse"],
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[1].length, 2);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
});

test("quarantines empty sitemap and enforces response and detail limits", () => {
  const empty = sitemap.replace(/<url><loc>https:\/\/careers\.deutsche-boerse\.com\/offer[\s\S]*<\/url>/, "");
  assert.equal(collectShadow([configuredSource], () => [response(empty, "text/xml")])
    .report.sources[0].status, "FAILED");

  const oversized = collectShadow(
    [{ ...configuredSource, maxResponseBytes: 10 }],
    () => [response(sitemap, "text/xml")],
  );
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const limited = collectShadow(
    [{ ...configuredSource, maxDetailJobs: 1 }],
    (requests) => requests.length === 1 && requests[0].url === configuredSource.endpoint
      ? [response(sitemap, "text/xml")]
      : [response(detailHtml, "text/html")],
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});