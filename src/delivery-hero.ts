import {
  isPotentialTargetTitle,
  type NormalizedJob,
  type SourceDefinition,
} from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const DELIVERY_HERO_MAX_SITEMAP_ENTRIES = 1_000;

export interface DeliveryHeroListing {
  sourceJobId: string;
  titleHint: string;
  detailUrl: string;
  updatedAt: string;
}

export interface DeliveryHeroSitemap {
  total: number;
  listings: DeliveryHeroListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Delivery Hero ${field} is missing or ambiguous`);
  }
  return matches[0];
}

function normalizeText(value: string): string {
  return htmlToText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseTimestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Delivery Hero has invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function extractJobPosting(html: string): Record<string, unknown> {
  const scripts = [...html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  const postings: Record<string, unknown>[] = [];
  for (const script of scripts) {
    let value: unknown;
    try {
      value = JSON.parse(script[1]) as unknown;
    } catch {
      throw new Error("Delivery Hero detail has invalid JSON-LD");
    }
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (isRecord(entry) && entry["@type"] === "JobPosting") {
        postings.push(entry);
      } else if (isRecord(entry) && Array.isArray(entry["@graph"])) {
        postings.push(...entry["@graph"].filter(
          (item): item is Record<string, unknown> => isRecord(item) && item["@type"] === "JobPosting",
        ));
      }
    }
  }
  if (postings.length !== 1) {
    throw new Error("Delivery Hero JobPosting is missing or ambiguous");
  }
  return postings[0];
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Delivery Hero detail has invalid ${field}`);
  }
  return value.trim();
}

function parseEmploymentType(posting: Record<string, unknown>): string {
  const value = posting.employmentType;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (Array.isArray(value)
    && value.length === 1
    && typeof value[0] === "string"
    && value[0].trim() !== "") {
    return value[0].trim();
  }
  throw new Error("Delivery Hero detail has invalid employmentType");
}

function requireMatchingCanonical(
  html: string,
  listing: DeliveryHeroListing,
  source: SourceDefinition,
): void {
  const canonicalUrl = assertAllowedHttpsUrl(exactlyOneMatch(
    html,
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    "detail canonical URL",
  )[1], source.allowedHosts);
  if (canonicalUrl !== listing.detailUrl) {
    throw new Error("Delivery Hero detail canonical URL does not match its listing");
  }
}

export function isExpiredDeliveryHeroDetail(
  html: string,
  listing: DeliveryHeroListing,
  source: SourceDefinition,
): boolean {
  requireMatchingCanonical(html, listing, source);
  return /\bThis vacancy has now expired\. Please see similar roles below\.\.\./i
    .test(htmlToText(html));
}

export function parseDeliveryHeroSitemap(
  xml: string,
  source: SourceDefinition,
): DeliveryHeroSitemap {
  if (!/^\s*<urlset\b[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(xml)) {
    throw new Error("Delivery Hero sitemap has an invalid document root");
  }
  if (!/<\/urlset>\s*$/.test(xml)
    || (xml.match(/<url>/g) ?? []).length !== (xml.match(/<\/url>/g) ?? []).length) {
    throw new Error("Delivery Hero sitemap is incomplete");
  }
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  if (blocks.length === 0
    || blocks.length > DELIVERY_HERO_MAX_SITEMAP_ENTRIES
    || blocks.length > source.maxJobs) {
    throw new Error("Delivery Hero sitemap has an invalid entry count");
  }

  const listings: DeliveryHeroListing[] = [];
  const seenIds = new Set<string>();
  for (const block of blocks) {
    const detailUrl = assertAllowedHttpsUrl(
      exactlyOneMatch(block, /<loc>([^<]+)<\/loc>/g, "sitemap URL")[1],
      source.allowedHosts,
    );
    const updatedAt = parseTimestamp(
      exactlyOneMatch(block, /<lastmod>([^<]+)<\/lastmod>/g, "sitemap lastmod")[1],
      "sitemap lastmod",
    );
    const pathMatch = /^\/job\/(.*)-in-([a-z0-9-]+)-jid-(\d+)$/.exec(
      allowedHttpsPath(detailUrl, source.allowedHosts),
    );
    if (!pathMatch) {
      throw new Error("Delivery Hero sitemap contains an unexpected job URL");
    }
    const sourceJobId = pathMatch[3];
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Delivery Hero sitemap contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const titleHint = pathMatch[1].replaceAll("-", " ");
    if (pathMatch[2].endsWith("-germany") && isPotentialTargetTitle(titleHint)) {
      listings.push({ sourceJobId, titleHint, detailUrl, updatedAt });
    }
  }
  return { total: blocks.length, listings };
}

export function parseDeliveryHeroDetail(
  html: string,
  listing: DeliveryHeroListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  requireMatchingCanonical(html, listing, source);

  const posting = extractJobPosting(html);
  if (requireString(posting, "url") !== listing.detailUrl
    || requireString(posting, "title").length > 300) {
    throw new Error("Delivery Hero detail identity does not match its listing");
  }
  const title = requireString(posting, "title");
  if (normalizeText(title) !== normalizeText(listing.titleHint)) {
    throw new Error("Delivery Hero detail title does not match its listing");
  }
  if (!isRecord(posting.identifier)
    || requireString(posting.identifier, "name") !== source.company
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      requireString(posting.identifier, "value"),
    )) {
    throw new Error("Delivery Hero detail has invalid identifier");
  }
  if (!isRecord(posting.hiringOrganization)
    || requireString(posting.hiringOrganization, "name") !== source.company) {
    throw new Error("Delivery Hero detail has unexpected organization");
  }
  if (!Array.isArray(posting.jobLocation) || posting.jobLocation.length !== 1
    || !isRecord(posting.jobLocation[0]) || !isRecord(posting.jobLocation[0].address)) {
    throw new Error("Delivery Hero detail has invalid jobLocation");
  }
  const locationText = requireString(posting.jobLocation[0].address, "addressLocality");
  if (!/\bBerlin, Germany\b/i.test(locationText)) {
    throw new Error("Delivery Hero detail has unexpected location");
  }
  const descriptionText = htmlToText(requireString(posting, "description"));
  if (descriptionText.length < 100 || descriptionText.length > 40_000) {
    throw new Error("Delivery Hero detail has invalid description");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText,
    countryCodes: ["DE"],
    workplaceType: null,
    employmentType: parseEmploymentType(posting),
    publishedAt: parseTimestamp(requireString(posting, "datePosted"), "datePosted"),
    updatedAt: listing.updatedAt,
    canonicalUrl: listing.detailUrl,
    fetchedAt,
  };
}