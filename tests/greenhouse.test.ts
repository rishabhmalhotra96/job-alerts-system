import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SourceDefinition } from "../src/domain.ts";
import { assertAllowedHttpsUrl, parseGreenhouseResponse } from "../src/greenhouse.ts";

const source: SourceDefinition = {
  sourceKey: "example-greenhouse",
  company: "Example",
  adapter: "GREENHOUSE",
  endpoint: "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true",
  allowedHosts: ["boards.greenhouse.io"],
  maxJobs: 100,
  maxResponseBytes: 1_000_000,
  maxDetailJobs: 20,
  maxPages: 1,
};

test("normalizes a valid Greenhouse fixture and strips active HTML", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/greenhouse.json", import.meta.url), "utf8"),
  ) as unknown;

  const jobs = parseGreenhouseResponse(fixture, source, "2026-09-16T09:00:00Z");

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].sourceJobId, "101");
  assert.equal(jobs[0].descriptionText, "Build ranking & recommendation systems.");
  assert.equal(jobs[0].canonicalUrl, "https://boards.greenhouse.io/example/jobs/101");
  assert.equal(jobs[0].employmentType, "Employee - Permanent");
  assert.equal(jobs[0].publishedAt, "2026-09-15T08:00:00Z");
});

test("rejects non-allowlisted job links", () => {
  const payload = {
    jobs: [{
      id: 1,
      title: "Senior Data Scientist",
      location: { name: "Amsterdam, Netherlands" },
      absolute_url: "https://attacker.example/jobs/1",
    }],
  };

  assert.throws(
    () => parseGreenhouseResponse(payload, source, "2026-09-16T09:00:00Z"),
    /not allowlisted/,
  );
});

test("rejects credentials, ports, and private or local IP literals", () => {
  assert.equal(
    assertAllowedHttpsUrl("https://example.com:443/jobs", ["example.com"]),
    "https://example.com:443/jobs",
  );
  assert.throws(
    () => assertAllowedHttpsUrl("https://user@example.com/jobs", ["example.com"]),
    /credentials or a non-default port/,
  );
  assert.throws(
    () => assertAllowedHttpsUrl("https://example.com:8443/jobs", ["example.com"]),
    /credentials or a non-default port/,
  );
  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.2",
    "172.16.0.1",
    "192.168.1.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "127.1",
  ]) {
    assert.throws(
      () => assertAllowedHttpsUrl(`https://${address}/jobs`, [address]),
      /private or local address/,
    );
  }
  assert.throws(
    () => assertAllowedHttpsUrl("https://[::1]/jobs", ["[::1]"]),
    /unsupported IP literal/,
  );
  assert.throws(
    () => assertAllowedHttpsUrl("https://example.com\r\nX-Test: injected/jobs", ["example.com"]),
    /invalid/,
  );
});

test("rejects duplicate IDs and oversized responses", () => {
  const duplicate = {
    jobs: [
      { id: 1, title: "A", location: { name: "A" }, absolute_url: "https://boards.greenhouse.io/a" },
      { id: 1, title: "B", location: { name: "B" }, absolute_url: "https://boards.greenhouse.io/b" },
    ],
  };
  assert.throws(
    () => parseGreenhouseResponse(duplicate, source, "2026-09-16T09:00:00Z"),
    /duplicate job id/,
  );

  assert.throws(
    () => parseGreenhouseResponse({ jobs: [{}, {}] }, { ...source, maxJobs: 1 }, "2026-09-16T09:00:00Z"),
    /exceeds maxJobs/,
  );
});

test("rejects ambiguous employment metadata", () => {
  const payload = {
    jobs: [{
      id: 1,
      title: "Senior Data Scientist",
      location: { name: "Vilnius, Lithuania" },
      absolute_url: "https://boards.greenhouse.io/example/jobs/1",
      metadata: [
        { name: "Employment Type", value: "Permanent" },
        { name: "Employment Type", value: "Contract" },
      ],
    }],
  };

  assert.throws(
    () => parseGreenhouseResponse(payload, source, "2026-09-16T09:00:00Z"),
    /ambiguous Employment Type metadata/,
  );
});