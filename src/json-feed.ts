import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`JSON Feed item has invalid ${field}`);
  }
  return value.trim();
}

function parseTimestamp(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`JSON Feed item has invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function optionalTimestamp(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined || record[field] === null) {
    return null;
  }
  return parseTimestamp(record, field);
}

function parseLocations(
  posting: Record<string, unknown>,
  sourceJobId: string,
): { locationText: string; countryCodes: string[] } {
  if (!Array.isArray(posting.jobLocation) || posting.jobLocation.length === 0) {
    throw new Error(`JSON Feed item ${sourceJobId} has invalid jobLocation`);
  }
  const locations: string[] = [];
  const countryCodes: string[] = [];
  for (const value of posting.jobLocation) {
    if (!isRecord(value) || value["@type"] !== "Place" || !isRecord(value.address)
      || value.address["@type"] !== "PostalAddress") {
      throw new Error(`JSON Feed item ${sourceJobId} has invalid jobLocation`);
    }
    const location = requireString(value.address, "addressLocality");
    const countryCode = requireString(value.address, "addressCountry").toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error(`JSON Feed item ${sourceJobId} has invalid addressCountry`);
    }
    locations.push(location);
    countryCodes.push(countryCode);
  }
  return {
    locationText: [...new Set(locations)].join(" | "),
    countryCodes: [...new Set(countryCodes)],
  };
}

function parsePosting(
  item: Record<string, unknown>,
  source: SourceDefinition,
  sourceJobId: string,
): {
  canonicalUrl: string;
  descriptionText: string;
  locations: { locationText: string; countryCodes: string[] };
} {
  if (!isRecord(item._jobposting)) {
    throw new Error(`JSON Feed item ${sourceJobId} has invalid _jobposting`);
  }
  const posting = item._jobposting;
  if (posting["@type"] !== "JobPosting"
    || posting.title !== item.title
    || posting.description !== item.content_html
    || posting.datePosted !== item.date_published) {
    throw new Error(`JSON Feed item ${sourceJobId} has inconsistent JobPosting`);
  }
  if (!isRecord(posting.hiringOrganization)
    || requireString(posting.hiringOrganization, "name").toLowerCase()
      !== source.company.toLowerCase()) {
    throw new Error(`JSON Feed item ${sourceJobId} has unexpected organization`);
  }
  if (!isRecord(posting.identifier)
    || posting.identifier["@type"] !== "PropertyValue"
    || requireString(posting.identifier, "name").toLowerCase()
      !== source.company.toLowerCase()
    || !Number.isSafeInteger(posting.identifier.value)
    || (posting.identifier.value as number) <= 0) {
    throw new Error(`JSON Feed item ${sourceJobId} has invalid identifier`);
  }

  const canonicalUrl = assertAllowedHttpsUrl(requireString(item, "url"), source.allowedHosts);
  const identifier = String(posting.identifier.value);
  const canonicalPath = allowedHttpsPath(canonicalUrl, source.allowedHosts);
  if (!new RegExp(`^/jobs/${identifier}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(canonicalPath)
    || /[?#]/.test(canonicalUrl)) {
    throw new Error(`JSON Feed item ${sourceJobId} has mismatched url`);
  }
  const descriptionText = htmlToText(requireString(item, "content_html"));
  if (descriptionText === "") {
    throw new Error(`JSON Feed item ${sourceJobId} has no complete description`);
  }
  return {
    canonicalUrl,
    descriptionText,
    locations: parseLocations(posting, sourceJobId),
  };
}

export function parseJsonFeedResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!isRecord(payload)
    || payload.version !== "https://jsonfeed.org/version/1.1"
    || payload.feed_url !== source.endpoint
    || payload.next_url !== undefined
    || !Array.isArray(payload.items)) {
    throw new Error("JSON Feed response is incomplete or invalid");
  }
  if (payload.items.length > source.maxJobs) {
    throw new Error(`JSON Feed response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  return payload.items.map((value) => {
    if (!isRecord(value)) {
      throw new Error("JSON Feed items[] contains a non-object entry");
    }
    const sourceJobId = requireString(value, "id");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceJobId)) {
      throw new Error("JSON Feed item has invalid id");
    }
    if (seenIds.has(sourceJobId)) {
      throw new Error(`JSON Feed response contains duplicate item id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    const parsed = parsePosting(value, source, sourceJobId);

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value, "title"),
      descriptionText: parsed.descriptionText,
      descriptionCompleteness: "FULL",
      locationText: parsed.locations.locationText,
      countryCodes: parsed.locations.countryCodes,
      workplaceType: null,
      employmentType: null,
      publishedAt: parseTimestamp(value, "date_published"),
      updatedAt: optionalTimestamp(value, "date_modified"),
      canonicalUrl: parsed.canonicalUrl,
      fetchedAt,
    };
  });
}