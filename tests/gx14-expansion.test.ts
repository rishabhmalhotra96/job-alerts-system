import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAshbyResponse } from "../src/ashby.ts";
import { matchJob } from "../src/domain.ts";
import { parseLeverResponse } from "../src/lever.ts";
import { parseRecruiteeResponse } from "../src/recruitee.ts";
import { getTargetScope, MVP_SOURCES } from "../src/sources.ts";

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

test("GX14 freezes reviewed European company scopes", () => {
  assert.deepEqual(getTargetScope("Adjoe")?.eligibleCountryCodes, ["DE"]);
  assert.deepEqual(getTargetScope("Mayflower")?.eligibleCountryCodes, ["CY"]);
  assert.deepEqual(getTargetScope("QuantCo")?.eligibleCountryCodes, ["CH", "DE", "GB"]);
});

test("Adjoe normalizes a complete German Ashby role", async () => {
  const definition = source("adjoe-ashby");
  const [job] = parseAshbyResponse(
    await fixture("adjoe-ashby.json"),
    definition,
    "2026-10-19T12:00:00Z",
  );

  assert.deepEqual(job.countryCodes, ["DE"]);
  assert.equal(matchJob(job, definition.matchingPolicy).status, "STRONG");
});

test("Mayflower normalizes a complete Cyprus Recruitee role", async () => {
  const definition = source("mayflower-recruitee");
  const [job] = parseRecruiteeResponse(
    await fixture("mayflower-recruitee.json"),
    definition,
    "2026-10-19T12:00:00Z",
  );

  assert.deepEqual(job.countryCodes, ["CY"]);
  assert.equal(matchJob(job, definition.matchingPolicy).status, "STRONG");
});

test("QuantCo maps only its exact Europe Lever label to reviewed offices", async () => {
  const definition = source("quantco-lever");
  const [job] = parseLeverResponse(
    await fixture("quantco-lever.json"),
    definition,
    "2026-10-19T12:00:00Z",
  );

  assert.equal(job.locationText, "Europe");
  assert.deepEqual(job.countryCodes, ["CH", "DE", "GB"]);
  assert.equal(matchJob(job, definition.matchingPolicy).status, "REVIEW");
});