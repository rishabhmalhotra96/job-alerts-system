import assert from "node:assert/strict";
import test from "node:test";

import {
  collectShadow,
  evaluateCountIntegrity,
  type FetchMany,
  type ShadowHttpRequest,
  type ShadowHttpResponse,
  validateSourceRegistry,
} from "../src/collector.ts";
import type { SourceDefinition } from "../src/domain.ts";
import {
  getUnsupportedTargets,
  ACTIVE_MVP_SOURCES,
  ACTIVE_REQUIRED_TARGET_COUNT,
  ACTIVE_ROLLOUT_WAVE_ID,
  ACTIVE_TARGET_COMPANIES,
  BASELINE_SOURCE_KEYS,
  EXISTING_ASHBY_SOURCE_KEYS,
  getTargetScope,
  MVP_SOURCES,
  REQUIRED_TARGET_COUNT,
  TARGET_COMPANIES,
  TARGET_SCOPES,
  validateSourceTargetScopes,
} from "../src/sources.ts";

const source: SourceDefinition = {
  sourceKey: "example-greenhouse",
  company: "Example",
  adapter: "GREENHOUSE",
  endpoint: "https://boards-api.greenhouse.io/v1/boards/example/jobs",
  allowedHosts: ["boards-api.greenhouse.io", "boards.greenhouse.io"],
  maxJobs: 100,
  maxResponseBytes: 100_000,
  maxDetailJobs: 10,
  maxPages: 1,
};

function response(payload: unknown): ShadowHttpResponse {
  const body = JSON.stringify(payload);
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    body,
    byteLength: Buffer.byteLength(body),
  };
}

test("collects listings, fetches only candidate details, and remains degraded", () => {
  const calls: ShadowHttpRequest[][] = [];
  const fetchMany: FetchMany = (requests) => {
    calls.push(requests);
    if (calls.length === 1) {
      return [response({ jobs: [
        {
          id: 101,
          title: "Senior Machine Learning Engineer",
          location: { name: "Berlin, Germany" },
          absolute_url: "https://boards.greenhouse.io/example/jobs/101",
        },
        {
          id: 102,
          title: "Account Executive",
          location: { name: "Berlin, Germany" },
          absolute_url: "https://boards.greenhouse.io/example/jobs/102",
        },
      ] })];
    }
    return [response({
      id: 101,
      title: "Senior Machine Learning Engineer",
      location: { name: "Berlin, Germany" },
      absolute_url: "https://boards.greenhouse.io/example/jobs/101",
      content: "Build machine learning ranking systems.",
    })];
  };
  const times = [new Date("2026-09-16T09:00:00Z"), new Date("2026-09-16T09:00:01Z")];

  const collection = collectShadow([source], fetchMany, () => times.shift()!, 26);
  const report = collection.report;

  assert.equal(report.mode, "DEGRADED_SHADOW");
  assert.equal(report.configuredTargets, 1);
  assert.equal(report.requiredTargets, 26);
  assert.deepEqual(calls[1], [{ url: `${source.endpoint}/101`, method: "get" }]);
  assert.deepEqual(report.sources[0].matches, { STRONG: 0, REVIEW: 1, EXCLUDED: 1 });
});

test("fails a source without detail fetches when listing integrity fails", () => {
  let callCount = 0;
  const fetchMany: FetchMany = () => {
    callCount += 1;
    return [{ status: 200, contentType: "text/html", body: "<html>", byteLength: 6 }];
  };

  const report = collectShadow(
    [source],
    fetchMany,
    () => new Date(),
    26,
    new Map([[source.sourceKey, {
      lastHealthyCount: 100,
      pendingCount: 10,
      pendingConfirmations: 1,
    }]]),
  ).report;

  assert.equal(callCount, 1);
  assert.equal(report.sources[0].status, "FAILED");
  assert.deepEqual(report.sources[0].warnings, ["CONTENT_TYPE"]);
  assert.deepEqual(report.sources[0].integrity, {
    accepted: false,
    pendingCount: 10,
    pendingConfirmations: 1,
  });
});

test("sends stored validators and treats 304 as healthy without candidates", () => {
  const calls: ShadowHttpRequest[][] = [];
  const collection = collectShadow(
    [source],
    (requests) => {
      calls.push(requests);
      return [{
        status: 304,
        contentType: "",
        etag: '"new-etag"',
        body: "",
        byteLength: 0,
      }];
    },
    () => new Date("2026-09-16T12:00:00Z"),
    28,
    new Map([[source.sourceKey, {
      lastHealthyCount: 42,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: {
        etag: '"old-etag"',
        lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
      },
      httpValidatorUrl: source.endpoint,
    }]]),
  );

  assert.deepEqual(calls, [[{
    url: source.endpoint,
    method: "get",
    ifNoneMatch: '"old-etag"',
    ifModifiedSince: "Wed, 16 Sep 2026 09:00:00 GMT",
  }]]);
  assert.deepEqual(collection.candidates, []);
  assert.deepEqual(collection.report.sources[0], {
    sourceKey: source.sourceKey,
    status: "SUCCESS",
    listedJobs: 42,
    detailedJobs: 0,
    matches: { STRONG: 0, REVIEW: 0, EXCLUDED: 0 },
    warnings: ["NOT_MODIFIED"],
    integrity: { accepted: true, pendingCount: null, pendingConfirmations: 0 },
    unchanged: true,
    httpValidators: {
      etag: '"new-etag"',
      lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
    },
    httpValidatorUrl: source.endpoint,
  });
});

test("does not send source validators after the endpoint changes", () => {
  const migratedSource = {
    ...source,
    endpoint: "https://boards-api.greenhouse.io/v1/boards/example-v2/jobs",
  };
  let request: ShadowHttpRequest | undefined;
  const report = collectShadow(
    [migratedSource],
    (requests) => {
      [request] = requests;
      return [{ status: 304, contentType: "", body: "", byteLength: 0 }];
    },
    () => new Date("2026-09-16T12:00:00Z"),
    28,
    new Map([[source.sourceKey, {
      lastHealthyCount: 42,
      pendingCount: null,
      pendingConfirmations: 0,
      httpValidators: { etag: '"old"', lastModified: null },
      httpValidatorUrl: source.endpoint,
    }]]),
  ).report;

  assert.deepEqual(request, { url: migratedSource.endpoint, method: "get" });
  assert.equal(report.sources[0].status, "FAILED");
  assert.deepEqual(report.sources[0].warnings, ["HTTP_STATUS"]);
});

test("registry rejects duplicate keys and unsafe endpoints", () => {
  const workdaySource = MVP_SOURCES.find(({ sourceKey }) =>
    sourceKey === "bbva-ai-factory-workday")!;
  assert.throws(() => validateSourceRegistry([source, source]), /Duplicate source key/);
  assert.throws(
    () => validateSourceRegistry([{ ...source, endpoint: "http://boards-api.greenhouse.io/jobs" }]),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...source,
      matchingPolicy: { eligibleCountryCodes: ["ie"] },
    }]),
    /matching countries are invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...source,
      matchingPolicy: { eligibleCountryCodes: ["IE"], locationMode: "IGNORE" },
    }]),
    /location policy is contradictory/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...source,
      matchingPolicy: { excludeRequiredNonEnglish: true },
    }]),
    /language policy requires complete descriptions/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...source,
      matchingPolicy: { requireVisaSponsorship: true },
    }]),
    /sponsorship policy requires complete descriptions/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...workdaySource,
      workdayAppliedFacets: { "bad-facet": ["spain-id"] },
    }]),
    /applied facets are invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...workdaySource,
      workdayRequiredAttributionTerms: [],
    }]),
    /attribution terms are invalid/,
  );
  const leverSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "farfetch-lever")!;
  assert.throws(
    () => validateSourceRegistry([{ ...leverSource, maxPages: 2 }]),
    /must use one complete page/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...leverSource,
      leverLocationCountryCodes: { Europe: ["de"] },
    }]),
    /location countries are invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...leverSource,
      leverLocationCountryCodes: { Europe: ["DE"] },
    }]),
    /location countries are invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{
      ...source,
      leverLocationCountryCodes: { Europe: ["DE"] },
    }]),
    /Non-Lever source has Lever configuration/,
  );
  const amdSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "amd-finland-json")!;
  assert.throws(
    () => validateSourceRegistry([{ ...amdSource, maxPages: 2 }]),
    /must use one complete page/,
  );
  const recruiteeSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "patsnap-recruitee")!;
  assert.throws(
    () => validateSourceRegistry([{ ...recruiteeSource, maxPages: 2 }]),
    /must use one complete page/,
  );
  const jsonFeedSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "boozt-json-feed")!;
  assert.throws(
    () => validateSourceRegistry([{ ...jsonFeedSource, maxPages: 2 }]),
    /must use one complete page/,
  );
  const deliveryHeroSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "delivery-hero-sitemap")!;
  assert.throws(
    () => validateSourceRegistry([{ ...deliveryHeroSource, locationFilters: ["austria"] }]),
    /configuration is invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{ ...deliveryHeroSource, maxPages: 2 }]),
    /configuration is invalid/,
  );
  const deutscheBoerseSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "deutsche-boerse-sitemap")!;
  assert.throws(
    () => validateSourceRegistry([{ ...deutscheBoerseSource, locationFilters: ["germany"] }]),
    /configuration is invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{ ...deutscheBoerseSource, maxPages: 2 }]),
    /configuration is invalid/,
  );
  const becSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "bec-vacancies")!;
  assert.throws(
    () => validateSourceRegistry([{ ...becSource, locationFilters: ["poland"] }]),
    /configuration is invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{ ...becSource, maxPages: 2 }]),
    /configuration is invalid/,
  );
  const inescTecSource = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "inesc-tec-opportunities")!;
  assert.throws(
    () => validateSourceRegistry([{ ...inescTecSource, locationFilters: ["spain"] }]),
    /configuration is invalid/,
  );
  assert.throws(
    () => validateSourceRegistry([{ ...inescTecSource, maxPages: 2 }]),
    /configuration is invalid/,
  );
});

test("collector applies source country policy to unstructured Greenhouse locations", () => {
  const irelandOnly = {
    ...source,
    matchingPolicy: { eligibleCountryCodes: ["IE"] },
  } satisfies SourceDefinition;
  let calls = 0;

  const collection = collectShadow([irelandOnly], () => {
    calls += 1;
    if (calls === 1) {
      return [response({ jobs: [{
        id: 101,
        title: "Senior Machine Learning Engineer",
        location: { name: "Berlin, Germany" },
        absolute_url: "https://boards.greenhouse.io/example/jobs/101",
      }] })];
    }
    return [response({
      id: 101,
      title: "Senior Machine Learning Engineer",
      location: { name: "Berlin, Germany" },
      absolute_url: "https://boards.greenhouse.io/example/jobs/101",
      content: "Build machine learning ranking systems.",
      metadata: [{ name: "Employment Type", value: "Full-time" }],
    })];
  }, () => new Date("2026-09-23T09:00:00Z"), 1);

  assert.equal(calls, 2);
  assert.deepEqual(collection.report.sources[0].matches, {
    STRONG: 0,
    REVIEW: 0,
    EXCLUDED: 1,
  });
  assert.deepEqual(collection.candidates[0].reasons, ["location:ineligible-country"]);
});

test("collector excludes a full Greenhouse detail with mandatory non-English language", () => {
  const languageGatedSource = {
    ...source,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  } satisfies SourceDefinition;
  let calls = 0;

  const collection = collectShadow([languageGatedSource], () => {
    calls += 1;
    if (calls === 1) {
      return [response({ jobs: [{
        id: 101,
        title: "Senior Machine Learning Engineer",
        location: { name: "Berlin, Germany" },
        absolute_url: "https://boards.greenhouse.io/example/jobs/101",
      }] })];
    }
    return [response({
      id: 101,
      title: "Senior Machine Learning Engineer",
      location: { name: "Berlin, Germany" },
      absolute_url: "https://boards.greenhouse.io/example/jobs/101",
      content: "Build machine learning systems. Fluent German required.",
      metadata: [{ name: "Employment Type", value: "Full-time" }],
    })];
  }, () => new Date("2026-09-23T09:00:00Z"), 1);

  assert.equal(calls, 2);
  assert.equal(collection.candidates[0].job.descriptionCompleteness, "FULL");
  assert.equal(collection.candidates[0].status, "EXCLUDED");
  assert.deepEqual(collection.candidates[0].reasons, ["language:de:required"]);
});

test("collector adds historical DETE evidence to an Ireland target without a sponsorship claim", () => {
  const stripeSource: SourceDefinition = {
    ...source,
    sourceKey: "stripe-greenhouse",
    company: "Stripe",
    matchingPolicy: {
      eligibleCountryCodes: ["IE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  };
  let call = 0;
  const collection = collectShadow(
    [stripeSource],
    () => {
      call += 1;
      return call === 1
        ? [response({ jobs: [{
          id: 901,
          title: "Senior Machine Learning Engineer",
          location: { name: "Dublin, Ireland" },
          absolute_url: "https://boards.greenhouse.io/example/jobs/901",
        }] })]
        : [response({
          id: 901,
          title: "Senior Machine Learning Engineer",
          location: { name: "Dublin, Ireland" },
          absolute_url: "https://boards.greenhouse.io/example/jobs/901",
          content: "Build machine learning ranking systems in a permanent role.",
        })];
    },
    () => new Date("2026-09-25T10:00:00.000Z"),
    51,
  );

  assert.equal(collection.candidates.length, 1);
  assert.ok(collection.candidates[0].reasons.includes("permit_history:dete:current_year"));
  assert.doesNotMatch(collection.candidates[0].job.descriptionText, /sponsor|permit/i);
});

test("registry represents 55 unique companies in the 60-target scope", () => {
  validateSourceRegistry(MVP_SOURCES);
  validateSourceTargetScopes(MVP_SOURCES);
  assert.equal(new Set(MVP_SOURCES.map(({ company }) => company)).size, 55);
  assert.equal(REQUIRED_TARGET_COUNT, 60);
  assert.equal(TARGET_SCOPES.length, REQUIRED_TARGET_COUNT);
  assert.equal(getTargetScope("Grab")?.eligibleCountryCodes.includes("MY"), true);
  assert.deepEqual(getTargetScope("Feedzai")?.eligibleCountryCodes, ["PT"]);
  assert.deepEqual(getTargetScope("Talkdesk")?.eligibleCountryCodes, ["PT"]);
  assert.deepEqual(getTargetScope("HelloFresh")?.eligibleCountryCodes, ["DE"]);
  assert.deepEqual(getTargetScope("Black Forest Labs")?.eligibleCountryCodes, ["DE"]);
  assert.deepEqual(getTargetScope("Aleph Alpha")?.eligibleCountryCodes, ["DE"]);
  assert.deepEqual(getTargetScope("Razer")?.eligibleCountryCodes, ["SG"]);
  assert.deepEqual(getTargetScope("Shell")?.eligibleCountryCodes, ["NL"]);
  assert.deepEqual(getTargetScope("Philips")?.eligibleCountryCodes, ["NL"]);
  assert.deepEqual(getTargetScope("Wolt")?.eligibleCountryCodes, ["FI"]);
  assert.deepEqual(getTargetScope("JetBrains")?.eligibleCountryCodes, ["CZ"]);
  assert.deepEqual(getTargetScope("Gen Digital")?.eligibleCountryCodes, ["CZ"]);
  assert.deepEqual(getTargetScope("Supercell")?.eligibleCountryCodes, ["FI"]);
  assert.deepEqual(getTargetScope("RELEX")?.eligibleCountryCodes, ["FI"]);
  assert.deepEqual(getTargetScope("BBVA AI Factory")?.eligibleCountryCodes, ["ES"]);
  assert.deepEqual(getTargetScope("Farfetch")?.eligibleCountryCodes, ["PT"]);
  assert.deepEqual(getTargetScope("AMD")?.eligibleCountryCodes, ["FI"]);
  assert.deepEqual(getTargetScope("PatSnap")?.eligibleCountryCodes, ["SG"]);
  assert.deepEqual(getTargetScope("Boozt")?.eligibleCountryCodes, ["DK"]);
  assert.deepEqual(getTargetScope("Delivery Hero")?.eligibleCountryCodes, ["DE"]);
  assert.deepEqual(getTargetScope("Deutsche Boerse")?.eligibleCountryCodes, ["LU"]);
  assert.deepEqual(getTargetScope("BEC Financial Technology")?.eligibleCountryCodes, ["DK"]);
  assert.deepEqual(getTargetScope("INESC TEC")?.eligibleCountryCodes, ["PT"]);
  assert.deepEqual(getTargetScope("Datadog")?.eligibleCountryCodes, [
    "AT", "CH", "DE", "DK", "ES", "FR", "GB", "IE", "IT", "NL", "PL", "PT", "SE",
  ]);
  assert.deepEqual(getTargetScope("Apple")?.eligibleCountryCodes, ["IN"]);
  assert.deepEqual(getTargetScope("Monzo")?.eligibleCountryCodes, ["GB"]);
  assert.equal(getTargetScope("Rebtel")?.eligibleCountryCodes.includes("SE"), true);
  assert.deepEqual(getTargetScope("Amo")?.eligibleCountryCodes, ["FR"]);
  assert.equal(getTargetScope("Voodoo")?.eligibleCountryCodes.includes("GB"), true);
  assert.equal(TARGET_SCOPES
    .filter(({ company }) => company !== "Grab")
    .some(({ eligibleCountryCodes }) => eligibleCountryCodes.includes("MY")), false);
  assert.deepEqual(getUnsupportedTargets(MVP_SOURCES), [
    "Uber",
    "Miro",
    "SAP",
    "ByteDance",
    "Apple",
  ]);
  assert.equal(TARGET_COMPANIES.length, REQUIRED_TARGET_COUNT);
});

test("active manifest includes every permitted expansion source", () => {
  assert.equal(ACTIVE_ROLLOUT_WAVE_ID, "gx15-expansion");
  assert.equal(BASELINE_SOURCE_KEYS.length, 24);
  assert.equal(EXISTING_ASHBY_SOURCE_KEYS.length, 4);
  assert.equal(ACTIVE_MVP_SOURCES.length, 55);
  assert.equal(new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company)).size, 54);
  assert.equal(ACTIVE_REQUIRED_TARGET_COUNT, 60);
  assert.equal(ACTIVE_TARGET_COMPANIES.length, ACTIVE_REQUIRED_TARGET_COUNT);
  assert.deepEqual(getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES), [
    "Uber",
    "Miro",
    "SAP",
    "ByteDance",
    "Sea Group / Shopee",
    "Apple",
  ]);
  assert.deepEqual(
    ACTIVE_MVP_SOURCES.filter(({ sourceKey }) =>
      EXISTING_ASHBY_SOURCE_KEYS.includes(sourceKey as typeof EXISTING_ASHBY_SOURCE_KEYS[number]))
      .map(({ sourceKey }) => sourceKey),
    [...EXISTING_ASHBY_SOURCE_KEYS],
  );
  assert.equal(ACTIVE_MVP_SOURCES.some(({ sourceKey }) => sourceKey === "feedzai-greenhouse"), true);
  assert.equal(ACTIVE_MVP_SOURCES.some(({ sourceKey }) => sourceKey === "sea-public-json"), false);
});

test("source matching countries cannot exceed the owning target scope", () => {
  const booking = MVP_SOURCES.find(({ company }) => company === "Booking.com")!;
  assert.throws(
    () => validateSourceTargetScopes([{
      ...booking,
      matchingPolicy: { eligibleCountryCodes: ["GB"] },
    }]),
    /matching countries exceed target scope/,
  );
});

test("rejects target-manifest duplicates and unknown source companies", () => {
  assert.throws(
    () => getUnsupportedTargets(MVP_SOURCES, [...TARGET_COMPANIES, "NUS"]),
    /duplicate companies/,
  );
  assert.throws(
    () => getUnsupportedTargets([{ ...source, company: "Unknown" }]),
    /unknown companies: Unknown/,
  );
});

test("quarantines a sudden count collapse until two similar confirmations", () => {
  const first = evaluateCountIntegrity(10, {
    lastHealthyCount: 100,
    pendingCount: null,
    pendingConfirmations: 0,
  });
  assert.deepEqual(first, {
    accepted: false,
    pendingCount: 10,
    pendingConfirmations: 0,
  });

  const second = evaluateCountIntegrity(11, {
    lastHealthyCount: 100,
    pendingCount: first.pendingCount,
    pendingConfirmations: first.pendingConfirmations,
  });
  assert.equal(second.accepted, false);
  assert.equal(second.pendingConfirmations, 1);

  const third = evaluateCountIntegrity(10, {
    lastHealthyCount: 100,
    pendingCount: second.pendingCount,
    pendingConfirmations: second.pendingConfirmations,
  });
  assert.deepEqual(third, {
    accepted: true,
    pendingCount: null,
    pendingConfirmations: 0,
  });
});

test("quarantines an empty first snapshot and resets stale anomalies", () => {
  assert.equal(evaluateCountIntegrity(0, {
    lastHealthyCount: null,
    pendingCount: null,
    pendingConfirmations: 0,
  }).accepted, false);

  assert.deepEqual(evaluateCountIntegrity(95, {
    lastHealthyCount: 100,
    pendingCount: 10,
    pendingConfirmations: 1,
  }), {
    accepted: true,
    pendingCount: null,
    pendingConfirmations: 0,
  });
});

test("skips an open source circuit and probes it after twelve hours", () => {
  let calls = 0;
  const fetchMany: FetchMany = () => {
    calls += 1;
    return [response({ jobs: [] })];
  };
  const state = {
    lastHealthyCount: 100,
    pendingCount: null,
    pendingConfirmations: 0,
    consecutiveFailures: 3,
    circuitOpenedAt: "2026-09-16T00:00:00.000Z",
  };

  const blocked = collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-16T06:00:00.000Z"),
    28,
    new Map([[source.sourceKey, state]]),
  );
  assert.equal(calls, 0);
  assert.deepEqual(blocked.report.sources[0].warnings, ["CIRCUIT_OPEN"]);

  collectShadow(
    [source],
    fetchMany,
    () => new Date("2026-09-16T12:00:00.000Z"),
    28,
    new Map([[source.sourceKey, state]]),
  );
  assert.equal(calls, 1);
});

test("a code-disabled source performs no fetch and preserves a bounded status", () => {
  let fetchCalls = 0;
  const collection = collectShadow(
    [{ ...source, operationallyDisabled: true }],
    () => {
      fetchCalls += 1;
      return [];
    },
    () => new Date("2026-09-16T12:00:00Z"),
  );

  assert.equal(fetchCalls, 0);
  assert.equal(collection.report.sources[0].status, "FAILED");
  assert.deepEqual(collection.report.sources[0].warnings, ["SOURCE_DISABLED"]);
});