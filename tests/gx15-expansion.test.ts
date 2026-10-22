import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAshbyResponse } from "../src/ashby.ts";
import { EEA_COUNTRY_CODES, matchJob } from "../src/domain.ts";
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

test("GX15 freezes reviewed European company scopes", () => {
  assert.deepEqual(getTargetScope("Amo")?.eligibleCountryCodes, ["FR"]);
  assert.deepEqual(
    getTargetScope("Voodoo")?.eligibleCountryCodes,
    [...EEA_COUNTRY_CODES, "GB"],
  );
});

test("Amo admits its French AI software role and rejects a US equivalent", async () => {
  const definition = source("amo-ashby");
  const jobs = parseAshbyResponse(
    await fixture("amo-ashby.json"),
    definition,
    "2026-10-20T14:00:00Z",
  );

  assert.deepEqual(jobs.map(({ countryCodes }) => countryCodes), [["FR"], ["US"], ["FR"]]);
  assert.equal(matchJob(jobs[0], definition.matchingPolicy).status, "REVIEW");
  assert.deepEqual(matchJob(jobs[1], definition.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
  assert.deepEqual(matchJob(jobs[2], definition.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["title:not-target-family"],
  });
});

test("Voodoo admits its European ML role and rejects a US data-science role", async () => {
  const definition = source("voodoo-ashby");
  const jobs = parseAshbyResponse(
    await fixture("voodoo-ashby.json"),
    definition,
    "2026-10-20T14:00:00Z",
  );

  assert.deepEqual(jobs[0].countryCodes, ["FI", "FR"]);
  assert.equal(matchJob(jobs[0], definition.matchingPolicy).status, "STRONG");
  assert.deepEqual(matchJob(jobs[1], definition.matchingPolicy), {
    status: "EXCLUDED",
    reasons: ["location:ineligible-country"],
  });
});

test("GX15 source capacities cover the verified live inventories", () => {
  const amo = source("amo-ashby");
  const voodoo = source("voodoo-ashby");

  assert.deepEqual(
    { maxJobs: amo.maxJobs, maxResponseBytes: amo.maxResponseBytes, maxPages: amo.maxPages },
    { maxJobs: 50, maxResponseBytes: 500_000, maxPages: 1 },
  );
  assert.deepEqual(
    {
      maxJobs: voodoo.maxJobs,
      maxResponseBytes: voodoo.maxResponseBytes,
      maxPages: voodoo.maxPages,
    },
    { maxJobs: 150, maxResponseBytes: 1_500_000, maxPages: 1 },
  );
});
