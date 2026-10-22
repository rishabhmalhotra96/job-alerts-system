import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { matchJob } from "../src/domain.ts";
import { parseGreenhouseResponse } from "../src/greenhouse.ts";
import { parseJsonFeedResponse } from "../src/json-feed.ts";
import { MVP_SOURCES } from "../src/sources.ts";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(
    new URL(`./fixtures/${name}`, import.meta.url),
    "utf8",
  )) as unknown;
}

function source(sourceKey: string) {
  const definition = MVP_SOURCES.find((candidate) => candidate.sourceKey === sourceKey);
  assert.ok(definition, `missing source ${sourceKey}`);
  return definition;
}

test("Datadog admits only reviewed European country labels", async () => {
  const definition = source("datadog-greenhouse");
  const jobs = parseGreenhouseResponse(
    await fixture("datadog-greenhouse.json"),
    definition,
    "2026-10-06T09:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => matchJob(job, definition.matchingPolicy)), [
    {
      status: "STRONG",
      reasons: [
        "title:machine-learning-engineer",
        "skill:machine-learning",
        "location:eligible",
        "seniority:senior",
      ],
    },
    { status: "EXCLUDED", reasons: ["location:ineligible-country"] },
    { status: "EXCLUDED", reasons: ["location:broad-or-remote-only"] },
  ]);
});

test("Monzo requires explicit role-level sponsorship and UK location", async () => {
  const definition = source("monzo-greenhouse");
  const jobs = parseGreenhouseResponse(
    await fixture("monzo-greenhouse.json"),
    definition,
    "2026-10-06T09:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => matchJob(job, definition.matchingPolicy)), [
    {
      status: "STRONG",
      reasons: [
        "title:data-scientist",
        "skill:data-scientist",
        "location:eligible",
        "seniority:senior",
      ],
    },
    { status: "EXCLUDED", reasons: ["sponsorship:not-explicit"] },
    { status: "EXCLUDED", reasons: ["sponsorship:not-offered"] },
    { status: "EXCLUDED", reasons: ["location:ineligible-country"] },
  ]);
});

test("Rebtel excludes relocation-only and negative sponsorship wording", async () => {
  const definition = source("rebtel-json-feed");
  const jobs = parseJsonFeedResponse(
    await fixture("rebtel-json-feed.json"),
    definition,
    "2026-10-06T09:00:00Z",
  );

  assert.deepEqual(jobs.map((job) => matchJob(job, definition.matchingPolicy)), [
    { status: "EXCLUDED", reasons: ["sponsorship:not-explicit"] },
    { status: "EXCLUDED", reasons: ["sponsorship:not-offered"] },
  ]);
});