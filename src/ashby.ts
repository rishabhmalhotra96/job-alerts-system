import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl } from "./greenhouse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Ashby job has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalTimestamp(record: Record<string, unknown>, field: string): string | null {
  const value = optionalString(record, field);
  if (value !== null
    && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value)))) {
    throw new Error(`Ashby job has invalid ${field}`);
  }
  return value === null || value.endsWith("Z") ? value : new Date(value).toISOString();
}

const COUNTRY_CODES: Record<string, string> = {
  austria: "AT",
  belgium: "BE",
  bulgaria: "BG",
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
  hungary: "HU",
  iceland: "IS",
  ireland: "IE",
  italy: "IT",
  latvia: "LV",
  liechtenstein: "LI",
  lithuania: "LT",
  luxembourg: "LU",
  malta: "MT",
  netherlands: "NL",
  norway: "NO",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  singapore: "SG",
  slovakia: "SK",
  slovenia: "SI",
  spain: "ES",
  sweden: "SE",
  "united kingdom": "GB",
  "united states": "US",
};

function canonicalUrl(
  value: Record<string, unknown>,
  source: SourceDefinition,
  sourceJobId: string,
  title: string,
): string {
  const providerUrl = assertAllowedHttpsUrl(requireString(value, "jobUrl"), source.allowedHosts);
  if (!allowedHttpsPath(providerUrl, source.allowedHosts).endsWith(`/${sourceJobId}`)) {
    throw new Error(`Ashby job ${sourceJobId} has an inconsistent jobUrl`);
  }
  if (source.ashbyCanonicalBaseUrl === undefined) {
    return providerUrl;
  }

  const baseUrl = assertAllowedHttpsUrl(source.ashbyCanonicalBaseUrl, source.allowedHosts)
    .replace(/\/+$/, "");
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\//g, "")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  if (slug === "") {
    throw new Error(`Ashby job ${sourceJobId} has an invalid canonical slug`);
  }
  return assertAllowedHttpsUrl(
    `${baseUrl}/${slug}/${encodeURIComponent(sourceJobId)}/`,
    source.allowedHosts,
  );
}

function addressCountry(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.postalAddress)) {
    return null;
  }
  const country = value.postalAddress.addressCountry;
  return typeof country === "string" && country.trim() !== "" ? country.trim() : null;
}

export function parseAshbyResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error("Ashby response is missing jobs[]");
  }
  if (payload.jobs.length > source.maxJobs) {
    throw new Error(`Ashby response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  return payload.jobs
    .filter((value) => !isRecord(value) || value.isListed !== false)
    .map((value) => {
      if (!isRecord(value)) {
        throw new Error("Ashby jobs[] contains a non-object entry");
      }

      const sourceJobId = requireString(value, "id");
      if (seenIds.has(sourceJobId)) {
        throw new Error(`Ashby response contains duplicate job id: ${sourceJobId}`);
      }
      seenIds.add(sourceJobId);

      const title = requireString(value, "title");

      const primaryLocation = requireString(value, "location");
      const secondaryLocations = value.secondaryLocations;
      if (secondaryLocations !== undefined && !Array.isArray(secondaryLocations)) {
        throw new Error(`Ashby job ${sourceJobId} has invalid secondaryLocations`);
      }

      const locationNames = [primaryLocation];
      const countryNames = [addressCountry(value.address)];
      for (const secondary of secondaryLocations ?? []) {
        if (!isRecord(secondary)) {
          throw new Error(`Ashby job ${sourceJobId} has an invalid secondary location`);
        }
        locationNames.push(requireString(secondary, "location"));
        countryNames.push(addressCountry(secondary.address));
      }

      const countryCodes = [...new Set(countryNames
        .filter((country): country is string => country !== null)
        .map((country) => COUNTRY_CODES[country.toLowerCase()])
        .filter((code): code is string => code !== undefined))];
      const workplaceType = optionalString(value, "workplaceType")
        ?? (value.isRemote === true ? "Remote" : null);

      return {
        sourceKey: source.sourceKey,
        company: source.company,
        sourceJobId,
        title,
        descriptionText: requireString(value, "descriptionPlain"),
        descriptionCompleteness: "FULL",
        locationText: [...new Set(locationNames)].join(" | "),
        countryCodes,
        workplaceType,
        employmentType: optionalString(value, "employmentType"),
        publishedAt: optionalTimestamp(value, "publishedAt"),
        updatedAt: optionalTimestamp(value, "updatedAt"),
        canonicalUrl: canonicalUrl(value, source, sourceJobId, title),
        fetchedAt,
      };
    });
}