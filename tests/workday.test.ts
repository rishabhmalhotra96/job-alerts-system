import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SourceDefinition } from "../src/domain.ts";
import {
  collectShadow,
  type FetchMany,
  type ShadowHttpRequest,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import {
  buildWorkdayListingRequest,
  hasRequiredWorkdayAttribution,
  parseWorkdayDetail,
  parseWorkdayListingPage,
} from "../src/workday.ts";

const source: SourceDefinition = {
  sourceKey: "example-workday",
  company: "Example",
  adapter: "WORKDAY",
  endpoint: "https://example.wd3.myworkdayjobs.com/wday/cxs/example/Careers",
  allowedHosts: ["example.wd3.myworkdayjobs.com"],
  maxJobs: 200,
  maxResponseBytes: 500_000,
  maxDetailJobs: 30,
  maxPages: 10,
  searchTerms: ["data scientist"],
};

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
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

test("builds a bounded Workday POST body", () => {
  const request = buildWorkdayListingRequest(source, "data scientist", 20);
  assert.equal(request.url, `${source.endpoint}/jobs`);
  assert.deepEqual(JSON.parse(request.body), {
    appliedFacets: {},
    limit: 20,
    offset: 20,
    searchText: "data scientist",
  });
  assert.throws(() => buildWorkdayListingRequest(source, "", 1), /page boundary/);
});

test("applies configured Workday facets without changing unfiltered sources", () => {
  const filtered = buildWorkdayListingRequest({
    ...source,
    workdayAppliedFacets: {
      locationCountry: ["spain-workday-id"],
    },
  }, "", 0);

  assert.deepEqual(JSON.parse(filtered.body).appliedFacets, {
    locationCountry: ["spain-workday-id"],
  });
  assert.deepEqual(JSON.parse(buildWorkdayListingRequest(source, "", 0).body).appliedFacets, {});
});

test("parses listing metadata and rejects unsafe paths", async () => {
  const page = parseWorkdayListingPage(await fixture("workday-listing.json"));
  assert.equal(page.total, 2);
  assert.equal(page.postings[0].externalPath, "/job/Singapore/Senior-Machine-Learning-Engineer_WD100");

  assert.throws(() => parseWorkdayListingPage({
    total: 1,
    jobPostings: [{ title: "A", externalPath: "/job/../admin", locationsText: "A" }],
  }), /unsafe externalPath/);
});

test("omits identity-less Workday tombstones without accepting partial job identity", () => {
  const page = parseWorkdayListingPage({
    total: 2,
    jobPostings: [
      { bulletFields: ["588580"] },
      {
        title: "Data Scientist",
        externalPath: "/job/Amsterdam/Data-Scientist_WD101",
        locationsText: "Amsterdam, Netherlands",
      },
    ],
  });

  assert.equal(page.total, 2);
  assert.deepEqual(page.postings, [{
    title: "Data Scientist",
    externalPath: "/job/Amsterdam/Data-Scientist_WD101",
    locationText: "Amsterdam, Netherlands",
  }]);
  assert.throws(() => parseWorkdayListingPage({
    total: 1,
    jobPostings: [{
      bulletFields: ["588580"],
      externalPath: "/job/Amsterdam/Data-Scientist_WD101",
      locationsText: "Amsterdam, Netherlands",
    }],
  }), /invalid title/);
  assert.throws(() => parseWorkdayListingPage({
    total: 1,
    jobPostings: [{ bulletFields: [] }],
  }), /invalid title/);
});

test("normalizes a Workday detail with stable ID and country", async () => {
  const job = parseWorkdayDetail(
    await fixture("workday-detail.json"),
    source,
    "2026-09-16T12:00:00Z",
  );
  assert.equal(job.sourceJobId, "WD100");
  assert.equal(job.locationText, "Singapore - Central | Singapore - East");
  assert.deepEqual(job.countryCodes, ["SG"]);
  assert.equal(job.employmentType, "Full time");
  assert.equal(job.descriptionText, "Build machine learning ranking systems.");
});

test("requires explicit normalized Workday detail attribution when configured", async () => {
  const job = parseWorkdayDetail(
    await fixture("workday-detail.json"),
    source,
    "2026-09-16T12:00:00Z",
  );
  const attributed = {
    ...job,
    descriptionText: "Join BBVA AI-Factory's Madrid data team.",
  };
  const configured = {
    ...source,
    workdayRequiredAttributionTerms: ["AI Factory"],
  };

  assert.equal(hasRequiredWorkdayAttribution(attributed, configured), true);
  assert.equal(hasRequiredWorkdayAttribution(job, configured), false);
  assert.equal(hasRequiredWorkdayAttribution(job, source), true);
});

test("normalizes a Workday country descriptor object", async () => {
  const detail = await fixture("workday-detail.json") as { jobPostingInfo: Record<string, unknown> };
  detail.jobPostingInfo.country = {
    descriptor: "Belgium",
    id: "a04ea128f43a42e59b1e6a19e8f0b374",
  };
  detail.jobPostingInfo.location = "Bruxelles Avenue Marnix (ING)";
  detail.jobPostingInfo.additionalLocations = [];

  const job = parseWorkdayDetail(detail, source, "2026-09-16T12:00:00Z");

  assert.deepEqual(job.countryCodes, ["BE"]);
});

test("normalizes an ineligible Workday country for deterministic exclusion", async () => {
  const detail = await fixture("workday-detail.json") as { jobPostingInfo: Record<string, unknown> };
  detail.jobPostingInfo.country = {
    descriptor: "Türkiye",
    id: "workday-country-id",
  };
  detail.jobPostingInfo.location = "Istanbul";
  detail.jobPostingInfo.additionalLocations = [];

  const job = parseWorkdayDetail(detail, source, "2026-09-16T12:00:00Z");

  assert.deepEqual(job.countryCodes, ["TR"]);
});

test("rejects oversized listing pages and unsafe detail links", async () => {
  assert.throws(() => parseWorkdayListingPage({
    total: 21,
    jobPostings: Array.from({ length: 21 }, (_, index) => ({
      title: `Job ${index}`,
      externalPath: `/job/Test/Job-${index}`,
      locationsText: "Test",
    })),
  }), /exceeds page size/);

  const detail = await fixture("workday-detail.json") as { jobPostingInfo: Record<string, unknown> };
  detail.jobPostingInfo.externalUrl = "https://attacker.example/job/WD100";
  assert.throws(
    () => parseWorkdayDetail(detail, source, "2026-09-16T12:00:00Z"),
    /not allowlisted/,
  );
});

test("paginates Workday searches and fetches only candidate details", async () => {
  const calls: ShadowHttpRequest[][] = [];
  const detail = await fixture("workday-detail.json");
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    if (calls.length === 1) {
      return [response({
        total: 21,
        jobPostings: [{
          title: "Senior Machine Learning Engineer",
          externalPath: "/job/Singapore/Senior-Machine-Learning-Engineer_WD100",
          locationsText: "Singapore - Central",
        }],
      })];
    }
    if (calls.length === 2) {
      return [response({
        total: 21,
        jobPostings: [{
          title: "Account Executive",
          externalPath: "/job/Singapore/Account-Executive_WD101",
          locationsText: "Singapore - Central",
        }],
      })];
    }
    return [response(detail)];
  };

  const collection = collectShadow(
    [{ ...source, maxPages: 2 }],
    fetchMany,
  );

  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0][0].body!).offset, 0);
  assert.equal(JSON.parse(calls[1][0].body!).offset, 20);
  assert.deepEqual(calls[2], [{
    url: `${source.endpoint}/job/Singapore/Senior-Machine-Learning-Engineer_WD100`,
    method: "get",
  }]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 1,
    REVIEW: 0,
    EXCLUDED: 1,
  });
});

test("retries one transient Workday listing schema failure once", () => {
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    return calls.length === 1
      ? [response({ errorCode: "transient" })]
      : [response({
        total: 1,
        jobPostings: [{
          title: "Account Executive",
          externalPath: "/job/Singapore/Account-Executive_WD101",
          locationsText: "Singapore - Central",
        }],
      })];
  };

  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].warnings, []);
});

test("retries one transient Workday pagination schema failure once", () => {
  let callCount = 0;
  const fetchMany: FetchMany = () => {
    callCount += 1;
    if (callCount === 1) {
      return [response({
        total: 21,
        jobPostings: [{
          title: "Account Executive",
          externalPath: "/job/Singapore/Account-Executive_WD101",
          locationsText: "Singapore - Central",
        }],
      })];
    }
    return callCount === 2
      ? [response({ errorCode: "transient" })]
      : [response({
        total: 21,
        jobPostings: [{
          title: "Account Manager",
          externalPath: "/job/Singapore/Account-Manager_WD102",
          locationsText: "Singapore - Central",
        }],
      })];
  };

  const collection = collectShadow([{ ...source, maxPages: 2 }], fetchMany);

  assert.equal(callCount, 3);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 2);
});

test("retries two isolated Workday listing schema failures once", () => {
  let callCount = 0;
  const validPages = [
    response({
      total: 1,
      jobPostings: [{
        title: "Account Executive",
        externalPath: "/job/Singapore/Account-Executive_WD101",
        locationsText: "Singapore - Central",
      }],
    }),
    response({
      total: 1,
      jobPostings: [{
        title: "Account Manager",
        externalPath: "/job/Singapore/Account-Manager_WD102",
        locationsText: "Singapore - Central",
      }],
    }),
  ];
  const fetchMany: FetchMany = (requests) => {
    callCount += 1;
    return callCount === 1
      ? requests.map(() => response({ errorCode: "transient" }))
      : validPages;
  };

  const collection = collectShadow([{
    ...source,
    maxPages: 2,
    searchTerms: ["data scientist", "machine learning engineer"],
  }], fetchMany);

  assert.equal(callCount, 2);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 2);
});

test("retries a repeated transient Workday listing schema failure twice", () => {
  let callCount = 0;
  const retryRounds: number[] = [];
  const fetchMany: FetchMany = () => {
    callCount += 1;
    return callCount < 3
      ? [response({ errorCode: "transient" })]
      : [response({
        total: 1,
        jobPostings: [{
          title: "Account Executive",
          externalPath: "/job/Singapore/Account-Executive_WD101",
          locationsText: "Singapore - Central",
        }],
      })];
  };

  const collection = collectShadow(
    [{ ...source, maxPages: 1 }],
    fetchMany,
    undefined,
    undefined,
    undefined,
    undefined,
    (retryRound) => retryRounds.push(retryRound),
  );

  assert.equal(callCount, 3);
  assert.deepEqual(retryRounds, [1, 2]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.deepEqual(collection.report.sources[0].warnings, []);
});

test("fails closed after two Workday listing schema retry rounds", () => {
  let callCount = 0;
  const collection = collectShadow(
    [{ ...source, maxPages: 1 }],
    () => {
      callCount += 1;
      return [response({ errorCode: "persistent" })];
    },
  );

  assert.equal(callCount, 3);
  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.deepEqual(collection.report.sources[0].warnings, ["SCHEMA_INVALID"]);
});

test("does not retry broad Workday listing schema failure", () => {
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    return requests.map(() => response({ errorCode: "persistent" }));
  };

  const collection = collectShadow([{
    ...source,
    maxPages: 3,
    searchTerms: ["data scientist", "machine learning engineer", "research scientist"],
  }], fetchMany);

  assert.equal(calls.length, 1);
  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.deepEqual(collection.report.sources[0].warnings, ["SCHEMA_INVALID"]);
});

test("preserves a transport failure from the Workday schema retry", () => {
  let callCount = 0;
  const fetchMany: FetchMany = () => {
    callCount += 1;
    return callCount === 1
      ? [response({ errorCode: "transient" })]
      : [{ status: 503, contentType: "application/json", body: "{}", byteLength: 2 }];
  };

  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(callCount, 2);
  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.deepEqual(collection.report.sources[0].warnings, ["HTTP_STATUS"]);
});

test("marks Workday partial when pagination exceeds its hard cap", () => {
  const fetchMany: FetchMany = () => [response({
    total: 21,
    jobPostings: [{
      title: "Account Executive",
      externalPath: "/job/Singapore/Account-Executive_WD101",
      locationsText: "Singapore - Central",
    }],
  })];

  const collection = collectShadow([{ ...source, maxPages: 1 }], fetchMany);

  assert.equal(collection.report.sources[0].status, "PARTIAL");
  assert.deepEqual(collection.report.sources[0].warnings, ["PAGINATION_LIMIT"]);
});