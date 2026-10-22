import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SourceDefinition } from "../src/domain.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import {
  buildGlovoDetailUrl,
  buildGlovoListingRequest,
  parseGlovoDetail,
  parseGlovoListingPage,
} from "../src/glovo.ts";

const source: SourceDefinition = {
  sourceKey: "glovo-test",
  company: "Glovo",
  adapter: "GLOVO",
  endpoint: "https://careers.glovoapp.com/wp-admin/admin-ajax.php",
  allowedHosts: [
    "careers.glovoapp.com",
    "api.smartrecruiters.com",
    "jobs.smartrecruiters.com",
  ],
  maxJobs: 100,
  maxResponseBytes: 250_000,
  maxDetailJobs: 30,
  maxPages: 12,
  searchTerms: ["data", "engineer", "scientist"],
  locationFilters: ["es", "pl"],
};

const glovoFixture = JSON.parse(await readFile(
  new URL("./fixtures/glovo-listing.json", import.meta.url),
  "utf8",
)) as unknown;

const listingHtml = `<div class="col-12" data-job-card="744000147038484" data-job-profile="Data - IC2">
  <div class="career-card">
    <h4 class="job-title">Senior Data Scientist</h4>
    <ul class="job-address"><li><span>Warsaw, Poland</span></li></ul>
    <div class="apply-job"><a href="https://careers.glovoapp.com/job/senior-data-scientist-in-warsaw-poland-jid-744000147038484/">Apply</a></div>
  </div>
</div>`;

const listing = {
  sourceJobId: "744000147038484",
  title: "Senior Data Scientist",
  detailUrl: "https://careers.glovoapp.com/job/senior-data-scientist-in-warsaw-poland-jid-744000147038484/",
};

const detail = {
  active: true,
  id: listing.sourceJobId,
  name: listing.title,
  company: { identifier: "DeliveryHero", name: "Delivery Hero" },
  customField: [{ fieldLabel: "Brands", valueId: "Glovo", valueLabel: "Glovo" }],
  releasedDate: "2026-09-15T14:09:58.558Z",
  postingUrl: "https://jobs.smartrecruiters.com/DeliveryHero/744000147038484-senior-data-scientist",
  location: {
    country: "pl",
    fullLocation: "Warsaw, Poland",
    remote: false,
    hybrid: true,
  },
  typeOfEmployment: { id: "permanent", label: "Full-time" },
  jobAd: {
    sections: {
      companyDescription: { text: "<p>About Glovo.</p>" },
      jobDescription: { text: "<p>Build machine learning systems.</p>" },
      qualifications: { text: "<p>Production experience.</p>" },
      additionalInformation: { text: "" },
    },
  },
};

function response(value: unknown): ShadowHttpResponse {
  const body = JSON.stringify(value);
  return {
    status: 200,
    contentType: "application/json",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("builds a bounded Glovo form request", () => {
  const request = buildGlovoListingRequest(source, "data", 2);
  assert.equal(request.url, source.endpoint);
  assert.equal(request.contentType, "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(
    request.body,
    "action=glovo_filter_jobs&page=2&search=data&team_page=false&team_id=",
  );
  assert.throws(() => buildGlovoListingRequest(source, "", 1), /must not be empty/);
  assert.throws(() => buildGlovoListingRequest(source, "data", 0), /positive integer/);
});

test("parses strict Glovo listing cards", () => {
  assert.deepEqual(
    parseGlovoListingPage(glovoFixture, source),
    { total: 1, listings: [listing] },
  );
  assert.throws(
    () => parseGlovoListingPage({
      success: true,
      data: { total: 1, html: listingHtml.replace(listing.sourceJobId, "123") },
    }, source),
    /invalid job id/,
  );
});

test("normalizes only matching Glovo-branded details", () => {
  assert.equal(buildGlovoDetailUrl(listing, source),
    `https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings/${listing.sourceJobId}`);
  const job = parseGlovoDetail(detail, listing, source, "2026-09-16T12:00:00Z");
  assert.equal(job.company, "Glovo");
  assert.equal(job.descriptionText, "About Glovo. Build machine learning systems. Production experience.");
  assert.deepEqual(job.countryCodes, ["PL"]);
  assert.equal(job.workplaceType, "Hybrid");
});

test("rejects non-Glovo and mismatched detail payloads", () => {
  assert.throws(
    () => parseGlovoDetail({
      ...detail,
      customField: [{ fieldLabel: "Brands", valueId: "default", valueLabel: "Delivery Hero" }],
    }, listing, source, "2026-09-16T12:00:00Z"),
    /unexpected brand/,
  );
  assert.throws(
    () => parseGlovoDetail({ ...detail, id: "744000147038999" }, listing, source, "2026-09-16T12:00:00Z"),
    /does not match/,
  );
});

test("collects Glovo listings and fetches only branded candidate details", () => {
  const calls: Parameters<FetchMany>[0][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    return calls.length === 1
      ? requests.map(() => response({ success: true, data: { total: 1, html: listingHtml } }))
      : [response(detail)];
  };
  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 3);
  assert.equal(calls[0][0].contentType, "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(calls[1][0].url,
    `https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings/${listing.sourceJobId}`);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 0,
  });
});

test("marks Glovo partial when pagination exceeds its cap", () => {
  const nonCandidateHtml = listingHtml.replace("Senior Data Scientist", "Account Executive");
  const fetchMany: FetchMany = (requests) => requests.map(() => response({
    success: true,
    data: { total: 13, html: nonCandidateHtml },
  }));
  const collection = collectShadow([{ ...source, maxPages: 3 }], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});