import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateRolloutCapacity,
  calculateSourceCapacity,
  EXPANSION_ROLLOUT_WAVES,
  EXPANSION_SOURCE_KEYS,
  MAX_ROLLOUT_WAVE_REQUEST_ATTEMPTS,
} from "../src/rollout-capacity.ts";
import { MVP_SOURCES } from "../src/sources.ts";

function source(sourceKey: string) {
  const match = MVP_SOURCES.find((candidate) => candidate.sourceKey === sourceKey);
  assert.ok(match);
  return match;
}

test("derives conservative request and materialization bounds from adapter control flow", () => {
  assert.deepEqual(calculateSourceCapacity(source("feedzai-greenhouse")), {
    sourceKey: "feedzai-greenhouse",
    company: "Feedzai",
    adapter: "GREENHOUSE",
    host: "boards-api.greenhouse.io",
    listingRequests: 1,
    detailRequests: 30,
    requestAttempts: 93,
    materializedResponseBytes: 9_300_000,
    customAdapter: false,
  });
  assert.deepEqual(calculateSourceCapacity(source("vinted-greenhouse")), {
    sourceKey: "vinted-greenhouse",
    company: "Vinted",
    adapter: "GREENHOUSE",
    host: "boards-api.greenhouse.io",
    listingRequests: 1,
    detailRequests: 40,
    requestAttempts: 123,
    materializedResponseBytes: 61_500_000,
    customAdapter: false,
  });
  assert.equal(calculateSourceCapacity(source("philips-workday")).requestAttempts, 258);
  assert.equal(calculateSourceCapacity(source("nus-public-sitemap")).requestAttempts, 183);
  assert.equal(calculateSourceCapacity(source("amazon-public-json")).requestAttempts, 60);
});

test("covers every expansion source exactly once in bounded rollout waves", () => {
  const capacities = calculateRolloutCapacity();
  assert.deepEqual(
    capacities.flatMap(({ sourceKeys }) => sourceKeys).sort(),
    [...EXPANSION_SOURCE_KEYS].sort(),
  );
  assert.equal(capacities.length, EXPANSION_ROLLOUT_WAVES.length);
  assert.ok(capacities.every(({ companies }) => companies.length <= 12));
  assert.ok(capacities.every(({ customCompanies }) => customCompanies.length <= 8));
  assert.ok(capacities.every(({ requestAttempts }) =>
    requestAttempts <= MAX_ROLLOUT_WAVE_REQUEST_ATTEMPTS));
  assert.ok(capacities.every(({ projectedDailyUrlFetchCalls }) =>
    projectedDailyUrlFetchCalls <= 20_000));
  assert.ok(capacities.every(({ cohorts }) => cohorts.every(({ sourceKeys }) =>
    sourceKeys.length > 0)));
});

test("fails closed on missing, duplicate, unknown, disabled, or oversized waves", () => {
  assert.throws(
    () => calculateRolloutCapacity(MVP_SOURCES, EXPANSION_ROLLOUT_WAVES.slice(1)),
    /membership is incomplete/,
  );
  assert.throws(
    () => calculateRolloutCapacity(MVP_SOURCES, [
      ...EXPANSION_ROLLOUT_WAVES,
      { id: "duplicate", sourceKeys: [EXPANSION_SOURCE_KEYS[0]] },
    ]),
    /unexpected or duplicated/,
  );
  assert.throws(
    () => calculateRolloutCapacity(MVP_SOURCES, [
      { id: "unknown", sourceKeys: ["unknown-source"] },
    ]),
    /unexpected or duplicated/,
  );
  assert.throws(
    () => calculateRolloutCapacity(
      MVP_SOURCES.map((item) => item.sourceKey === EXPANSION_SOURCE_KEYS[0]
        ? { ...item, operationallyDisabled: true }
        : item),
    ),
    /missing or disabled/,
  );
  assert.throws(
    () => calculateRolloutCapacity(MVP_SOURCES, [
      {
        id: "oversized",
        sourceKeys: [
          "philips-workday",
          "shell-workday",
          ...EXPANSION_SOURCE_KEYS.filter((key) =>
            key !== "philips-workday" && key !== "shell-workday"),
        ],
      },
    ]),
    /exceeds a capacity limit/,
  );
});