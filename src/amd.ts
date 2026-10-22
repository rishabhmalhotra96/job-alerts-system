import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { htmlToText, resolveAllowedHttpsUrl } from "./greenhouse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`AMD job has invalid ${field}`);
  }
  return value.trim();
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`AMD job has invalid ${field}`);
  }
  return value;
}

function parseTimestamp(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`AMD job has invalid ${field}`);
  }
  return new Date(normalized).toISOString();
}

function canonicalUrl(source: SourceDefinition, slug: string): string {
  if (!/^\d+$/.test(slug)) {
    throw new Error("AMD job has invalid slug");
  }
  return resolveAllowedHttpsUrl(
    `/careers-home/jobs/${slug}`,
    source.endpoint,
    source.allowedHosts,
  );
}

export function parseAmdResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!isRecord(payload)
    || !Array.isArray(payload.jobs)
    || !Number.isInteger(payload.totalCount)
    || !Number.isInteger(payload.count)
    || payload.totalCount !== payload.count
    || payload.totalCount !== payload.jobs.length) {
    throw new Error("AMD response has incomplete or invalid pagination");
  }
  if (payload.jobs.length > source.maxJobs) {
    throw new Error(`AMD response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  const jobs: NormalizedJob[] = [];
  for (const value of payload.jobs) {
    if (!isRecord(value) || !isRecord(value.data)) {
      throw new Error("AMD jobs[] contains an invalid entry");
    }
    const data = value.data;
    const searchable = requireBoolean(data, "searchable");
    const applyable = requireBoolean(data, "applyable");
    if (!searchable || !applyable) {
      continue;
    }

    const sourceJobId = requireString(data, "req_id");
    const slug = requireString(data, "slug");
    if (sourceJobId !== slug) {
      throw new Error(`AMD job ${sourceJobId} has mismatched slug`);
    }
    if (seenIds.has(sourceJobId)) {
      throw new Error(`AMD response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const countryCode = requireString(data, "country_code").toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error(`AMD job ${sourceJobId} has invalid country_code`);
    }
    const descriptionText = htmlToText(requireString(data, "description"));
    if (descriptionText === "") {
      throw new Error(`AMD job ${sourceJobId} has no complete description`);
    }

    jobs.push({
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(data, "title"),
      descriptionText,
      descriptionCompleteness: "FULL",
      locationText: requireString(data, "full_location"),
      countryCodes: [countryCode],
      workplaceType: null,
      employmentType: requireString(data, "employment_type"),
      publishedAt: parseTimestamp(data, "posted_date"),
      updatedAt: parseTimestamp(data, "update_date"),
      canonicalUrl: canonicalUrl(source, slug),
      fetchedAt,
    });
  }
  return jobs;
}