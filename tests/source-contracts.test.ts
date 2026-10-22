import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AdapterType } from "../src/domain.ts";
import { MVP_SOURCES } from "../src/sources.ts";

interface SourceContract {
  sourceKey: string;
  company: string;
  adapter: AdapterType;
  endpoint: string;
  allowedHosts: string[];
}

const contracts: SourceContract[] = [
  { sourceKey: "booking-public-json", company: "Booking.com", adapter: "BOOKING", endpoint: "https://jobs.booking.com/api/jobs", allowedHosts: ["jobs.booking.com"] },
  { sourceKey: "databricks-greenhouse", company: "Databricks", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/databricks/jobs", allowedHosts: ["boards-api.greenhouse.io", "databricks.com"] },
  { sourceKey: "celonis-greenhouse", company: "Celonis", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/celonis/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "getyourguide-greenhouse", company: "GetYourGuide", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/getyourguide/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "trivago-greenhouse", company: "Trivago", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/trivago/jobs", allowedHosts: ["boards-api.greenhouse.io", "careers.trivago.com"] },
  { sourceKey: "deepl-ashby", company: "DeepL", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/deepl", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "black-forest-labs-ashby", company: "Black Forest Labs", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/black-forest-labs", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "aleph-alpha-ashby", company: "Aleph Alpha", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/alephalpha", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "gen-digital-ashby", company: "Gen Digital", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/gen-digital", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "supercell-ashby", company: "Supercell", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/supercell", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com", "supercell.com"] },
  { sourceKey: "asml-berlin-workday", company: "ASML", adapter: "WORKDAY", endpoint: "https://asml.wd3.myworkdayjobs.com/wday/cxs/asml/ASMLBERLIN", allowedHosts: ["asml.wd3.myworkdayjobs.com"] },
  { sourceKey: "dbs-workday", company: "DBS", adapter: "WORKDAY", endpoint: "https://dbs.wd3.myworkdayjobs.com/wday/cxs/dbs/DBS_Careers", allowedHosts: ["dbs.wd3.myworkdayjobs.com"] },
  { sourceKey: "adyen-greenhouse", company: "Adyen", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/adyen/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "catawiki-greenhouse", company: "Catawiki", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/catawiki/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "n26-greenhouse", company: "N26", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/n26/jobs", allowedHosts: ["boards-api.greenhouse.io", "n26.com"] },
  { sourceKey: "stripe-greenhouse", company: "Stripe", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs", allowedHosts: ["boards-api.greenhouse.io", "stripe.com"] },
  { sourceKey: "amazon-public-json", company: "Amazon", adapter: "AMAZON", endpoint: "https://www.amazon.jobs/en/search.json", allowedHosts: ["www.amazon.jobs"] },
  { sourceKey: "sea-public-json", company: "Sea Group / Shopee", adapter: "SEA", endpoint: "https://career.sea.com/api/user/job/list", allowedHosts: ["career.sea.com"] },
  { sourceKey: "grab-smartrecruiters", company: "Grab", adapter: "SMARTRECRUITERS", endpoint: "https://api.smartrecruiters.com/v1/companies/Grab/postings", allowedHosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"] },
  { sourceKey: "grab-malaysia-smartrecruiters", company: "Grab", adapter: "SMARTRECRUITERS", endpoint: "https://api.smartrecruiters.com/v1/companies/Grab/postings", allowedHosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"] },
  { sourceKey: "optiver-public-json", company: "Optiver", adapter: "OPTIVER", endpoint: "https://www.optiver.com/en/api/v1/jobs", allowedHosts: ["www.optiver.com"] },
  { sourceKey: "glovo-public-json", company: "Glovo", adapter: "GLOVO", endpoint: "https://careers.glovoapp.com/wp-admin/admin-ajax.php", allowedHosts: ["careers.glovoapp.com", "api.smartrecruiters.com", "jobs.smartrecruiters.com"] },
  { sourceKey: "picnic-public-sitemap", company: "Picnic", adapter: "PICNIC", endpoint: "https://jobs.picnic.app/sitemap/vacancies.xml", allowedHosts: ["jobs.picnic.app"] },
  { sourceKey: "ing-workday", company: "ING", adapter: "WORKDAY", endpoint: "https://ing.wd3.myworkdayjobs.com/wday/cxs/ing/ICSGBLCOR", allowedHosts: ["ing.wd3.myworkdayjobs.com"] },
  { sourceKey: "razer-workday", company: "Razer", adapter: "WORKDAY", endpoint: "https://razer.wd3.myworkdayjobs.com/wday/cxs/razer/Careers", allowedHosts: ["razer.wd3.myworkdayjobs.com"] },
  { sourceKey: "shell-workday", company: "Shell", adapter: "WORKDAY", endpoint: "https://shell.wd3.myworkdayjobs.com/wday/cxs/shell/shellcareers", allowedHosts: ["shell.wd3.myworkdayjobs.com"] },
  { sourceKey: "philips-workday", company: "Philips", adapter: "WORKDAY", endpoint: "https://philips.wd3.myworkdayjobs.com/wday/cxs/philips/jobs-and-careers", allowedHosts: ["philips.wd3.myworkdayjobs.com"] },
  { sourceKey: "bbva-ai-factory-workday", company: "BBVA AI Factory", adapter: "WORKDAY", endpoint: "https://bbva.wd3.myworkdayjobs.com/wday/cxs/bbva/BBVA", allowedHosts: ["bbva.wd3.myworkdayjobs.com"] },
  { sourceKey: "nus-public-sitemap", company: "NUS", adapter: "NUS", endpoint: "https://careers.nus.edu.sg/sitemap.xml", allowedHosts: ["careers.nus.edu.sg"] },
  { sourceKey: "bolt-public-html", company: "Bolt", adapter: "BOLT", endpoint: "https://bolt.eu/en/careers/positions/", allowedHosts: ["bolt.eu"] },
  { sourceKey: "vinted-greenhouse", company: "Vinted", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/vinteden/jobs", allowedHosts: ["boards-api.greenhouse.io", "careers.vinted.com"] },
  { sourceKey: "agoda-greenhouse", company: "Agoda", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/agoda/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "feedzai-greenhouse", company: "Feedzai", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/feedzai/jobs", allowedHosts: ["boards-api.greenhouse.io", "careers.feedzai.com"] },
  { sourceKey: "talkdesk-greenhouse", company: "Talkdesk", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/talkdesk2/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "hellofresh-greenhouse", company: "HelloFresh", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs", allowedHosts: ["boards-api.greenhouse.io", "careers.hellofresh.com"] },
  { sourceKey: "wolt-greenhouse", company: "Wolt", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/wolt/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "jetbrains-greenhouse", company: "JetBrains", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/jetbrains/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.eu.greenhouse.io"] },
  { sourceKey: "relex-greenhouse", company: "RELEX", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/relex/jobs", allowedHosts: ["boards-api.greenhouse.io", "www.relexsolutions.com"] },
  { sourceKey: "farfetch-lever", company: "Farfetch", adapter: "LEVER", endpoint: "https://api.lever.co/v0/postings/farfetch?mode=json", allowedHosts: ["api.lever.co", "jobs.lever.co"] },
  { sourceKey: "amd-finland-json", company: "AMD", adapter: "AMD", endpoint: "https://careers.amd.com/api/jobs?country=Finland&page=1&sortBy=relevance&descending=false&internal=false", allowedHosts: ["careers.amd.com"] },
  { sourceKey: "patsnap-recruitee", company: "PatSnap", adapter: "RECRUITEE", endpoint: "https://patsnap.recruitee.com/api/offers", allowedHosts: ["patsnap.recruitee.com", "careers.patsnap.com"] },
  { sourceKey: "boozt-json-feed", company: "Boozt", adapter: "JSON_FEED", endpoint: "https://careers.booztgroup.com/jobs.json", allowedHosts: ["careers.booztgroup.com"] },
  { sourceKey: "zalando-public-json", company: "Zalando", adapter: "ZALANDO", endpoint: "https://jobs-api.corptech.zalan.do/workday", allowedHosts: ["jobs-api.corptech.zalan.do", "jobs.zalando.com"] },
  { sourceKey: "mercedes-tech-xml", company: "Mercedes-Benz Tech", adapter: "MERCEDES_TECH", endpoint: "https://www.mercedes-benz-techinnovation.com/en/jobs.xml", allowedHosts: ["www.mercedes-benz-techinnovation.com", "mercedesbenztechinnovation.wd3.myworkdayjobs.com"] },
  { sourceKey: "delivery-hero-sitemap", company: "Delivery Hero", adapter: "DELIVERY_HERO", endpoint: "https://careers.deliveryhero.com/vacanciessitemap.xml", allowedHosts: ["careers.deliveryhero.com"] },
  { sourceKey: "deutsche-boerse-sitemap", company: "Deutsche Boerse", adapter: "DEUTSCHE_BOERSE", endpoint: "https://careers.deutsche-boerse.com/sitemap.xml", allowedHosts: ["careers.deutsche-boerse.com"] },
  { sourceKey: "bec-vacancies", company: "BEC Financial Technology", adapter: "BEC", endpoint: "https://candidate.hr-manager.net/vacancies/list.aspx?customer=bec", allowedHosts: ["candidate.hr-manager.net"] },
  { sourceKey: "inesc-tec-opportunities", company: "INESC TEC", adapter: "INESC_TEC", endpoint: "https://www.inesctec.pt/en/opportunities/list?type=open", allowedHosts: ["www.inesctec.pt"] },
  { sourceKey: "datadog-greenhouse", company: "Datadog", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/datadog/jobs", allowedHosts: ["boards-api.greenhouse.io", "careers.datadoghq.com"] },
  { sourceKey: "monzo-greenhouse", company: "Monzo", adapter: "GREENHOUSE", endpoint: "https://boards-api.greenhouse.io/v1/boards/monzo/jobs", allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"] },
  { sourceKey: "rebtel-json-feed", company: "Rebtel", adapter: "JSON_FEED", endpoint: "https://rebtel.teamtailor.com/jobs.json", allowedHosts: ["rebtel.teamtailor.com"] },
  { sourceKey: "adjoe-ashby", company: "Adjoe", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/adjoe", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "mayflower-recruitee", company: "Mayflower", adapter: "RECRUITEE", endpoint: "https://mayflower.recruitee.com/api/offers", allowedHosts: ["mayflower.recruitee.com"] },
  { sourceKey: "quantco-lever", company: "QuantCo", adapter: "LEVER", endpoint: "https://api.lever.co/v0/postings/quantco-?mode=json&location=Europe", allowedHosts: ["api.lever.co", "jobs.lever.co"] },
  { sourceKey: "amo-ashby", company: "Amo", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/amo", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
  { sourceKey: "voodoo-ashby", company: "Voodoo", adapter: "ASHBY", endpoint: "https://api.ashbyhq.com/posting-api/job-board/voodoo", allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"] },
];

assert.equal(MVP_SOURCES.length, contracts.length);

test("ASML Workday capacity covers a second page", () => {
  const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "asml-berlin-workday");
  assert.ok(source);
  assert.equal(source.maxJobs, 40);
  assert.equal(source.maxPages, 2);
});

test("Vinted detail capacity covers the observed target-title inventory", () => {
  const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "vinted-greenhouse");
  assert.ok(source);
  assert.equal(source.maxDetailJobs, 40);
});

test("Mercedes feed capacity covers the verified inventory without widening its row cap", () => {
  const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "mercedes-tech-xml");
  assert.ok(source);
  assert.equal(source.maxJobs, 25);
  assert.equal(source.maxResponseBytes, 200_000);
});

test("Boozt feed capacity covers the verified inventory without widening its row cap", () => {
  const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "boozt-json-feed");
  assert.ok(source);
  assert.equal(source.maxJobs, 25);
  assert.equal(source.maxResponseBytes, 200_000);
});

test("BEC listing capacity covers the verified Talentech page without widening its row cap", () => {
  const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === "bec-vacancies");
  assert.ok(source);
  assert.equal(source.maxJobs, 50);
  assert.equal(source.maxResponseBytes, 1_000_000);
});

for (const contract of contracts) {
  test(`source contract: ${contract.company} (${contract.sourceKey})`, () => {
    const source = MVP_SOURCES.find(({ sourceKey }) => sourceKey === contract.sourceKey);
    assert.ok(source, `missing source ${contract.sourceKey}`);
    assert.deepEqual({
      sourceKey: source.sourceKey,
      company: source.company,
      adapter: source.adapter,
      endpoint: source.endpoint,
      allowedHosts: source.allowedHosts,
    }, contract);
    const endpoint = new URL(source.endpoint);
    assert.equal(endpoint.protocol, "https:");
    assert.equal(endpoint.username, "");
    assert.equal(endpoint.password, "");
    assert.equal(endpoint.port, "");
    assert.equal(source.allowedHosts.includes(endpoint.hostname), true);
    assert.equal(Number.isSafeInteger(source.maxJobs) && source.maxJobs > 0, true);
    assert.equal(Number.isSafeInteger(source.maxResponseBytes) && source.maxResponseBytes > 0, true);
    assert.equal(Number.isSafeInteger(source.maxDetailJobs) && source.maxDetailJobs > 0, true);
    assert.equal(Number.isSafeInteger(source.maxPages) && source.maxPages > 0, true);
  });
}

test("every active adapter type has a nonempty sanitized response fixture", async () => {
  const fixtures: Record<AdapterType, string> = {
    GREENHOUSE: "greenhouse.json",
    ASHBY: "ashby.json",
    LEVER: "lever.json",
    RECRUITEE: "recruitee.json",
    JSON_FEED: "json-feed.json",
    AMD: "amd.json",
    WORKDAY: "workday-listing.json",
    AMAZON: "amazon-search.json",
    BOOKING: "booking-search.json",
    SEA: "sea-search.json",
    SMARTRECRUITERS: "smartrecruiters-listing.json",
    OPTIVER: "optiver-listing.json",
    GLOVO: "glovo-listing.json",
    PICNIC: "picnic-sitemap.xml",
    NUS: "nus-sitemap.xml",
    DELIVERY_HERO: "delivery-hero-sitemap.xml",
    DEUTSCHE_BOERSE: "deutsche-boerse-sitemap.xml",
    BEC: "bec-listing.html",
    INESC_TEC: "inesc-tec-listing.html",
    ZALANDO: "zalando-listing.json",
    MERCEDES_TECH: "mercedes-tech.xml",
    BOLT: "bolt-listing.html",
  };
  const activeAdapters = new Set(MVP_SOURCES.map(({ adapter }) => adapter));
  assert.deepEqual(new Set(Object.keys(fixtures)), activeAdapters);
  for (const adapter of activeAdapters) {
    const content = await readFile(new URL(`./fixtures/${fixtures[adapter]}`, import.meta.url), "utf8");
    assert.equal(content.trim().length > 0, true, `${adapter} fixture is empty`);
  }
});
