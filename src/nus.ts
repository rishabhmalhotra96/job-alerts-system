import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { isPotentialTargetTitleWithStrongSignal } from "./domain.ts";
import {
  allowedHttpsPath,
  assertAllowedHttpsUrl,
  htmlToText,
  resolveAllowedHttpsUrl,
} from "./greenhouse.ts";

export const NUS_MAX_SITEMAP_ENTRIES = 1_200;

export interface NusListing {
  sourceJobId: string;
  titleHint: string;
  detailUrl: string;
}

export interface NusSitemap {
  total: number;
  listings: NusListing[];
}

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`NUS ${field} is missing or ambiguous`);
  }
  return matches[0];
}

function normalizeForComparison(value: string): string {
  return htmlToText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) {
    throw new Error("NUS detail has an invalid posting date");
  }
  const year = Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    throw new Error("NUS detail has an invalid posting date");
  }
  return date.toISOString().slice(0, 10);
}

function matchLabeledValue(html: string, label: string): RegExpExecArray {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return exactlyOneMatch(
    html,
    new RegExp(
      `<span\\b[^>]*>\\s*${escapedLabel}\\s*<\\/span>\\s*<span\\b[^>]*>([\\s\\S]*?)<\\/span>`,
      "gi",
    ),
    `${label} field`,
  );
}

function extractLabeledValue(html: string, label: string): string {
  const text = htmlToText(matchLabeledValue(html, label)[1]);
  if (text === "") {
    throw new Error(`NUS ${label} field is empty`);
  }
  return text;
}

export function parseNusSitemap(xml: string, source: SourceDefinition): NusSitemap {
  if (!xml.startsWith("<?xml")
    || !/<urlset\b[^>]*xmlns="http:\/\/www\.google\.com\/schemas\/sitemap\/0\.9"/.test(xml)) {
    throw new Error("NUS sitemap has an invalid document root");
  }
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  if (blocks.length === 0
    || blocks.length > NUS_MAX_SITEMAP_ENTRIES
    || blocks.length > source.maxJobs) {
    throw new Error("NUS sitemap has an invalid entry count");
  }

  const listings: NusListing[] = [];
  const seenIds = new Set<string>();
  for (const block of blocks) {
    const encodedUrl = exactlyOneMatch(block, /<loc>([^<]+)<\/loc>/g, "sitemap URL")[1];
    const detailUrl = assertAllowedHttpsUrl(htmlToText(encodedUrl), source.allowedHosts);
    const pathMatch = /^\/(?:NUS|DukeNUS)\/job\/([^/]+)\/(\d{7,8})\/$/.exec(
      allowedHttpsPath(detailUrl, source.allowedHosts),
    );
    if (!pathMatch) {
      throw new Error("NUS sitemap contains an unexpected job URL");
    }
    const sourceJobId = pathMatch[2];
    if (seenIds.has(sourceJobId)) {
      throw new Error(`NUS sitemap contains duplicate job id: ${sourceJobId}`);
    }
    seenIds.add(sourceJobId);

    let titleHint: string;
    try {
      titleHint = decodeURIComponent(pathMatch[1]).replaceAll("-", " ");
    } catch {
      throw new Error("NUS sitemap contains an invalid encoded title");
    }
    if (isPotentialTargetTitleWithStrongSignal(titleHint)) {
      listings.push({ sourceJobId, titleHint, detailUrl });
    }
  }
  return { total: blocks.length, listings };
}

export function parseNusRedirect(
  status: number,
  location: string | undefined,
  currentUrl: string,
  source: SourceDefinition,
): string {
  if (![301, 302, 307, 308].includes(status) || !location) {
    throw new Error("NUS detail redirect is missing or invalid");
  }
  const validatedUrl = resolveAllowedHttpsUrl(location, currentUrl, source.allowedHosts);
  if (/[?#]/.test(validatedUrl)
    || !/^\/(?:(?:NUS|DukeNUS)\/)?job\/[A-Za-z0-9%&()+,._~-]+\/\d+-en_GB\/$/.test(
      allowedHttpsPath(validatedUrl, source.allowedHosts),
    )) {
    throw new Error("NUS detail redirect URL is invalid");
  }
  return validatedUrl;
}

export function parseNusDetail(
  html: string,
  listing: NusListing,
  finalUrl: string,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const canonical = htmlToText(exactlyOneMatch(
    html,
    /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"[^>]*>/gi,
    "detail canonical URL",
  )[1]);
  const canonicalUrl = assertAllowedHttpsUrl(canonical, source.allowedHosts);
  if (canonicalUrl !== finalUrl) {
    throw new Error("NUS detail canonical URL does not match its redirect");
  }

  const sourceJobId = extractLabeledValue(html, "Req ID:");
  const finalPathMatch = /\/(\d+)-en_GB\/$/.exec(allowedHttpsPath(finalUrl, source.allowedHosts));
  if (!finalPathMatch || finalPathMatch[1] !== sourceJobId) {
    throw new Error("NUS detail requisition does not match its URL");
  }
  const title = extractLabeledValue(html, "Job Title:");
  if (!normalizeForComparison(listing.titleHint).includes(normalizeForComparison(title))) {
    throw new Error("NUS detail title does not match its sitemap listing");
  }
  const location = extractLabeledValue(html, "Location_ONB:");
  if (!/\b(?:campus|singapore)\b/i.test(location)) {
    throw new Error("NUS detail has an unexpected location");
  }

  const postingDate = matchLabeledValue(html, "Posting Start Date:");
  const descriptionEnd = exactlyOneMatch(
    html,
    /<span\b[^>]*>\s*Req ID:\s*<\/span>/gi,
    "description end",
  );
  if (postingDate.index === undefined
    || descriptionEnd.index === undefined
    || postingDate.index + postingDate[0].length >= descriptionEnd.index) {
    throw new Error("NUS detail description boundary is invalid");
  }
  const descriptionText = htmlToText(html.slice(
    postingDate.index + postingDate[0].length,
    descriptionEnd.index,
  ));
  if (descriptionText.length < 100 || descriptionText.length > 40_000) {
    throw new Error("NUS detail has invalid role content");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: `${location}, Singapore`,
    countryCodes: ["SG"],
    workplaceType: null,
    employmentType: /\bcontract\b/i.test(title) ? "Contract" : null,
    publishedAt: parseDate(htmlToText(postingDate[1])),
    updatedAt: null,
    canonicalUrl,
    fetchedAt,
  };
}