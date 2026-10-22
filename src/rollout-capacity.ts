import type { AdapterType, SourceDefinition } from "./domain.ts";
import { EXISTING_ASHBY_SOURCE_KEYS, MVP_SOURCES } from "./sources.ts";

export const MAX_ROLLOUT_WAVE_COMPANIES = 12;
export const MAX_ROLLOUT_WAVE_CUSTOM_COMPANIES = 8;
export const MAX_ROLLOUT_WAVE_REQUEST_ATTEMPTS = 350;
export const MAX_DAILY_URL_FETCH_CALLS = 20_000;
export const ROLLOUT_RUNS_PER_DAY = 12;
const MAX_ATTEMPTS_PER_REQUEST = 3;

const REUSABLE_ADAPTERS = new Set<AdapterType>([
  "GREENHOUSE",
  "ASHBY",
  "LEVER",
  "RECRUITEE",
  "JSON_FEED",
  "WORKDAY",
  "SMARTRECRUITERS",
]);

export const EXPANSION_SOURCE_KEYS = Object.freeze([
  "black-forest-labs-ashby",
  "aleph-alpha-ashby",
  "gen-digital-ashby",
  "supercell-ashby",
  "razer-workday",
  "shell-workday",
  "philips-workday",
  "bbva-ai-factory-workday",
  "feedzai-greenhouse",
  "talkdesk-greenhouse",
  "hellofresh-greenhouse",
  "wolt-greenhouse",
  "jetbrains-greenhouse",
  "relex-greenhouse",
  "farfetch-lever",
  "amd-finland-json",
  "patsnap-recruitee",
  "boozt-json-feed",
  "zalando-public-json",
  "mercedes-tech-xml",
  "delivery-hero-sitemap",
  "deutsche-boerse-sitemap",
  "bec-vacancies",
  "inesc-tec-opportunities",
  "datadog-greenhouse",
  "monzo-greenhouse",
  "rebtel-json-feed",
  "adjoe-ashby",
  "mayflower-recruitee",
  "quantco-lever",
  "amo-ashby",
  "voodoo-ashby",
] as const);

export interface RolloutWaveDefinition {
  id: string;
  sourceKeys: readonly string[];
}

export const EXPANSION_ROLLOUT_WAVES: readonly RolloutWaveDefinition[] = Object.freeze([
  {
    id: "existing-ashby",
    sourceKeys: EXISTING_ASHBY_SOURCE_KEYS,
  },
  {
    id: "existing-greenhouse-a",
    sourceKeys: ["feedzai-greenhouse", "talkdesk-greenhouse", "hellofresh-greenhouse"],
  },
  {
    id: "existing-greenhouse-b",
    sourceKeys: ["wolt-greenhouse", "jetbrains-greenhouse", "relex-greenhouse"],
  },
  {
    id: "existing-complete-feeds",
    sourceKeys: ["farfetch-lever", "patsnap-recruitee", "boozt-json-feed"],
  },
  {
    id: "existing-workday-razer-bbva",
    sourceKeys: ["razer-workday", "bbva-ai-factory-workday"],
  },
  { id: "existing-workday-shell", sourceKeys: ["shell-workday"] },
  { id: "existing-workday-philips", sourceKeys: ["philips-workday"] },
  {
    id: "custom-detail-a",
    sourceKeys: ["delivery-hero-sitemap", "deutsche-boerse-sitemap", "bec-vacancies"],
  },
  {
    id: "custom-detail-b",
    sourceKeys: ["inesc-tec-opportunities", "amd-finland-json"],
  },
  {
    id: "custom-detail-c",
    sourceKeys: ["zalando-public-json", "mercedes-tech-xml"],
  },
  {
    id: "gx10-datadog-monzo-rebtel",
    sourceKeys: ["datadog-greenhouse", "monzo-greenhouse", "rebtel-json-feed"],
  },
  {
    id: "gx14-adjoe-mayflower-quantco",
    sourceKeys: ["adjoe-ashby", "mayflower-recruitee", "quantco-lever"],
  },
  {
    id: "gx15-amo-voodoo",
    sourceKeys: ["amo-ashby", "voodoo-ashby"],
  },
]);

export interface SourceCapacity {
  sourceKey: string;
  company: string;
  adapter: AdapterType;
  host: string;
  listingRequests: number;
  detailRequests: number;
  requestAttempts: number;
  materializedResponseBytes: number;
  customAdapter: boolean;
}

export interface CapacityCohort {
  adapter: AdapterType;
  host: string;
  sourceKeys: string[];
  requestAttempts: number;
  materializedResponseBytes: number;
}

export interface RolloutWaveCapacity {
  id: string;
  sourceKeys: string[];
  companies: string[];
  customCompanies: string[];
  requestAttempts: number;
  materializedResponseBytes: number;
  projectedDailyUrlFetchCalls: number;
  cohorts: CapacityCohort[];
}

function requestShape(source: SourceDefinition): { listingRequests: number; detailRequests: number } {
  switch (source.adapter) {
    case "GREENHOUSE":
      return { listingRequests: 1, detailRequests: source.maxDetailJobs };
    case "WORKDAY":
    case "BOOKING":
    case "GLOVO":
    case "OPTIVER":
    case "SMARTRECRUITERS":
    case "ZALANDO":
      return { listingRequests: source.maxPages, detailRequests: source.maxDetailJobs };
    case "AMAZON":
    case "SEA":
      return { listingRequests: source.maxPages, detailRequests: 0 };
    case "PICNIC":
    case "DELIVERY_HERO":
    case "DEUTSCHE_BOERSE":
    case "BEC":
    case "INESC_TEC":
      return { listingRequests: 1, detailRequests: source.maxDetailJobs };
    case "NUS":
      return { listingRequests: 1, detailRequests: source.maxDetailJobs * 3 };
    case "ASHBY":
    case "LEVER":
    case "RECRUITEE":
    case "JSON_FEED":
    case "AMD":
    case "MERCEDES_TECH":
    case "BOLT":
      return { listingRequests: 1, detailRequests: 0 };
  }
}

export function calculateSourceCapacity(source: SourceDefinition): SourceCapacity {
  const { listingRequests, detailRequests } = requestShape(source);
  const requestAttempts = (listingRequests + detailRequests) * MAX_ATTEMPTS_PER_REQUEST;
  return {
    sourceKey: source.sourceKey,
    company: source.company,
    adapter: source.adapter,
    host: new URL(source.endpoint).hostname,
    listingRequests,
    detailRequests,
    requestAttempts,
    materializedResponseBytes: requestAttempts * source.maxResponseBytes,
    customAdapter: !REUSABLE_ADAPTERS.has(source.adapter),
  };
}

export function calculateRolloutCapacity(
  sources: readonly SourceDefinition[] = MVP_SOURCES,
  waves: readonly RolloutWaveDefinition[] = EXPANSION_ROLLOUT_WAVES,
): RolloutWaveCapacity[] {
  const sourcesByKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const expectedKeys = new Set<string>(EXPANSION_SOURCE_KEYS);
  const assignedKeys = new Set<string>();
  const waveIds = new Set<string>();

  const capacities = waves.map((wave) => {
    if (wave.id.trim() === "" || waveIds.has(wave.id)) {
      throw new Error(`Rollout wave ID is invalid or duplicated: ${wave.id}`);
    }
    waveIds.add(wave.id);
    if (wave.sourceKeys.length === 0 || new Set(wave.sourceKeys).size !== wave.sourceKeys.length) {
      throw new Error(`Rollout wave source membership is invalid: ${wave.id}`);
    }

    const sourceCapacities = wave.sourceKeys.map((sourceKey) => {
      if (!expectedKeys.has(sourceKey) || assignedKeys.has(sourceKey)) {
        throw new Error(`Rollout source is unexpected or duplicated: ${sourceKey}`);
      }
      const source = sourcesByKey.get(sourceKey);
      if (!source || source.operationallyDisabled === true) {
        throw new Error(`Rollout source is missing or disabled: ${sourceKey}`);
      }
      assignedKeys.add(sourceKey);
      return calculateSourceCapacity(source);
    });

    const companies = [...new Set(sourceCapacities.map(({ company }) => company))];
    const customCompanies = [...new Set(sourceCapacities
      .filter(({ customAdapter }) => customAdapter)
      .map(({ company }) => company))];
    const requestAttempts = sourceCapacities.reduce(
      (total, source) => total + source.requestAttempts,
      0,
    );
    const materializedResponseBytes = sourceCapacities.reduce(
      (total, source) => total + source.materializedResponseBytes,
      0,
    );
    const projectedDailyUrlFetchCalls = requestAttempts * ROLLOUT_RUNS_PER_DAY;
    if (companies.length > MAX_ROLLOUT_WAVE_COMPANIES
      || customCompanies.length > MAX_ROLLOUT_WAVE_CUSTOM_COMPANIES
      || requestAttempts > MAX_ROLLOUT_WAVE_REQUEST_ATTEMPTS
      || projectedDailyUrlFetchCalls > MAX_DAILY_URL_FETCH_CALLS) {
      throw new Error(`Rollout wave exceeds a capacity limit: ${wave.id}`);
    }

    const cohortsByKey = new Map<string, CapacityCohort>();
    for (const source of sourceCapacities) {
      const cohortKey = `${source.adapter}:${source.host}`;
      const cohort = cohortsByKey.get(cohortKey) ?? {
        adapter: source.adapter,
        host: source.host,
        sourceKeys: [],
        requestAttempts: 0,
        materializedResponseBytes: 0,
      };
      cohort.sourceKeys.push(source.sourceKey);
      cohort.requestAttempts += source.requestAttempts;
      cohort.materializedResponseBytes += source.materializedResponseBytes;
      cohortsByKey.set(cohortKey, cohort);
    }

    return {
      id: wave.id,
      sourceKeys: [...wave.sourceKeys],
      companies,
      customCompanies,
      requestAttempts,
      materializedResponseBytes,
      projectedDailyUrlFetchCalls,
      cohorts: [...cohortsByKey.values()],
    };
  });

  const missingKeys = EXPANSION_SOURCE_KEYS.filter((sourceKey) => !assignedKeys.has(sourceKey));
  if (missingKeys.length > 0 || assignedKeys.size !== EXPANSION_SOURCE_KEYS.length) {
    throw new Error(`Rollout source membership is incomplete: ${missingKeys.join(",")}`);
  }
  return capacities;
}