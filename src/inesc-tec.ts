import {
  isPotentialTargetTitle,
  type NormalizedJob,
  type SourceDefinition,
} from "./domain.ts";
import { assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

export const INESC_TEC_MAX_LISTINGS = 50;

export interface InescTecListing {
  sourceJobId: string;
  title: string;
  employmentType: string;
  qualification: string | null;
  centre: string | null;
  advisor: string;
  applicationDeadline: string;
  detailUrl: string;
}

export interface InescTecListingPage {
  total: number;
  listings: InescTecListing[];
}

const INESC_TEC_DETAIL_URL = /^https:\/\/www\.inesctec\.pt\/en\/opportunities\/([a-z0-9]+(?:-[a-z0-9]+)*)-(AE\d{4}-\d{4})$/;
const MONTHS: Readonly<Record<string, string>> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function exactlyOneMatch(value: string, pattern: RegExp, field: string): RegExpExecArray {
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`INESC TEC ${field} is missing or ambiguous`);
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

function stripHtmlComments(value: string): string {
  let result = "";
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf("<!--", offset);
    const closing = value.indexOf("-->", offset);
    if (closing >= 0 && (opening < 0 || closing < opening)) {
      throw new Error("INESC TEC listing has malformed HTML comments");
    }
    if (opening < 0) {
      return result + value.slice(offset);
    }
    result += value.slice(offset, opening);
    const commentEnd = value.indexOf("-->", opening + 4);
    if (commentEnd < 0) {
      throw new Error("INESC TEC listing has malformed HTML comments");
    }
    offset = commentEnd + 3;
  }
  return result;
}

function parseIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`INESC TEC has invalid ${field}`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`INESC TEC has invalid ${field}`);
  }
  return value;
}

function fetchedDate(fetchedAt: string): string {
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error("INESC TEC has invalid fetch timestamp");
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseEnglishDate(value: string, field: string): string {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value);
  const month = match ? MONTHS[match[2]] : undefined;
  if (!match || !month) {
    throw new Error(`INESC TEC detail has invalid ${field}`);
  }
  return parseIsoDate(`${match[3]}-${month}-${match[1]}`, `detail ${field}`);
}

function parseDetailUrl(encodedUrl: string, source: SourceDefinition): {
  detailUrl: string;
  sourceJobId: string;
} {
  const detailUrl = assertAllowedHttpsUrl(htmlToText(encodedUrl), source.allowedHosts);
  const match = INESC_TEC_DETAIL_URL.exec(detailUrl);
  if (!match) {
    throw new Error("INESC TEC contains an unexpected detail URL");
  }
  return { detailUrl, sourceJobId: match[2] };
}

function parseSection(html: string, label: string, required = true): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...html.matchAll(new RegExp(
    `<h3[^>]*>\\s*${escapedLabel}\\s*<\\/h3>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`,
    "gi",
  ))];
  if (matches.length === 0 && !required) {
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(`INESC TEC detail ${label} is missing or ambiguous`);
  }
  const value = htmlToText(matches[0][1]);
  if (value === "") {
    if (!required) {
      return null;
    }
    throw new Error(`INESC TEC detail ${label} is empty`);
  }
  return value;
}

export function parseInescTecListing(
  html: string,
  source: SourceDefinition,
  fetchedAt: string,
): InescTecListingPage {
  if (!/<title>\s*Opportunities - INESC TEC\s*<\/title>/i.test(html)
    || !/<meta\b[^>]*property="og:site_name"[^>]*content="INESC TEC"[^>]*>/i.test(html)
    || !/<meta\b[^>]*property="og:url"[^>]*content="https:\/\/www\.inesctec\.pt\/en\/opportunities\/list"[^>]*>/i.test(html)) {
    throw new Error("INESC TEC listing has invalid identity");
  }
  const thead = stripHtmlComments(
    exactlyOneMatch(html, /<thead[^>]*>([\s\S]*?)<\/thead>/gi, "listing header")[1],
  );
  const headers = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((match) => htmlToText(match[1]))
    .filter((value) => value !== "");
  if (headers.join("|") !== "Ref|Position|Academic Qualification|Work Area|Centre|Scientific Advisor|Application Deadline") {
    throw new Error("INESC TEC listing has unexpected columns");
  }

  const tbody = exactlyOneMatch(html, /<tbody[^>]*>([\s\S]*?)<\/tbody>/gi, "listing body")[1];
  const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length === 0 || rows.length > INESC_TEC_MAX_LISTINGS || rows.length > source.maxJobs) {
    throw new Error("INESC TEC listing has an invalid entry count");
  }

  const today = fetchedDate(fetchedAt);
  const seenIds = new Set<string>();
  const allListings = rows.map((row) => {
    const rowHtml = stripHtmlComments(row[1]);
    const cells = [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length !== 10) {
      throw new Error("INESC TEC listing row has unexpected columns");
    }
    const cellUrls = cells.map((cell) => exactlyOneMatch(
      cell[1],
      /\bdata-url="([^"]+)"/gi,
      "listing cell URL",
    )[1]);
    const identity = parseDetailUrl(cellUrls[0], source);
    if (cellUrls.some((url) => htmlToText(url) !== identity.detailUrl)) {
      throw new Error("INESC TEC listing row has inconsistent URLs");
    }

    const values = cells.map((cell) => htmlToText(cell[2]));
    const [, sourceJobId, employmentType, qualification, title, centre, advisor, deadlineText, sortOrder, actionText] = values;
    if (sourceJobId !== identity.sourceJobId
      || seenIds.has(sourceJobId)
      || employmentType === ""
      || title === ""
      || advisor === ""
      || !/^[1-9]\d*$/.test(sortOrder)
      || [employmentType, qualification, title, centre, advisor].some((value) => value.length > 300)) {
      throw new Error("INESC TEC listing row has invalid identity or metadata");
    }
    seenIds.add(sourceJobId);

    const deadlineMatch = /^(\d{4}-\d{2}-\d{2}) (Apply now|\[Open soon\])$/.exec(deadlineText);
    if (!deadlineMatch || actionText !== `view details ${deadlineMatch[2]}`) {
      throw new Error("INESC TEC listing row has invalid lifecycle");
    }
    const applicationDeadline = parseIsoDate(deadlineMatch[1], "application deadline");
    const actionLinks = [...cells[9][2].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/gi)]
      .map((match) => parseDetailUrl(match[1], source).detailUrl);
    const expectedActionLinks = deadlineMatch[2] === "Apply now" ? 2 : 1;
    if (actionLinks.length !== expectedActionLinks
      || actionLinks.some((url) => url !== identity.detailUrl)) {
      throw new Error("INESC TEC listing row has invalid action links");
    }

    return {
      listing: {
        sourceJobId,
        title,
        employmentType,
        qualification: qualification === "" ? null : qualification,
        centre: centre === "" ? null : centre,
        advisor,
        applicationDeadline,
        detailUrl: identity.detailUrl,
      },
      isActive: deadlineMatch[2] === "Apply now" && applicationDeadline >= today,
    };
  });

  return {
    total: allListings.length,
    listings: allListings
      .filter(({ listing, isActive }) => isActive && isPotentialTargetTitle(listing.title))
      .map(({ listing }) => listing),
  };
}

export function parseInescTecDetail(
  html: string,
  listing: InescTecListing,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob {
  const canonical = parseDetailUrl(exactlyOneMatch(
    html,
    /<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"[^>]*>/gi,
    "detail canonical URL",
  )[1], source);
  const openGraphUrl = parseDetailUrl(exactlyOneMatch(
    html,
    /<meta\b[^>]*property="og:url"[^>]*content="([^"]+)"[^>]*>/gi,
    "detail Open Graph URL",
  )[1], source);
  if (canonical.detailUrl !== listing.detailUrl
    || openGraphUrl.detailUrl !== listing.detailUrl
    || canonical.sourceJobId !== listing.sourceJobId
    || openGraphUrl.sourceJobId !== listing.sourceJobId) {
    throw new Error("INESC TEC detail identity does not match its listing");
  }
  if (!/<meta\b[^>]*property="og:site_name"[^>]*content="INESC TEC"[^>]*>/i.test(html)) {
    throw new Error("INESC TEC detail has unexpected attribution");
  }

  const title = htmlToText(exactlyOneMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, "detail title")[1]);
  const pageTitle = htmlToText(exactlyOneMatch(html, /<title>([\s\S]*?)<\/title>/gi, "page title")[1]);
  if (normalizeText(title) !== normalizeText(listing.title)
    || normalizeText(pageTitle) !== normalizeText(`${listing.title} - INESC TEC`)) {
    throw new Error("INESC TEC detail title does not match its listing");
  }

  const formalCall = exactlyOneMatch(
    html,
    /href="(https:\/\/www\.inesctec\.pt\/editais\/en\/(AE\d{4}-\d{4})\.pdf)"/gi,
    "formal call",
  );
  assertAllowedHttpsUrl(formalCall[1], source.allowedHosts);
  if (formalCall[2] !== listing.sourceJobId) {
    throw new Error("INESC TEC detail formal call does not match its listing");
  }

  const workDescription = parseSection(html, "Work description")!;
  const qualifications = parseSection(html, "Academic Qualifications")!;
  const minimumProfile = parseSection(html, "Minimum profile required")!;
  const preferenceFactors = parseSection(html, "Preference factors", false);
  const centre = parseSection(html, "Centre", listing.centre !== null);
  const advisor = parseSection(html, "Scientific Advisor")!;
  if ((listing.centre !== null && normalizeText(centre!) !== normalizeText(listing.centre))
    || normalizeText(advisor) !== normalizeText(listing.advisor)) {
    throw new Error("INESC TEC detail metadata does not match its listing");
  }

  const period = parseSection(html, "Application Period")!;
  const periodMatch = /^Since (\d{2} [A-Z][a-z]{2} \d{4}) to (\d{2} [A-Z][a-z]{2} \d{4})$/.exec(period);
  if (!periodMatch) {
    throw new Error("INESC TEC detail has invalid application period");
  }
  const startsOn = parseEnglishDate(periodMatch[1], "application start");
  const endsOn = parseEnglishDate(periodMatch[2], "application end");
  const today = fetchedDate(fetchedAt);
  if (endsOn !== listing.applicationDeadline || startsOn > endsOn || today < startsOn || today > endsOn) {
    throw new Error("INESC TEC detail is outside its application period");
  }

  const descriptionText = [
    `Work description: ${workDescription}`,
    `Academic qualifications: ${qualifications}`,
    `Minimum profile required: ${minimumProfile}`,
    ...(preferenceFactors ? [`Preference factors: ${preferenceFactors}`] : []),
  ].join("\n");
  if (descriptionText.length < 100 || descriptionText.length > 40_000) {
    throw new Error("INESC TEC detail has invalid description");
  }

  return {
    sourceKey: source.sourceKey,
    company: source.company,
    sourceJobId: listing.sourceJobId,
    title,
    descriptionText,
    descriptionCompleteness: "FULL",
    locationText: "INESC TEC, Porto, Portugal",
    countryCodes: ["PT"],
    workplaceType: null,
    employmentType: listing.employmentType,
    publishedAt: null,
    updatedAt: null,
    canonicalUrl: canonical.detailUrl,
    fetchedAt,
  };
}