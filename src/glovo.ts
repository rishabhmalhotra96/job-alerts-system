import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";
import { parseSmartRecruitersDetail } from "./smartrecruiters.ts";

export const GLOVO_PAGE_SIZE = 12;

export interface GlovoListingRequest {
  url: string;
  body: string;
  contentType: string;
  searchTerm: string;
  page: number;
}

export interface GlovoListing {
  sourceJobId: string;
  title: string;
  detailUrl: string;
}

export interface GlovoListingPage {
  total: number;
  listings: GlovoListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Glovo job has invalid ${field}`);
  }
  return value.trim();
}

export function buildGlovoListingRequest(
  source: SourceDefinition,
  searchTerm: string,
  page: number,
): GlovoListingRequest {
  if (searchTerm.trim() === "") {
    throw new Error("Glovo search term must not be empty");
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("Glovo page must be a positive integer");
  }
  return {
    url: assertAllowedHttpsUrl(source.endpoint, source.allowedHosts),
    body: [
      "action=glovo_filter_jobs",
      `page=${page}`,
      `search=${encodeURIComponent(searchTerm)}`,
      "team_page=false",
      "team_id=",
    ].join("&"),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    searchTerm,
    page,
  };
}

export function parseGlovoListingPage(
  payload: unknown,
  source: SourceDefinition,
): GlovoListingPage {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new Error("Glovo listing response has invalid shape");
  }
  const total = payload.data.total;
  const html = payload.data.html;
  if (!Number.isInteger(total) || (total as number) < 0 || typeof html !== "string") {
    throw new Error("Glovo listing response has invalid total or HTML");
  }

  const cardCount = html.match(/\bdata-job-card="/g)?.length ?? 0;
  const cardPattern = /<div\b[^>]*\bdata-job-card="([^"]+)"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bdata-job-card="|$)/g;
  const listings: GlovoListing[] = [];
  const seenIds = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = cardPattern.exec(html)) !== null) {
    const sourceJobId = match[1];
    const cardHtml = match[2];
    if (!/^\d{15}$/.test(sourceJobId)) {
      throw new Error("Glovo listing has an invalid job id");
    }
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Glovo response contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    const titleMatch = /<h4\s+class="job-title">([\s\S]*?)<\/h4>/.exec(cardHtml);
    const linkMatch = /<a\s+href="([^"]+)">Apply<\/a>/.exec(cardHtml);
    if (!titleMatch || !linkMatch) {
      throw new Error(`Glovo listing ${sourceJobId} is missing title or link`);
    }
    const title = htmlToText(titleMatch[1]);
    if (title === "") {
      throw new Error(`Glovo listing ${sourceJobId} has an empty title`);
    }
    const detailUrl = assertAllowedHttpsUrl(linkMatch[1], source.allowedHosts);
    const detailPath = allowedHttpsPath(detailUrl, source.allowedHosts);
    if (!detailPath.startsWith("/job/") || !detailPath.endsWith(`-jid-${sourceJobId}/`)) {
      throw new Error(`Glovo listing ${sourceJobId} has a mismatched detail link`);
    }
    listings.push({ sourceJobId, title, detailUrl });
  }

  if (listings.length !== cardCount
    || listings.length > GLOVO_PAGE_SIZE
    || listings.length > (total as number)
    || ((total as number) > 0 && listings.length === 0)) {
    throw new Error("Glovo listing response has inconsistent cards");
  }
  return { total: total as number, listings };
}

export function buildGlovoDetailUrl(
  listing: GlovoListing,
  source: SourceDefinition,
): string {
  return assertAllowedHttpsUrl(
    `https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings/${listing.sourceJobId}`,
    source.allowedHosts,
  );
}

export function parseGlovoDetail(
  payload: unknown,
  listing: GlovoListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  if (!isRecord(payload) || !isRecord(payload.company)) {
    throw new Error("Glovo detail response has invalid shape");
  }
  if (requireString(payload, "id") !== listing.sourceJobId
    || requireString(payload, "name") !== listing.title) {
    throw new Error("Glovo detail does not match its listing");
  }
  if (requireString(payload.company, "identifier") !== "DeliveryHero"
    || requireString(payload.company, "name") !== "Delivery Hero") {
    throw new Error("Glovo detail has an unexpected company");
  }
  if (!Array.isArray(payload.customField)) {
    throw new Error("Glovo detail has no custom fields");
  }
  const brandFields = payload.customField.filter((value) =>
    isRecord(value) && value.fieldLabel === "Brands");
  if (brandFields.length !== 1
    || !isRecord(brandFields[0])
    || brandFields[0].valueId !== "Glovo"
    || brandFields[0].valueLabel !== "Glovo") {
    throw new Error("Glovo detail has an unexpected brand");
  }

  return parseSmartRecruitersDetail(payload, source, fetchedAt);
}