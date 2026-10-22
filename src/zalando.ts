import {
  type NormalizedJob,
  type SourceDefinition,
} from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const ZALANDO_PAGE_SIZE = 100;

export interface ZalandoListing {
  sourceJobId: string;
  title: string;
  entity: string | null;
  offices: string[];
  updatedAt: string;
}

export interface ZalandoListingPage {
  total: number;
  listings: ZalandoListing[];
}

const ISO3_TO_ISO2: Readonly<Record<string, string>> = Object.freeze({
  AUT: "AT", BEL: "BE", BGR: "BG", HRV: "HR", CYP: "CY", CZE: "CZ",
  DEU: "DE", DNK: "DK", ESP: "ES", EST: "EE", FIN: "FI", FRA: "FR",
  GBR: "GB", GRC: "GR", HUN: "HU", IRL: "IE", ISL: "IS", ITA: "IT",
  LIE: "LI", LTU: "LT", LUX: "LU", LVA: "LV", MLT: "MT", NLD: "NL",
  NOR: "NO", POL: "PL", PRT: "PT", ROU: "RO", SGP: "SG", SVK: "SK",
  SVN: "SI", SWE: "SE", CHE: "CH", USA: "US",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Zalando has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Zalando has invalid ${field}`);
  }
  return value.trim();
}

function requireStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Zalando has invalid ${field}`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function parseTimestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Zalando has invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function expectedSearchPath(offset: number): string {
  return `/search?q=&filters=%7B%7D&limit=${ZALANDO_PAGE_SIZE}&offset=${offset}`;
}

function requirePaginationPath(
  payload: Record<string, unknown>,
  field: string,
  expected: string | undefined,
): void {
  const actual = payload[field];
  if (expected === undefined ? actual !== undefined : actual !== expected) {
    throw new Error(`Zalando listing has invalid ${field}`);
  }
}

export function buildZalandoListingUrl(source: SourceDefinition, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % ZALANDO_PAGE_SIZE !== 0) {
    throw new Error("Zalando listing offset is invalid");
  }
  return assertAllowedHttpsUrl(
    `${source.endpoint}${expectedSearchPath(offset)}`,
    source.allowedHosts,
  );
}

export function buildZalandoDetailUrl(
  source: SourceDefinition,
  listing: ZalandoListing,
): string {
  return assertAllowedHttpsUrl(
    `${source.endpoint}/jobs/${encodeURIComponent(listing.sourceJobId)}`,
    source.allowedHosts,
  );
}

export function parseZalandoListingPage(
  payload: unknown,
  source: SourceDefinition,
  offset: number,
): ZalandoListingPage {
  if (!isRecord(payload) || !Array.isArray(payload.data)
    || !Number.isSafeInteger(payload.total) || (payload.total as number) <= 0
    || (payload.total as number) > source.maxJobs) {
    throw new Error("Zalando listing is incomplete or invalid");
  }
  const total = payload.total as number;
  const expectedCount = Math.min(ZALANDO_PAGE_SIZE, Math.max(total - offset, 0));
  if (payload.data.length !== expectedCount) {
    throw new Error("Zalando listing page is incomplete");
  }
  const lastOffset = Math.floor((total - 1) / ZALANDO_PAGE_SIZE) * ZALANDO_PAGE_SIZE;
  requirePaginationPath(payload, "first", expectedSearchPath(0));
  requirePaginationPath(payload, "last", expectedSearchPath(lastOffset));
  requirePaginationPath(
    payload,
    "previous",
    offset === 0 ? undefined : expectedSearchPath(offset - ZALANDO_PAGE_SIZE),
  );
  requirePaginationPath(
    payload,
    "next",
    offset >= lastOffset ? undefined : expectedSearchPath(offset + ZALANDO_PAGE_SIZE),
  );

  const seenIds = new Set<string>();
  const listings = payload.data.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Zalando listing contains a non-object entry");
    }
    const sourceJobId = requireString(value, "id");
    if (!/^\d{5,12}$/.test(sourceJobId) || seenIds.has(sourceJobId)) {
      throw new Error("Zalando listing has an invalid or duplicate id");
    }
    seenIds.add(sourceJobId);
    return {
      sourceJobId,
      title: requireString(value, "title"),
      entity: optionalString(value, "entity"),
      offices: requireStringArray(value, "offices"),
      updatedAt: parseTimestamp(requireString(value, "updated_at"), "updated_at"),
    };
  });
  return { total, listings };
}

export function parseZalandoDetail(
  payload: unknown,
  listing: ZalandoListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  if (!isRecord(payload) || !isRecord(payload.rawData) || payload.closed !== false) {
    throw new Error("Zalando detail is invalid or closed");
  }
  const sourceJobId = requireString(payload, "id");
  const title = requireString(payload, "title");
  const entity = requireString(payload.rawData, "Company");
  if (sourceJobId !== listing.sourceJobId
    || title !== listing.title
    || (listing.entity !== null && entity !== listing.entity)
    || requireString(payload.rawData, "Job_Req_Id") !== sourceJobId
    || requireString(payload.rawData, "Posting_Title") !== title) {
    throw new Error("Zalando detail identity does not match its listing");
  }
  const offices = requireStringArray(payload, "offices");
  if (offices.length !== listing.offices.length
    || offices.some((office, index) => office !== listing.offices[index]
      && !office.endsWith(` - ${listing.offices[index]}`))) {
    throw new Error("Zalando detail offices do not match its listing");
  }
  const updatedAt = parseTimestamp(requireString(payload, "updated_at"), "updated_at");
  if (updatedAt !== listing.updatedAt
    || parseTimestamp(requireString(payload.rawData, "Last_Update"), "Last_Update") !== updatedAt) {
    throw new Error("Zalando detail timestamp does not match its listing");
  }
  const countryReference = requireString(payload.rawData, "Job_Req_Country_referenceID").toUpperCase();
  const countryCode = ISO3_TO_ISO2[countryReference];
  if (!countryCode) {
    throw new Error("Zalando detail has an unsupported country reference");
  }
  const descriptionText = htmlToText(requireString(payload, "content"));
  if (descriptionText.length < 100 || descriptionText.length > 50_000) {
    throw new Error("Zalando detail has an invalid description");
  }
  const contractTypes = requireStringArray(payload, "contract_types");
  const publishedDate = requireString(payload.rawData, "Job_Posting_Start_Date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)
    || !Number.isFinite(Date.parse(`${publishedDate}T00:00:00Z`))) {
    throw new Error("Zalando detail has an invalid posting date");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: offices.join(" | "),
    countryCodes: [countryCode],
    workplaceType: null,
    employmentType: contractTypes.join(" | "),
    publishedAt: `${publishedDate}T00:00:00.000Z`,
    updatedAt,
    canonicalUrl: assertAllowedHttpsUrl(
      `https://jobs.zalando.com/en/jobs/${encodeURIComponent(sourceJobId)}`,
      source.allowedHosts,
    ),
    fetchedAt,
  };
}