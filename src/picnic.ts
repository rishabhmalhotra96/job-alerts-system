import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const PICNIC_MAX_SITEMAP_ENTRIES = 500;

export interface PicnicListing {
  sourceJobId: string;
  title: string;
  detailUrl: string;
  updatedAt: string;
}

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Picnic ${field} is missing or ambiguous`);
  }
  return matches[0];
}

function normalizeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Picnic sitemap has an invalid lastmod");
  }
  return date.toISOString();
}

export function parsePicnicSitemap(
  xml: string,
  source: SourceDefinition,
): PicnicListing[] {
  if (!xml.startsWith("<?xml")
    || !/<urlset\b[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(xml)) {
    throw new Error("Picnic sitemap has an invalid document root");
  }
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  if (blocks.length === 0 || blocks.length > PICNIC_MAX_SITEMAP_ENTRIES) {
    throw new Error("Picnic sitemap has an invalid entry count");
  }

  const listings: PicnicListing[] = [];
  const seenIds = new Set<string>();
  for (const block of blocks) {
    const url = exactlyOneMatch(block, /<loc>([^<]+)<\/loc>/g, "sitemap URL")[1];
    const lastmod = exactlyOneMatch(block, /<lastmod>([^<]+)<\/lastmod>/g, "sitemap lastmod")[1];
    const detailUrl = assertAllowedHttpsUrl(url, source.allowedHosts);
    const path = allowedHttpsPath(detailUrl, source.allowedHosts);
    const pathMatch = /^\/en\/vacancies\/(J[A-Z0-9]{7})\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)\/(netherlands)$/.exec(path);
    if (!pathMatch) {
      continue;
    }
    if (source.locationFilters?.length !== 1
      || pathMatch[6] !== source.locationFilters[0].toLowerCase()) {
      throw new Error("Picnic sitemap has an unexpected country");
    }

    const sourceJobId = pathMatch[1];
    if (seenIds.has(sourceJobId)) {
      throw new Error(`Picnic sitemap contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);
    listings.push({
      sourceJobId,
      title: pathMatch[3].replaceAll("-", " "),
      detailUrl,
      updatedAt: normalizeDate(lastmod),
    });
  }
  if (listings.length === 0 || listings.length > source.maxJobs) {
    throw new Error("Picnic sitemap has an invalid Netherlands job count");
  }
  return listings;
}

export function parsePicnicDetail(
  html: string,
  listing: PicnicListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const canonical = exactlyOneMatch(
    html,
    /<link rel="canonical" href="([^"]+)"\/>/g,
    "detail canonical URL",
  )[1];
  if (assertAllowedHttpsUrl(canonical, source.allowedHosts) !== listing.detailUrl) {
    throw new Error("Picnic detail canonical URL does not match its listing");
  }

  const title = htmlToText(exactlyOneMatch(
    html,
    /<h1[^>]*><strong>([^<]+)<\/strong><\/h1>/g,
    "detail title",
  )[1]);
  if (title.toLowerCase() !== listing.title) {
    throw new Error("Picnic detail title does not match its listing");
  }
  const location = htmlToText(exactlyOneMatch(
    html,
    /<a[^>]+href="https:\/\/jobs\.picnic\.app\/amsterdam"[^>]*>([^<]+)<\/a>/g,
    "detail location",
  )[1]);
  if (location !== "📍Amsterdam") {
    throw new Error("Picnic detail has an unexpected location");
  }

  const starts = [...html.matchAll(/<h1[^>]*>In a nutshell(?:&nbsp;|\s)*<\/h1>/g)];
  const ends = [...html.matchAll(/<h1[^>]*>Picnic Perks(?:&nbsp;|\s)*<\/h1>/g)];
  if (starts.length !== 1
    || ends.length !== 1
    || starts[0].index === undefined
    || ends[0].index === undefined
    || starts[0].index >= ends[0].index) {
    throw new Error("Picnic detail content boundary is missing or ambiguous");
  }
  const descriptionText = htmlToText(html.slice(starts[0].index, ends[0].index));
  if (descriptionText.length < 100
    || descriptionText.length > 40_000
    || !/\bPicnic\b/.test(descriptionText)) {
    throw new Error("Picnic detail has invalid role content");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: "Amsterdam, Netherlands",
    countryCodes: ["NL"],
    workplaceType: null,
    employmentType: null,
    publishedAt: null,
    updatedAt: listing.updatedAt,
    canonicalUrl: listing.detailUrl,
    fetchedAt,
  };
}