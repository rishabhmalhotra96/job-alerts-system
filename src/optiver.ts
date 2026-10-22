import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const OPTIVER_PAGE_SIZE = 16;

export interface OptiverListing {
  sourceJobId: string;
  title: string;
  detailPath: string;
}

export interface OptiverListingPage {
  total: number;
  listings: OptiverListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Optiver job has invalid ${field}`);
  }
  return value.trim();
}

function requireDetailPath(value: unknown): string {
  if (typeof value !== "string"
    || !/^\/join-us\/jobs\/[a-z0-9%&()+,._/-]+\/$/i.test(value)
    || value.includes("//")) {
    throw new Error("Optiver job has an unsafe detail path");
  }
  return value;
}

export function buildOptiverListingUrl(source: SourceDefinition, offset: number): string {
  if (!Number.isInteger(offset) || offset < 0 || offset % OPTIVER_PAGE_SIZE !== 0) {
    throw new Error("Optiver offset must be on a page boundary");
  }
  if (source.locationFilters?.length !== 1) {
    throw new Error("Optiver requires one explicit location filter");
  }
  return assertAllowedHttpsUrl(
    `${source.endpoint}?from=${offset}&size=${OPTIVER_PAGE_SIZE}`
      + `&location=${encodeURIComponent(source.locationFilters[0])}&level=experienced`,
    source.allowedHosts,
  );
}

export function parseOptiverListingPage(
  payload: unknown,
  source: SourceDefinition,
): OptiverListingPage {
  if (!isRecord(payload)
    || !Number.isInteger(payload.totalCount)
    || (payload.totalCount as number) < 0
    || !Array.isArray(payload.items)) {
    throw new Error("Optiver listing response has invalid shape");
  }
  if (payload.items.length > OPTIVER_PAGE_SIZE) {
    throw new Error("Optiver listing response exceeds page size");
  }
  const configuredLocation = source.locationFilters?.[0]?.toLowerCase();
  const seenIds = new Set<string>();
  const listings = payload.items.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Optiver items contains a non-object entry");
    }
    const rawId = value.componentID;
    if ((typeof rawId !== "number" && typeof rawId !== "string") || String(rawId).trim() === "") {
      throw new Error("Optiver job has invalid componentID");
    }
    const sourceJobId = String(rawId);
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Optiver response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    if (requireString(value, "location").toLowerCase() !== configuredLocation
      || requireString(value, "experience").toLowerCase() !== "experienced") {
      throw new Error(`Optiver job ${sourceJobId} escaped configured filters`);
    }
    return {
      sourceJobId,
      title: requireString(value, "title"),
      detailPath: requireDetailPath(value.href),
    };
  });
  return { total: payload.totalCount as number, listings };
}

function parseJsonScripts(html: string, pattern: RegExp): unknown[] {
  const values: unknown[] = [];
  for (const match of html.matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1]) as unknown);
    } catch {
      throw new Error("Optiver detail contains invalid structured JSON");
    }
  }
  return values;
}

export function parseOptiverDetail(
  html: string,
  listing: OptiverListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const jobPostings = parseJsonScripts(
    html,
    /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  ).filter((value) => isRecord(value) && value["@type"] === "JobPosting");
  const richTextValues = parseJsonScripts(
    html,
    /React\.createElement\(Components\.RichText,(\{[\s\S]*?\})\)\);/g,
  ).filter(isRecord);
  if (jobPostings.length !== 1 || richTextValues.length !== 1) {
    throw new Error("Optiver detail has ambiguous structured content");
  }

  const jobPosting = jobPostings[0] as Record<string, unknown>;
  const richText = richTextValues[0];
  const organization = jobPosting.hiringOrganization;
  const location = jobPosting.jobLocation;
  if (!isRecord(organization)
    || requireString(organization, "name") !== "Optiver"
    || !isRecord(location)
    || requireString(location, "name").toLowerCase() !== source.locationFilters?.[0]?.toLowerCase()) {
    throw new Error("Optiver detail identity or location is invalid");
  }
  const title = requireString(jobPosting, "title");
  if (title !== listing.title) {
    throw new Error("Optiver detail title does not match listing");
  }
  const expectedUrl = assertAllowedHttpsUrl(
    `https://www.optiver.com${listing.detailPath}`,
    source.allowedHosts,
  );
  const canonicalUrl = assertAllowedHttpsUrl(requireString(jobPosting, "url"), source.allowedHosts);
  if (canonicalUrl !== expectedUrl) {
    throw new Error("Optiver detail URL does not match listing");
  }
  const descriptionText = htmlToText(requireString(richText, "text"));
  if (descriptionText === "") {
    throw new Error("Optiver detail has no description");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: "Amsterdam, Netherlands",
    countryCodes: ["NL"],
    workplaceType: null,
    employmentType: null,
    publishedAt: requireString(jobPosting, "datePosted"),
    updatedAt: null,
    canonicalUrl,
    fetchedAt,
  };
}