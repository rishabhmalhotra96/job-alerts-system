import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const AMAZON_PAGE_SIZE = 10;

export interface AmazonSearchRequest {
  url: string;
  searchTerm: string;
  offset: number;
}

export interface AmazonSearchPage {
  total: number;
  jobs: NormalizedJob[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Amazon job has invalid ${field}`);
  }
  return value.trim();
}

function validateJobPath(value: string): string {
  if (!/^\/en\/jobs\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value) || value.includes("..")) {
    throw new Error("Amazon job has unsafe job_path");
  }
  return value;
}

const ELIGIBLE_ISO3_TO_ISO2: Record<string, string> = {
  AUT: "AT",
  BEL: "BE",
  BGR: "BG",
  HRV: "HR",
  CYP: "CY",
  CZE: "CZ",
  DEU: "DE",
  DNK: "DK",
  EST: "EE",
  ESP: "ES",
  FIN: "FI",
  FRA: "FR",
  GRC: "GR",
  HUN: "HU",
  IRL: "IE",
  ISL: "IS",
  ITA: "IT",
  LIE: "LI",
  LTU: "LT",
  LUX: "LU",
  LVA: "LV",
  MLT: "MT",
  NLD: "NL",
  NOR: "NO",
  POL: "PL",
  PRT: "PT",
  ROU: "RO",
  SGP: "SG",
  SVK: "SK",
  SVN: "SI",
  SWE: "SE",
};

export function buildAmazonSearchRequest(
  source: SourceDefinition,
  searchTerm: string,
  offset: number,
): AmazonSearchRequest {
  if (!Number.isInteger(offset) || offset < 0 || offset % AMAZON_PAGE_SIZE !== 0) {
    throw new Error("Amazon offset must be a non-negative page boundary");
  }
  if (!source.locationFilters || source.locationFilters.length === 0) {
    throw new Error("Amazon source requires location filters");
  }
  const query = [
    `base_query=${encodeURIComponent(searchTerm)}`,
    `offset=${offset}`,
    `result_limit=${AMAZON_PAGE_SIZE}`,
    ...source.locationFilters.map((location) => `location[]=${encodeURIComponent(location)}`),
  ].join("&");
  return {
    url: `${source.endpoint}?${query}`,
    searchTerm,
    offset,
  };
}

export function parseAmazonSearchPage(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): AmazonSearchPage {
  if (!isRecord(payload)
    || typeof payload.hits !== "number"
    || !Number.isInteger(payload.hits)
    || payload.hits < 0
    || !Array.isArray(payload.jobs)) {
    throw new Error("Amazon search response has invalid shape");
  }
  if (payload.jobs.length > AMAZON_PAGE_SIZE) {
    throw new Error("Amazon search response exceeds page size");
  }

  const jobs = payload.jobs.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Amazon jobs contains a non-object entry");
    }
    const countryCode = requireString(value, "country_code").toUpperCase();
    const jobPath = validateJobPath(requireString(value, "job_path"));
    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId: requireString(value, "id"),
      title: requireString(value, "title"),
      descriptionText: htmlToText(requireString(value, "description")),
      descriptionCompleteness: "FULL",
      locationText: requireString(value, "location"),
      countryCodes: [ELIGIBLE_ISO3_TO_ISO2[countryCode] ?? countryCode],
      workplaceType: null,
      employmentType: requireString(value, "job_schedule_type"),
      publishedAt: null,
      updatedAt: null,
      canonicalUrl: assertAllowedHttpsUrl(
        `https://www.amazon.jobs${jobPath}`,
        source.allowedHosts,
      ),
      fetchedAt,
    } satisfies NormalizedJob;
  });
  return { total: payload.hits, jobs };
}