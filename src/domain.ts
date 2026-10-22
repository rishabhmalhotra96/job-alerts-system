export type AdapterType =
  | "GREENHOUSE"
  | "ASHBY"
  | "LEVER"
  | "RECRUITEE"
  | "JSON_FEED"
  | "AMD"
  | "WORKDAY"
  | "AMAZON"
  | "SEA"
  | "SMARTRECRUITERS"
  | "OPTIVER"
  | "BOOKING"
  | "GLOVO"
  | "PICNIC"
  | "NUS"
  | "DELIVERY_HERO"
  | "DEUTSCHE_BOERSE"
  | "BEC"
  | "INESC_TEC"
  | "ZALANDO"
  | "MERCEDES_TECH"
  | "BOLT";

export interface SourceDefinition {
  sourceKey: string;
  company: string;
  adapter: AdapterType;
  endpoint: string;
  allowedHosts: string[];
  maxJobs: number;
  maxResponseBytes: number;
  maxDetailJobs: number;
  maxPages: number;
  searchTerms?: string[];
  locationFilters?: string[];
  ashbyCanonicalBaseUrl?: string;
  leverLocationCountryCodes?: Readonly<Record<string, readonly string[]>>;
  workdayAppliedFacets?: Readonly<Record<string, readonly string[]>>;
  workdayRequiredAttributionTerms?: readonly string[];
  matchingPolicy?: SourceMatchingPolicy;
  operationallyDisabled?: true;
}

export interface NormalizedJob {
  sourceKey: string;
  company: string;
  sourceJobId: string;
  title: string;
  descriptionText: string;
  descriptionCompleteness: DescriptionCompleteness;
  locationText: string;
  countryCodes: string[];
  workplaceType: string | null;
  employmentType: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  canonicalUrl: string;
  fetchedAt: string;
}

export type DescriptionCompleteness = "FULL" | "TEASER" | "UNKNOWN";

export type MatchStatus = "STRONG" | "REVIEW" | "EXCLUDED";

export interface MatchDecision {
  status: MatchStatus;
  reasons: string[];
}

export type LocationMatchMode = "REQUIRE_ELIGIBLE" | "IGNORE";

export interface SourceMatchingPolicy {
  eligibleCountryCodes?: readonly string[];
  locationMode?: LocationMatchMode;
  requireCompleteDescription?: boolean;
  excludeRequiredNonEnglish?: boolean;
  requireVisaSponsorship?: boolean;
}

export type LanguageRequirementStatus =
  | "CLEAR"
  | "NON_ENGLISH_REQUIRED"
  | "AMBIGUOUS";

export interface LanguageRequirementDecision {
  status: LanguageRequirementStatus;
  reason: string | null;
}

export type SupportSignal = "yes" | "unknown" | "no";

export interface MobilitySignals {
  sponsorship: SupportSignal;
  relocation: SupportSignal;
}

export const EEA_COUNTRY_CODES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT",
  "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

const EEA_COUNTRY_CODE_SET = new Set<string>(EEA_COUNTRY_CODES);

const ELIGIBLE_LOCATION_TERMS = [
  "amsterdam", "berlin", "dublin", "eindhoven", "helsinki", "lisbon",
  "madrid", "munich", "oslo", "paris", "prague", "singapore", "stockholm",
  "vienna", "warsaw", "netherlands", "germany", "ireland", "finland",
  "portugal", "spain", "france", "czechia", "czech republic", "norway",
  "sweden", "austria", "poland", "belgium", "bulgaria", "croatia",
  "cyprus", "denmark", "estonia", "greece", "hungary", "iceland",
  "italy", "latvia", "liechtenstein", "lithuania", "luxembourg", "malta",
  "romania", "slovakia", "slovenia",
];

const INELIGIBLE_LOCATION_TERMS = [
  "united states", "usa", "san francisco", "new york", "seattle", "chicago",
  "canada", "toronto", "united kingdom", "uk", "london", "switzerland",
  "zurich", "geneva",
];

const POLICY_COUNTRY_LOCATION_TERMS: Readonly<Record<string, readonly string[]>> = {
  AT: ["austria", "vienna"],
  CA: ["canada", "toronto"],
  CH: ["switzerland", "zurich", "geneva"],
  CZ: ["czechia", "czech republic", "prague"],
  DE: ["germany", "berlin", "munich"],
  DK: ["denmark", "copenhagen"],
  ES: ["spain", "barcelona", "madrid"],
  FI: ["finland", "helsinki"],
  FR: ["france", "paris"],
  GB: ["united kingdom", "uk", "england", "london"],
  IE: ["ireland", "dublin"],
  IT: ["italy"],
  LU: ["luxembourg"],
  NL: ["netherlands", "amsterdam", "eindhoven"],
  PL: ["poland", "warsaw"],
  PT: ["portugal", "lisbon", "porto"],
  SE: ["sweden", "stockholm"],
  SG: ["singapore"],
  US: ["united states", "usa", "new york", "san francisco", "seattle", "chicago"],
};

const TITLE_EXCLUSIONS = [
  "intern", "internship", "working student", "graduate", "junior",
  "data analyst", "bi", "business intelligence", "analytics engineer", "data engineer",
  "quantitative analyst", "staff", "principal", "lead", "manager", "head",
  "director", "chief", "vice president", "vp",
];

const TARGET_TITLES = [
  "data scientist", "machine learning engineer", "ml engineer",
  "applied scientist", "research scientist", "decision scientist",
  "ai engineer", "ai agent engineer", "research engineer",
  "software engineer ai", "ai software engineer",
];

const STRONG_SIGNALS = [
  "data science", "data scientist", "machine learning", "deep learning", "recommendation", "recommender",
  "ranking", "forecasting", "natural language processing", "nlp", "llm",
  "ai agent", "ai agents", "ai-powered", "personalization", "experimentation", "causal inference",
];

const WEAK_SIGNALS = ["search", "optimization"];
const SENIORITY_SIGNALS = ["mid level", "mid-level", "intermediate", "senior", "sr"];

const SPONSORSHIP_YES_PATTERNS = [
  /\b(?:visa|work permit) sponsorship (?:is )?(?:available|offered|provided)\b/i,
  /\b(?:we|the company) (?:can|will) sponsor\b/i,
  /\bsponsorship available\b/i,
];
const SPONSORSHIP_NO_PATTERNS = [
  /\b(?:visa|work permit) sponsorship (?:is )?not (?:available|offered|provided)\b/i,
  /\b(?:we|the company) (?:cannot|can't|will not|won't) sponsor\b/i,
  /\bno (?:visa|work permit) sponsorship\b/i,
  /\bmust (?:already )?(?:have|hold) (?:the )?(?:right|authorization) to work\b/i,
];
const RELOCATION_YES_PATTERNS = [
  /\brelocation (?:assistance|support|package) (?:is )?(?:available|offered|provided)\b/i,
  /\b(?:we|the company) (?:can|will) (?:assist|help|support) (?:you )?with relocation\b/i,
];
const RELOCATION_NO_PATTERNS = [
  /\bno relocation (?:assistance|support|package)\b/i,
  /\brelocation (?:assistance|support|package) (?:is )?not (?:available|offered|provided)\b/i,
  /\b(?:we|the company) (?:cannot|can't|will not|won't) (?:assist|help|support) (?:you )?with relocation\b/i,
];

const NON_ENGLISH_LANGUAGES = [
  ["ar", "arabic"],
  ["cs", "czech"],
  ["da", "danish"],
  ["de", "german"],
  ["es", "spanish"],
  ["fi", "finnish"],
  ["fr", "french"],
  ["it", "italian"],
  ["ja", "japanese"],
  ["ko", "korean"],
  ["lt", "lithuanian"],
  ["lv", "latvian"],
  ["ms", "malay"],
  ["nl", "dutch"],
  ["no", "norwegian"],
  ["pl", "polish"],
  ["pt", "portuguese"],
  ["sv", "swedish"],
  ["zh", "mandarin"],
  ["zh", "chinese"],
] as const;

const MANDATORY_LANGUAGE_PATTERNS = [
  "fluent", "fluency", "proficient", "proficiency", "business level",
  "professional level", "working proficiency", "native", "c1", "c2",
  "required", "mandatory", "must speak", "must write", "must know",
  "command of",
];

const OPTIONAL_LANGUAGE_PATTERNS = [
  "preferred", "a plus", "plus", "nice to have", "advantage", "beneficial",
  "optional", "not required", "isn t required", "is not required",
];

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(value: string, phrase: string): boolean {
  const normalizedValue = ` ${normalizeText(value)} `;
  const normalizedPhrase = normalizeText(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${normalizedPhrase}(?=\\s|$)`).test(normalizedValue);
}

function firstPhrase(value: string, phrases: string[]): string | null {
  return phrases.find((phrase) => containsPhrase(value, phrase)) ?? null;
}

function phraseOffsets(value: string, phrase: string): number[] {
  const normalizedValue = ` ${normalizeText(value)} `;
  const normalizedPhrase = ` ${normalizeText(phrase)} `;
  const offsets: number[] = [];
  let offset = normalizedValue.indexOf(normalizedPhrase);
  while (offset !== -1) {
    offsets.push(offset + 1);
    offset = normalizedValue.indexOf(normalizedPhrase, offset + 1);
  }
  return offsets;
}

function nearestPhraseDistance(
  value: string,
  target: string,
  phrases: readonly string[],
): number {
  const targetOffsets = phraseOffsets(value, target);
  let nearest = Number.POSITIVE_INFINITY;
  for (const phrase of phrases) {
    for (const phraseOffset of phraseOffsets(value, phrase)) {
      for (const targetOffset of targetOffsets) {
        nearest = Math.min(nearest, Math.abs(phraseOffset - targetOffset));
      }
    }
  }
  return nearest;
}

export function isPotentialTargetTitle(title: string): boolean {
  return firstPhrase(title, TITLE_EXCLUSIONS) === null
    && firstPhrase(title, TARGET_TITLES) !== null;
}

export function isPotentialTargetTitleWithStrongSignal(title: string): boolean {
  return isPotentialTargetTitle(title) && firstPhrase(title, STRONG_SIGNALS) !== null;
}

function classifySupportSignal(
  text: string,
  positivePatterns: RegExp[],
  negativePatterns: RegExp[],
): SupportSignal {
  if (negativePatterns.some((pattern) => pattern.test(text))) {
    return "no";
  }
  if (positivePatterns.some((pattern) => pattern.test(text))) {
    return "yes";
  }
  return "unknown";
}

export function detectMobilitySignals(descriptionText: string): MobilitySignals {
  return {
    sponsorship: classifySupportSignal(
      descriptionText,
      SPONSORSHIP_YES_PATTERNS,
      SPONSORSHIP_NO_PATTERNS,
    ),
    relocation: classifySupportSignal(
      descriptionText,
      RELOCATION_YES_PATTERNS,
      RELOCATION_NO_PATTERNS,
    ),
  };
}

export function classifyLanguageRequirement(
  descriptionText: string,
): LanguageRequirementDecision {
  const sentences = descriptionText
    .split(/[.!?;:\n]+|\bbut\b/i)
    .map((sentence) => normalizeText(sentence))
    .filter((sentence) => sentence !== "");

  for (const [code, language] of NON_ENGLISH_LANGUAGES) {
    for (const sentence of sentences) {
      if (!containsPhrase(sentence, language)) {
        continue;
      }
      const mandatoryDistance = nearestPhraseDistance(
        sentence,
        language,
        MANDATORY_LANGUAGE_PATTERNS,
      );
      const optionalDistance = nearestPhraseDistance(
        sentence,
        language,
        OPTIONAL_LANGUAGE_PATTERNS,
      );
      if (Number.isFinite(optionalDistance) && optionalDistance <= mandatoryDistance) {
        continue;
      }
      if (Number.isFinite(mandatoryDistance)) {
        return {
          status: "NON_ENGLISH_REQUIRED",
          reason: `language:${code}:required`,
        };
      }
      if (/\b(?:language|languages|speak|spoken|written|verbal|communication)\b/.test(sentence)) {
        return { status: "AMBIGUOUS", reason: "language:ambiguous" };
      }
    }
  }

  return { status: "CLEAR", reason: null };
}

function isEligibleCountry(
  job: NormalizedJob,
  code: string,
  policy?: SourceMatchingPolicy,
): boolean {
  const normalized = code.toUpperCase();
  if (policy?.eligibleCountryCodes) {
    return policy.eligibleCountryCodes.some((eligible) => eligible.toUpperCase() === normalized);
  }
  return EEA_COUNTRY_CODE_SET.has(normalized)
    || normalized === "SG"
    || (normalized === "MY" && job.sourceKey === "grab-malaysia-smartrecruiters");
}

function hasEligibleLocation(job: NormalizedJob, policy?: SourceMatchingPolicy): boolean {
  if (job.countryCodes.some((code) => isEligibleCountry(job, code, policy))) {
    return true;
  }
  if (policy?.eligibleCountryCodes) {
    return policy.eligibleCountryCodes.some((code) =>
      (POLICY_COUNTRY_LOCATION_TERMS[code.toUpperCase()] ?? [])
        .some((term) => containsPhrase(job.locationText, term)));
  }
  return ELIGIBLE_LOCATION_TERMS.some((term) => containsPhrase(job.locationText, term));
}

function hasExplicitlyIneligibleLocation(
  job: NormalizedJob,
  policy?: SourceMatchingPolicy,
): boolean {
  if (job.countryCodes.some((code) => !isEligibleCountry(job, code, policy))) {
    return true;
  }
  if (policy?.eligibleCountryCodes) {
    const eligible = new Set(policy.eligibleCountryCodes.map((code) => code.toUpperCase()));
    return Object.entries(POLICY_COUNTRY_LOCATION_TERMS).some(([code, terms]) =>
      !eligible.has(code) && terms.some((term) => containsPhrase(job.locationText, term)));
  }
  return INELIGIBLE_LOCATION_TERMS.some((term) => containsPhrase(job.locationText, term));
}

export function matchJob(
  job: NormalizedJob,
  policy?: SourceMatchingPolicy,
): MatchDecision {
  const excludedTitle = firstPhrase(job.title, TITLE_EXCLUSIONS);
  if (excludedTitle) {
    return { status: "EXCLUDED", reasons: [`title-excluded:${excludedTitle}`] };
  }

  if (job.employmentType && /contract|freelance/i.test(job.employmentType)) {
    return { status: "EXCLUDED", reasons: ["employment:contract"] };
  }

  const titleFamily = firstPhrase(job.title, TARGET_TITLES);
  if (!titleFamily) {
    return { status: "EXCLUDED", reasons: ["title:not-target-family"] };
  }

  const combinedText = `${job.title} ${job.descriptionText}`;
  const strongSignal = firstPhrase(combinedText, STRONG_SIGNALS);
  const weakSignals = WEAK_SIGNALS.filter((signal) => containsPhrase(combinedText, signal));
  if (!strongSignal && weakSignals.length < 2) {
    return { status: "EXCLUDED", reasons: ["skill:insufficient-ml-signal"] };
  }

  if (policy?.requireCompleteDescription && job.descriptionCompleteness !== "FULL") {
    return { status: "REVIEW", reasons: ["language:description-incomplete"] };
  }
  if (policy?.requireVisaSponsorship) {
    const sponsorship = detectMobilitySignals(job.descriptionText).sponsorship;
    if (sponsorship !== "yes") {
      return {
        status: "EXCLUDED",
        reasons: [sponsorship === "no"
          ? "sponsorship:not-offered"
          : "sponsorship:not-explicit"],
      };
    }
  }
  if (policy?.excludeRequiredNonEnglish) {
    const language = classifyLanguageRequirement(job.descriptionText);
    if (language.status === "NON_ENGLISH_REQUIRED") {
      return { status: "EXCLUDED", reasons: [language.reason!] };
    }
    if (language.status === "AMBIGUOUS") {
      return { status: "REVIEW", reasons: [language.reason!] };
    }
  }

  const ignoreLocation = policy?.locationMode === "IGNORE";
  if (!ignoreLocation) {
    const broadRemoteOnly = /\b(remote|global|emea|apac|europe)\b/i.test(job.locationText)
      && !hasEligibleLocation(job, policy);
    if (broadRemoteOnly) {
      return { status: "EXCLUDED", reasons: ["location:broad-or-remote-only"] };
    }
    if (hasExplicitlyIneligibleLocation(job, policy) && !hasEligibleLocation(job, policy)) {
      return { status: "EXCLUDED", reasons: ["location:ineligible-country"] };
    }
  }

  const reasons = [
    `title:${titleFamily.replaceAll(" ", "-")}`,
    strongSignal
      ? `skill:${strongSignal.replaceAll(" ", "-")}`
      : `skills:${weakSignals.join("+")}`,
  ];

  if (!ignoreLocation && !hasEligibleLocation(job, policy)) {
    return { status: "REVIEW", reasons: [...reasons, "location:ambiguous"] };
  }
  reasons.push(ignoreLocation ? "location:source-exception" : "location:eligible");

  const seniority = firstPhrase(job.title, SENIORITY_SIGNALS);
  if (!seniority) {
    return { status: "REVIEW", reasons: [...reasons, "seniority:ambiguous"] };
  }

  if (!job.employmentType) {
    return { status: "REVIEW", reasons: [...reasons, "employment:unknown"] };
  }
  if (!/full[-_ ]?time|permanent|regular/i.test(job.employmentType)) {
    return { status: "REVIEW", reasons: [...reasons, "employment:ambiguous"] };
  }

  return {
    status: "STRONG",
    reasons: [...reasons, `seniority:${seniority.replaceAll(" ", "-")}`],
  };
}