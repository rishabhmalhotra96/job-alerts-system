import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const WORKDAY_PAGE_SIZE = 20;

export interface WorkdayListingRequest {
  url: string;
  body: string;
  searchTerm: string;
  offset: number;
}

export interface WorkdayListing {
  title: string;
  externalPath: string;
  locationText: string;
}

export interface WorkdayListingPage {
  total: number;
  postings: WorkdayListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workday value has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalCountryDescriptor(record: Record<string, unknown>): string | null {
  const value = record.country;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (isRecord(value)) {
    return requireString(value, "descriptor");
  }
  throw new Error("Workday detail has invalid country");
}

function validateExternalPath(value: string): string {
  if (!/^\/job\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value) || value.includes("..")) {
    throw new Error("Workday posting has unsafe externalPath");
  }
  return value;
}

export function buildWorkdayListingRequest(
  source: SourceDefinition,
  searchTerm: string,
  offset: number,
): WorkdayListingRequest {
  if (!Number.isInteger(offset) || offset < 0 || offset % WORKDAY_PAGE_SIZE !== 0) {
    throw new Error("Workday offset must be a non-negative page boundary");
  }
  return {
    url: `${source.endpoint}/jobs`,
    body: JSON.stringify({
      appliedFacets: source.workdayAppliedFacets ?? {},
      limit: WORKDAY_PAGE_SIZE,
      offset,
      searchText: searchTerm,
    }),
    searchTerm,
    offset,
  };
}

export function parseWorkdayListingPage(payload: unknown): WorkdayListingPage {
  if (!isRecord(payload)
    || typeof payload.total !== "number"
    || !Number.isInteger(payload.total)
    || payload.total < 0
    || !Array.isArray(payload.jobPostings)) {
    throw new Error("Workday listing response has invalid shape");
  }
  if (payload.jobPostings.length > WORKDAY_PAGE_SIZE) {
    throw new Error("Workday listing response exceeds page size");
  }

  const postings = payload.jobPostings.flatMap((value) => {
    if (!isRecord(value)) {
      throw new Error("Workday jobPostings contains a non-object entry");
    }
    const fields = Object.keys(value);
    if (fields.length === 1
      && fields[0] === "bulletFields"
      && Array.isArray(value.bulletFields)
      && value.bulletFields.length === 1
      && typeof value.bulletFields[0] === "string"
      && value.bulletFields[0].trim() !== "") {
      return [];
    }
    return [{
      title: requireString(value, "title"),
      externalPath: validateExternalPath(requireString(value, "externalPath")),
      locationText: requireString(value, "locationsText"),
    }];
  });
  return { total: payload.total, postings };
}

const COUNTRY_CODES: Record<string, string> = {
  australia: "AU",
  austria: "AT",
  belgium: "BE",
  bulgaria: "BG",
  brazil: "BR",
  canada: "CA",
  china: "CN",
  "costa rica": "CR",
  croatia: "HR",
  cyprus: "CY",
  czechia: "CZ",
  "czech republic": "CZ",
  denmark: "DK",
  estonia: "EE",
  finland: "FI",
  france: "FR",
  germany: "DE",
  greece: "GR",
  "hong kong": "HK",
  hungary: "HU",
  iceland: "IS",
  india: "IN",
  indonesia: "ID",
  ireland: "IE",
  italy: "IT",
  japan: "JP",
  latvia: "LV",
  liechtenstein: "LI",
  lithuania: "LT",
  luxembourg: "LU",
  malta: "MT",
  malaysia: "MY",
  mexico: "MX",
  netherlands: "NL",
  norway: "NO",
  philippines: "PH",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  singapore: "SG",
  "south korea": "KR",
  slovakia: "SK",
  slovenia: "SI",
  spain: "ES",
  "españa": "ES",
  sweden: "SE",
  switzerland: "CH",
  turkey: "TR",
  "türkiye": "TR",
  "united kingdom": "GB",
  "united states": "US",
  vietnam: "VN",
};

function inferCountryCodes(info: Record<string, unknown>, locations: string[]): string[] {
  const values = [optionalCountryDescriptor(info), ...locations]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase());
  return [...new Set(Object.entries(COUNTRY_CODES)
    .filter(([country]) => values.some((value) => value.includes(country)))
    .map(([, code]) => code))];
}

export function parseWorkdayDetail(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  if (!isRecord(payload) || !isRecord(payload.jobPostingInfo)) {
    throw new Error("Workday detail response is missing jobPostingInfo");
  }
  const info = payload.jobPostingInfo;
  const additional = info.additionalLocations;
  if (additional !== undefined && additional !== null
    && (!Array.isArray(additional) || additional.some((value) => typeof value !== "string"))) {
    throw new Error("Workday detail has invalid additionalLocations");
  }
  const locations = [
    requireString(info, "location"),
    ...((additional ?? []) as string[]).map((value) => value.trim()).filter(Boolean),
  ];
  const sourceJobId = optionalString(info, "jobReqId") ?? requireString(info, "id");

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId,
    title: requireString(info, "title"),
    descriptionText: htmlToText(requireString(info, "jobDescription")),
    descriptionCompleteness: "FULL",
    locationText: [...new Set(locations)].join(" | "),
    countryCodes: inferCountryCodes(info, locations),
    workplaceType: null,
    employmentType: optionalString(info, "timeType"),
    publishedAt: null,
    updatedAt: null,
    canonicalUrl: assertAllowedHttpsUrl(requireString(info, "externalUrl"), source.allowedHosts),
    fetchedAt,
  };
}

function normalizeAttributionText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function hasRequiredWorkdayAttribution(
  job: NormalizedJob,
  source: SourceDefinition,
): boolean {
  const terms = source.workdayRequiredAttributionTerms;
  if (terms === undefined) {
    return true;
  }
  const detailText = normalizeAttributionText(`${job.title} ${job.descriptionText}`);
  return terms.some((term) => detailText.includes(normalizeAttributionText(term)));
}