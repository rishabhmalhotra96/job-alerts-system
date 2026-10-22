import type { NormalizedJob, SourceDefinition } from "./domain.ts";
import { allowedHttpsPath, assertAllowedHttpsUrl, htmlToText } from "./greenhouse.ts";

const MERCEDES_COMPANY = "Mercedes-Benz Tech Innovation";
const MERCEDES_SITE = "MBTI Jobportal";
const EXCLUDED_POSTING_SITES = new Set(["prognum Automotive GmbH"]);

function exactlyOneElement(block: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const matches = [...block.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Mercedes feed ${tag} is missing or ambiguous`);
  }
  const value = htmlToText(matches[0][1]);
  if (value === "") {
    throw new Error(`Mercedes feed ${tag} is empty`);
  }
  return value;
}

function exactlyOneCdataElement(block: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    "g",
  );
  const matches = [...block.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Mercedes feed ${tag} is missing or ambiguous`);
  }
  return matches[0][1];
}

function normalizedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Mercedes feed startDate is invalid");
  }
  return date.toISOString();
}

function parseLocations(block: string): string[] {
  const matches = [...block.matchAll(/<Location(?:\s*\/|>([\s\S]*?)<\/Location)>/g)];
  if (matches.length === 0 || matches.length > 10) {
    throw new Error("Mercedes feed locations are missing or invalid");
  }
  const locations = matches
    .map((match) => htmlToText(match[1] ?? ""))
    .filter((location) => location !== "");
  const uniqueLocations = [...new Set(locations)];
  if (uniqueLocations.length === 0
    || uniqueLocations.length !== locations.length
    || uniqueLocations.some((location) => location.length > 100)) {
    throw new Error("Mercedes feed locations are missing or invalid");
  }
  return uniqueLocations;
}

export function parseMercedesTechFeed(
  xml: string,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  const root = /^(?:<\?xml\b[^?]*\?>\s*)?<Report_Data\b([^>]*)>([\s\S]*)<\/Report_Data>\s*$/.exec(xml);
  if (!root
    || !/\bxmlns:wd="urn:com\.workday\.report\/INT003_DE_O_Open_Positions_202211_Data_Outbound_Custom_Report"/.test(root[1])) {
    throw new Error("Mercedes feed has an invalid document root");
  }

  const entryPattern = /<Report_Entry>([\s\S]*?)<\/Report_Entry>/g;
  const entries = [...root[2].matchAll(entryPattern)].map((match) => match[1]);
  if (entries.length === 0 || entries.length > source.maxJobs
    || root[2].replace(entryPattern, "").trim() !== "") {
    throw new Error("Mercedes feed has an invalid entry count");
  }

  const scopedEntries = entries.filter((entry) => {
    const postingSite = exactlyOneElement(entry, "jobPostingSite");
    if (exactlyOneElement(entry, "Company") !== MERCEDES_COMPANY
      || (postingSite !== MERCEDES_SITE && !EXCLUDED_POSTING_SITES.has(postingSite))) {
      throw new Error("Mercedes feed has an unexpected identity");
    }
    return postingSite === MERCEDES_SITE;
  });
  if (scopedEntries.length === 0) {
    throw new Error("Mercedes feed has no MBTI jobs");
  }

  const seenIds = new Set<string>();
  return scopedEntries.map((entry) => {
    const title = exactlyOneElement(entry, "Title");
    if (title !== exactlyOneElement(entry, "jobPosting") || title.length > 300) {
      throw new Error("Mercedes feed title is invalid or inconsistent");
    }
    const sourceJobId = exactlyOneElement(entry, "jobRequisitionID");
    if (!/^R\d{7}$/.test(sourceJobId) || seenIds.has(sourceJobId)) {
      throw new Error("Mercedes feed has an invalid or duplicate requisition ID");
    }
    seenIds.add(sourceJobId);

    const descriptionHtml = exactlyOneCdataElement(entry, "jobDescription");
    const additionalDescription = htmlToText(
      exactlyOneCdataElement(entry, "jobAdditionalDescription"),
    );
    const requisitionDescription = htmlToText(
      exactlyOneCdataElement(entry, "jobRequisition"),
    );
    const descriptionText = htmlToText(descriptionHtml);
    if (descriptionText.length < 100
      || descriptionText.length > 50_000
      || additionalDescription.length < 20
      || requisitionDescription.length < 20) {
      throw new Error("Mercedes feed has an incomplete description");
    }

    const canonicalUrl = assertAllowedHttpsUrl(
      exactlyOneElement(entry, "URL"),
      source.allowedHosts,
    );
    const escapedId = sourceJobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^/MBTI_JOBPORTAL/job/[A-Za-z0-9%._~/-]+_${escapedId}(?:-\\d+)?$`).test(
      allowedHttpsPath(canonicalUrl, source.allowedHosts),
    )) {
      throw new Error("Mercedes feed canonical URL does not match its requisition ID");
    }
    const externalApplyUrl = assertAllowedHttpsUrl(
      exactlyOneElement(entry, "externalApplyURL"),
      source.allowedHosts,
    );
    if (externalApplyUrl !== `${canonicalUrl}/apply`) {
      throw new Error("Mercedes feed apply URL does not match its canonical URL");
    }

    const locations = parseLocations(entry);
    return {
      sourceKey: source.sourceKey,
      company: source.company,
      sourceJobId,
      title,
      descriptionText,
      descriptionCompleteness: "FULL",
      locationText: `${locations.join(", ")}, Germany`,
      countryCodes: ["DE"],
      workplaceType: locations.includes("Remote - Hybrid") ? "Hybrid" : null,
      employmentType: exactlyOneElement(entry, "targetGroup"),
      publishedAt: normalizedDate(exactlyOneElement(entry, "startDate")),
      updatedAt: null,
      canonicalUrl,
      fetchedAt,
    };
  });
}
