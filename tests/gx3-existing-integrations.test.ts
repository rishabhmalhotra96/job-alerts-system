import assert from "node:assert/strict";
import test from "node:test";

import { parseAmazonSearchPage } from "../src/amazon.ts";
import type { NormalizedJob, SourceDefinition } from "../src/domain.ts";
import { matchJob } from "../src/domain.ts";
import { parseGlovoDetail } from "../src/glovo.ts";
import { parseGreenhouseResponse } from "../src/greenhouse.ts";
import { parseOptiverDetail } from "../src/optiver.ts";
import { parseSeaSearchPage } from "../src/sea.ts";
import { MVP_SOURCES } from "../src/sources.ts";

const FETCHED_AT = "2026-09-23T12:00:00Z";

function source(sourceKey: string): SourceDefinition {
  const value = MVP_SOURCES.find((candidate) => candidate.sourceKey === sourceKey);
  assert.ok(value, `missing source ${sourceKey}`);
  return value;
}

const amazon = source("amazon-public-json");
const sea = source("sea-public-json");
const optiver = source("optiver-public-json");
const stripe = source("stripe-greenhouse");
const glovo = source("glovo-public-json");

function amazonJob(countryCode: "IRL" | "LUX" | "ESP", location: string): NormalizedJob {
  return parseAmazonSearchPage({
    hits: 1,
    jobs: [{
      id: `amazon-${countryCode.toLowerCase()}`,
      title: "Senior Applied Scientist",
      description: "<p>Build machine learning ranking systems.</p>",
      location,
      country_code: countryCode,
      job_path: `/en/jobs/${countryCode.toLowerCase()}/senior-applied-scientist`,
      job_schedule_type: "full-time",
    }],
  }, amazon, FETCHED_AT).jobs[0];
}

function seaJob(): NormalizedJob {
  return parseSeaSearchPage({
    code: 0,
    data: {
      total_count: 1,
      job_list: [{
        id: 134934,
        job_id: "J02160976",
        job_name: "Senior AI Engineer",
        city_id: 25,
        sub_team_description: "<p>Build AI products.</p>",
        job_description: "<p>Deploy machine learning systems.</p>",
        requirements: "<p>Production experience and Python.</p>",
      }],
    },
  }, sea, FETCHED_AT).jobs[0];
}

function optiverJob(): NormalizedJob {
  const listing = {
    sourceJobId: "13705",
    title: "Senior AI Engineer",
    detailPath: "/join-us/jobs/technology/amsterdam/senior-ai-engineer/",
  };
  const detailHtml = `
<script type="application/ld+json">{
  "@context":"https://schema.org",
  "@type":"JobPosting",
  "title":"Senior AI Engineer",
  "url":"https://www.optiver.com/join-us/jobs/technology/amsterdam/senior-ai-engineer/",
  "datePosted":"2026-09-20",
  "hiringOrganization":{"@type":"Organization","name":"Optiver"},
  "jobLocation":{"@type":"Place","name":"Amsterdam"}
}</script>
<script>React.createElement(Components.RichText,{"text":"<p>Build AI agents and machine learning systems.</p>"}));</script>`;
  return parseOptiverDetail(detailHtml, listing, optiver, FETCHED_AT);
}

function stripeJob(): NormalizedJob {
  return parseGreenhouseResponse({
    jobs: [{
      id: 8172508,
      title: "Senior Machine Learning Engineer",
      location: { name: "Dublin, Ireland" },
      absolute_url: "https://stripe.com/jobs/search?gh_jid=8172508",
      content: "<p>Build machine learning ranking systems.</p>",
      metadata: [{ name: "Employment Type", value: "Full-time" }],
    }],
  }, stripe, FETCHED_AT)[0];
}

function glovoJob(active = true): NormalizedJob {
  const listing = {
    sourceJobId: "744000147038484",
    title: "Senior Data Scientist",
    detailUrl: "https://careers.glovoapp.com/job/senior-data-scientist-in-barcelona-spain-jid-744000147038484/",
  };
  return parseGlovoDetail({
    active,
    id: listing.sourceJobId,
    name: listing.title,
    company: { identifier: "DeliveryHero", name: "Delivery Hero" },
    customField: [{ fieldLabel: "Brands", valueId: "Glovo", valueLabel: "Glovo" }],
    releasedDate: "2026-09-20T10:00:00Z",
    postingUrl: "https://jobs.smartrecruiters.com/DeliveryHero/744000147038484-senior-data-scientist",
    location: {
      country: "es",
      fullLocation: "Barcelona, Spain",
      remote: false,
      hybrid: true,
    },
    typeOfEmployment: { id: "permanent", label: "Full-time" },
    jobAd: {
      sections: {
        companyDescription: { text: "<p>About Glovo.</p>" },
        jobDescription: { text: "<p>Build machine learning systems.</p>" },
        qualifications: { text: "<p>Production experience.</p>" },
        additionalInformation: { text: "" },
      },
    },
  }, listing, glovo, FETCHED_AT);
}

test("GX3 sources keep stable identities and exact placement policies", () => {
  assert.deepEqual([stripe, amazon, sea, optiver, glovo].map((value) => ({
    sourceKey: value.sourceKey,
    maxJobs: value.maxJobs,
    maxResponseBytes: value.maxResponseBytes,
    maxDetailJobs: value.maxDetailJobs,
    maxPages: value.maxPages,
  })), [
    { sourceKey: "stripe-greenhouse", maxJobs: 1_000, maxResponseBytes: 750_000, maxDetailJobs: 30, maxPages: 1 },
    { sourceKey: "amazon-public-json", maxJobs: 100, maxResponseBytes: 250_000, maxDetailJobs: 50, maxPages: 20 },
    { sourceKey: "sea-public-json", maxJobs: 100, maxResponseBytes: 250_000, maxDetailJobs: 30, maxPages: 8 },
    { sourceKey: "optiver-public-json", maxJobs: 48, maxResponseBytes: 150_000, maxDetailJobs: 20, maxPages: 3 },
    { sourceKey: "glovo-public-json", maxJobs: 100, maxResponseBytes: 250_000, maxDetailJobs: 30, maxPages: 12 },
  ]);
  assert.deepEqual(stripe.matchingPolicy, {
    eligibleCountryCodes: ["IE"],
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  });
  assert.deepEqual(amazon.matchingPolicy, {
    eligibleCountryCodes: ["IE", "LU", "ES"],
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  });
  assert.deepEqual(sea.matchingPolicy, {
    eligibleCountryCodes: ["SG"],
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  });
  assert.deepEqual(optiver.matchingPolicy, {
    eligibleCountryCodes: ["NL"],
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  });
  assert.deepEqual(glovo.matchingPolicy, {
    eligibleCountryCodes: ["ES"],
    requireCompleteDescription: true,
    excludeRequiredNonEnglish: true,
  });
});

test("GX3 Glovo detail must remain active", () => {
  assert.throws(() => glovoJob(false), /invalid shape/);
});

const placements: Array<{
  name: string;
  source: SourceDefinition;
  job: () => NormalizedJob;
  canonicalUrl: string;
  language: string;
  reason: string;
}> = [
  { name: "Sea Group Singapore", source: sea, job: seaJob, canonicalUrl: "https://career.sea.com/position/J02160976", language: "Mandarin", reason: "language:zh:required" },
  { name: "Optiver Netherlands", source: optiver, job: optiverJob, canonicalUrl: "https://www.optiver.com/join-us/jobs/technology/amsterdam/senior-ai-engineer/", language: "Dutch", reason: "language:nl:required" },
  { name: "Amazon Ireland", source: amazon, job: () => amazonJob("IRL", "IE, Dublin"), canonicalUrl: "https://www.amazon.jobs/en/jobs/irl/senior-applied-scientist", language: "German", reason: "language:de:required" },
  { name: "Amazon Luxembourg", source: amazon, job: () => amazonJob("LUX", "LU, Luxembourg"), canonicalUrl: "https://www.amazon.jobs/en/jobs/lux/senior-applied-scientist", language: "French", reason: "language:fr:required" },
  { name: "Amazon Spain", source: amazon, job: () => amazonJob("ESP", "ES, Madrid"), canonicalUrl: "https://www.amazon.jobs/en/jobs/esp/senior-applied-scientist", language: "Spanish", reason: "language:es:required" },
  { name: "Stripe Ireland", source: stripe, job: stripeJob, canonicalUrl: "https://stripe.com/jobs/search?gh_jid=8172508", language: "German", reason: "language:de:required" },
  { name: "Glovo Spain", source: glovo, job: glovoJob, canonicalUrl: "https://jobs.smartrecruiters.com/DeliveryHero/744000147038484-senior-data-scientist", language: "Spanish", reason: "language:es:required" },
];

for (const placement of placements) {
  test(`GX3 placement: ${placement.name}`, () => {
    const job = placement.job();
    assert.equal(job.descriptionCompleteness, "FULL");
    assert.equal(job.canonicalUrl, placement.canonicalUrl);

    const positive = matchJob(job, placement.source.matchingPolicy);
    assert.notEqual(positive.status, "EXCLUDED");
    assert.equal(positive.reasons.some((reason) => reason.startsWith("language:")), false);
    assert.equal(positive.reasons.includes("location:ineligible-country"), false);

    assert.deepEqual(matchJob({
      ...job,
      locationText: "Berlin, Germany",
      countryCodes: ["DE"],
    }, placement.source.matchingPolicy), {
      status: "EXCLUDED",
      reasons: ["location:ineligible-country"],
    });

    assert.deepEqual(matchJob({
      ...job,
      descriptionText: `${job.descriptionText} Fluent ${placement.language} required.`,
    }, placement.source.matchingPolicy), {
      status: "EXCLUDED",
      reasons: [placement.reason],
    });
  });
}