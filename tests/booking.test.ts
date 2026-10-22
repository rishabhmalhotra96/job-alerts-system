import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildBookingSearchRequest,
  parseBookingSearchPage,
} from "../src/booking.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";

const source: SourceDefinition = {
  sourceKey: "booking-test",
  company: "Booking.com",
  adapter: "BOOKING",
  endpoint: "https://jobs.booking.com/api/jobs",
  allowedHosts: ["jobs.booking.com"],
  maxJobs: 100,
  maxResponseBytes: 500_000,
  maxDetailJobs: 30,
  maxPages: 16,
  searchTerms: ["data scientist"],
  locationFilters: ["Amsterdam"],
};

const bookingFixture = JSON.parse(await readFile(
  new URL("./fixtures/booking-search.json", import.meta.url),
  "utf8",
)) as unknown;

function bookingJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      slug: "30097",
      req_id: "30097",
      title: "Data Scientist II - Finance Payments",
      description: "<p>Build machine learning ranking systems.</p>",
      city: "Amsterdam",
      country: "Netherlands",
      country_code: "NL",
      tags1: ["Booking.com Company Hierarchy"],
      brand: "Booking.com",
      hiring_organization: "Booking.com",
      employment_type: "FULL_TIME",
      posted_date: "2026-09-08T16:17:00+0000",
      update_date: "2026-09-08T16:18:45+0000",
      searchable: true,
      applyable: true,
      ...overrides,
    },
  };
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

test("builds a bounded Booking Amsterdam search URL", () => {
  const request = buildBookingSearchRequest(source, "data scientist", 2);
  assert.match(request.url, /keywords=data%20scientist/);
  assert.match(request.url, /location=Amsterdam/);
  assert.match(request.url, /page=2/);
  assert.match(request.url, /tags1=Booking\.com%20Company%20Hierarchy%7CTransport%20Company%20Hierarchy/);
  assert.throws(() => buildBookingSearchRequest(source, "", 1), /must not be empty/);
  assert.throws(() => buildBookingSearchRequest(source, "test", 0), /positive integer/);
});

test("normalizes a verified Booking job", () => {
  const page = parseBookingSearchPage(
    bookingFixture,
    source,
    "2026-09-16T12:00:00Z",
  );
  assert.equal(page.jobs[0].sourceJobId, "30097");
  assert.equal(page.jobs[0].descriptionText, "Build machine learning ranking systems.");
  assert.equal(page.jobs[0].employmentType, "full-time");
  assert.deepEqual(page.jobs[0].countryCodes, ["NL"]);
  assert.equal(page.jobs[0].canonicalUrl, "https://jobs.booking.com/booking/jobs/30097?lang=en-us");
});

test("rejects mismatched company, location, identity, and oversized pages", () => {
  assert.throws(
    () => parseBookingSearchPage(
      { totalCount: 1, jobs: [bookingJob({ brand: "Other" })] },
      source,
      "2026-09-16T12:00:00Z",
    ),
    /unexpected company/,
  );
  assert.throws(
    () => parseBookingSearchPage(
      { totalCount: 1, jobs: [bookingJob({ city: "London", country: "United Kingdom", country_code: "GB" })] },
      source,
      "2026-09-16T12:00:00Z",
    ),
    /unexpected location/,
  );
  assert.throws(
    () => parseBookingSearchPage(
      { totalCount: 1, jobs: [bookingJob({ slug: "different" })] },
      source,
      "2026-09-16T12:00:00Z",
    ),
    /mismatched slug/,
  );
  assert.throws(
    () => parseBookingSearchPage(
      { totalCount: 11, jobs: Array.from({ length: 11 }, () => bookingJob()) },
      source,
      "2026-09-16T12:00:00Z",
    ),
    /exceeds page size/,
  );
});

test("collects and classifies Booking jobs without detail requests", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map((request) => request.url));
    return [response({ totalCount: 1, jobs: [bookingJob()] })];
  };
  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /keywords=data%20scientist/);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 1,
    EXCLUDED: 0,
  });
});

test("marks Booking partial when pagination exceeds its cap", () => {
  const fetchMany: FetchMany = () => [response({
    totalCount: 11,
    jobs: [bookingJob({
      req_id: "30098",
      slug: "30098",
      title: "Account Executive",
    })],
  })];
  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});