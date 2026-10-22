import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const SMARTRECRUITERS_PAGE_SIZE = 100;

export interface SmartRecruitersListing {
  sourceJobId: string;
  title: string;
}

export interface SmartRecruitersListingPage {
  total: number;
  listings: SmartRecruitersListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`SmartRecruiters job has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function buildSmartRecruitersListingUrl(
  source: SourceDefinition,
  offset: number,
): string {
  if (!Number.isInteger(offset) || offset < 0 || offset % SMARTRECRUITERS_PAGE_SIZE !== 0) {
    throw new Error("SmartRecruiters offset must be on a page boundary");
  }
  if (!source.locationFilters || source.locationFilters.length !== 1) {
    throw new Error("SmartRecruiters requires one explicit country filter");
  }
  return assertAllowedHttpsUrl(
    `${source.endpoint}?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`
      + `&country=${encodeURIComponent(source.locationFilters[0])}`,
    source.allowedHosts,
  );
}

export function parseSmartRecruitersListingPage(
  payload: unknown,
  source: SourceDefinition,
): SmartRecruitersListingPage {
  if (!isRecord(payload)
    || !Number.isInteger(payload.totalFound)
    || (payload.totalFound as number) < 0
    || !Array.isArray(payload.content)) {
    throw new Error("SmartRecruiters listing response has invalid shape");
  }
  if (payload.content.length > SMARTRECRUITERS_PAGE_SIZE) {
    throw new Error("SmartRecruiters listing response exceeds page size");
  }

  const seenIds = new Set<string>();
  const listings = payload.content.map((value) => {
    if (!isRecord(value)) {
      throw new Error("SmartRecruiters content contains a non-object entry");
    }
    const sourceJobId = requireString(value, "id");
    if (seenIds.has(sourceJobId)) {
      throw new Error(`SmartRecruiters response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    const location = value.location;
    if (!isRecord(location)
      || !source.locationFilters?.some((country) =>
        country.toLowerCase() === optionalString(location, "country")?.toLowerCase())) {
      throw new Error(`SmartRecruiters job ${sourceJobId} has an unexpected country`);
    }
    return { sourceJobId, title: requireString(value, "name") };
  });
  return { total: payload.totalFound as number, listings };
}

function sectionText(sections: Record<string, unknown>, field: string): string {
  const section = sections[field];
  return isRecord(section) && typeof section.text === "string" ? section.text : "";
}

export function parseSmartRecruitersDetail(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  if (!isRecord(payload) || payload.active !== true) {
    throw new Error("SmartRecruiters detail response has invalid shape");
  }
  const location = payload.location;
  const jobAd = payload.jobAd;
  if (!isRecord(location) || !isRecord(jobAd) || !isRecord(jobAd.sections)) {
    throw new Error("SmartRecruiters detail response is missing location or sections");
  }
  const countryCode = requireString(location, "country").toUpperCase();
  const allowedCountries = new Set(
    (source.locationFilters ?? []).map((country) => country.toUpperCase()),
  );
  if (!allowedCountries.has(countryCode)) {
    throw new Error("SmartRecruiters detail country is not configured");
  }
  const employment = isRecord(payload.typeOfEmployment)
    ? optionalString(payload.typeOfEmployment, "label")
    : null;
  const descriptionText = htmlToText([
    sectionText(jobAd.sections, "companyDescription"),
    sectionText(jobAd.sections, "jobDescription"),
    sectionText(jobAd.sections, "qualifications"),
    sectionText(jobAd.sections, "additionalInformation"),
  ].join(" "));
  if (descriptionText === "") {
    throw new Error("SmartRecruiters detail has no description");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: requireString(payload, "id"),
    title: requireString(payload, "name"),
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: requireString(location, "fullLocation"),
    countryCodes: [countryCode],
    workplaceType: location.remote === true
      ? "Remote"
      : location.hybrid === true ? "Hybrid" : null,
    employmentType: employment,
    publishedAt: optionalString(payload, "releasedDate"),
    updatedAt: null,
    canonicalUrl: assertAllowedHttpsUrl(
      requireString(payload, "postingUrl"),
      source.allowedHosts,
    ),
    fetchedAt,
  };
}