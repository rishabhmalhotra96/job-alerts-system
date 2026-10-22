import {
  isPotentialTargetTitle,
  type NormalizedJob,
  type SourceDefinition,
} from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const DEUTSCHE_BOERSE_MAX_OFFERS = 250;
const DEUTSCHE_BOERSE_MAX_TITLE_SLUG_LENGTH = 35;

export interface DeutscheBoerseListing {
  sourceJobId: string;
  titleHint: string;
  detailUrl: string;
}

export interface DeutscheBoerseSitemap {
  total: number;
  listings: DeutscheBoerseListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Deutsche Boerse ${field} is missing or ambiguous`);
  }
  return matches[0];
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Deutsche Boerse detail has invalid ${field}`);
  }
  return value.trim();
}

function normalizeText(value: string): string {
  return htmlToText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleMatchesListing(
  title: string,
  listing: DeutscheBoerseListing,
  source: SourceDefinition,
): boolean {
  const normalizedTitle = normalizeText(title);
  const normalizedHint = normalizeText(listing.titleHint);
  if (normalizedTitle === normalizedHint) {
    return true;
  }
  const titleSlug = /^\/offer\/([^/]+)\//.exec(
    allowedHttpsPath(listing.detailUrl, source.allowedHosts),
  )?.[1];
  return titleSlug?.length === DEUTSCHE_BOERSE_MAX_TITLE_SLUG_LENGTH
    && normalizedTitle.startsWith(`${normalizedHint} `);
}

function parseTimestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Deutsche Boerse detail has invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function extractJobPosting(html: string): Record<string, unknown> {
  const postings: Record<string, unknown>[] = [];
  for (const script of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let value: unknown;
    try {
      value = JSON.parse(script[1]) as unknown;
    } catch {
      throw new Error("Deutsche Boerse detail has invalid JSON-LD");
    }
    if (isRecord(value) && value["@type"] === "JobPosting") {
      postings.push(value);
    }
  }
  if (postings.length !== 1) {
    throw new Error("Deutsche Boerse JobPosting is missing or ambiguous");
  }
  return postings[0];
}

export function parseDeutscheBoerseSitemap(
  xml: string,
  source: SourceDefinition,
): DeutscheBoerseSitemap {
  if (!/^\s*(?:<\?xml version="1\.0" encoding="UTF-8"\?>\s*)?<urlset\b[^>]*xmlns="https:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(xml)) {
    throw new Error("Deutsche Boerse sitemap has an invalid document root");
  }
  if (!/<\/urlset>\s*$/.test(xml)
    || (xml.match(/<url>/g) ?? []).length !== (xml.match(/<\/url>/g) ?? []).length) {
    throw new Error("Deutsche Boerse sitemap is incomplete");
  }

  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  const offers: DeutscheBoerseListing[] = [];
  const seenIds = new Set<string>();
  for (const block of blocks) {
    const detailUrl = assertAllowedHttpsUrl(
      exactlyOneMatch(block, /<loc>([^<]+)<\/loc>/g, "sitemap URL")[1],
      source.allowedHosts,
    );
    const path = allowedHttpsPath(detailUrl, source.allowedHosts);
    if (!path.startsWith("/offer/")) {
      continue;
    }
    const pathMatch = /^\/offer\/([a-z0-9-]+)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(path);
    if (!pathMatch) {
      throw new Error("Deutsche Boerse sitemap contains an unexpected offer URL");
    }
    const sourceJobId = pathMatch[2].toLowerCase();
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Deutsche Boerse sitemap contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    offers.push({
      sourceJobId,
      titleHint: pathMatch[1].replaceAll("-", " ").trim(),
      detailUrl,
    });
  }
  if (offers.length === 0
    || offers.length > DEUTSCHE_BOERSE_MAX_OFFERS
    || offers.length > source.maxJobs) {
    throw new Error("Deutsche Boerse sitemap has an invalid offer count");
  }
  return {
    total: offers.length,
    listings: offers.filter(({ titleHint }) => isPotentialTargetTitle(titleHint)),
  };
}

export function parseDeutscheBoerseDetail(
  html: string,
  listing: DeutscheBoerseListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const canonicalUrl = assertAllowedHttpsUrl(exactlyOneMatch(
    html,
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    "detail canonical URL",
  )[1], source.allowedHosts);
  if (canonicalUrl !== listing.detailUrl) {
    throw new Error("Deutsche Boerse detail canonical URL does not match its listing");
  }

  const posting = extractJobPosting(html);
  const title = requireString(posting, "title");
  if (requireString(posting, "url") !== listing.detailUrl
    || !titleMatchesListing(title, listing, source)) {
    throw new Error("Deutsche Boerse detail identity does not match its listing");
  }
  if (!isRecord(posting.identifier)
    || requireString(posting.identifier, "name") !== "id"
    || requireString(posting.identifier, "value").toLowerCase() !== listing.sourceJobId) {
    throw new Error("Deutsche Boerse detail has invalid identifier");
  }
  if (!isRecord(posting.hiringOrganization)
    || requireString(posting.hiringOrganization, "name") !== requireString(posting.hiringOrganization, "legalName")
    || requireString(posting.hiringOrganization, "url") !== "https://careers.deutsche-boerse.com/") {
    throw new Error("Deutsche Boerse detail has unexpected organization");
  }
  if (!Array.isArray(posting.jobLocation) || posting.jobLocation.length !== 1
    || !isRecord(posting.jobLocation[0]) || !isRecord(posting.jobLocation[0].address)) {
    throw new Error("Deutsche Boerse detail has invalid jobLocation");
  }
  const address = posting.jobLocation[0].address;
  const location = requireString(address, "addressLocality");
  const countryCode = requireString(address, "addressCountry").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error("Deutsche Boerse detail has invalid addressCountry");
  }
  const descriptionText = htmlToText(requireString(posting, "description"));
  if (descriptionText.length < 100
    || descriptionText.length > 40_000
    || !/^Your career at Deutsche B\u00f6rse Group\b/.test(descriptionText)) {
    throw new Error("Deutsche Boerse detail has invalid description");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: `${location}, ${countryCode}`,
    countryCodes: [countryCode],
    workplaceType: null,
    employmentType: null,
    publishedAt: parseTimestamp(requireString(posting, "datePosted"), "datePosted"),
    updatedAt: null,
    canonicalUrl,
    fetchedAt,
  };
}