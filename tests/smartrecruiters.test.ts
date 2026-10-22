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
  buildSmartRecruitersListingUrl,
  parseSmartRecruitersDetail,
  parseSmartRecruitersListingPage,
} from "../src/smartrecruiters.ts";

const source: SourceDefinition = {
  sourceKey: "grab-test",
  company: "Grab",
  adapter: "SMARTRECRUITERS",
  endpoint: "https://api.smartrecruiters.com/v1/companies/Grab/postings",
  allowedHosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"],
  maxJobs: 200,
  maxResponseBytes: 250_000,
  maxDetailJobs: 30,
  maxPages: 2,
  locationFilters: ["sg"],
};

const malaysiaSource: SourceDefinition = {
  ...source,
  sourceKey: "grab-malaysia-smartrecruiters",
  locationFilters: ["my"],
};

const smartRecruitersFixture = JSON.parse(await readFile(
  new URL("./fixtures/smartrecruiters-listing.json", import.meta.url),
  "utf8",
)) as unknown;

const listing = {
  totalFound: 1,
  limit: 100,
  offset: 0,
  content: [{
    id: "744000149615591",
    name: "Senior Data Scientist",
    location: { country: "sg" },
  }],
};

const detail = {
  active: true,
  id: "744000149615591",
  name: "Senior Data Scientist",
  releasedDate: "2026-09-15T14:09:58.558Z",
  postingUrl: "https://jobs.smartrecruiters.com/Grab/744000149615591-senior-data-scientist",
  location: {
    country: "sg",
    fullLocation: "Singapore, Singapore",
    remote: false,
    hybrid: true,
  },
  typeOfEmployment: { id: "permanent", label: "Full-time" },
  jobAd: {
    sections: {
      companyDescription: { text: "<p>About Grab.</p>" },
      jobDescription: { text: "<p>Build machine learning systems.</p>" },
      qualifications: { text: "<p>Production experience &amp; Python.</p>" },
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

test("builds a bounded SmartRecruiters listing URL with a country filter", () => {
  const url = buildSmartRecruitersListingUrl(source, 100);
  assert.equal(
    url,
    "https://api.smartrecruiters.com/v1/companies/Grab/postings?limit=100&offset=100&country=sg",
  );
  assert.throws(() => buildSmartRecruitersListingUrl(source, 1), /page boundary/);
  assert.equal(
    buildSmartRecruitersListingUrl(malaysiaSource, 0),
    "https://api.smartrecruiters.com/v1/companies/Grab/postings?limit=100&offset=0&country=my",
  );
});

test("parses SmartRecruiters listing metadata and rejects duplicates", () => {
  assert.deepEqual(parseSmartRecruitersListingPage(smartRecruitersFixture, source), {
    total: 1,
    listings: [{ sourceJobId: "744000149615591", title: "Senior Data Scientist" }],
  });
  assert.throws(
    () => parseSmartRecruitersListingPage({
      ...listing,
      content: [listing.content[0], listing.content[0]],
    }, source),
    /duplicate job id/,
  );
  assert.throws(
    () => parseSmartRecruitersListingPage({
      ...listing,
      content: [{ ...listing.content[0], location: { country: "my" } }],
    }, source),
    /unexpected country/,
  );
});

test("normalizes SmartRecruiters detail HTML and employment metadata", () => {
  const job = parseSmartRecruitersDetail(detail, source, "2026-09-16T12:00:00Z");
  assert.equal(job.sourceJobId, "744000149615591");
  assert.equal(job.descriptionText, "About Grab. Build machine learning systems. Production experience & Python.");
  assert.deepEqual(job.countryCodes, ["SG"]);
  assert.equal(job.workplaceType, "Hybrid");
  assert.equal(job.employmentType, "Full-time");
  assert.equal(job.canonicalUrl, detail.postingUrl);

  const malaysiaJob = parseSmartRecruitersDetail({
    ...detail,
    location: {
      ...detail.location,
      country: "my",
      fullLocation: "Petaling Jaya, Malaysia",
    },
  }, malaysiaSource, "2026-09-16T12:00:00Z");
  assert.equal(malaysiaJob.sourceKey, "grab-malaysia-smartrecruiters");
  assert.deepEqual(malaysiaJob.countryCodes, ["MY"]);
});

test("rejects inactive, unexpected-country, and unsafe SmartRecruiters details", () => {
  assert.throws(
    () => parseSmartRecruitersDetail({ ...detail, active: false }, source, "2026-09-16T12:00:00Z"),
    /invalid shape/,
  );
  assert.throws(
    () => parseSmartRecruitersDetail({
      ...detail,
      location: { ...detail.location, country: "my" },
    }, source, "2026-09-16T12:00:00Z"),
    /country is not configured/,
  );
  assert.throws(
    () => parseSmartRecruitersDetail({
      ...detail,
      postingUrl: "https://attacker.example/job",
    }, source, "2026-09-16T12:00:00Z"),
    /not allowlisted/,
  );
});

test("collects SmartRecruiters listings and fetches only candidate details", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map((request) => request.url));
    return calls.length === 1 ? [response(listing)] : [response(detail)];
  };
  const collection = collectShadow([source], fetchMany);

  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /country=sg/);
  assert.equal(calls[1][0], `${source.endpoint}/744000149615591`);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 0,
  });
});

test("collects Grab Singapore and Malaysia as isolated bounded sources", () => {
  const requests: string[] = [];
  const malaysiaListing = {
    ...listing,
    content: [{
      ...listing.content[0],
      id: "744000146439114",
      location: { country: "my" },
    }],
  };
  const malaysiaDetail = {
    ...detail,
    id: "744000146439114",
    location: {
      ...detail.location,
      country: "my",
      fullLocation: "Petaling Jaya, Malaysia",
    },
  };
  const fetchMany: FetchMany = (batch) => {
    requests.push(...batch.map((request) => request.url));
    return batch.map((request) => request.url.includes("country=sg")
      ? response(listing)
      : request.url.includes("country=my")
        ? response(malaysiaListing)
        : request.url.endsWith("744000146439114")
          ? response(malaysiaDetail)
          : response(detail));
  };
  const collection = collectShadow([source, malaysiaSource], fetchMany);

  assert.ok(requests.some((url) => url.endsWith("offset=0&country=sg")));
  assert.ok(requests.some((url) => url.endsWith("offset=0&country=my")));
  assert.deepEqual(collection.report.sources.map((result) => ({
    sourceKey: result.sourceKey,
    status: result.status,
    matches: result.matches,
  })), [
    { sourceKey: "grab-test", status: "SUCCESS", matches: { STRONG: 1, REVIEW: 0, EXCLUDED: 0 } },
    { sourceKey: "grab-malaysia-smartrecruiters", status: "SUCCESS", matches: { STRONG: 1, REVIEW: 0, EXCLUDED: 0 } },
  ]);
});

test("marks SmartRecruiters partial when pagination exceeds its cap", () => {
  const fetchMany: FetchMany = () => [response({
    ...listing,
    totalFound: 101,
    content: [{
      id: "744000149794720",
      name: "Account Executive",
      location: { country: "sg" },
    }],
  })];
  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});