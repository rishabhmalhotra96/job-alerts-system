import type { NormalizedJob, SourceDefinition } from "./domain.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Greenhouse job has invalid ${field}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalMetadataString(record: Record<string, unknown>, name: string): string | null {
  const metadata = record.metadata;
  if (metadata === undefined || metadata === null) {
    return null;
  }
  if (!Array.isArray(metadata)) {
    throw new Error("Greenhouse job has invalid metadata");
  }
  const matches = metadata.filter((item) => isRecord(item) && item.name === name);
  if (matches.length > 1) {
    throw new Error(`Greenhouse job has ambiguous ${name} metadata`);
  }
  return matches.length === 1 ? optionalString(matches[0], "value") : null;
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  if (entity.startsWith("#x")) {
    return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  }
  if (entity.startsWith("#")) {
    return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  }
  return named[entity] ?? `&${entity};`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity.toLowerCase()))
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumericIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((part) => part === "")) {
    return null;
  }

  const values = parts.map((part) => {
    const radix = /^0x/i.test(part) ? 16 : /^0[0-7]+$/.test(part) ? 8 : 10;
    const digits = radix === 16 ? part.slice(2) : part;
    const validDigits = radix === 16 ? /^[\da-f]+$/i.test(digits) : /^\d+$/.test(digits);
    if (digits === "" || !validDigits) {
      return Number.NaN;
    }
    return Number.parseInt(digits, radix);
  });
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }

  const lastLimit = 256 ** (5 - values.length);
  if (values.slice(0, -1).some((value) => value > 255)
    || values[values.length - 1] >= lastLimit) {
    return null;
  }

  let address = values[values.length - 1];
  for (let index = 0; index < values.length - 1; index += 1) {
    address += values[index] * (256 ** (3 - index));
  }
  return [
    Math.floor(address / (256 ** 3)) % 256,
    Math.floor(address / (256 ** 2)) % 256,
    Math.floor(address / 256) % 256,
    address % 256,
  ];
}

export function assertAllowedHttpsUrl(url: string, allowedHosts: string[]): string {
  if (/[\u0000-\u001f\u007f\\]/.test(url)) {
    throw new Error("Job URL is invalid");
  }
  const scheme = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)(?:[/?#]|$)/i.exec(url);
  if (!scheme) {
    throw new Error("Job URL is invalid");
  }
  if (scheme[1].toLowerCase() !== "https") {
    throw new Error("Job URL must use HTTPS");
  }
  const authority = scheme[2];
  if (authority.includes("@")) {
    throw new Error("Job URL contains credentials or a non-default port");
  }
  if (authority.startsWith("[") || authority.includes("]")) {
    throw new Error("Job URL uses an unsupported IP literal");
  }
  const authorityParts = authority.split(":");
  if (authorityParts.length > 2
    || (authorityParts.length === 2 && authorityParts[1] !== "443")) {
    throw new Error("Job URL contains credentials or a non-default port");
  }
  const host = authorityParts[0].toLowerCase().replace(/\.$/, "");
  if (host === "" || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(host)
    || host.includes("..")) {
    throw new Error("Job URL is invalid");
  }

  const numericHost = /^(?:\d|0x)/i.test(host) && /^[\da-fx.]+$/i.test(host);
  const octets = numericHost ? parseNumericIpv4(host) : null;
  if (numericHost && !octets) {
    throw new Error("Job URL is invalid");
  }
  if (octets) {
    const [first, second] = octets;
    const privateOrLocal = first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
    if (privateOrLocal) {
      throw new Error("Job URL uses a private or local address");
    }
  }
  const allowed = allowedHosts.some((allowedHost) => {
    const normalizedAllowedHost = allowedHost.toLowerCase().replace(/\.$/, "");
    return host === normalizedAllowedHost || host.endsWith(`.${normalizedAllowedHost}`);
  });
  if (!allowed) {
    throw new Error(`Job URL host is not allowlisted: ${host}`);
  }
  return url;
}

export function allowedHttpsPath(url: string, allowedHosts: string[]): string {
  const validatedUrl = assertAllowedHttpsUrl(url, allowedHosts);
  const match = /^https:\/\/[^/?#]+([^?#]*)/i.exec(validatedUrl);
  return match?.[1] || "/";
}

export function resolveAllowedHttpsUrl(
  location: string,
  currentUrl: string,
  allowedHosts: string[],
): string {
  const validatedCurrentUrl = assertAllowedHttpsUrl(currentUrl, allowedHosts);
  if (/^https:\/\//i.test(location)) {
    return assertAllowedHttpsUrl(location, allowedHosts);
  }
  if (!location.startsWith("/") || location.startsWith("//")) {
    throw new Error("Job URL is invalid");
  }
  const origin = /^(https:\/\/[^/?#]+)/i.exec(validatedCurrentUrl)?.[1];
  if (!origin) {
    throw new Error("Job URL is invalid");
  }
  return assertAllowedHttpsUrl(`${origin}${location}`, allowedHosts);
}

export function parseGreenhouseResponse(
  payload: unknown,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error("Greenhouse response is missing jobs[]");
  }
  if (payload.jobs.length > source.maxJobs) {
    throw new Error(`Greenhouse response exceeds maxJobs (${source.maxJobs})`);
  }

  const seenIds = new Set<string>();
  return payload.jobs.map((value) => {
    if (!isRecord(value)) {
      throw new Error("Greenhouse jobs[] contains a non-object entry");
    }

    const rawId = value.id;
    if ((typeof rawId !== "string" && typeof rawId !== "number") || String(rawId).trim() === "") {
      throw new Error("Greenhouse job has invalid id");
    }
    const sourceJobId = String(rawId);
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Greenhouse response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const location = value.location;
    if (!isRecord(location)) {
      throw new Error(`Greenhouse job ${sourceJobId} has invalid location`);
    }

    const canonicalUrl = assertAllowedHttpsUrl(
      requireString(value, "absolute_url"),
      source.allowedHosts,
    );
    const content = optionalString(value, "content") ?? "";

    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title: requireString(value, "title"),
      descriptionText: htmlToText(content),
      descriptionCompleteness: content === "" ? "TEASER" : "FULL",
      locationText: requireString(location, "name"),
      countryCodes: [],
      workplaceType: null,
      employmentType: optionalMetadataString(value, "Employment Type"),
      publishedAt: optionalString(value, "first_published"),
      updatedAt: optionalString(value, "updated_at"),
      canonicalUrl,
      fetchedAt,
    };
  });
}