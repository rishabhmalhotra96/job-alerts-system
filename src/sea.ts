import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const SEA_PAGE_SIZE = 100;

export interface SeaSearchPage {
  total: number;
  jobs: NormalizedJob[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Sea job has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

export function buildSeaSearchUrl(
  source: SourceDefinition,
  searchTerm: string,
): string {
  if (searchTerm.trim() === "") {
    throw new Error("Sea search term must not be empty");
  }
  if (!source.locationFilters || source.locationFilters.length === 0) {
    throw new Error("Sea search requires explicit city filters");
  }

  const cityFilters = source.locationFilters
    .map((cityId) => `city_ids=${encodeURIComponent(cityId)}`)
    .join("&");
  return assertAllowedHttpsUrl(
    `${source.endpoint}?external_entity_id=3&limit=${SEA_PAGE_SIZE}&offset=0&post_type=1`
      + `&search_content=${encodeURIComponent(searchTerm)}&${cityFilters}`,
    source.allowedHosts,
  );
}

export function parseSeaSearchPage(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): SeaSearchPage {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) {
    throw new Error("Sea search response has invalid shape");
  }
  const total = payload.data.total_count;
  const rawJobList = payload.data.job_list;
  const jobList = total === 0 && rawJobList === null ? [] : rawJobList;
  if (!Number.isInteger(total) || (total as number) < 0 || !Array.isArray(jobList)) {
    throw new Error("Sea search response has invalid count or jobs");
  }
  if (jobList.length > SEA_PAGE_SIZE) {
    throw new Error("Sea search response exceeds page size");
  }

  const allowedCities = new Set(source.locationFilters ?? []);
  const seenIds = new Set<string>();
  const jobs = jobList.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Sea job list contains a non-object entry");
    }
    const rawId = value.id;
    if ((typeof rawId !== "number" && typeof rawId !== "string") || String(rawId).trim() === "") {
      throw new Error("Sea job has invalid id");
    }
    const sourceJobId = String(rawId);
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Sea response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    const publicJobId = requireString(value, "job_id");

    const cityId = String(value.city_id);
    if (cityId !== "25" || !allowedCities.has(cityId)) {
      throw new Error(`Sea job ${sourceJobId} has an unexpected city`);
    }
    const descriptionText = htmlToText([
      optionalString(value, "sub_team_description"),
      optionalString(value, "job_description"),
      optionalString(value, "requirements"),
    ].join(" "));

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value, "job_name"),
      descriptionText,
      descriptionCompleteness: "FULL",
      locationText: "Singapore",
      countryCodes: ["SG"],
      workplaceType: null,
      employmentType: null,
      publishedAt: null,
      updatedAt: null,
      canonicalUrl: assertAllowedHttpsUrl(
        `https://career.sea.com/position/${encodeURIComponent(publicJobId)}`,
        source.allowedHosts,
      ),
      fetchedAt,
    } satisfies NormalizedJob;
  });

  return { total: total as number, jobs };
}