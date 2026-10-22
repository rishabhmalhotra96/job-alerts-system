import {
  isPotentialTargetTitle,
  type NormalizedJob,
  type SourceDefinition,
} from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const BEC_MAX_LISTINGS = 50;

export interface BecListing {
  sourceJobId: string;
  departmentId: string;
  title: string;
  detailUrl: string;
}

export interface BecListingPage {
  total: number;
  listings: BecListing[];
}

const BEC_DETAIL_URL = /^https:\/\/candidate\.hr-manager\.net\/ApplicationInit\.aspx\?cid=1017&ProjectId=([1-9]\d*)&DepartmentId=([1-9]\d*)&MediaId=5$/;
const BEC_CUSTOMER_ALIAS = "bec";
const BEC_CUSTOMER_NAME = "Bankernes EDB Central";

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`BEC ${field} is missing or ambiguous`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`BEC listing has invalid ${field}`);
  }
  return value.trim();
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`BEC listing has invalid ${field}`);
  }
  return value as number;
}

function decodeHtmlAttribute(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\"",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, rawEntity: string) => {
    const entity = rawEntity.toLowerCase();
    if (entity in namedEntities) {
      return namedEntities[entity];
    }
    const codePoint = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith("#")
        ? Number.parseInt(entity.slice(1), 10)
        : Number.NaN;
    if (!Number.isSafeInteger(codePoint)
      || codePoint < 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error("BEC listing has an invalid HTML entity");
    }
    return String.fromCodePoint(codePoint);
  });
}

function assertBecPayloadIdentity(record: Record<string, unknown>): void {
  const transactionStatus = record.TransactionStatus;
  if (record.CustomerAlias !== BEC_CUSTOMER_ALIAS
    || record.CustomerName !== BEC_CUSTOMER_NAME
    || !isRecord(transactionStatus)
    || transactionStatus.StatusCode !== 0) {
    throw new Error("BEC listing has invalid identity");
  }
}

function parseTimestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`BEC detail has invalid ${field}`);
  }
  return new Date(value).toISOString();
}

function parseDetailUrl(encodedUrl: string, source: SourceDefinition): {
  detailUrl: string;
  sourceJobId: string;
  departmentId: string;
} {
  const detailUrl = assertAllowedHttpsUrl(htmlToText(encodedUrl), source.allowedHosts);
  const match = BEC_DETAIL_URL.exec(detailUrl);
  if (!match) {
    throw new Error("BEC listing contains an unexpected detail URL");
  }
  return { detailUrl, sourceJobId: match[1], departmentId: match[2] };
}

function parseOptionalLabeledValue(html: string, labelId: string): string | null {
  const match = exactlyOneMatch(
    html,
    new RegExp(`<div id="${labelId}"[^>]*>[\\s\\S]*?<\\/div><div class="widget-line"><\\/div><span class="empty">([\\s\\S]*?)<\\/span>`, "g"),
    labelId,
  );
  const value = htmlToText(match[1]);
  return value === "" ? null : value;
}

function parseCountryCodes(locationText: string): string[] {
  const countryByLocation: Readonly<Record<string, string>> = {
    Aalborg: "DK",
    Copenhagen: "DK",
    Roskilde: "DK",
    Warsaw: "PL",
  };
  const locations = locationText.split(",").map((value) => value.trim());
  if (locations.length === 0 || locations.some((value) => !(value in countryByLocation))) {
    throw new Error("BEC detail has unexpected workplace");
  }
  return [...new Set(locations.map((value) => countryByLocation[value]))];
}

export function parseBecListing(
  html: string,
  source: SourceDefinition,
): BecListingPage {
  const encodedPayload = exactlyOneMatch(
    html,
    /<input\b(?=[^>]*\bid=["'][A-Za-z0-9_]*HiddenField_PositionList["'])[^>]*\bvalue=(["'])([\s\S]*?)\1[^>]*>/gi,
    "position payload",
  )[2];
  let payload: unknown;
  try {
    payload = JSON.parse(decodeHtmlAttribute(encodedPayload));
  } catch {
    throw new Error("BEC listing has invalid position payload");
  }
  if (!isRecord(payload)) {
    throw new Error("BEC listing has invalid position payload");
  }
  assertBecPayloadIdentity(payload);
  const positionList = payload.PositionList;
  if (!isRecord(positionList) || !Array.isArray(positionList.Items)) {
    throw new Error("BEC listing has invalid position list");
  }
  assertBecPayloadIdentity(positionList);
  const items = positionList.Items;
  if (items.length === 0
    || items.length > BEC_MAX_LISTINGS
    || items.length > source.maxJobs
    || positionList.PositionCountCustomer !== items.length
    || positionList.PositionCountSearch !== items.length
    || positionList.PositionCountList !== items.length
    || positionList.PositionCountSkipped !== 0) {
    throw new Error("BEC listing has an invalid entry count");
  }

  const seenIds = new Set<string>();
  const listings = items.map((item) => {
    if (!isRecord(item)) {
      throw new Error("BEC listing contains an invalid entry");
    }
    assertBecPayloadIdentity(item);
    const sourceJobId = String(requirePositiveInteger(item, "Id"));
    const department = item.Department;
    if (!isRecord(department)) {
      throw new Error("BEC listing has invalid Department");
    }
    const departmentId = String(requirePositiveInteger(department, "Id"));
    const identity = parseDetailUrl(requireString(item, "AdvertisementUrl"), source);
    if (identity.sourceJobId !== sourceJobId || identity.departmentId !== departmentId) {
      throw new Error("BEC listing entry identity does not match its URL");
    }
    const title = requireString(item, "Name");
    if (title === "" || title.length > 300) {
      throw new Error("BEC listing contains an invalid title");
    }
    if (seenIds.has(identity.sourceJobId)) {
      throw new Error(`BEC listing contains duplicate job id: ${identity.sourceJobId}`);
    }
    seenIds.add(identity.sourceJobId);
    return { ...identity, title };
  });
  return {
    total: listings.length,
    listings: listings.filter(({ title }) => isPotentialTargetTitle(title)),
  };
}

export function parseBecDetail(
  html: string,
  listing: BecListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const canonical = parseDetailUrl(exactlyOneMatch(
    html,
    /<meta\b[^>]*property="og:url"[^>]*content="([^"]+)"[^>]*>/gi,
    "detail canonical URL",
  )[1], source);
  if (canonical.detailUrl !== listing.detailUrl
    || canonical.sourceJobId !== listing.sourceJobId
    || canonical.departmentId !== listing.departmentId) {
    throw new Error("BEC detail identity does not match its listing");
  }
  const title = htmlToText(exactlyOneMatch(
    html,
    /<meta\b[^>]*property="og:title"[^>]*content="([^"]+)"[^>]*>/gi,
    "detail title",
  )[1]);
  const bodyTitle = htmlToText(exactlyOneMatch(
    html,
    /<div class="ProjectName">([\s\S]*?)<\/div>/g,
    "detail body title",
  )[1]);
  if (normalizeText(title) !== normalizeText(listing.title)
    || normalizeText(bodyTitle) !== normalizeText(listing.title)) {
    throw new Error("BEC detail title does not match its listing");
  }
  if (!/<meta\b[^>]*property="og:site_name"[^>]*content="Talentech"[^>]*>/i.test(html)
    || !/<a href="https:\/\/www\.bec\.dk"[^>]*id="url"[^>]*>https:\/\/www\.bec\.dk<\/a>/i.test(html)
    || !/<a id="more_lang" href="https:\/\/www\.bec\.dk\/en\/vacancies\/"/i.test(html)
    || !new RegExp(`<!-- HRM INFO: ProjectId='${listing.sourceJobId}' -->`).test(html)
    || !new RegExp(`<!-- HRM INFO: DepartmentId='${listing.departmentId}' -->`).test(html)) {
    throw new Error("BEC detail has unexpected attribution");
  }

  const descriptionText = htmlToText(exactlyOneMatch(
    html,
    /<div id="AdvertisementInnerContent">([\s\S]*?)<\/div>\s*<!-- START LayoutTemplate Advertisement Footer -->/g,
    "detail description",
  )[1]);
  if (descriptionText.length < 100 || descriptionText.length > 40_000) {
    throw new Error("BEC detail has invalid description");
  }
  const locationText = parseOptionalLabeledValue(html, "workplacelist_lang");
  if (!locationText) {
    throw new Error("BEC detail has invalid workplace");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText,
    countryCodes: parseCountryCodes(locationText),
    workplaceType: null,
    employmentType: parseOptionalLabeledValue(html, "positiontype_lang"),
    publishedAt: parseTimestamp(exactlyOneMatch(
      html,
      /<meta\b[^>]*property="article:published_time"[^>]*content="([^"]+)"[^>]*>/gi,
      "published timestamp",
    )[1], "published timestamp"),
    updatedAt: parseTimestamp(exactlyOneMatch(
      html,
      /<meta\b[^>]*property="article:modified_time"[^>]*content="([^"]+)"[^>]*>/gi,
      "modified timestamp",
    )[1], "modified timestamp"),
    canonicalUrl: canonical.detailUrl,
    fetchedAt,
  };
}