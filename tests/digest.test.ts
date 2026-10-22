import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DIGEST_HTML_BYTES, renderDigest, type DigestJob } from "../src/digest.ts";

function job(overrides: Partial<DigestJob> = {}): DigestJob {
  return {
    sourceKey: "example",
    sourceJobId: "1",
    title: "Senior Machine Learning Engineer",
    company: "Example",
    location: "Berlin, Germany",
    workplaceType: "Hybrid",
    firstSeenAt: "2026-09-16T09:00:00.000Z",
    matchStatus: "STRONG",
    matchReasons: ["title:machine-learning-engineer", "location:eligible"],
    sponsorshipSignal: "unknown",
    relocationSignal: "yes",
    canonicalUrl: "https://jobs.example.com/1",
    ...overrides,
  };
}

const baseInput = {
  batchId: "notification:shadow:2026-09-16T09:00:00.000Z",
  createdAt: "2026-09-16T09:00:00.000Z",
  sourceWarnings: ["source-a: PARTIAL"],
  reviewSheetUrl: "https://docs.google.com/spreadsheets/d/private_sheet_id/edit",
};

test("renders strong, review, and warning sections in deterministic order", () => {
  const digest = renderDigest({
    ...baseInput,
    jobs: [
      job({ sourceJobId: "review", matchStatus: "REVIEW", company: "Beta" }),
      job({ sourceJobId: "later", company: "Zulu", firstSeenAt: "2026-09-16T10:00:00.000Z" }),
      job({ sourceJobId: "earlier", company: "Alpha" }),
    ],
  });
  assert.equal(digest.overflowed, false);
  assert.match(digest.subject, /^ML\/Data roles - Europe, Singapore & Malaysia - 3 new\/reopened - /);
  assert.ok(digest.htmlBody.indexOf("Strong matches") < digest.htmlBody.indexOf("Review matches"));
  assert.ok(digest.htmlBody.indexOf("Review matches") < digest.htmlBody.indexOf("Source warnings"));
  assert.ok(digest.htmlBody.indexOf("Zulu") < digest.htmlBody.indexOf("Alpha"));
  assert.match(digest.plainTextBody, /Sponsorship: unknown \| Relocation: yes/);
});

test("labels reopened jobs and orders them by latest meaningful activity", () => {
  const digest = renderDigest({
    ...baseInput,
    jobs: [
      job({ sourceJobId: "new", company: "New", firstSeenAt: "2026-09-16T10:00:00.000Z" }),
      job({
        sourceJobId: "reopened",
        company: "Reopened",
        firstSeenAt: "2026-08-01T10:00:00.000Z",
        lastReopenedAt: "2026-09-16T11:00:00.000Z",
        repostCount: 2,
      }),
    ],
  });

  assert.ok(digest.htmlBody.indexOf("Reopened") < digest.htmlBody.indexOf("New"));
  assert.match(digest.htmlBody, /Reopened: 2026-09-16T11:00:00.000Z \(cycle 2\)/);
  assert.match(digest.plainTextBody, /Reopened: 2026-09-16T11:00:00.000Z \(cycle 2\)/);
});

test("labels permit history as historical and informational", () => {
  const rendered = renderDigest({
    ...baseInput,
    jobs: [job({
      matchReasons: ["title:machine-learning-engineer", "permit_history:dete:current_year"],
    })],
  });

  assert.match(rendered.plainTextBody, /historical and informational/);
  assert.match(rendered.htmlBody, /does not guarantee sponsorship or permit approval/);
});

test("escapes every job-controlled HTML field and warning", () => {
  const digest = renderDigest({
    ...baseInput,
    sourceWarnings: ["<script>alert('warning')</script>"],
    jobs: [job({
      title: "<img src=x onerror=alert(1)>",
      company: "A & B",
      location: "<b>Berlin</b>",
      workplaceType: "\"Hybrid\"",
      matchReasons: ["<script>alert(1)</script>"],
      canonicalUrl: "https://jobs.example.com/1?x=\" onclick=\"alert(1)",
    })],
  });
  assert.doesNotMatch(digest.htmlBody, /<script|<img|<b>|onclick="/i);
  assert.match(digest.htmlBody, /&lt;img/);
  assert.match(digest.htmlBody, /A &amp; B/);
  assert.match(digest.htmlBody, /&quot;Hybrid&quot;/);
});

test("uses one bounded private-Sheet summary when UTF-8 HTML exceeds the cap", () => {
  const largeText = "界".repeat(400);
  const jobs = Array.from({ length: 180 }, (_, index) => job({
    sourceJobId: String(index),
    title: `${largeText} ${index}`,
    matchReasons: ["title:machine-learning-engineer", "permit_history:dete:current_year"],
    canonicalUrl: `https://jobs.example.com/${index}`,
  }));
  const digest = renderDigest({ ...baseInput, jobs });
  assert.equal(digest.overflowed, true);
  assert.ok(Buffer.byteLength(digest.htmlBody, "utf8") < MAX_DIGEST_HTML_BYTES);
  assert.match(digest.htmlBody, /docs\.google\.com\/spreadsheets/);
  assert.match(digest.htmlBody, /historical and informational/);
  assert.match(digest.plainTextBody, /does not guarantee sponsorship or permit approval/);
  assert.doesNotMatch(digest.htmlBody, new RegExp(largeText.slice(0, 20)));
});

test("rejects unsafe review links, job URLs, duplicates, and malformed fields", () => {
  assert.throws(
    () => renderDigest({ ...baseInput, reviewSheetUrl: "https://attacker.example", jobs: [job()] }),
    /REVIEW_URL_INVALID/,
  );
  assert.throws(
    () => renderDigest({ ...baseInput, jobs: [job({ canonicalUrl: "javascript:alert(1)" })] }),
    /JOB_URL_INVALID/,
  );
  assert.throws(
    () => renderDigest({ ...baseInput, jobs: [job(), job()] }),
    /JOB_DUPLICATE/,
  );
  assert.throws(
    () => renderDigest({ ...baseInput, jobs: [job({ firstSeenAt: "not-a-date" })] }),
    /FIRST_SEEN_AT_INVALID/,
  );
  assert.throws(
    () => renderDigest({ ...baseInput, jobs: [job({ title: "Safe\nInjected heading" })] }),
    /TITLE_INVALID/,
  );
  assert.throws(
    () => renderDigest({ ...baseInput, jobs: [job({ repostCount: 1 })] }),
    /REPOST_INVALID/,
  );
});