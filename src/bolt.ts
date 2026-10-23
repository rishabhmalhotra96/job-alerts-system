import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

const BOLT_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DESCRIPTION_LENGTH = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Bolt job has invalid ${field}`);
  }
  return value.trim();
}

function extractJsonArray(value: string, marker: string): string {
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0 || value.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error("Bolt payload has a missing or ambiguous jobs array");
  }
  const start = markerIndex + marker.length;
  if (value[start] !== "[") {
    throw new Error("Bolt payload has an invalid jobs array");
  }

  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  throw new Error("Bolt payload has an unterminated jobs array");
}

function isHtmlSpace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f";
}

function extractScriptBodies(html: string): string[] {
  const lowerHtml = html.toLowerCase();
  const bodies: string[] = [];
  let offset = 0;
  while (offset < html.length) {
    const opening = lowerHtml.indexOf("<script", offset);
    if (opening < 0) {
      break;
    }
    const afterOpeningName = lowerHtml[opening + "<script".length];
    if (afterOpeningName !== ">" && !isHtmlSpace(afterOpeningName)) {
      offset = opening + "<script".length;
      continue;
    }
    const openingEnd = html.indexOf(">", opening + "<script".length);
    if (openingEnd < 0) {
      break;
    }

    let closing = lowerHtml.indexOf("</script", openingEnd + 1);
    while (closing >= 0) {
      const afterClosingName = lowerHtml[closing + "</script".length];
      if (afterClosingName === ">" || isHtmlSpace(afterClosingName)) {
        break;
      }
      closing = lowerHtml.indexOf("</script", closing + "</script".length);
    }
    if (closing < 0) {
      break;
    }
    const closingEnd = html.indexOf(">", closing + "</script".length);
    if (closingEnd < 0) {
      break;
    }
    bodies.push(html.slice(openingEnd + 1, closing));
    offset = closingEnd + 1;
  }
  return bodies;
}

function parseFlightPayload(html: string): unknown[] {
  const scripts = extractScriptBodies(html)
    .filter((script) => script.includes("parsedJobs"));
  if (scripts.length !== 1) {
    throw new Error("Bolt page has a missing or ambiguous jobs payload");
  }

  const script = scripts[0];
  const callMatch = /^self\.__next_f\.push\((\[[\s\S]*\])\)$/.exec(script);
  if (!callMatch) {
    throw new Error("Bolt page has an invalid jobs payload wrapper");
  }
  const call = JSON.parse(callMatch[1]) as unknown;
  if (!Array.isArray(call) || call.length !== 2 || call[0] !== 1 || typeof call[1] !== "string") {
    throw new Error("Bolt page has an invalid jobs payload call");
  }

  const jobs = JSON.parse(extractJsonArray(call[1], '"parsedJobs":')) as unknown;
  if (!Array.isArray(jobs)) {
    throw new Error("Bolt payload jobs value is not an array");
  }
  return jobs;
}

function parseLocations(value: unknown): { locationText: string; countryCodes: string[] } {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Bolt job has invalid locations");
  }
  const locations: string[] = [];
  const countryCodes: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error("Bolt job has an invalid location entry");
    }
    const city = requireString(item, "city");
    const country = requireString(item, "country");
    const countryCode = requireString(item, "countryCode").toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new Error("Bolt job has an invalid country code");
    }
    locations.push(`${city}, ${country}`);
    countryCodes.push(countryCode);
  }
  return {
    locationText: locations.length > 0 ? [...new Set(locations)].join("; ") : "Unspecified",
    countryCodes: [...new Set(countryCodes)],
  };
}

export function parseBoltResponse(
  html: string,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  const values = parseFlightPayload(html);
  if (values.length === 0 || values.length > source.maxJobs) {
    throw new Error(`Bolt response has an invalid job count (${values.length})`);
  }

  const seenIds = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value) || !isRecord(value.header) || !isRecord(value.body)) {
      throw new Error("Bolt jobs array contains an invalid entry");
    }
    const sourceJobId = requireString(value, "id");
    if (!BOLT_JOB_ID.test(sourceJobId)) {
      throw new Error("Bolt job has an invalid id");
    }
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Bolt response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const descriptionText = htmlToText(requireString(value.body, "description"));
    if (descriptionText.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error("Bolt job description exceeds its size limit");
    }
    const rawPublishedAt = requireString(value.body, "jobPostedDate");
    if (!/^\$D\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rawPublishedAt)
      || Number.isNaN(Date.parse(rawPublishedAt.slice(2)))) {
      throw new Error("Bolt job has an invalid posting date");
    }
    const { locationText, countryCodes } = parseLocations(value.header.locations);
    const canonicalUrl = assertAllowedHttpsUrl(
      `https://bolt.eu/en/careers/positions/${sourceJobId}/`,
      source.allowedHosts,
    );

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value.header, "roleTitle"),
      descriptionText,
      descriptionCompleteness: "FULL",
      locationText,
      countryCodes,
      workplaceType: null,
      employmentType: null,
      publishedAt: rawPublishedAt.slice(2),
      updatedAt: null,
      canonicalUrl,
      fetchedAt,
    };
  });
}