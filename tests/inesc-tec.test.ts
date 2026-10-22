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
  INESC_TEC_MAX_LISTINGS,
  parseInescTecDetail,
  parseInescTecListing,
} from "../src/inesc-tec.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "inesc-tec-test",
  company: "INESC TEC",
  adapter: "INESC_TEC",
  endpoint: "https://www.inesctec.pt/en/opportunities/list?type=open",
  allowedHosts: ["www.inesctec.pt"],
  maxJobs: 50,
  maxResponseBytes: 200_000,
  maxDetailJobs: 30,
  maxPages: 1,
  locationFilters: ["portugal"],
};
const configuredSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "inesc-tec-opportunities")!;
const listingHtml = await readFile(new URL("./fixtures/inesc-tec-listing.html", import.meta.url), "utf8");
const detailHtml = await readFile(new URL("./fixtures/inesc-tec-detail.html", import.meta.url), "utf8");
const fetchedAt = "2026-09-25T12:00:00Z";

test("keeps configured INESC TEC inventory and response bounds aligned", () => {
  assert.equal(configuredSource.maxJobs, INESC_TEC_MAX_LISTINGS);
  assert.equal(configuredSource.maxResponseBytes, 200_000);
  assert.equal(configuredSource.maxDetailJobs, 30);
});

function response(body: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType: "text/html; charset=UTF-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("parses complete INESC TEC rows and excludes future opportunities before details", () => {
  const parsed = parseInescTecListing(listingHtml, source, fetchedAt);

  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.listings, [{
    sourceJobId: "AE2026-0268",
    title: "Senior Machine Learning Engineer",
    employmentType: "Investigação (BI)",
    qualification: "Bachelor's",
    centre: "Artificial Intelligence and Decision Support",
    advisor: "Nuno Ricardo Guimarães",
    applicationDeadline: "2026-10-02",
    detailUrl: "https://www.inesctec.pt/en/opportunities/senior-machine-learning-engineer-AE2026-0268",
  }]);
});

test("normalizes a complete active INESC TEC detail with reviewed Portugal evidence", () => {
  const listing = parseInescTecListing(listingHtml, source, fetchedAt).listings[0];
  const job = parseInescTecDetail(detailHtml, listing, source, fetchedAt);

  assert.equal(job.sourceJobId, "AE2026-0268");
  assert.equal(job.title, "Senior Machine Learning Engineer");
  assert.equal(job.locationText, "INESC TEC, Porto, Portugal");
  assert.deepEqual(job.countryCodes, ["PT"]);
  assert.equal(job.employmentType, "Investigação (BI)");
  assert.equal(job.descriptionCompleteness, "FULL");
  assert.equal(job.publishedAt, null);
  assert.match(job.descriptionText, /Academic qualifications:/);
});

test("accepts missing non-authoritative centre metadata", () => {
  const listingWithoutCentre = listingHtml.replace(
    ">Artificial Intelligence and Decision Support</td>",
    "></td>",
  );
  const listing = parseInescTecListing(listingWithoutCentre, source, fetchedAt).listings[0];

  assert.equal(listing.centre, null);
  assert.equal(parseInescTecDetail(detailHtml, listing, source, fetchedAt).sourceJobId, "AE2026-0268");
});

test("ignores complete listing comments and rejects malformed comment boundaries", () => {
  const commented = listingHtml
    .replace("<thead>", "<thead><!-- <th>Ignored</th> -->")
    .replace("<tbody>\n<tr>", "<tbody>\n<tr><!-- <td>Ignored</td> -->");

  assert.equal(parseInescTecListing(commented, source, fetchedAt).total, 3);
  assert.throws(
    () => parseInescTecListing(listingHtml.replace("<thead>", "<thead><!--"), source, fetchedAt),
    /malformed HTML comments/,
  );
});

test("enforces Portugal, complete English content, and conservative employment", () => {
  const listing = parseInescTecListing(listingHtml, configuredSource, fetchedAt).listings[0];
  const job = parseInescTecDetail(detailHtml, listing, configuredSource, fetchedAt);
  assert.deepEqual(matchJob(job, configuredSource.matchingPolicy), {
    status: "REVIEW",
    reasons: [
      "title:machine-learning-engineer",
      "skill:data-science",
      "location:eligible",
      "employment:ambiguous",
    ],
  });

  const language = parseInescTecDetail(
    detailHtml.replace("Advanced knowledge of English", "Fluent Portuguese is required"),
    listing,
    configuredSource,
    fetchedAt,
  );
  assert.deepEqual(matchJob(language, configuredSource.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["language:pt:required"],
  });
});

test("rejects malformed listing and inconsistent detail identity or lifecycle", () => {
  assert.throws(
    () => parseInescTecListing(listingHtml.replace(
      "https://www.inesctec.pt/en/opportunities/senior-machine-learning-engineer-AE2026-0268",
      "https://evil.example/en/opportunities/senior-machine-learning-engineer-AE2026-0268",
    ), source, fetchedAt),
    /not allowlisted/,
  );
  assert.throws(
    () => parseInescTecListing(listingHtml.replace("AE2026-0261", "AE2026-0268"), source, fetchedAt),
    /inconsistent URLs|invalid identity|duplicate/,
  );
  assert.throws(
    () => parseInescTecListing(listingHtml.replace(
      '<a href="https://www.inesctec.pt/en/opportunities/senior-machine-learning-engineer-AE2026-0268" class="btn">Apply now</a>',
      "Apply now",
    ), source, fetchedAt),
    /invalid action links/,
  );
  assert.throws(() => parseInescTecListing("<html></html>", source, fetchedAt), /invalid identity/);

  const listing = parseInescTecListing(listingHtml, source, fetchedAt).listings[0];
  assert.throws(
    () => parseInescTecDetail(detailHtml.replace("AE2026-0268", "AE2026-9999"), listing, source, fetchedAt),
    /identity does not match/,
  );
  assert.throws(
    () => parseInescTecDetail(detailHtml.replace("02 Oct 2026", "02 Oct 2025"), listing, source, fetchedAt),
    /outside its application period/,
  );
  assert.throws(
    () => parseInescTecDetail(detailHtml.replace("INESC TEC\"", "Other\""), listing, source, fetchedAt),
    /unexpected attribution/,
  );
  assert.throws(
    () => parseInescTecDetail(detailHtml.replace(
      "https://www.inesctec.pt/editais/en/AE2026-0268.pdf",
      "https://evil.example/editais/en/AE2026-0268.pdf",
    ), listing, source, fetchedAt),
    /formal call is missing or ambiguous/,
  );
});

test("collects one complete list and fetches only active target-title details", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return calls.length === 1 ? [response(listingHtml)] : [response(detailHtml)];
  };
  const collection = collectShadow(
    [configuredSource],
    fetchMany,
    () => new Date(fetchedAt),
    1,
    new Map(),
    ["INESC TEC"],
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [configuredSource.endpoint]);
  assert.equal(calls[1].length, 1);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 3);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 2,
  });
});

test("marks failed candidate details partial without inferring exclusions", () => {
  let requestBatch = 0;
  const collection = collectShadow(
    [configuredSource],
    () => {
      requestBatch += 1;
      return requestBatch === 1
        ? [response(listingHtml)]
        : [response(detailHtml.replace("02 Oct 2026", "02 Oct 2025"))];
    },
    () => new Date(fetchedAt),
    1,
    new Map(),
    ["INESC TEC"],
  );

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.equal(collection.report.sources[0].detailedJobs, 0);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 0,
    EXCLUDED: 2,
  });
  assert.deepEqual(collection.report.sources[0].warnings, ["DETAIL_SCHEMA_INVALID"]);
});

test("quarantines empty listings and enforces response and detail limits", () => {
  assert.equal(collectShadow(
    [configuredSource],
    () => [response(listingHtml.replace(/<tbody>[\s\S]*<\/tbody>/, "<tbody></tbody>"))],
    () => new Date(fetchedAt),
  ).report.sources[0].status, "FAILED");

  const oversized = collectShadow(
    [{ ...configuredSource, maxResponseBytes: 10 }],
    () => [response(listingHtml)],
    () => new Date(fetchedAt),
  );
  assert.deepEqual(oversized.report.sources[0].warnings, ["RESPONSE_TOO_LARGE"]);

  const twoCandidates = listingHtml
    .replaceAll("/energy-AE2026-0261", "/senior-data-scientist-AE2026-0261")
    .replace(">Energy</td>", ">Senior Data Scientist</td>");
  let requestBatch = 0;
  const limited = collectShadow(
    [{ ...configuredSource, maxDetailJobs: 1 }],
    () => {
      requestBatch += 1;
      return requestBatch === 1 ? [response(twoCandidates)] : [response(detailHtml)];
    },
    () => new Date(fetchedAt),
  );
  assert.equal(limited.report.sources[0].status, "PARTIAL");
  assert.deepEqual(limited.report.sources[0].warnings, ["DETAIL_LIMIT"]);
});