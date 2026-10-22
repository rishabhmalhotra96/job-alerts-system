import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Lever job has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Lever job has invalid ${field}`);
  }
  return value.trim() || null;
}

function plainOrHtml(
  record: Record<string, unknown>,
  plainFields: readonly string[],
  htmlFields: readonly string[],
): string | null {
  for (const field of plainFields) {
    const value = optionalString(record, field);
    if (value !== null) {
      return value;
    }
  }
  for (const field of htmlFields) {
    const value = optionalString(record, field);
    if (value !== null) {
      const text = htmlToText(value);
      return text || null;
    }
  }
  return null;
}

function descriptionText(job: Record<string, unknown>, sourceJobId: string): string {
  const lists = job.lists;
  if (!Array.isArray(lists)) {
    throw new Error(`Lever job ${sourceJobId} has invalid lists`);
  }
  const sections = [
    plainOrHtml(job, ["openingPlain"], ["opening"]),
    plainOrHtml(job, ["descriptionPlain", "descriptionBodyPlain"], ["description", "descriptionBody"]),
    ...lists.map((value) => {
      if (!isRecord(value)) {
        throw new Error(`Lever job ${sourceJobId} has an invalid list`);
      }
      return `${requireString(value, "text")} ${htmlToText(requireString(value, "content"))}`;
    }),
    plainOrHtml(job, ["additionalPlain"], ["additional"]),
  ].filter((value): value is string => value !== null);
  const description = sections.join("\n").trim();
  if (description === "") {
    throw new Error(`Lever job ${sourceJobId} has no complete description`);
  }
  return description;
}

function parsePublishedAt(job: Record<string, unknown>): string {
  const value = job.createdAt;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("Lever job has invalid createdAt");
  }
  const timestamp = new Date(value as number);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Lever job has invalid createdAt");
  }
  return timestamp.toISOString();
}

function parseLocations(
  job: Record<string, unknown>,
  source: SourceDefinition,
): { text: string; countryCodes: string[] } {
  if (!isRecord(job.categories)) {
    throw new Error("Lever job has invalid categories");
  }
  const categories = job.categories;
  const locations = categories.allLocations;
  if (!Array.isArray(locations)
    || locations.length === 0
    || locations.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("Lever job has invalid allLocations");
  }
  const locationText = [...new Set((locations as string[]).map((value) => value.trim()))]
    .join(" | ");
  const country = optionalString(job, "country");
  const configuredCountryCodes = source.leverLocationCountryCodes?.[locationText];
  const countryCodes = country === null
    ? configuredCountryCodes?.map((code) => code.toUpperCase())
    : [country.toUpperCase()];
  if (countryCodes === undefined
    || countryCodes.length === 0
    || new Set(countryCodes).size !== countryCodes.length
    || countryCodes.some((code) => !/^[A-Z]{2}$/.test(code))) {
    throw new Error("Lever job has invalid country");
  }
  return {
    text: locationText,
    countryCodes,
  };
}

export function parseLeverResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!Array.isArray(payload)) {
    throw new Error("Lever response must be an array");
  }
  if (payload.length > source.maxJobs) {
    throw new Error(`Lever response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  return payload.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Lever response contains a non-object entry");
    }
    const sourceJobId = requireString(value, "id");
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Lever response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    const location = parseLocations(value, source);
    const categories = value.categories as Record<string, unknown>;

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value, "text"),
      descriptionText: descriptionText(value, sourceJobId),
      descriptionCompleteness: "FULL",
      locationText: location.text,
      countryCodes: location.countryCodes,
      workplaceType: optionalString(value, "workplaceType"),
      employmentType: optionalString(categories, "commitment"),
      publishedAt: parsePublishedAt(value),
      updatedAt: null,
      canonicalUrl: assertAllowedHttpsUrl(requireString(value, "hostedUrl"), source.allowedHosts),
      fetchedAt,
    };
  });
}