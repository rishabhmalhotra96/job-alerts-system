import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const BOOKING_PAGE_SIZE = 10;
const BOOKING_COMPANY_TAG = "Booking.com Company Hierarchy";
const BOOKING_QUERY_COMPANIES = `${BOOKING_COMPANY_TAG}|Transport Company Hierarchy`;

export interface BookingSearchRequest {
  url: string;
  searchTerm: string;
  page: number;
}

export interface BookingSearchPage {
  total: number;
  jobs: NormalizedJob[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Booking job has invalid ${field}`);
  }
  return value.trim();
}

function normalizeDate(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Booking job has invalid ${field}`);
  }
  return date.toISOString();
}

function normalizeEmploymentType(value: string): string {
  if (!/^[A-Z]+(?:_[A-Z]+)*$/.test(value)) {
    throw new Error("Booking job has invalid employment_type");
  }
  return value.toLowerCase().replaceAll("_", "-");
}

export function buildBookingSearchRequest(
  source: SourceDefinition,
  searchTerm: string,
  page: number,
): BookingSearchRequest {
  if (searchTerm.trim() === "") {
    throw new Error("Booking search term must not be empty");
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("Booking page must be a positive integer");
  }
  if (source.locationFilters?.length !== 1
    || source.locationFilters[0].toLowerCase() !== "amsterdam") {
    throw new Error("Booking search requires the Amsterdam location filter");
  }

  const query = [
    `keywords=${encodeURIComponent(searchTerm)}`,
    `location=${encodeURIComponent(source.locationFilters[0])}`,
    "stretch=25",
    "stretchUnit=MILES",
    "sortBy=relevance",
    `page=${page}`,
    "internal=false",
    `tags1=${encodeURIComponent(BOOKING_QUERY_COMPANIES)}`,
  ].join("&");
  return {
    url: assertAllowedHttpsUrl(`${source.endpoint}?${query}`, source.allowedHosts),
    searchTerm,
    page,
  };
}

export function parseBookingSearchPage(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): BookingSearchPage {
  if (!isRecord(payload)
    || !Number.isInteger(payload.totalCount)
    || (payload.totalCount as number) < 0
    || !Array.isArray(payload.jobs)) {
    throw new Error("Booking search response has invalid shape");
  }
  if (payload.jobs.length > BOOKING_PAGE_SIZE) {
    throw new Error("Booking search response exceeds page size");
  }
  if (payload.jobs.length > (payload.totalCount as number)) {
    throw new Error("Booking search response has an invalid total");
  }

  const seenIds = new Set<string>();
  const jobs = payload.jobs.map((wrapper) => {
    if (!isRecord(wrapper) || !isRecord(wrapper.data)) {
      throw new Error("Booking jobs contains an invalid entry");
    }
    const record = wrapper.data;
    const sourceJobId = requireString(record, "req_id");
    if (requireString(record, "slug") !== sourceJobId) {
      throw new Error(`Booking job ${sourceJobId} has a mismatched slug`);
    }
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Booking response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const tags = record.tags1;
    if (!Array.isArray(tags)
      || !tags.every((tag) => typeof tag === "string")
      || !tags.includes(BOOKING_COMPANY_TAG)
      || requireString(record, "brand") !== "Booking.com"
      || requireString(record, "hiring_organization") !== "Booking.com") {
      throw new Error(`Booking job ${sourceJobId} has an unexpected company`);
    }
    const city = requireString(record, "city");
    const country = requireString(record, "country");
    const countryCode = requireString(record, "country_code").toUpperCase();
    if (city.toLowerCase() !== "amsterdam"
      || country.toLowerCase() !== "netherlands"
      || countryCode !== "NL") {
      throw new Error(`Booking job ${sourceJobId} has an unexpected location`);
    }
    if (record.searchable !== true || record.applyable !== true) {
      throw new Error(`Booking job ${sourceJobId} is not active`);
    }

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(record, "title"),
      descriptionText: htmlToText(requireString(record, "description")),
      descriptionCompleteness: "FULL",
      locationText: `${city}, ${country}`,
      countryCodes: [countryCode],
      workplaceType: null,
      employmentType: normalizeEmploymentType(requireString(record, "employment_type")),
      publishedAt: normalizeDate(requireString(record, "posted_date"), "posted_date"),
      updatedAt: normalizeDate(requireString(record, "update_date"), "update_date"),
      canonicalUrl: assertAllowedHttpsUrl(
        `https://jobs.booking.com/booking/jobs/${encodeURIComponent(sourceJobId)}?lang=en-us`,
        source.allowedHosts,
      ),
      fetchedAt,
    } satisfies NormalizedJob;
  });

  return { total: payload.totalCount as number, jobs };
}