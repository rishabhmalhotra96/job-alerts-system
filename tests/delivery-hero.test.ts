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
  isExpiredDeliveryHeroDetail,
  parseDeliveryHeroDetail,
  parseDeliveryHeroSitemap,
} from "../src/delivery-hero.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "delivery-hero-test",
  company: "Delivery Hero",
  adapter: "DELIVERY_HERO",
  endpoint: "https://careers.deliveryhero.com/vacanciessitemap.xml",
  allowedHosts: ["careers.deliveryhero.com"],
  maxJobs: 1_000,
  maxResponseBytes: 250_000,
  maxDetailJobs: 30,
  maxPages: 1,
  locationFilters: ["germany"],
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "delivery-hero-sitemap")!;
const sitemap = await readFile(new URL("./fixtures/delivery-hero-sitemap.xml", import.meta.url), "utf8");
const detailHtml = await readFile(new URL("./fixtures/delivery-hero-detail.html", import.meta.url), "utf8");

function response(body: string, contentType: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType,
    body,
    byteLength: Buffer.byteLength(body),
  };
}

function removeJobPostingScript(html: string): string {
  const openingTag = '<script type="application/ld+json">';
  const start = html.indexOf(openingTag);
  const closing = html.indexOf("</script>", start + openingTag.length);
  assert.notEqual(start, -1, "fixture must contain a JSON-LD script");
  assert.notEqual(closing, -1, "fixture JSON-LD script must be complete");
  return html.slice(0, start) + html.slice(closing + "</script>".length);
}

test("prefilters Germany target titles from the complete Delivery Hero sitemap", () => {
  const parsed = parseDeliveryHeroSitemap(sitemap, source);

  assert.equal(parsed.total, 5);
  assert.deepEqual(parsed.listings.map(({ sourceJobId, titleHint }) => ({ sourceJobId, titleHint })), [
    { sourceJobId: "10906", titleHint: "senior machine learning engineer logistics optimization" },
    { sourceJobId: "10845", titleHint: "senior data scientist maternity cover" },
  ]);
});

test("normalizes a complete Delivery Hero JobPosting detail", () => {
  const listing = parseDeliveryHeroSitemap(sitemap, source).listings[0];
  const job = parseDeliveryHeroDetail(detailHtml, listing, source, "2026-09-25T12:00:00Z");

  assert.equal(job.sourceJobId, "10906");
  assert.equal(job.title, "Senior Machine Learning Engineer - (Logistics, Optimization)");
  assert.deepEqual(job.countryCodes, ["DE"]);
  assert.equal(job.employmentType, "Full-time");
  assert.equal(job.publishedAt, "2026-08-24T07:37:49.000Z");
  assert.equal(job.updatedAt, "2026-09-24T07:37:49.000Z");
  assert.match(job.descriptionText, /forecasting, and optimization/);
});

test("accepts valid whitespace in JSON-LD script closing tags", () => {
  const listing = parseDeliveryHeroSitemap(sitemap, source).listings[0];
  const job = parseDeliveryHeroDetail(
    detailHtml.replace("</script>", "</script >"),
    listing,
    source,
    "2026-09-25T12:00:00Z",
  );

  assert.equal(job.sourceJobId, "10906");
});

test("recognizes only canonically matched expired Delivery Hero details", () => {
  const listing = parseDeliveryHeroSitemap(sitemap, source).listings[0];
  const expired = removeJobPostingScript(detailHtml)
    .replace("<body>", "<body><h2>This vacancy has now expired. Please see similar roles below...</h2>");

  assert.equal(isExpiredDeliveryHeroDetail(expired, listing, source), true);
  assert.equal(isExpiredDeliveryHeroDetail(detailHtml, listing, source), false);
  assert.throws(
    () => isExpiredDeliveryHeroDetail(
      expired.replace(listing.detailUrl, "https://careers.deliveryhero.com/job/other-in-berlin-germany-jid-1"),
      listing,
      source,
    ),
    /canonical URL does not match/,
  );
});

test("rejects malformed sitemap identities and inconsistent details", () => {
  assert.throws(
    () => parseDeliveryHeroSitemap(sitemap.replace("careers.deliveryhero.com/job", "evil.example/job"), source),
    /not allowlisted/,
  );
  assert.throws(
    () => parseDeliveryHeroSitemap(sitemap.replace("</urlset>", `<url><loc>https://careers.deliveryhero.com/job/other-in-berlin-germany-jid-10906</loc><lastmod>2026-09-24T07:37:49Z</lastmod></url></urlset>`), source),
    /duplicate job id/,
  );
  assert.throws(() => parseDeliveryHeroSitemap("<html></html>", source), /document root/);
  assert.throws(() => parseDeliveryHeroSitemap(sitemap.replace("</urlset>", ""), source), /incomplete/);

  const listing = parseDeliveryHeroSitemap(sitemap, source).listings[0];
  assert.throws(
    () => parseDeliveryHeroDetail(
      detailHtml.replace("Berlin, Germany", "Vienna, Austria"),
      listing,
      source,
      "2026-09-25T12:00:00Z",
    ),
    /unexpected location/,
  );
  assert.throws(
    () => parseDeliveryHeroDetail(
      detailHtml.replace("Delivery Hero", "Other"),
      listing,
      source,
      "2026-09-25T12:00:00Z",
    ),
    /invalid identifier|unexpected organization/,
  );
});

test("enforces Delivery Hero language, geography, and temporary employment rules", () => {
  const listing = parseDeliveryHeroSitemap(sitemap, configuredSource).listings[0];
  const positive = parseDeliveryHeroDetail(detailHtml, listing, configuredSource, "2026-09-25T12:00:00Z");
  assert.equal(matchJob(positive, configuredSource.matchingPolicy).status, "STRONG");

  const language = parseDeliveryHeroDetail(
    detailHtml.replace("Professional English is required.", "Fluent German is required."),
    listing,
    configuredSource,
    "2026-09-25T12:00:00Z",
  );
  assert.deepEqual(matchJob(language, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["language:de:required"],
  });

  const temporary = { ...positive, employmentType: "Temporary" };
  assert.deepEqual(matchJob(temporary, configuredSource.matchingPolicy), {
    status: "REVIEW",
    reasons: [
      "title:machine-learning-engineer",
      "skill:machine-learning",
      "location:eligible",
      "employment:ambiguous",
    ],
  });
});

test("collects the sitemap and fetches only bounded candidate details", () => {
  const calls: string[][] = [];
  const maternityDetail = detailHtml
    .replaceAll("10906", "10845")
    .replaceAll("senior-machine-learning-engineer-logistics-optimization", "senior-data-scientist-maternity-cover")
    .replace("Senior Machine Learning Engineer - (Logistics, Optimization)", "Senior Data Scientist (Maternity Cover)")
    .replace("Full-time", "Temporary");
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1
      ? [response(sitemap, "text/xml; charset=utf-8")]
      : [
        response(detailHtml, "text/html; charset=utf-8"),
        response(maternityDetail, "text/html; charset=utf-8"),
      ];
  };

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Delivery Hero"],
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[1].length, 2);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 5);
  assert.equal(collection.report.sources[0].detailedJobs, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 1,
    EXCLUDED: 3,
  });
});

test("excludes an explicitly expired Delivery Hero detail without masking malformed pages", () => {
  const expired = removeJobPostingScript(detailHtml
    .replaceAll("10906", "10845")
    .replaceAll("senior-machine-learning-engineer-logistics-optimization", "senior-data-scientist-maternity-cover"))
    .replace("<body>", "<body><h2>This vacancy has now expired. Please see similar roles below...</h2>");
  const fetchMany: FetchMany = (requests) => requests.length === 1
    ? [response(sitemap, "text/xml; charset=utf-8")]
    : [
      response(detailHtml, "text/html; charset=utf-8"),
      response(expired, "text/html; charset=utf-8"),
    ];

  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Delivery Hero"],
  );

  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].detailedJobs, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 4,
  });
  assert.equal(collection.candidates.length, 1);

  const malformed = collectShadow(
    [configuredSource],
    (requests) => requests.length === 1
      ? [response(sitemap, "text/xml; charset=utf-8")]
      : [
        response(detailHtml, "text/html; charset=utf-8"),
        response(expired.replace("This vacancy has now expired.", "This page is unavailable."), "text/html; charset=utf-8"),
      ],
    () => new Date("2026-09-25T12:00:00Z"),
    1,
    new Map(),
    ["Delivery Hero"],
  );
  assert.equal(malformed.report.sources[0].status, "PARTIAL");
  assert.deepEqual(malformed.report.sources[0].warnings, ["DETAIL_SCHEMA_INVALID"]);
});

test("quarantines empty sitemap and enforces response and detail limits", () => {
  const empty = sitemap.replace(/<url>[\s\S]*<\/url>/, "");
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