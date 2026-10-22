import { EEA_COUNTRY_CODES, type SourceDefinition } from "./domain.ts";

const TARGET_COMPANY_NAMES = [
  "Booking.com",
  "ASML",
  "Adyen",
  "Uber",
  "Databricks",
  "Miro",
  "Optiver",
  "Picnic",
  "Catawiki",
  "ING",
  "SAP",
  "Amazon",
  "Zalando",
  "Celonis",
  "Mercedes-Benz Tech",
  "GetYourGuide",
  "DeepL",
  "N26",
  "Glovo",
  "Trivago",
  "Bolt",
  "Vinted",
  "ByteDance",
  "Grab",
  "Sea Group / Shopee",
  "Stripe",
  "DBS",
  "NUS",
  "Agoda",
  "Feedzai",
  "Talkdesk",
  "HelloFresh",
  "Black Forest Labs",
  "Aleph Alpha",
  "Razer",
  "Shell",
  "Philips",
  "Wolt",
  "JetBrains",
  "Gen Digital",
  "Supercell",
  "RELEX",
  "BBVA AI Factory",
  "Farfetch",
  "AMD",
  "PatSnap",
  "Boozt",
  "Delivery Hero",
  "Deutsche Boerse",
  "BEC Financial Technology",
  "INESC TEC",
  "Datadog",
  "Apple",
  "Monzo",
  "Rebtel",
  "Adjoe",
  "Mayflower",
  "QuantCo",
  "Amo",
  "Voodoo",
] as const;

export type TargetCompany = typeof TARGET_COMPANY_NAMES[number];

export interface TargetScopeDefinition {
  company: TargetCompany;
  eligibleCountryCodes: readonly string[];
}

const GENERAL_ELIGIBLE_COUNTRY_CODES = [...EEA_COUNTRY_CODES, "SG"] as const;
const DATADOG_EUROPE_COUNTRY_CODES = [
  "AT", "CH", "DE", "DK", "ES", "FR", "GB", "IE", "IT", "NL", "PL", "PT", "SE",
] as const;
const VOODOO_EUROPE_COUNTRY_CODES = [...EEA_COUNTRY_CODES, "GB"] as const;

export const TARGET_SCOPES: readonly TargetScopeDefinition[] = Object.freeze(
  TARGET_COMPANY_NAMES.map((company) => Object.freeze({
    company,
    eligibleCountryCodes: Object.freeze(company === "Razer"
      ? ["SG"]
      : company === "Shell" || company === "Philips"
        ? ["NL"]
      : company === "Wolt" || company === "Supercell" || company === "RELEX" || company === "AMD"
        ? ["FI"]
      : company === "JetBrains" || company === "Gen Digital"
        ? ["CZ"]
      : company === "BBVA AI Factory"
        ? ["ES"]
      : company === "PatSnap"
        ? ["SG"]
      : company === "Boozt"
        ? ["DK"]
      : company === "Delivery Hero"
        ? ["DE"]
      : company === "Deutsche Boerse"
        ? ["LU"]
      : company === "BEC Financial Technology"
        ? ["DK"]
      : company === "Feedzai" || company === "Talkdesk" || company === "Farfetch" || company === "INESC TEC"
      ? ["PT"]
      : company === "Datadog"
        ? [...DATADOG_EUROPE_COUNTRY_CODES]
      : company === "Apple"
        ? ["IN"]
      : company === "Monzo"
        ? ["GB"]
      : company === "Rebtel"
        ? [...EEA_COUNTRY_CODES]
      : company === "Adjoe"
        ? ["DE"]
      : company === "Mayflower"
        ? ["CY"]
      : company === "QuantCo"
        ? ["CH", "DE", "GB"]
      : company === "Amo"
        ? ["FR"]
      : company === "Voodoo"
        ? [...VOODOO_EUROPE_COUNTRY_CODES]
      : company === "HelloFresh" || company === "Black Forest Labs" || company === "Aleph Alpha"
        ? ["DE"]
        : [
          ...GENERAL_ELIGIBLE_COUNTRY_CODES,
          ...(company === "Grab" ? ["MY"] : []),
        ]),
  })),
);

export const TARGET_COMPANIES: readonly TargetCompany[] = Object.freeze(
  TARGET_SCOPES.map(({ company }) => company),
);

export const REQUIRED_TARGET_COUNT: number = TARGET_COMPANIES.length;
export const WAIVED_UNSUPPORTED_TARGETS: readonly TargetCompany[] = Object.freeze([
  "Uber",
  "Miro",
  "SAP",
  "ByteDance",
  "Sea Group / Shopee",
  "Apple",
]);
export const BASELINE_SOURCE_KEYS = Object.freeze([
  "booking-public-json",
  "databricks-greenhouse",
  "celonis-greenhouse",
  "getyourguide-greenhouse",
  "trivago-greenhouse",
  "deepl-ashby",
  "asml-berlin-workday",
  "dbs-workday",
  "adyen-greenhouse",
  "catawiki-greenhouse",
  "n26-greenhouse",
  "stripe-greenhouse",
  "amazon-public-json",
  "sea-public-json",
  "grab-smartrecruiters",
  "grab-malaysia-smartrecruiters",
  "optiver-public-json",
  "glovo-public-json",
  "picnic-public-sitemap",
  "ing-workday",
  "nus-public-sitemap",
  "bolt-public-html",
  "vinted-greenhouse",
  "agoda-greenhouse",
] as const);
export const EXISTING_ASHBY_SOURCE_KEYS = Object.freeze([
  "black-forest-labs-ashby",
  "aleph-alpha-ashby",
  "gen-digital-ashby",
  "supercell-ashby",
] as const);
export const ACTIVE_ROLLOUT_WAVE_ID = "gx15-expansion";

export function getTargetScope(company: string): TargetScopeDefinition | undefined {
  return TARGET_SCOPES.find((scope) => scope.company === company);
}

export function validateSourceTargetScopes(
  sources: readonly SourceDefinition[],
  targetScopes: readonly TargetScopeDefinition[] = TARGET_SCOPES,
): void {
  const scopesByCompany = new Map<string, TargetScopeDefinition>();
  for (const scope of targetScopes) {
    if (scopesByCompany.has(scope.company)) {
      throw new Error(`Target scope contains duplicate company: ${scope.company}`);
    }
    if (scope.eligibleCountryCodes.length === 0
      || new Set(scope.eligibleCountryCodes).size !== scope.eligibleCountryCodes.length
      || scope.eligibleCountryCodes.some((code) => !/^[A-Z]{2}$/.test(code))) {
      throw new Error(`Target scope countries are invalid: ${scope.company}`);
    }
    scopesByCompany.set(scope.company, scope);
  }

  for (const source of sources) {
    const scope = scopesByCompany.get(source.company);
    if (!scope) {
      throw new Error(`Source registry contains unknown company: ${source.company}`);
    }
    const approved = new Set(scope.eligibleCountryCodes);
    if (source.matchingPolicy?.eligibleCountryCodes?.some((code) => !approved.has(code))) {
      throw new Error(`Source matching countries exceed target scope: ${source.sourceKey}`);
    }
  }
}

export function getUnsupportedTargets(
  sources: readonly SourceDefinition[],
  targets: readonly string[] = TARGET_COMPANIES,
): string[] {
  if (new Set(targets).size !== targets.length) {
    throw new Error("Target manifest contains duplicate companies");
  }
  const targetSet = new Set(targets);
  const configured = new Set(sources.map(({ company }) => company));
  const unknownCompanies = [...configured].filter((company) => !targetSet.has(company));
  if (unknownCompanies.length > 0) {
    throw new Error(`Source registry contains unknown companies: ${unknownCompanies.join(",")}`);
  }
  return targets.filter((company) => !configured.has(company));
}

export const MVP_SOURCES: SourceDefinition[] = [
  {
    sourceKey: "booking-public-json",
    company: "Booking.com",
    adapter: "BOOKING",
    endpoint: "https://jobs.booking.com/api/jobs",
    allowedHosts: ["jobs.booking.com"],
    maxJobs: 100,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 16,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
    locationFilters: ["Amsterdam"],
  },
  {
    sourceKey: "databricks-greenhouse",
    company: "Databricks",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/databricks/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "databricks.com"],
    maxJobs: 1_000,
    maxResponseBytes: 1_500_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "celonis-greenhouse",
    company: "Celonis",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/celonis/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 500,
    maxResponseBytes: 1_000_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "getyourguide-greenhouse",
    company: "GetYourGuide",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/getyourguide/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 250,
    maxResponseBytes: 750_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "trivago-greenhouse",
    company: "Trivago",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/trivago/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "careers.trivago.com"],
    maxJobs: 100,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "deepl-ashby",
    company: "DeepL",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/deepl",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 150,
    maxResponseBytes: 1_500_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "black-forest-labs-ashby",
    company: "Black Forest Labs",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/black-forest-labs",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 25,
    maxResponseBytes: 300_000,
    maxDetailJobs: 25,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "aleph-alpha-ashby",
    company: "Aleph Alpha",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/alephalpha",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 50,
    maxResponseBytes: 100_000,
    maxDetailJobs: 50,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "gen-digital-ashby",
    company: "Gen Digital",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/gen-digital",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 150,
    maxResponseBytes: 2_500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["CZ"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "supercell-ashby",
    company: "Supercell",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/supercell",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com", "supercell.com"],
    maxJobs: 50,
    maxResponseBytes: 1_000_000,
    maxDetailJobs: 30,
    maxPages: 1,
    ashbyCanonicalBaseUrl: "https://supercell.com/en/careers",
    matchingPolicy: {
      eligibleCountryCodes: ["FI"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "asml-berlin-workday",
    company: "ASML",
    adapter: "WORKDAY",
    endpoint: "https://asml.wd3.myworkdayjobs.com/wday/cxs/asml/ASMLBERLIN",
    allowedHosts: ["asml.wd3.myworkdayjobs.com"],
    maxJobs: 40,
    maxResponseBytes: 250_000,
    maxDetailJobs: 20,
    maxPages: 2,
    searchTerms: [""],
  },
  {
    sourceKey: "dbs-workday",
    company: "DBS",
    adapter: "WORKDAY",
    endpoint: "https://dbs.wd3.myworkdayjobs.com/wday/cxs/dbs/DBS_Careers",
    allowedHosts: ["dbs.wd3.myworkdayjobs.com"],
    maxJobs: 300,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 20,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
  },
  {
    sourceKey: "adyen-greenhouse",
    company: "Adyen",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/adyen/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 400,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "catawiki-greenhouse",
    company: "Catawiki",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/catawiki/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "n26-greenhouse",
    company: "N26",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/n26/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "n26.com"],
    maxJobs: 150,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "stripe-greenhouse",
    company: "Stripe",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "stripe.com"],
    maxJobs: 1_000,
    maxResponseBytes: 750_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["IE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "amazon-public-json",
    company: "Amazon",
    adapter: "AMAZON",
    endpoint: "https://www.amazon.jobs/en/search.json",
    allowedHosts: ["www.amazon.jobs"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 50,
    maxPages: 20,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "applied scientist",
      "research scientist",
      "ai engineer",
      "research engineer",
    ],
    locationFilters: [
      "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia",
      "Denmark", "Estonia", "Finland", "France", "Germany", "Greece",
      "Hungary", "Ireland", "Iceland", "Italy", "Latvia", "Liechtenstein",
      "Lithuania", "Luxembourg", "Malta", "Netherlands", "Norway", "Poland",
      "Portugal", "Romania", "Singapore", "Slovakia", "Slovenia", "Spain",
      "Sweden",
    ],
    matchingPolicy: {
      eligibleCountryCodes: ["IE", "LU", "ES"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "sea-public-json",
    company: "Sea Group / Shopee",
    adapter: "SEA",
    endpoint: "https://career.sea.com/api/user/job/list",
    allowedHosts: ["career.sea.com"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 8,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
    locationFilters: ["25"],
    matchingPolicy: {
      eligibleCountryCodes: ["SG"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
    operationallyDisabled: true,
  },
  {
    sourceKey: "grab-smartrecruiters",
    company: "Grab",
    adapter: "SMARTRECRUITERS",
    endpoint: "https://api.smartrecruiters.com/v1/companies/Grab/postings",
    allowedHosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"],
    maxJobs: 200,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 2,
    locationFilters: ["sg"],
  },
  {
    sourceKey: "grab-malaysia-smartrecruiters",
    company: "Grab",
    adapter: "SMARTRECRUITERS",
    endpoint: "https://api.smartrecruiters.com/v1/companies/Grab/postings",
    allowedHosts: ["api.smartrecruiters.com", "jobs.smartrecruiters.com"],
    maxJobs: 200,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 2,
    locationFilters: ["my"],
  },
  {
    sourceKey: "optiver-public-json",
    company: "Optiver",
    adapter: "OPTIVER",
    endpoint: "https://www.optiver.com/en/api/v1/jobs",
    allowedHosts: ["www.optiver.com"],
    maxJobs: 48,
    maxResponseBytes: 150_000,
    maxDetailJobs: 20,
    maxPages: 3,
    locationFilters: ["amsterdam"],
    matchingPolicy: {
      eligibleCountryCodes: ["NL"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "glovo-public-json",
    company: "Glovo",
    adapter: "GLOVO",
    endpoint: "https://careers.glovoapp.com/wp-admin/admin-ajax.php",
    allowedHosts: [
      "careers.glovoapp.com",
      "api.smartrecruiters.com",
      "jobs.smartrecruiters.com",
    ],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 12,
    searchTerms: ["data", "engineer", "scientist"],
    locationFilters: [
      "at", "be", "bg", "hr", "cy", "cz", "de", "dk", "ee", "es", "fi",
      "fr", "gr", "hu", "ie", "is", "it", "li", "lt", "lu", "lv", "mt",
      "nl", "no", "pl", "pt", "ro", "se", "si", "sk", "sg",
    ],
    matchingPolicy: {
      eligibleCountryCodes: ["ES"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "picnic-public-sitemap",
    company: "Picnic",
    adapter: "PICNIC",
    endpoint: "https://jobs.picnic.app/sitemap/vacancies.xml",
    allowedHosts: ["jobs.picnic.app"],
    maxJobs: 150,
    maxResponseBytes: 600_000,
    maxDetailJobs: 20,
    maxPages: 1,
    locationFilters: ["netherlands"],
  },
  {
    sourceKey: "ing-workday",
    company: "ING",
    adapter: "WORKDAY",
    endpoint: "https://ing.wd3.myworkdayjobs.com/wday/cxs/ing/ICSGBLCOR",
    allowedHosts: ["ing.wd3.myworkdayjobs.com"],
    maxJobs: 200,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 20,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
  },
  {
    sourceKey: "razer-workday",
    company: "Razer",
    adapter: "WORKDAY",
    endpoint: "https://razer.wd3.myworkdayjobs.com/wday/cxs/razer/Careers",
    allowedHosts: ["razer.wd3.myworkdayjobs.com"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 16,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
    matchingPolicy: {
      eligibleCountryCodes: ["SG"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "shell-workday",
    company: "Shell",
    adapter: "WORKDAY",
    endpoint: "https://shell.wd3.myworkdayjobs.com/wday/cxs/shell/shellcareers",
    allowedHosts: ["shell.wd3.myworkdayjobs.com"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 24,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
    matchingPolicy: {
      eligibleCountryCodes: ["NL"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "philips-workday",
    company: "Philips",
    adapter: "WORKDAY",
    endpoint: "https://philips.wd3.myworkdayjobs.com/wday/cxs/philips/jobs-and-careers",
    allowedHosts: ["philips.wd3.myworkdayjobs.com"],
    maxJobs: 300,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 56,
    searchTerms: [
      "data scientist",
      "machine learning engineer",
      "ml engineer",
      "applied scientist",
      "research scientist",
      "decision scientist",
      "ai engineer",
      "research engineer",
    ],
    matchingPolicy: {
      eligibleCountryCodes: ["NL"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "bbva-ai-factory-workday",
    company: "BBVA AI Factory",
    adapter: "WORKDAY",
    endpoint: "https://bbva.wd3.myworkdayjobs.com/wday/cxs/bbva/BBVA",
    allowedHosts: ["bbva.wd3.myworkdayjobs.com"],
    maxJobs: 100,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 10,
    searchTerms: [""],
    workdayAppliedFacets: {
      locationCountry: ["bd34c524a6a04ae6915f5d96fa086199"],
    },
    workdayRequiredAttributionTerms: ["AI Factory"],
    matchingPolicy: {
      eligibleCountryCodes: ["ES"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "nus-public-sitemap",
    company: "NUS",
    adapter: "NUS",
    endpoint: "https://careers.nus.edu.sg/sitemap.xml",
    allowedHosts: ["careers.nus.edu.sg"],
    maxJobs: 1_200,
    maxResponseBytes: 300_000,
    maxDetailJobs: 20,
    maxPages: 1,
    locationFilters: ["singapore"],
  },
  {
    sourceKey: "bolt-public-html",
    company: "Bolt",
    adapter: "BOLT",
    endpoint: "https://bolt.eu/en/careers/positions/",
    allowedHosts: ["bolt.eu"],
    maxJobs: 300,
    maxResponseBytes: 800_000,
    maxDetailJobs: 20,
    maxPages: 1,
  },
  {
    sourceKey: "vinted-greenhouse",
    company: "Vinted",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/vinteden/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "careers.vinted.com"],
    maxJobs: 300,
    maxResponseBytes: 500_000,
    maxDetailJobs: 40,
    maxPages: 1,
  },
  {
    sourceKey: "agoda-greenhouse",
    company: "Agoda",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/agoda/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 500,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
  },
  {
    sourceKey: "feedzai-greenhouse",
    company: "Feedzai",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/feedzai/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "careers.feedzai.com"],
    maxJobs: 100,
    maxResponseBytes: 100_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["PT"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "talkdesk-greenhouse",
    company: "Talkdesk",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/talkdesk2/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 100,
    maxResponseBytes: 150_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["PT"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "hellofresh-greenhouse",
    company: "HelloFresh",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "careers.hellofresh.com"],
    maxJobs: 500,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "wolt-greenhouse",
    company: "Wolt",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/wolt/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 300,
    maxResponseBytes: 750_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["FI"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "jetbrains-greenhouse",
    company: "JetBrains",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/jetbrains/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.eu.greenhouse.io"],
    maxJobs: 100,
    maxResponseBytes: 150_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["CZ"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "relex-greenhouse",
    company: "RELEX",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/relex/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "www.relexsolutions.com"],
    maxJobs: 100,
    maxResponseBytes: 150_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["FI"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "farfetch-lever",
    company: "Farfetch",
    adapter: "LEVER",
    endpoint: "https://api.lever.co/v0/postings/farfetch?mode=json",
    allowedHosts: ["api.lever.co", "jobs.lever.co"],
    maxJobs: 100,
    maxResponseBytes: 750_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["PT"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "amd-finland-json",
    company: "AMD",
    adapter: "AMD",
    endpoint: "https://careers.amd.com/api/jobs?country=Finland&page=1&sortBy=relevance&descending=false&internal=false",
    allowedHosts: ["careers.amd.com"],
    maxJobs: 10,
    maxResponseBytes: 250_000,
    maxDetailJobs: 10,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["FI"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "patsnap-recruitee",
    company: "PatSnap",
    adapter: "RECRUITEE",
    endpoint: "https://patsnap.recruitee.com/api/offers",
    allowedHosts: ["patsnap.recruitee.com", "careers.patsnap.com"],
    maxJobs: 50,
    maxResponseBytes: 1_000_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["SG"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "boozt-json-feed",
    company: "Boozt",
    adapter: "JSON_FEED",
    endpoint: "https://careers.booztgroup.com/jobs.json",
    allowedHosts: ["careers.booztgroup.com"],
    maxJobs: 25,
    maxResponseBytes: 200_000,
    maxDetailJobs: 25,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DK"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "zalando-public-json",
    company: "Zalando",
    adapter: "ZALANDO",
    endpoint: "https://jobs-api.corptech.zalan.do/workday",
    allowedHosts: ["jobs-api.corptech.zalan.do", "jobs.zalando.com"],
    maxJobs: 250,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 3,
    matchingPolicy: {
      eligibleCountryCodes: [...EEA_COUNTRY_CODES, "SG"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "mercedes-tech-xml",
    company: "Mercedes-Benz Tech",
    adapter: "MERCEDES_TECH",
    endpoint: "https://www.mercedes-benz-techinnovation.com/en/jobs.xml",
    allowedHosts: [
      "www.mercedes-benz-techinnovation.com",
      "mercedesbenztechinnovation.wd3.myworkdayjobs.com",
    ],
    maxJobs: 25,
    maxResponseBytes: 200_000,
    maxDetailJobs: 25,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "delivery-hero-sitemap",
    company: "Delivery Hero",
    adapter: "DELIVERY_HERO",
    endpoint: "https://careers.deliveryhero.com/vacanciessitemap.xml",
    allowedHosts: ["careers.deliveryhero.com"],
    maxJobs: 1_000,
    maxResponseBytes: 250_000,
    maxDetailJobs: 30,
    maxPages: 1,
    locationFilters: ["germany"],
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "deutsche-boerse-sitemap",
    company: "Deutsche Boerse",
    adapter: "DEUTSCHE_BOERSE",
    endpoint: "https://careers.deutsche-boerse.com/sitemap.xml",
    allowedHosts: ["careers.deutsche-boerse.com"],
    maxJobs: 250,
    maxResponseBytes: 200_000,
    maxDetailJobs: 30,
    maxPages: 1,
    locationFilters: ["luxembourg"],
    matchingPolicy: {
      eligibleCountryCodes: ["LU"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "bec-vacancies",
    company: "BEC Financial Technology",
    adapter: "BEC",
    endpoint: "https://candidate.hr-manager.net/vacancies/list.aspx?customer=bec",
    allowedHosts: ["candidate.hr-manager.net"],
    maxJobs: 50,
    maxResponseBytes: 1_000_000,
    maxDetailJobs: 30,
    maxPages: 1,
    locationFilters: ["denmark"],
    matchingPolicy: {
      eligibleCountryCodes: ["DK"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "inesc-tec-opportunities",
    company: "INESC TEC",
    adapter: "INESC_TEC",
    endpoint: "https://www.inesctec.pt/en/opportunities/list?type=open",
    allowedHosts: ["www.inesctec.pt"],
    maxJobs: 50,
    maxResponseBytes: 200_000,
    maxDetailJobs: 30,
    maxPages: 1,
    locationFilters: ["portugal"],
    matchingPolicy: {
      eligibleCountryCodes: ["PT"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "datadog-greenhouse",
    company: "Datadog",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/datadog/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "careers.datadoghq.com"],
    maxJobs: 500,
    maxResponseBytes: 750_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: [...DATADOG_EUROPE_COUNTRY_CODES],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "monzo-greenhouse",
    company: "Monzo",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/monzo/jobs",
    allowedHosts: ["boards-api.greenhouse.io", "job-boards.greenhouse.io"],
    maxJobs: 100,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["GB"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
      requireVisaSponsorship: true,
    },
  },
  {
    sourceKey: "rebtel-json-feed",
    company: "Rebtel",
    adapter: "JSON_FEED",
    endpoint: "https://rebtel.teamtailor.com/jobs.json",
    allowedHosts: ["rebtel.teamtailor.com"],
    maxJobs: 25,
    maxResponseBytes: 150_000,
    maxDetailJobs: 25,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: [...EEA_COUNTRY_CODES],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
      requireVisaSponsorship: true,
    },
  },
  {
    sourceKey: "adjoe-ashby",
    company: "Adjoe",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/adjoe",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 75,
    maxResponseBytes: 1_000_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["DE"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "mayflower-recruitee",
    company: "Mayflower",
    adapter: "RECRUITEE",
    endpoint: "https://mayflower.recruitee.com/api/offers",
    allowedHosts: ["mayflower.recruitee.com"],
    maxJobs: 75,
    maxResponseBytes: 1_500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["CY"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "quantco-lever",
    company: "QuantCo",
    adapter: "LEVER",
    endpoint: "https://api.lever.co/v0/postings/quantco-?mode=json&location=Europe",
    allowedHosts: ["api.lever.co", "jobs.lever.co"],
    maxJobs: 25,
    maxResponseBytes: 250_000,
    maxDetailJobs: 20,
    maxPages: 1,
    leverLocationCountryCodes: {
      Europe: ["CH", "DE", "GB"],
    },
    matchingPolicy: {
      eligibleCountryCodes: ["CH", "DE", "GB"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "amo-ashby",
    company: "Amo",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/amo",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 50,
    maxResponseBytes: 500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: ["FR"],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
  {
    sourceKey: "voodoo-ashby",
    company: "Voodoo",
    adapter: "ASHBY",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/voodoo",
    allowedHosts: ["api.ashbyhq.com", "jobs.ashbyhq.com"],
    maxJobs: 150,
    maxResponseBytes: 1_500_000,
    maxDetailJobs: 30,
    maxPages: 1,
    matchingPolicy: {
      eligibleCountryCodes: [...VOODOO_EUROPE_COUNTRY_CODES],
      requireCompleteDescription: true,
      excludeRequiredNonEnglish: true,
    },
  },
];

validateSourceTargetScopes(MVP_SOURCES);
export const ACTIVE_MVP_SOURCES: readonly SourceDefinition[] = Object.freeze(
  MVP_SOURCES.filter(({ operationallyDisabled }) => operationallyDisabled !== true),
);

const activeCompanies = new Set(ACTIVE_MVP_SOURCES.map(({ company }) => company));
const waivedTargets = new Set<string>(WAIVED_UNSUPPORTED_TARGETS);

export const ACTIVE_TARGET_COMPANIES: readonly TargetCompany[] = Object.freeze(
  TARGET_COMPANIES.filter((company) => activeCompanies.has(company) || waivedTargets.has(company)),
);

export const ACTIVE_REQUIRED_TARGET_COUNT = ACTIVE_TARGET_COMPANIES.length;

if (ACTIVE_MVP_SOURCES.length !== MVP_SOURCES.length - 1
  || MVP_SOURCES.filter(({ operationallyDisabled }) => operationallyDisabled === true).length !== 1
  || getUnsupportedTargets(ACTIVE_MVP_SOURCES, ACTIVE_TARGET_COMPANIES).length
    !== WAIVED_UNSUPPORTED_TARGETS.length) {
  throw new Error("Active rollout target manifest is inconsistent");
}