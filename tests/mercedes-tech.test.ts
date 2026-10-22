import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type FetchMany,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { parseMercedesTechFeed } from "../src/mercedes-tech.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "mercedes-tech-xml")!;
const feed = await readFile(new URL("./fixtures/mercedes-tech.xml", import.meta.url), "utf8");

function response(body: string): ShadowHttpResponse {
  return {
    status: 200,
    contentType: "application/xml; charset=UTF-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("normalizes the complete Mercedes-Benz Tech Innovation feed", () => {
  const jobs = parseMercedesTechFeed(feed, source, "2026-09-26T12:00:00.000Z");

  assert.equal(jobs.length, 2);
  assert.equal(parseMercedesTechFeed(
    feed.replace(/^<\?xml[^?]*\?>\s*/, ""),
    source,
    "2026-09-26T12:00:00.000Z",
  ).length, 2);
  assert.deepEqual(jobs[0], {
    sourceKey: "mercedes-tech-xml",
    company: "Mercedes-Benz Tech",
    sourceJobId: "R0007001",
    title: "Senior Data Scientist (m/f/d/x)",
    descriptionText: "We are Mercedes-Benz Tech Innovation. You will build production machine-learning models, design reliable experiments, and work with engineers to improve mobility products. You bring Python, statistics, causal inference, and strong communication skills to an international product team.",
    descriptionCompleteness: "FULL",
    locationText: "Berlin, Remote - Hybrid, Germany",
    countryCodes: ["DE"],
    workplaceType: "Hybrid",
    employmentType: "Professional (Permanent)",
    publishedAt: "2026-09-20T06:00:00.000Z",
    updatedAt: null,
    canonicalUrl: "https://mercedesbenztechinnovation.wd3.myworkdayjobs.com/MBTI_JOBPORTAL/job/Berlin/Senior-Data-Scientist_R0007001",
    fetchedAt: "2026-09-26T12:00:00.000Z",
  });
});

test("fails closed on incomplete entries and inconsistent URLs", () => {
  assert.throws(
    () => parseMercedesTechFeed(feed.replace("<Company>Mercedes-Benz Tech Innovation</Company>", ""), source, "2026-09-26T12:00:00.000Z"),
    /Company is missing or ambiguous/,
  );
  assert.throws(
    () => parseMercedesTechFeed(feed.replace("R0007001/apply", "R0009999/apply"), source, "2026-09-26T12:00:00.000Z"),
    /apply URL does not match/,
  );
  assert.throws(
    () => parseMercedesTechFeed(feed.replace("R0007002</jobRequisitionID>", "R0007001</jobRequisitionID>"), source, "2026-09-26T12:00:00.000Z"),
    /invalid or duplicate requisition ID/,
  );
});

test("excludes the reviewed prognum posting site and rejects unknown mixed sites", () => {
  const mixedEntry = `
  <Report_Entry>
    <jobPostingSite>prognum Automotive GmbH</jobPostingSite>
    <Company>Mercedes-Benz Tech Innovation</Company>
  </Report_Entry>
`;
  const mixedFeed = feed.replace("</Report_Data>", `${mixedEntry}</Report_Data>`);
  assert.equal(parseMercedesTechFeed(
    mixedFeed,
    source,
    "2026-09-28T12:00:00.000Z",
  ).length, 2);
  assert.throws(
    () => parseMercedesTechFeed(
      mixedFeed.replace("prognum Automotive GmbH", "Unknown Jobportal"),
      source,
      "2026-09-28T12:00:00.000Z",
    ),
    /unexpected identity/,
  );
});

test("collects Mercedes in one bounded request and evaluates only target titles", () => {
  const calls: string[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests.map(({ url }) => url));
    return [response(feed)];
  };

  const collection = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-26T12:00:00Z"),
    1,
    new Map(),
    ["Mercedes-Benz Tech"],
  );

  assert.deepEqual(calls, [["https://www.mercedes-benz-techinnovation.com/en/jobs.xml"]]);
  assert.equal(collection.report.sources[0].status, "SUCCESS");
  assert.equal(collection.report.sources[0].listedJobs, 2);
  assert.equal(collection.report.sources[0].detailedJobs, 1);
  assert.equal(collection.candidates.length, 1);
  assert.equal(collection.candidates[0].job.sourceJobId, "R0007001");
});
