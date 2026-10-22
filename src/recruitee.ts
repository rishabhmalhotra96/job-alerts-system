import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Recruitee offer has invalid ${field}`);
  }
  return value.trim();
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`Recruitee offer has invalid ${field}`);
  }
  return value;
}

function parseTimestamp(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(value)) {
    throw new Error(`Recruitee offer has invalid ${field}`);
  }
  const timestamp = new Date(value.replace(" ", "T").replace(" UTC", "Z"));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Recruitee offer has invalid ${field}`);
  }
  return timestamp.toISOString();
}

function parseLocations(
  offer: Record<string, unknown>,
  sourceJobId: string,
): { locationText: string; countryCodes: string[] } {
  if (!Array.isArray(offer.locations) || offer.locations.length === 0) {
    throw new Error(`Recruitee offer ${sourceJobId} has invalid locations`);
  }
  const names: string[] = [];
  const countryCodes: string[] = [];
  for (const value of offer.locations) {
    if (!isRecord(value)) {
      throw new Error(`Recruitee offer ${sourceJobId} has invalid locations`);
    }
    const name = requireString(value, "name");
    const countryCode = requireString(value, "country_code").toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error(`Recruitee offer ${sourceJobId} has invalid country_code`);
    }
    names.push(name);
    countryCodes.push(countryCode);
  }
  return {
    locationText: [...new Set(names)].join(" | "),
    countryCodes: [...new Set(countryCodes)],
  };
}

function parseCanonicalUrl(
  offer: Record<string, unknown>,
  slug: string,
  source: SourceDefinition,
): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Recruitee offer has invalid slug");
  }
  const canonicalUrl = assertAllowedHttpsUrl(
    requireString(offer, "careers_url"),
    source.allowedHosts,
  );
  if (allowedHttpsPath(canonicalUrl, source.allowedHosts) !== `/o/${slug}`
    || /[?#]/.test(canonicalUrl)) {
    throw new Error("Recruitee offer has mismatched careers_url");
  }
  return canonicalUrl;
}

function parseWorkplaceType(offer: Record<string, unknown>): string | null {
  const remote = requireBoolean(offer, "remote");
  const onSite = requireBoolean(offer, "on_site");
  const hybrid = requireBoolean(offer, "hybrid");
  if (hybrid || (remote && onSite)) {
    return "Hybrid";
  }
  if (remote) {
    return "Remote";
  }
  if (onSite) {
    return "On-site";
  }
  return null;
}

export function parseRecruiteeResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!isRecord(payload) || !Array.isArray(payload.offers)) {
    throw new Error("Recruitee response must contain offers[]");
  }
  if (payload.offers.length > source.maxJobs) {
    throw new Error(`Recruitee response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  return payload.offers.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Recruitee offers[] contains a non-object entry");
    }
    const id = value.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) {
      throw new Error("Recruitee offer has invalid id");
    }
    const sourceJobId = String(id);
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Recruitee response contains duplicate offer id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    if (requireString(value, "status") !== "published") {
      throw new Error(`Recruitee offer ${sourceJobId} is not published`);
    }
    if (requireString(value, "company_name").toLowerCase() !== source.company.toLowerCase()) {
      throw new Error(`Recruitee offer ${sourceJobId} has unexpected company_name`);
    }

    const description = htmlToText(requireString(value, "description"));
    const requirements = htmlToText(requireString(value, "requirements"));
    if (description === "" || requirements === "") {
      throw new Error(`Recruitee offer ${sourceJobId} has no complete description`);
    }
    const locations = parseLocations(value, sourceJobId);
    const slug = requireString(value, "slug");

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value, "title"),
      descriptionText: `${description}\n${requirements}`,
      descriptionCompleteness: "FULL",
      locationText: locations.locationText,
      countryCodes: locations.countryCodes,
      workplaceType: parseWorkplaceType(value),
      employmentType: requireString(value, "employment_type_code"),
      publishedAt: parseTimestamp(value, "published_at"),
      updatedAt: parseTimestamp(value, "updated_at"),
      canonicalUrl: parseCanonicalUrl(value, slug, source),
      fetchedAt,
    };
  });
}