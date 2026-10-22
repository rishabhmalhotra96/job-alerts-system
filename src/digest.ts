import type { MatchStatus, SupportSignal } from "./domain.ts";

export const MAX_DIGEST_HTML_BYTES = 149_000;
const MAX_DIGEST_JOBS = 1_000;
const MAX_WARNINGS = 100;

export interface DigestJob {
  sourceKey: string;
  sourceJobId: string;
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  firstSeenAt: string;
  lastReopenedAt?: string;
  repostCount?: number;
  matchStatus: Extract<MatchStatus, "STRONG" | "REVIEW">;
  matchReasons: string[];
  sponsorshipSignal: SupportSignal;
  relocationSignal: SupportSignal;
  canonicalUrl: string;
}

export interface DigestInput {
  batchId: string;
  createdAt: string;
  jobs: DigestJob[];
  sourceWarnings: string[];
  reviewSheetUrl: string;
}

export interface RenderedDigest {
  subject: string;
  plainTextBody: string;
  htmlBody: string;
  overflowed: boolean;
  jobCount: number;
}

function assertBoundedText(value: string, field: string, maximum: number): string {
  if (typeof value !== "string"
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`DIGEST_${field}_INVALID`);
  }
  return value;
}

function validateTimestamp(value: string, field: string): string {
  assertBoundedText(value, field, 40);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`DIGEST_${field}_INVALID`);
  }
  return value;
}

function validateReviewSheetUrl(value: string): string {
  assertBoundedText(value, "REVIEW_URL", 500);
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(value)) {
    throw new Error("DIGEST_REVIEW_URL_INVALID");
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function validateJob(job: DigestJob): DigestJob {
  assertBoundedText(job.sourceKey, "SOURCE_KEY", 200);
  assertBoundedText(job.sourceJobId, "SOURCE_JOB_ID", 1_000);
  assertBoundedText(job.title, "TITLE", 1_000);
  assertBoundedText(job.company, "COMPANY", 500);
  assertBoundedText(job.location, "LOCATION", 1_000);
  assertBoundedText(job.workplaceType, "WORKPLACE", 200);
  validateTimestamp(job.firstSeenAt, "FIRST_SEEN_AT");
  const lastReopenedAt = job.lastReopenedAt ?? "";
  const repostCount = job.repostCount ?? 0;
  if ((lastReopenedAt !== "" && !Number.isFinite(Date.parse(lastReopenedAt)))
    || !Number.isSafeInteger(repostCount)
    || repostCount < 0
    || (repostCount === 0) !== (lastReopenedAt === "")) {
    throw new Error("DIGEST_REPOST_INVALID");
  }
  if (!(["STRONG", "REVIEW"] as const).includes(job.matchStatus)) {
    throw new Error("DIGEST_MATCH_STATUS_INVALID");
  }
  if (!Array.isArray(job.matchReasons)
    || job.matchReasons.length === 0
    || job.matchReasons.length > 30) {
    throw new Error("DIGEST_MATCH_REASONS_INVALID");
  }
  job.matchReasons.forEach((reason) => assertBoundedText(reason, "MATCH_REASON", 200));
  if (!(["yes", "unknown", "no"] as const).includes(job.sponsorshipSignal)
    || !(["yes", "unknown", "no"] as const).includes(job.relocationSignal)) {
    throw new Error("DIGEST_MOBILITY_SIGNAL_INVALID");
  }
  assertBoundedText(job.canonicalUrl, "JOB_URL", 2_000);
  if (!job.canonicalUrl.startsWith("https://")) {
    throw new Error("DIGEST_JOB_URL_INVALID");
  }
  return { ...job, lastReopenedAt, repostCount };
}

function compareJobs(left: DigestJob, right: DigestJob): number {
  const leftActivity = left.lastReopenedAt || left.firstSeenAt;
  const rightActivity = right.lastReopenedAt || right.firstSeenAt;
  return rightActivity.localeCompare(leftActivity)
    || left.company.localeCompare(right.company)
    || left.title.localeCompare(right.title)
    || left.sourceKey.localeCompare(right.sourceKey)
    || left.sourceJobId.localeCompare(right.sourceJobId);
}

function htmlJob(job: DigestJob): string {
  const workplace = job.workplaceType || "unknown";
  const repost = job.lastReopenedAt
    ? `Reopened: ${escapeHtml(job.lastReopenedAt)} (cycle ${job.repostCount})<br>`
    : "";
  return [
    "<li>",
    `<p><strong><a href="${escapeHtml(job.canonicalUrl)}">${escapeHtml(job.title)}</a></strong><br>`,
    `${escapeHtml(job.company)} | ${escapeHtml(job.location)} | ${escapeHtml(workplace)}<br>`,
    `First seen: ${escapeHtml(job.firstSeenAt)}<br>`,
    repost,
    `Reasons: ${escapeHtml(job.matchReasons.join(", "))}<br>`,
    `Sponsorship: ${escapeHtml(job.sponsorshipSignal)} | Relocation: ${escapeHtml(job.relocationSignal)}</p>`,
    "</li>",
  ].join("");
}

function plainJob(job: DigestJob): string {
  return [
    `- ${job.title}`,
    `  ${job.company} | ${job.location} | ${job.workplaceType || "unknown"}`,
    `  First seen: ${job.firstSeenAt}`,
    ...(job.lastReopenedAt
      ? [`  Reopened: ${job.lastReopenedAt} (cycle ${job.repostCount})`]
      : []),
    `  Reasons: ${job.matchReasons.join(", ")}`,
    `  Sponsorship: ${job.sponsorshipSignal} | Relocation: ${job.relocationSignal}`,
    `  ${job.canonicalUrl}`,
  ].join("\n");
}

export function renderDigest(input: DigestInput): RenderedDigest {
  const batchId = assertBoundedText(input.batchId, "BATCH_ID", 220);
  if (!batchId.startsWith("notification:")) {
    throw new Error("DIGEST_BATCH_ID_INVALID");
  }
  validateTimestamp(input.createdAt, "CREATED_AT");
  const reviewSheetUrl = validateReviewSheetUrl(input.reviewSheetUrl);
  if (!Array.isArray(input.jobs) || input.jobs.length === 0 || input.jobs.length > MAX_DIGEST_JOBS) {
    throw new Error("DIGEST_JOBS_INVALID");
  }
  const jobs = input.jobs.map(validateJob);
  if (new Set(jobs.map((job) => `${job.sourceKey}\u001f${job.sourceJobId}`)).size !== jobs.length) {
    throw new Error("DIGEST_JOB_DUPLICATE");
  }
  if (!Array.isArray(input.sourceWarnings) || input.sourceWarnings.length > MAX_WARNINGS) {
    throw new Error("DIGEST_WARNINGS_INVALID");
  }
  const warnings = input.sourceWarnings.map((warning) =>
    assertBoundedText(warning, "WARNING", 300));
  const strong = jobs.filter((job) => job.matchStatus === "STRONG").sort(compareJobs);
  const review = jobs.filter((job) => job.matchStatus === "REVIEW").sort(compareJobs);
  const hasPermitHistoryEvidence = jobs.some((job) =>
    job.matchReasons.some((reason) => reason.startsWith("permit_history:")));
  const permitHistoryNote = "Permit-history evidence is historical and informational; it does not guarantee sponsorship or permit approval.";
  const subject = `ML/Data roles - Europe, Singapore & Malaysia - ${jobs.length} new/reopened - ${input.createdAt}`;
  const htmlSections = [
    "<!doctype html><html><body>",
    `<p>Batch ID: <code>${escapeHtml(batchId)}</code></p>`,
    ...(hasPermitHistoryEvidence ? [`<p>${escapeHtml(permitHistoryNote)}</p>`] : []),
    ...(strong.length > 0
      ? [`<h2>Strong matches (${strong.length})</h2><ol>${strong.map(htmlJob).join("")}</ol>`]
      : []),
    ...(review.length > 0
      ? [`<h2>Review matches (${review.length})</h2><ol>${review.map(htmlJob).join("")}</ol>`]
      : []),
    ...(warnings.length > 0
      ? [`<h2>Source warnings</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`]
      : []),
    "</body></html>",
  ];
  const plainSections = [
    `Batch ID: ${batchId}`,
    ...(hasPermitHistoryEvidence ? [permitHistoryNote] : []),
    ...(strong.length > 0 ? [`Strong matches (${strong.length})\n${strong.map(plainJob).join("\n\n")}`] : []),
    ...(review.length > 0 ? [`Review matches (${review.length})\n${review.map(plainJob).join("\n\n")}`] : []),
    ...(warnings.length > 0 ? [`Source warnings\n${warnings.map((warning) => `- ${warning}`).join("\n")}`] : []),
  ];
  const fullHtml = htmlSections.join("");
  if (utf8ByteLength(fullHtml) < MAX_DIGEST_HTML_BYTES) {
    return {
      subject,
      plainTextBody: plainSections.join("\n\n"),
      htmlBody: fullHtml,
      overflowed: false,
      jobCount: jobs.length,
    };
  }
  const overflowPlain = [
    `Batch ID: ${batchId}`,
    `${jobs.length} matching jobs exceeded the bounded email size.`,
    `Strong: ${strong.length} | Review: ${review.length}`,
    ...(hasPermitHistoryEvidence ? [permitHistoryNote] : []),
    `Review the private Jobs sheet: ${reviewSheetUrl}`,
  ].join("\n");
  const overflowHtml = [
    "<!doctype html><html><body>",
    `<p>Batch ID: <code>${escapeHtml(batchId)}</code></p>`,
    `<p>${jobs.length} matching jobs exceeded the bounded email size.</p>`,
    `<p>Strong: ${strong.length} | Review: ${review.length}</p>`,
    ...(hasPermitHistoryEvidence ? [`<p>${escapeHtml(permitHistoryNote)}</p>`] : []),
    `<p><a href="${escapeHtml(reviewSheetUrl)}">Review the private Jobs sheet</a></p>`,
    "</body></html>",
  ].join("");
  if (utf8ByteLength(overflowHtml) >= MAX_DIGEST_HTML_BYTES) {
    throw new Error("DIGEST_OVERFLOW_SUMMARY_TOO_LARGE");
  }
  return {
    subject,
    plainTextBody: overflowPlain,
    htmlBody: overflowHtml,
    overflowed: true,
    jobCount: jobs.length,
  };
}