import {
  type MatchStatus,
  type MatchDecision,
  type NormalizedJob,
  type SourceDefinition,
  isPotentialTargetTitle,
  matchJob,
} from "./domain.ts";
import { applyGovernmentEvidence } from "./government-evidence.ts";
import { parseAshbyResponse } from "./ashby.ts";
import { parseLeverResponse } from "./lever.ts";
import { parseRecruiteeResponse } from "./recruitee.ts";
import { parseJsonFeedResponse } from "./json-feed.ts";
import { parseAmdResponse } from "./amd.ts";
import {
  AMAZON_PAGE_SIZE,
  buildAmazonSearchRequest,
  parseAmazonSearchPage,
} from "./amazon.ts";
import { assertAllowedHttpsUrl, parseGreenhouseResponse } from "./greenhouse.ts";
import { buildSeaSearchUrl, parseSeaSearchPage } from "./sea.ts";
import {
  buildSmartRecruitersListingUrl,
  parseSmartRecruitersDetail,
  parseSmartRecruitersListingPage,
  SMARTRECRUITERS_PAGE_SIZE,
  type SmartRecruitersListing,
} from "./smartrecruiters.ts";
import {
  buildOptiverListingUrl,
  OPTIVER_PAGE_SIZE,
  parseOptiverDetail,
  parseOptiverListingPage,
  type OptiverListing,
} from "./optiver.ts";
import {
  BOOKING_PAGE_SIZE,
  buildBookingSearchRequest,
  parseBookingSearchPage,
} from "./booking.ts";
import {
  buildGlovoDetailUrl,
  buildGlovoListingRequest,
  GLOVO_PAGE_SIZE,
  parseGlovoDetail,
  parseGlovoListingPage,
  type GlovoListing,
} from "./glovo.ts";
import {
  parsePicnicDetail,
  parsePicnicSitemap,
  type PicnicListing,
} from "./picnic.ts";
import {
  parseNusDetail,
  parseNusRedirect,
  parseNusSitemap,
  type NusListing,
} from "./nus.ts";
import {
  isExpiredDeliveryHeroDetail,
  parseDeliveryHeroDetail,
  parseDeliveryHeroSitemap,
  type DeliveryHeroListing,
} from "./delivery-hero.ts";
import {
  parseDeutscheBoerseDetail,
  parseDeutscheBoerseSitemap,
  type DeutscheBoerseListing,
} from "./deutsche-boerse.ts";
import {
  parseBecDetail,
  parseBecListing,
  type BecListing,
} from "./bec.ts";
import {
  parseInescTecDetail,
  parseInescTecListing,
  type InescTecListing,
} from "./inesc-tec.ts";
import {
  buildZalandoDetailUrl,
  buildZalandoListingUrl,
  parseZalandoDetail,
  parseZalandoListingPage,
  ZALANDO_PAGE_SIZE,
  type ZalandoListing,
} from "./zalando.ts";
import { parseMercedesTechFeed } from "./mercedes-tech.ts";
import { parseBoltResponse } from "./bolt.ts";
import { getUnsupportedTargets, REQUIRED_TARGET_COUNT } from "./sources.ts";
import {
  buildWorkdayListingRequest,
  hasRequiredWorkdayAttribution,
  parseWorkdayDetail,
  parseWorkdayListingPage,
  WORKDAY_PAGE_SIZE,
  type WorkdayListing,
  type WorkdayListingPage,
  type WorkdayListingRequest,
} from "./workday.ts";
import {
  hasHttpValidators,
  normalizeHttpValidators,
  type HttpValidators,
} from "./transport.ts";
import { normalizeSourceWarning, normalizeSourceWarnings } from "./operations.ts";

export interface ShadowHttpRequest {
  url: string;
  method: "get" | "post";
  body?: string;
  contentType?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export interface ShadowHttpResponse {
  status: number;
  contentType: string;
  location?: string;
  retryAfter?: string;
  etag?: string;
  lastModified?: string;
  body: string;
  byteLength: number;
}

export type FetchMany = (requests: ShadowHttpRequest[]) => ShadowHttpResponse[];

export type SourceRunStatus = "SUCCESS" | "PARTIAL" | "FAILED";

export interface SourceIntegrityState {
  lastHealthyCount: number | null;
  pendingCount: number | null;
  pendingConfirmations: number;
  consecutiveFailures?: number;
  circuitOpenedAt?: string | null;
  httpValidators?: HttpValidators;
  httpValidatorUrl?: string | null;
}

export interface CountIntegrityResult {
  accepted: boolean;
  pendingCount: number | null;
  pendingConfirmations: number;
}

export interface SourceShadowResult {
  sourceKey: string;
  status: SourceRunStatus;
  listedJobs: number;
  detailedJobs: number;
  matches: Record<MatchStatus, number>;
  warnings: string[];
  integrity: CountIntegrityResult;
  unchanged?: boolean;
  httpValidators?: HttpValidators;
  httpValidatorUrl?: string;
}

export interface ShadowReport {
  mode: "DEGRADED_SHADOW";
  requiredTargets: number;
  configuredTargets: number;
  unsupportedTargets: string[];
  startedAt: string;
  completedAt: string;
  sources: SourceShadowResult[];
}

export interface CollectedCandidate {
  job: NormalizedJob;
  status: MatchStatus;
  reasons: string[];
}

export interface ShadowCollection {
  report: ShadowReport;
  candidates: CollectedCandidate[];
}

function emptyMatches(): Record<MatchStatus, number> {
  return { STRONG: 0, REVIEW: 0, EXCLUDED: 0 };
}

function matchCollectedJob(job: NormalizedJob, source: SourceDefinition): MatchDecision {
  return applyGovernmentEvidence(
    job,
    matchJob(job, source.matchingPolicy),
    job.fetchedAt,
    undefined,
    source.matchingPolicy,
  );
}

const EMPTY_INTEGRITY: SourceIntegrityState = {
  lastHealthyCount: null,
  pendingCount: null,
  pendingConfirmations: 0,
  consecutiveFailures: 0,
  circuitOpenedAt: null,
};

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_PROBE_INTERVAL_MS = 12 * 60 * 60 * 1_000;

function supportsConditionalListing(source: SourceDefinition): boolean {
  return source.adapter === "GREENHOUSE"
    || source.adapter === "ASHBY"
    || source.adapter === "LEVER"
    || source.adapter === "RECRUITEE"
    || source.adapter === "JSON_FEED"
    || source.adapter === "AMD"
    || source.adapter === "BOLT";
}

function conditionalListingRequest(
  source: SourceDefinition,
  state: SourceIntegrityState,
): ShadowHttpRequest {
  const validators = normalizeHttpValidators(
    state.httpValidatorUrl === source.endpoint ? state.httpValidators?.etag : null,
    state.httpValidatorUrl === source.endpoint ? state.httpValidators?.lastModified : null,
  );
  return {
    url: source.endpoint,
    method: "get",
    ...(validators.etag ? { ifNoneMatch: validators.etag } : {}),
    ...(validators.lastModified ? { ifModifiedSince: validators.lastModified } : {}),
  };
}

function responseValidators(
  response: ShadowHttpResponse,
  previous?: HttpValidators,
): HttpValidators {
  const received = normalizeHttpValidators(response.etag, response.lastModified);
  if (response.status !== 304) {
    return received;
  }
  const normalizedPrevious = normalizeHttpValidators(previous?.etag, previous?.lastModified);
  return {
    etag: received.etag ?? normalizedPrevious.etag,
    lastModified: received.lastModified ?? normalizedPrevious.lastModified,
  };
}

function notModifiedResult(
  source: SourceDefinition,
  response: ShadowHttpResponse,
  previous: SourceIntegrityState,
): SourceShadowResult | null {
  if (response.status !== 304 || !supportsConditionalListing(source)) {
    return null;
  }
  const previousValidators = normalizeHttpValidators(
    previous.httpValidators?.etag,
    previous.httpValidators?.lastModified,
  );
  if (previous.lastHealthyCount === null
    || previous.httpValidatorUrl !== source.endpoint
    || !hasHttpValidators(previousValidators)) {
    return null;
  }
  return {
    sourceKey: source.sourceKey,
    status: "SUCCESS",
    listedJobs: previous.lastHealthyCount,
    detailedJobs: 0,
    matches: emptyMatches(),
    warnings: ["NOT_MODIFIED"],
    integrity: { accepted: true, pendingCount: null, pendingConfirmations: 0 },
    unchanged: true,
    httpValidators: responseValidators(response, previousValidators),
    httpValidatorUrl: source.endpoint,
  };
}

function circuitIsOpen(state: SourceIntegrityState, startedAt: string): boolean {
  if ((state.consecutiveFailures ?? 0) < CIRCUIT_FAILURE_THRESHOLD || !state.circuitOpenedAt) {
    return false;
  }
  const openedAt = Date.parse(state.circuitOpenedAt);
  return Number.isFinite(openedAt)
    && Date.parse(startedAt) - openedAt < CIRCUIT_PROBE_INTERVAL_MS;
}

function countsAreSimilar(first: number, second: number): boolean {
  if (first === second) {
    return true;
  }
  return Math.abs(first - second) / Math.max(first, second, 1) <= 0.1;
}

export function evaluateCountIntegrity(
  currentCount: number,
  previous: SourceIntegrityState,
): CountIntegrityResult {
  const changeRatio = previous.lastHealthyCount === null || previous.lastHealthyCount === 0
    ? 0
    : Math.abs(currentCount - previous.lastHealthyCount) / previous.lastHealthyCount;
  const suspicious = currentCount === 0
    || (previous.lastHealthyCount !== null && changeRatio > 0.8);

  if (!suspicious) {
    return { accepted: true, pendingCount: null, pendingConfirmations: 0 };
  }

  if (previous.pendingCount === null || !countsAreSimilar(currentCount, previous.pendingCount)) {
    return { accepted: false, pendingCount: currentCount, pendingConfirmations: 0 };
  }

  const pendingConfirmations = previous.pendingConfirmations + 1;
  if (pendingConfirmations >= 2) {
    return { accepted: true, pendingCount: null, pendingConfirmations: 0 };
  }
  return { accepted: false, pendingCount: currentCount, pendingConfirmations };
}

export function validateSourceRegistry(sources: SourceDefinition[]): void {
  const keys = new Set<string>();
  for (const source of sources) {
    if (keys.has(source.sourceKey)) {
      throw new Error(`Duplicate source key: ${source.sourceKey}`);
    }
    keys.add(source.sourceKey);
    if (source.maxJobs <= 0
      || source.maxResponseBytes <= 0
      || source.maxDetailJobs <= 0
      || source.maxPages <= 0) {
      throw new Error(`Source limits must be positive: ${source.sourceKey}`);
    }
    const matchingPolicy = source.matchingPolicy;
    if (matchingPolicy) {
      const countryCodes = matchingPolicy.eligibleCountryCodes;
      if (countryCodes !== undefined
        && (countryCodes.length === 0
          || new Set(countryCodes).size !== countryCodes.length
          || countryCodes.some((code) => !/^[A-Z]{2}$/.test(code)))) {
        throw new Error(`Source matching countries are invalid: ${source.sourceKey}`);
      }
      if (matchingPolicy.locationMode === "IGNORE" && countryCodes !== undefined) {
        throw new Error(`Source matching location policy is contradictory: ${source.sourceKey}`);
      }
      if (matchingPolicy.excludeRequiredNonEnglish === true
        && matchingPolicy.requireCompleteDescription !== true) {
        throw new Error(`Source language policy requires complete descriptions: ${source.sourceKey}`);
      }
      if (matchingPolicy.requireVisaSponsorship === true
        && matchingPolicy.requireCompleteDescription !== true) {
        throw new Error(`Source sponsorship policy requires complete descriptions: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "WORKDAY") {
      if (!source.searchTerms
        || source.searchTerms.length === 0
        || source.searchTerms.length > source.maxPages
        || new Set(source.searchTerms).size !== source.searchTerms.length) {
        throw new Error(`Workday search terms are invalid: ${source.sourceKey}`);
      }
      const appliedFacets = source.workdayAppliedFacets;
      if (appliedFacets !== undefined
        && (Object.keys(appliedFacets).length === 0
          || Object.entries(appliedFacets).some(([facet, values]) =>
            !/^[A-Za-z][A-Za-z0-9]*$/.test(facet)
              || values.length === 0
              || new Set(values).size !== values.length
              || values.some((value) => !/^[A-Za-z0-9]+$/.test(value))))) {
        throw new Error(`Workday applied facets are invalid: ${source.sourceKey}`);
      }
      const attributionTerms = source.workdayRequiredAttributionTerms;
      if (attributionTerms !== undefined
        && (attributionTerms.length === 0
          || new Set(attributionTerms).size !== attributionTerms.length
          || attributionTerms.some((term) => term.trim() !== term || term.length < 2))) {
        throw new Error(`Workday attribution terms are invalid: ${source.sourceKey}`);
      }
    } else if (source.workdayAppliedFacets !== undefined
      || source.workdayRequiredAttributionTerms !== undefined) {
      throw new Error(`Non-Workday source has Workday configuration: ${source.sourceKey}`);
    }
    if (source.adapter === "LEVER") {
      if (source.maxPages !== 1) {
        throw new Error(`Lever source must use one complete page: ${source.sourceKey}`);
      }
      const locationCountryCodes = source.leverLocationCountryCodes;
      const eligibleCountryCodes = new Set(matchingPolicy?.eligibleCountryCodes ?? []);
      if (locationCountryCodes !== undefined
        && (Object.keys(locationCountryCodes).length === 0
          || Object.entries(locationCountryCodes).some(([location, countryCodes]) =>
            location.trim() !== location
              || location === ""
              || countryCodes.length === 0
              || new Set(countryCodes).size !== countryCodes.length
              || countryCodes.some((code) =>
                !/^[A-Z]{2}$/.test(code) || !eligibleCountryCodes.has(code))))) {
        throw new Error(`Lever location countries are invalid: ${source.sourceKey}`);
      }
    } else if (source.leverLocationCountryCodes !== undefined) {
      throw new Error(`Non-Lever source has Lever configuration: ${source.sourceKey}`);
    }
    if (source.adapter === "RECRUITEE" && source.maxPages !== 1) {
      throw new Error(`Recruitee source must use one complete page: ${source.sourceKey}`);
    }
    if (source.adapter === "JSON_FEED" && source.maxPages !== 1) {
      throw new Error(`JSON Feed source must use one complete page: ${source.sourceKey}`);
    }
    if (source.adapter === "AMD" && source.maxPages !== 1) {
      throw new Error(`AMD source must use one complete page: ${source.sourceKey}`);
    }
    if (source.adapter === "AMAZON") {
      if (!source.searchTerms
        || source.searchTerms.length === 0
        || source.searchTerms.length > source.maxPages
        || new Set(source.searchTerms).size !== source.searchTerms.length
        || !source.locationFilters
        || source.locationFilters.length === 0) {
        throw new Error(`Amazon search configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "SEA") {
      if (!source.searchTerms
        || source.searchTerms.length === 0
        || source.searchTerms.length > source.maxPages
        || new Set(source.searchTerms).size !== source.searchTerms.length
        || source.locationFilters?.length !== 1
        || source.locationFilters[0] !== "25") {
        throw new Error(`Sea search configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "SMARTRECRUITERS") {
      if (source.locationFilters?.length !== 1
        || !/^[a-z]{2}$/i.test(source.locationFilters[0])) {
        throw new Error(`SmartRecruiters country configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "OPTIVER") {
      if (source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "amsterdam") {
        throw new Error(`Optiver location configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "BOOKING") {
      if (!source.searchTerms
        || source.searchTerms.length === 0
        || source.searchTerms.length > source.maxPages
        || new Set(source.searchTerms).size !== source.searchTerms.length
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "amsterdam") {
        throw new Error(`Booking search configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "GLOVO") {
      if (!source.searchTerms
        || source.searchTerms.join(",") !== "data,engineer,scientist"
        || source.searchTerms.length > source.maxPages
        || !source.locationFilters
        || source.locationFilters.length === 0
        || new Set(source.locationFilters).size !== source.locationFilters.length
        || source.locationFilters.some((country) => !/^[a-z]{2}$/.test(country))) {
        throw new Error(`Glovo search configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "PICNIC") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "netherlands") {
        throw new Error(`Picnic source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "NUS") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "singapore") {
        throw new Error(`NUS source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "DELIVERY_HERO") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "germany") {
        throw new Error(`Delivery Hero source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "DEUTSCHE_BOERSE") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "luxembourg") {
        throw new Error(`Deutsche Boerse source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "BEC") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "denmark") {
        throw new Error(`BEC source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "INESC_TEC") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters?.length !== 1
        || source.locationFilters[0].toLowerCase() !== "portugal") {
        throw new Error(`INESC TEC source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "ZALANDO") {
      if (source.maxPages * ZALANDO_PAGE_SIZE < source.maxJobs
        || source.searchTerms !== undefined
        || source.locationFilters !== undefined
        || source.endpoint !== "https://jobs-api.corptech.zalan.do/workday") {
        throw new Error(`Zalando source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "MERCEDES_TECH") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters !== undefined
        || source.endpoint !== "https://www.mercedes-benz-techinnovation.com/en/jobs.xml") {
        throw new Error(`Mercedes source configuration is invalid: ${source.sourceKey}`);
      }
    }
    if (source.adapter === "BOLT") {
      if (source.maxPages !== 1
        || source.searchTerms !== undefined
        || source.locationFilters !== undefined
        || source.endpoint !== "https://bolt.eu/en/careers/positions/") {
        throw new Error(`Bolt source configuration is invalid: ${source.sourceKey}`);
      }
    }
    assertAllowedHttpsUrl(source.endpoint, source.allowedHosts);
  }
}

function parseJsonResponse(
  response: ShadowHttpResponse,
  source: SourceDefinition,
): unknown {
  if (response.status !== 200) {
    throw new Error("HTTP_STATUS");
  }
  const contentType = response.contentType.toLowerCase();
  if (!contentType.includes("application/json")
    && !contentType.includes("application/feed+json")) {
    throw new Error("CONTENT_TYPE");
  }
  if (response.byteLength > source.maxResponseBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }

  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function parseWorkdayListingResponses(
  source: SourceDefinition,
  requests: readonly WorkdayListingRequest[],
  responses: readonly ShadowHttpResponse[],
  fetchMany: FetchMany,
  waitBeforeRetry: (retryRound: number) => void,
): WorkdayListingPage[] {
  if (responses.length !== requests.length) {
    throw new Error("LISTING_RESPONSE_COUNT");
  }

  const pages: Array<WorkdayListingPage | undefined> = [];
  const malformedIndexes: number[] = [];
  responses.forEach((response, index) => {
    const payload = parseJsonResponse(response, source);
    try {
      pages[index] = parseWorkdayListingPage(payload);
    } catch {
      malformedIndexes.push(index);
    }
  });
  if (malformedIndexes.length === 0) {
    return pages as WorkdayListingPage[];
  }
  if (malformedIndexes.length > 2) {
    throw new Error("SCHEMA_INVALID");
  }

  let pendingIndexes = malformedIndexes;
  for (let retryRound = 0; retryRound < 2; retryRound += 1) {
    waitBeforeRetry(retryRound + 1);
    const retryRequests = pendingIndexes.map((index) => requests[index]);
    const retryResponses = fetchMany(retryRequests.map((request) => ({
      url: request.url,
      method: "post",
      body: request.body,
    })));
    if (retryResponses.length !== retryRequests.length) {
      throw new Error("LISTING_RESPONSE_COUNT");
    }
    const stillMalformed: number[] = [];
    pendingIndexes.forEach((retryIndex, index) => {
      const retryPayload = parseJsonResponse(retryResponses[index], source);
      try {
        pages[retryIndex] = parseWorkdayListingPage(retryPayload);
      } catch {
        stillMalformed.push(retryIndex);
      }
    });
    if (stillMalformed.length === 0) {
      return pages as WorkdayListingPage[];
    }
    pendingIndexes = stillMalformed;
  }
  throw new Error("SCHEMA_INVALID");
}

function parseHtmlResponse(
  response: ShadowHttpResponse,
  source: SourceDefinition,
): string {
  if (response.status !== 200) {
    throw new Error("HTTP_STATUS");
  }
  if (!response.contentType.toLowerCase().includes("text/html")) {
    throw new Error("CONTENT_TYPE");
  }
  if (response.byteLength > source.maxResponseBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  return response.body;
}

function parseXmlResponse(
  response: ShadowHttpResponse,
  source: SourceDefinition,
): string {
  if (response.status !== 200) {
    throw new Error("HTTP_STATUS");
  }
  const contentType = response.contentType.toLowerCase();
  if (!contentType.includes("application/xml") && !contentType.includes("text/xml")) {
    throw new Error("CONTENT_TYPE");
  }
  if (response.byteLength > source.maxResponseBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  return response.body;
}

function parseResponse(
  response: ShadowHttpResponse,
  source: SourceDefinition,
  fetchedAt: string,
): NormalizedJob[] {
  const payload = parseJsonResponse(response, source);

  try {
    return source.adapter === "ASHBY"
      ? parseAshbyResponse(payload, source, fetchedAt)
      : source.adapter === "LEVER"
        ? parseLeverResponse(payload, source, fetchedAt)
        : source.adapter === "RECRUITEE"
          ? parseRecruiteeResponse(payload, source, fetchedAt)
          : source.adapter === "JSON_FEED"
            ? parseJsonFeedResponse(payload, source, fetchedAt)
            : source.adapter === "AMD"
              ? parseAmdResponse(payload, source, fetchedAt)
              : parseGreenhouseResponse(payload, source, fetchedAt);
  } catch {
    throw new Error("SCHEMA_INVALID");
  }
}

function failedResult(
  sourceKey: string,
  warning: string,
  integrity: CountIntegrityResult = {
    accepted: false,
    pendingCount: null,
    pendingConfirmations: 0,
  },
  listedJobs = 0,
): SourceShadowResult {
  return {
    sourceKey,
    status: "FAILED",
    listedJobs,
    detailedJobs: 0,
    matches: emptyMatches(),
    warnings: [normalizeSourceWarning(warning)],
    integrity,
  };
}

export function collectShadow(
  sources: SourceDefinition[],
  fetchMany: FetchMany,
  now: () => Date = () => new Date(),
  requiredTargets = REQUIRED_TARGET_COUNT,
  sourceIntegrityStates: ReadonlyMap<string, SourceIntegrityState> = new Map(),
  targetCompanies: readonly string[] = [],
  waitBeforeWorkdayRetry: (retryRound: number) => void = () => {},
): ShadowCollection {
  validateSourceRegistry(sources);
  const startedAt = now().toISOString();
  const results: SourceShadowResult[] = [];
  const runnableSources = sources.filter((source) => {
    const state = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    if (source.operationallyDisabled === true) {
      results.push(failedResult(source.sourceKey, "SOURCE_DISABLED", {
        accepted: false,
        pendingCount: state.pendingCount,
        pendingConfirmations: state.pendingConfirmations,
      }));
      return false;
    }
    if (!circuitIsOpen(state, startedAt)) {
      return true;
    }
    results.push(failedResult(source.sourceKey, "CIRCUIT_OPEN", {
      accepted: false,
      pendingCount: state.pendingCount,
      pendingConfirmations: state.pendingConfirmations,
    }));
    return false;
  });
  const simpleSources = runnableSources.filter((source) =>
    source.adapter !== "WORKDAY"
      && source.adapter !== "AMAZON"
      && source.adapter !== "SEA"
      && source.adapter !== "SMARTRECRUITERS"
      && source.adapter !== "OPTIVER"
      && source.adapter !== "BOOKING"
      && source.adapter !== "GLOVO"
      && source.adapter !== "PICNIC"
      && source.adapter !== "NUS"
      && source.adapter !== "DELIVERY_HERO"
      && source.adapter !== "DEUTSCHE_BOERSE"
      && source.adapter !== "BEC"
      && source.adapter !== "INESC_TEC"
      && source.adapter !== "ZALANDO"
      && source.adapter !== "MERCEDES_TECH"
      && source.adapter !== "BOLT");
  const listingResponses = simpleSources.length === 0 ? [] : fetchMany(simpleSources.map((source) =>
    conditionalListingRequest(
      source,
      sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY,
    )));
  if (listingResponses.length !== simpleSources.length) {
    throw new Error("HTTP client returned the wrong number of listing responses");
  }

  const candidates: CollectedCandidate[] = [];
  const detailRequests: Array<{
    source: SourceDefinition;
    result: SourceShadowResult;
    request: ShadowHttpRequest;
    optiverListing?: OptiverListing;
    glovoListing?: GlovoListing;
    picnicListing?: PicnicListing;
    deliveryHeroListing?: DeliveryHeroListing;
    deutscheBoerseListing?: DeutscheBoerseListing;
    becListing?: BecListing;
    inescTecListing?: InescTecListing;
    zalandoListing?: ZalandoListing;
  }> = [];

  simpleSources.forEach((source, index) => {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    const unchanged = notModifiedResult(source, listingResponses[index], previousIntegrity);
    if (unchanged) {
      results.push(unchanged);
      return;
    }
    let jobs: NormalizedJob[];
    try {
      jobs = parseResponse(listingResponses[index], source, startedAt);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      return;
    }

    const integrity = evaluateCountIntegrity(
      jobs.length,
      previousIntegrity,
    );
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        jobs.length,
      ));
      return;
    }

    const candidateJobs = jobs.filter((job) => isPotentialTargetTitle(job.title));
    const boundedCandidates = candidateJobs.slice(0, source.maxDetailJobs);
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: candidateJobs.length > source.maxDetailJobs ? "PARTIAL" : "SUCCESS",
      listedJobs: jobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: jobs.length - candidateJobs.length,
      },
      warnings: candidateJobs.length > source.maxDetailJobs ? ["DETAIL_LIMIT"] : [],
      integrity,
      httpValidators: responseValidators(listingResponses[index]),
      httpValidatorUrl: source.endpoint,
    };
    results.push(result);

    if (source.adapter === "ASHBY"
      || source.adapter === "LEVER"
      || source.adapter === "RECRUITEE"
      || source.adapter === "JSON_FEED"
      || source.adapter === "AMD") {
      for (const candidate of boundedCandidates) {
        const decision = matchCollectedJob(candidate, source);
        result.matches[decision.status] += 1;
        result.detailedJobs += 1;
        candidates.push({
          job: candidate,
          status: decision.status,
          reasons: decision.reasons,
        });
      }
      return;
    }

    for (const candidate of boundedCandidates) {
      const url = assertAllowedHttpsUrl(
        `${source.endpoint}/${encodeURIComponent(candidate.sourceJobId)}`,
        source.allowedHosts,
      );
      detailRequests.push({ source, result, request: { url, method: "get" } });
    }
  });

  for (const source of runnableSources.filter((item) => item.adapter === "WORKDAY")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    const searchTerms = source.searchTerms!;
    let paginationLimited = false;
    let listingPages: ReturnType<typeof parseWorkdayListingPage>[];

    try {
      const firstRequests = searchTerms.map((searchTerm) =>
        buildWorkdayListingRequest(source, searchTerm, 0));
      const firstResponses = fetchMany(firstRequests.map((request) => ({
        url: request.url,
        method: "post",
        body: request.body,
      })));
      listingPages = parseWorkdayListingResponses(
        source,
        firstRequests,
        firstResponses,
        fetchMany,
        waitBeforeWorkdayRetry,
      );

      const remainingRequests = [];
      for (let index = 0; index < firstRequests.length; index += 1) {
        for (let offset = WORKDAY_PAGE_SIZE; offset < listingPages[index].total; offset += WORKDAY_PAGE_SIZE) {
          if (firstRequests.length + remainingRequests.length >= source.maxPages) {
            paginationLimited = true;
            break;
          }
          remainingRequests.push(buildWorkdayListingRequest(
            source,
            firstRequests[index].searchTerm,
            offset,
          ));
        }
      }

      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests.map((request) => ({
          url: request.url,
          method: "post",
          body: request.body,
        })));
        listingPages.push(...parseWorkdayListingResponses(
          source,
          remainingRequests,
          remainingResponses,
          fetchMany,
          waitBeforeWorkdayRetry,
        ));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const listingsByPath = new Map<string, WorkdayListing>();
    for (const page of listingPages) {
      for (const posting of page.postings) {
        listingsByPath.set(posting.externalPath, posting);
      }
    }
    const allListings = [...listingsByPath.values()];
    const jobLimited = allListings.length > source.maxJobs;
    const boundedListings = allListings.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedListings.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedListings.length,
      ));
      continue;
    }

    const candidateListings = boundedListings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedListings.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedListings.length - candidateListings.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        request: {
          url: assertAllowedHttpsUrl(`${source.endpoint}${listing.externalPath}`, source.allowedHosts),
          method: "get",
        },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "AMAZON")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    const searchTerms = source.searchTerms!;
    let paginationLimited = false;
    let pages: ReturnType<typeof parseAmazonSearchPage>[];

    try {
      const firstRequests = searchTerms.map((searchTerm) =>
        buildAmazonSearchRequest(source, searchTerm, 0));
      const firstResponses = fetchMany(firstRequests.map((request) => ({
        url: request.url,
        method: "get",
      })));
      if (firstResponses.length !== firstRequests.length) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = firstResponses.map((response) =>
        parseAmazonSearchPage(parseJsonResponse(response, source), source, startedAt));

      const remainingRequests = [];
      for (let index = 0; index < firstRequests.length; index += 1) {
        for (let offset = AMAZON_PAGE_SIZE; offset < pages[index].total; offset += AMAZON_PAGE_SIZE) {
          if (firstRequests.length + remainingRequests.length >= source.maxPages) {
            paginationLimited = true;
            break;
          }
          remainingRequests.push(buildAmazonSearchRequest(
            source,
            firstRequests[index].searchTerm,
            offset,
          ));
        }
      }
      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests.map((request) => ({
          url: request.url,
          method: "get",
        })));
        if (remainingResponses.length !== remainingRequests.length) {
          throw new Error("LISTING_RESPONSE_COUNT");
        }
        pages.push(...remainingResponses.map((response) =>
          parseAmazonSearchPage(parseJsonResponse(response, source), source, startedAt)));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const jobsById = new Map<string, NormalizedJob>();
    for (const page of pages) {
      for (const job of page.jobs) {
        jobsById.set(job.sourceJobId, job);
      }
    }
    const allJobs = [...jobsById.values()];
    const jobLimited = allJobs.length > source.maxJobs;
    const boundedJobs = allJobs.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedJobs.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedJobs.length,
      ));
      continue;
    }

    const candidateJobs = boundedJobs.filter((job) => isPotentialTargetTitle(job.title));
    const detailLimited = candidateJobs.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedJobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedJobs.length - candidateJobs.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const job of candidateJobs.slice(0, source.maxDetailJobs)) {
      const decision = matchCollectedJob(job, source);
      result.matches[decision.status] += 1;
      result.detailedJobs += 1;
      candidates.push({ job, status: decision.status, reasons: decision.reasons });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "SEA")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let pages: ReturnType<typeof parseSeaSearchPage>[];

    try {
      const responses = fetchMany(source.searchTerms!.map((searchTerm) => ({
        url: buildSeaSearchUrl(source, searchTerm),
        method: "get",
      })));
      if (responses.length !== source.searchTerms!.length) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = responses.map((response) =>
        parseSeaSearchPage(parseJsonResponse(response, source), source, startedAt));
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const jobsById = new Map<string, NormalizedJob>();
    for (const page of pages) {
      for (const job of page.jobs) {
        jobsById.set(job.sourceJobId, job);
      }
    }
    const paginationLimited = pages.some((page) => page.total > page.jobs.length);
    const allJobs = [...jobsById.values()];
    const jobLimited = allJobs.length > source.maxJobs;
    const boundedJobs = allJobs.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedJobs.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedJobs.length,
      ));
      continue;
    }

    const candidateJobs = boundedJobs.filter((job) => isPotentialTargetTitle(job.title));
    const detailLimited = candidateJobs.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedJobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedJobs.length - candidateJobs.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const job of candidateJobs.slice(0, source.maxDetailJobs)) {
      const decision = matchCollectedJob(job, source);
      result.matches[decision.status] += 1;
      result.detailedJobs += 1;
      candidates.push({ job, status: decision.status, reasons: decision.reasons });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "BOOKING")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    const searchTerms = source.searchTerms!;
    let paginationLimited = false;
    let pages: ReturnType<typeof parseBookingSearchPage>[];

    try {
      const firstRequests = searchTerms.map((searchTerm) =>
        buildBookingSearchRequest(source, searchTerm, 1));
      const firstResponses = fetchMany(firstRequests.map((request) => ({
        url: request.url,
        method: "get",
      })));
      if (firstResponses.length !== firstRequests.length) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = firstResponses.map((response) =>
        parseBookingSearchPage(parseJsonResponse(response, source), source, startedAt));

      const remainingRequests = [];
      for (let index = 0; index < firstRequests.length; index += 1) {
        const pageCount = Math.ceil(pages[index].total / BOOKING_PAGE_SIZE);
        for (let page = 2; page <= pageCount; page += 1) {
          if (firstRequests.length + remainingRequests.length >= source.maxPages) {
            paginationLimited = true;
            break;
          }
          remainingRequests.push(buildBookingSearchRequest(
            source,
            firstRequests[index].searchTerm,
            page,
          ));
        }
      }
      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests.map((request) => ({
          url: request.url,
          method: "get",
        })));
        if (remainingResponses.length !== remainingRequests.length) {
          throw new Error("LISTING_RESPONSE_COUNT");
        }
        pages.push(...remainingResponses.map((response) =>
          parseBookingSearchPage(parseJsonResponse(response, source), source, startedAt)));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const jobsById = new Map<string, NormalizedJob>();
    for (const page of pages) {
      for (const job of page.jobs) {
        jobsById.set(job.sourceJobId, job);
      }
    }
    const allJobs = [...jobsById.values()];
    const jobLimited = allJobs.length > source.maxJobs;
    const boundedJobs = allJobs.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedJobs.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedJobs.length,
      ));
      continue;
    }

    const candidateJobs = boundedJobs.filter((job) => isPotentialTargetTitle(job.title));
    const detailLimited = candidateJobs.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedJobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedJobs.length - candidateJobs.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const job of candidateJobs.slice(0, source.maxDetailJobs)) {
      const decision = matchCollectedJob(job, source);
      result.matches[decision.status] += 1;
      result.detailedJobs += 1;
      candidates.push({ job, status: decision.status, reasons: decision.reasons });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "SMARTRECRUITERS")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let paginationLimited = false;
    let pages: ReturnType<typeof parseSmartRecruitersListingPage>[];

    try {
      const firstResponse = fetchMany([{
        url: buildSmartRecruitersListingUrl(source, 0),
        method: "get",
      }]);
      if (firstResponse.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = [parseSmartRecruitersListingPage(
        parseJsonResponse(firstResponse[0], source),
        source,
      )];

      const remainingRequests = [];
      for (let offset = SMARTRECRUITERS_PAGE_SIZE; offset < pages[0].total; offset += SMARTRECRUITERS_PAGE_SIZE) {
        if (1 + remainingRequests.length >= source.maxPages) {
          paginationLimited = true;
          break;
        }
        remainingRequests.push({
          url: buildSmartRecruitersListingUrl(source, offset),
          method: "get" as const,
        });
      }
      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests);
        if (remainingResponses.length !== remainingRequests.length) {
          throw new Error("LISTING_RESPONSE_COUNT");
        }
        pages.push(...remainingResponses.map((response) =>
          parseSmartRecruitersListingPage(parseJsonResponse(response, source), source)));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const listingsById = new Map<string, SmartRecruitersListing>();
    for (const page of pages) {
      for (const listing of page.listings) {
        listingsById.set(listing.sourceJobId, listing);
      }
    }
    const allListings = [...listingsById.values()];
    const jobLimited = allListings.length > source.maxJobs;
    const boundedListings = allListings.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedListings.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedListings.length,
      ));
      continue;
    }

    const candidateListings = boundedListings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedListings.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedListings.length - candidateListings.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        request: {
          url: assertAllowedHttpsUrl(
            `${source.endpoint}/${encodeURIComponent(listing.sourceJobId)}`,
            source.allowedHosts,
          ),
          method: "get",
        },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "GLOVO")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    const searchTerms = source.searchTerms!;
    let paginationLimited = false;
    let pages: ReturnType<typeof parseGlovoListingPage>[];

    try {
      const firstRequests = searchTerms.map((searchTerm) =>
        buildGlovoListingRequest(source, searchTerm, 1));
      const firstResponses = fetchMany(firstRequests.map((request) => ({
        url: request.url,
        method: "post",
        body: request.body,
        contentType: request.contentType,
      })));
      if (firstResponses.length !== firstRequests.length) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = firstResponses.map((response) =>
        parseGlovoListingPage(parseJsonResponse(response, source), source));

      const remainingRequests = [];
      for (let index = 0; index < firstRequests.length; index += 1) {
        const pageCount = Math.ceil(pages[index].total / GLOVO_PAGE_SIZE);
        for (let page = 2; page <= pageCount; page += 1) {
          if (firstRequests.length + remainingRequests.length >= source.maxPages) {
            paginationLimited = true;
            break;
          }
          remainingRequests.push(buildGlovoListingRequest(
            source,
            firstRequests[index].searchTerm,
            page,
          ));
        }
      }
      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests.map((request) => ({
          url: request.url,
          method: "post",
          body: request.body,
          contentType: request.contentType,
        })));
        if (remainingResponses.length !== remainingRequests.length) {
          throw new Error("LISTING_RESPONSE_COUNT");
        }
        pages.push(...remainingResponses.map((response) =>
          parseGlovoListingPage(parseJsonResponse(response, source), source)));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const listingsById = new Map<string, GlovoListing>();
    for (const page of pages) {
      for (const listing of page.listings) {
        listingsById.set(listing.sourceJobId, listing);
      }
    }
    const allListings = [...listingsById.values()];
    const jobLimited = allListings.length > source.maxJobs;
    const boundedListings = allListings.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedListings.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedListings.length,
      ));
      continue;
    }

    const candidateListings = boundedListings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedListings.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedListings.length - candidateListings.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        glovoListing: listing,
        request: {
          url: buildGlovoDetailUrl(listing, source),
          method: "get",
        },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "OPTIVER")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let paginationLimited = false;
    let pages: ReturnType<typeof parseOptiverListingPage>[];

    try {
      const firstResponse = fetchMany([{
        url: buildOptiverListingUrl(source, 0),
        method: "get",
      }]);
      if (firstResponse.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      pages = [parseOptiverListingPage(parseJsonResponse(firstResponse[0], source), source)];

      const remainingRequests = [];
      for (let offset = OPTIVER_PAGE_SIZE; offset < pages[0].total; offset += OPTIVER_PAGE_SIZE) {
        if (1 + remainingRequests.length >= source.maxPages) {
          paginationLimited = true;
          break;
        }
        remainingRequests.push({
          url: buildOptiverListingUrl(source, offset),
          method: "get" as const,
        });
      }
      if (remainingRequests.length > 0) {
        const remainingResponses = fetchMany(remainingRequests);
        if (remainingResponses.length !== remainingRequests.length) {
          throw new Error("LISTING_RESPONSE_COUNT");
        }
        pages.push(...remainingResponses.map((response) =>
          parseOptiverListingPage(parseJsonResponse(response, source), source)));
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const listingsById = new Map<string, OptiverListing>();
    for (const page of pages) {
      for (const listing of page.listings) {
        listingsById.set(listing.sourceJobId, listing);
      }
    }
    const allListings = [...listingsById.values()];
    const jobLimited = allListings.length > source.maxJobs;
    const boundedListings = allListings.slice(0, source.maxJobs);
    const integrity = evaluateCountIntegrity(boundedListings.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        boundedListings.length,
      ));
      continue;
    }

    const candidateListings = boundedListings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const warnings = [
      ...(paginationLimited ? ["PAGINATION_LIMIT"] : []),
      ...(jobLimited ? ["JOB_LIMIT"] : []),
      ...(detailLimited ? ["DETAIL_LIMIT"] : []),
    ];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: boundedListings.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: boundedListings.length - candidateListings.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        optiverListing: listing,
        request: {
          url: assertAllowedHttpsUrl(
            `https://www.optiver.com${listing.detailPath}`,
            source.allowedHosts,
          ),
          method: "get",
        },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "PICNIC")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listings: PicnicListing[];
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      listings = parsePicnicSitemap(parseXmlResponse(responses[0], source), source);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(listings.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        listings.length,
      ));
      continue;
    }

    const candidateListings = listings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const warnings = detailLimited ? ["DETAIL_LIMIT"] : [];
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: warnings.length > 0 ? "PARTIAL" : "SUCCESS",
      listedJobs: listings.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: listings.length - candidateListings.length,
      },
      warnings,
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        picnicListing: listing,
        request: { url: listing.detailUrl, method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "NUS")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let sitemap: ReturnType<typeof parseNusSitemap>;
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      sitemap = parseNusSitemap(parseXmlResponse(responses[0], source), source);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(sitemap.total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        sitemap.total,
      ));
      continue;
    }

    const detailLimited = sitemap.listings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: sitemap.total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: sitemap.total - sitemap.listings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    let pending = sitemap.listings
      .slice(0, source.maxDetailJobs)
      .map((listing) => ({ listing, url: listing.detailUrl }));
    for (let hop = 0; hop < 2 && pending.length > 0; hop += 1) {
      const responses = fetchMany(pending.map(({ url }) => ({ url, method: "get" })));
      if (responses.length !== pending.length) {
        result.status = "PARTIAL";
        result.warnings.push("DETAIL_REDIRECT_RESPONSE_COUNT");
        pending = [];
        break;
      }
      const next: Array<{ listing: NusListing; url: string }> = [];
      pending.forEach(({ listing, url }, index) => {
        try {
          if (responses[index].byteLength > source.maxResponseBytes) {
            throw new Error("RESPONSE_TOO_LARGE");
          }
          next.push({
            listing,
            url: parseNusRedirect(responses[index].status, responses[index].location, url, source),
          });
        } catch (error) {
          result.status = "PARTIAL";
          const warning = normalizeSourceWarning(`DETAIL_${(error as Error).message}`);
          if (!result.warnings.includes(warning)) {
            result.warnings.push(warning);
          }
        }
      });
      pending = next;
    }

    if (pending.length > 0) {
      const responses = fetchMany(pending.map(({ url }) => ({ url, method: "get" })));
      if (responses.length !== pending.length) {
        result.status = "PARTIAL";
        result.warnings.push("DETAIL_RESPONSE_COUNT");
        continue;
      }
      pending.forEach(({ listing, url }, index) => {
        try {
          const job = parseNusDetail(
            parseHtmlResponse(responses[index], source),
            listing,
            url,
            source,
            startedAt,
          );
          const decision = matchCollectedJob(job, source);
          result.matches[decision.status] += 1;
          result.detailedJobs += 1;
          candidates.push({
            job,
            status: decision.status,
            reasons: decision.reasons,
          });
        } catch (error) {
          result.status = "PARTIAL";
          const warning = normalizeSourceWarning(`DETAIL_${(error as Error).message}`);
          if (!result.warnings.includes(warning)) {
            result.warnings.push(warning);
          }
        }
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "DELIVERY_HERO")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let sitemap: ReturnType<typeof parseDeliveryHeroSitemap>;
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      sitemap = parseDeliveryHeroSitemap(parseXmlResponse(responses[0], source), source);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(sitemap.total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        sitemap.total,
      ));
      continue;
    }

    const detailLimited = sitemap.listings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: sitemap.total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: sitemap.total - sitemap.listings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    for (const listing of sitemap.listings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        deliveryHeroListing: listing,
        request: { url: listing.detailUrl, method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "DEUTSCHE_BOERSE")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let sitemap: ReturnType<typeof parseDeutscheBoerseSitemap>;
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      sitemap = parseDeutscheBoerseSitemap(parseXmlResponse(responses[0], source), source);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(sitemap.total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        sitemap.total,
      ));
      continue;
    }

    const detailLimited = sitemap.listings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: sitemap.total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: sitemap.total - sitemap.listings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    for (const listing of sitemap.listings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        deutscheBoerseListing: listing,
        request: { url: listing.detailUrl, method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "BEC")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listing: ReturnType<typeof parseBecListing>;
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      listing = parseBecListing(parseHtmlResponse(responses[0], source), source);
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(listing.total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        listing.total,
      ));
      continue;
    }

    const detailLimited = listing.listings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: listing.total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: listing.total - listing.listings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    for (const item of listing.listings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        becListing: item,
        request: { url: item.detailUrl, method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "INESC_TEC")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listing: ReturnType<typeof parseInescTecListing>;
    try {
      const responses = fetchMany([{ url: source.endpoint, method: "get" }]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      listing = parseInescTecListing(
        parseHtmlResponse(responses[0], source),
        source,
        startedAt,
      );
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(listing.total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        listing.total,
      ));
      continue;
    }

    const detailLimited = listing.listings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: listing.total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: listing.total - listing.listings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    for (const item of listing.listings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        inescTecListing: item,
        request: { url: item.detailUrl, method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "ZALANDO")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listings: ZalandoListing[];
    let total: number;
    try {
      const firstResponses = fetchMany([{
        url: buildZalandoListingUrl(source, 0),
        method: "get",
      }]);
      if (firstResponses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      const firstPage = parseZalandoListingPage(
        parseJsonResponse(firstResponses[0], source),
        source,
        0,
      );
      total = firstPage.total;
      const offsets: number[] = [];
      for (let offset = ZALANDO_PAGE_SIZE; offset < total; offset += ZALANDO_PAGE_SIZE) {
        offsets.push(offset);
      }
      if (1 + offsets.length > source.maxPages) {
        throw new Error("PAGINATION_LIMIT");
      }
      const remainingResponses = offsets.length === 0 ? [] : fetchMany(offsets.map((offset) => ({
        url: buildZalandoListingUrl(source, offset),
        method: "get" as const,
      })));
      if (remainingResponses.length !== offsets.length) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      const pages = [
        firstPage,
        ...remainingResponses.map((response, index) => parseZalandoListingPage(
          parseJsonResponse(response, source),
          source,
          offsets[index],
        )),
      ];
      if (pages.some((page) => page.total !== total)) {
        throw new Error("LISTING_TOTAL_CHANGED");
      }
      const listingsById = new Map<string, ZalandoListing>();
      for (const page of pages) {
        for (const listing of page.listings) {
          if (listingsById.has(listing.sourceJobId)) {
            throw new Error("DUPLICATE_JOB_ID");
          }
          listingsById.set(listing.sourceJobId, listing);
        }
      }
      listings = [...listingsById.values()];
      if (listings.length !== total) {
        throw new Error("LISTING_INCOMPLETE");
      }
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(total, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        total,
      ));
      continue;
    }

    const candidateListings = listings.filter((listing) =>
      isPotentialTargetTitle(listing.title));
    const detailLimited = candidateListings.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: total,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: total - candidateListings.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
    };
    results.push(result);

    for (const listing of candidateListings.slice(0, source.maxDetailJobs)) {
      detailRequests.push({
        source,
        result,
        zalandoListing: listing,
        request: { url: buildZalandoDetailUrl(source, listing), method: "get" },
      });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "MERCEDES_TECH")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listingResponse: ShadowHttpResponse;
    let jobs: NormalizedJob[];
    try {
      const responses = fetchMany([conditionalListingRequest(source, previousIntegrity)]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      listingResponse = responses[0];
      const unchanged = notModifiedResult(source, listingResponse, previousIntegrity);
      if (unchanged) {
        results.push(unchanged);
        continue;
      }
      jobs = parseMercedesTechFeed(
        parseXmlResponse(listingResponse, source),
        source,
        startedAt,
      );
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(jobs.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        jobs.length,
      ));
      continue;
    }

    const candidateJobs = jobs.filter((job) => isPotentialTargetTitle(job.title));
    const detailLimited = candidateJobs.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: jobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: jobs.length - candidateJobs.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
      httpValidators: responseValidators(listingResponse),
      httpValidatorUrl: source.endpoint,
    };
    results.push(result);

    for (const job of candidateJobs.slice(0, source.maxDetailJobs)) {
      const decision = matchCollectedJob(job, source);
      result.matches[decision.status] += 1;
      result.detailedJobs += 1;
      candidates.push({ job, status: decision.status, reasons: decision.reasons });
    }
  }

  for (const source of runnableSources.filter((item) => item.adapter === "BOLT")) {
    const previousIntegrity = sourceIntegrityStates.get(source.sourceKey) ?? EMPTY_INTEGRITY;
    let listingResponse: ShadowHttpResponse;
    let jobs: NormalizedJob[];
    try {
      const responses = fetchMany([conditionalListingRequest(source, previousIntegrity)]);
      if (responses.length !== 1) {
        throw new Error("LISTING_RESPONSE_COUNT");
      }
      listingResponse = responses[0];
      const unchanged = notModifiedResult(source, listingResponse, previousIntegrity);
      if (unchanged) {
        results.push(unchanged);
        continue;
      }
      jobs = parseBoltResponse(
        parseHtmlResponse(listingResponse, source),
        source,
        startedAt,
      );
    } catch (error) {
      results.push(failedResult(source.sourceKey, (error as Error).message, {
        accepted: false,
        pendingCount: previousIntegrity.pendingCount,
        pendingConfirmations: previousIntegrity.pendingConfirmations,
      }));
      continue;
    }

    const integrity = evaluateCountIntegrity(jobs.length, previousIntegrity);
    if (!integrity.accepted) {
      results.push(failedResult(
        source.sourceKey,
        `COUNT_INTEGRITY_PENDING_${integrity.pendingConfirmations}`,
        integrity,
        jobs.length,
      ));
      continue;
    }

    const candidateJobs = jobs.filter((job) => isPotentialTargetTitle(job.title));
    const detailLimited = candidateJobs.length > source.maxDetailJobs;
    const result: SourceShadowResult = {
      sourceKey: source.sourceKey,
      status: detailLimited ? "PARTIAL" : "SUCCESS",
      listedJobs: jobs.length,
      detailedJobs: 0,
      matches: {
        ...emptyMatches(),
        EXCLUDED: jobs.length - candidateJobs.length,
      },
      warnings: detailLimited ? ["DETAIL_LIMIT"] : [],
      integrity,
      httpValidators: responseValidators(listingResponse),
      httpValidatorUrl: source.endpoint,
    };
    results.push(result);

    for (const job of candidateJobs.slice(0, source.maxDetailJobs)) {
      const decision = matchCollectedJob(job, source);
      result.matches[decision.status] += 1;
      result.detailedJobs += 1;
      candidates.push({ job, status: decision.status, reasons: decision.reasons });
    }
  }

  if (detailRequests.length > 0) {
    const detailResponses = fetchMany(detailRequests.map(({ request }) => request));
    if (detailResponses.length !== detailRequests.length) {
      throw new Error("HTTP client returned the wrong number of detail responses");
    }

    detailRequests.forEach(({
      source,
      result,
      optiverListing,
      glovoListing,
      picnicListing,
      deliveryHeroListing,
      deutscheBoerseListing,
      becListing,
      inescTecListing,
      zalandoListing,
    }, index) => {
      try {
        if (source.adapter === "DELIVERY_HERO") {
          const html = parseHtmlResponse(detailResponses[index], source);
          if (isExpiredDeliveryHeroDetail(html, deliveryHeroListing!, source)) {
            result.matches.EXCLUDED += 1;
            result.detailedJobs += 1;
            return;
          }
        }
        const job = source.adapter === "OPTIVER"
          ? parseOptiverDetail(
            parseHtmlResponse(detailResponses[index], source),
            optiverListing!,
            source,
            startedAt,
          )
          : source.adapter === "PICNIC"
            ? parsePicnicDetail(
              parseHtmlResponse(detailResponses[index], source),
              picnicListing!,
              source,
              startedAt,
            )
            : source.adapter === "DELIVERY_HERO"
              ? parseDeliveryHeroDetail(
                parseHtmlResponse(detailResponses[index], source),
                deliveryHeroListing!,
                source,
                startedAt,
              )
            : source.adapter === "DEUTSCHE_BOERSE"
              ? parseDeutscheBoerseDetail(
                parseHtmlResponse(detailResponses[index], source),
                deutscheBoerseListing!,
                source,
                startedAt,
              )
            : source.adapter === "BEC"
              ? parseBecDetail(
                parseHtmlResponse(detailResponses[index], source),
                becListing!,
                source,
                startedAt,
              )
            : source.adapter === "INESC_TEC"
              ? parseInescTecDetail(
                parseHtmlResponse(detailResponses[index], source),
                inescTecListing!,
                source,
                startedAt,
              )
            : source.adapter === "ZALANDO"
              ? parseZalandoDetail(
                parseJsonResponse(detailResponses[index], source),
                zalandoListing!,
                source,
                startedAt,
              )
            : source.adapter === "GLOVO"
            ? parseGlovoDetail(
              parseJsonResponse(detailResponses[index], source),
              glovoListing!,
              source,
              startedAt,
            )
            : source.adapter === "WORKDAY"
            ? parseWorkdayDetail(
              parseJsonResponse(detailResponses[index], source),
              source,
              startedAt,
            )
            : source.adapter === "SMARTRECRUITERS"
              ? parseSmartRecruitersDetail(
                parseJsonResponse(detailResponses[index], source),
                source,
                startedAt,
              )
              : parseResponse(
            { ...detailResponses[index], body: `{"jobs":[${detailResponses[index].body}]}` },
            source,
            startedAt,
          )[0];
          if (source.adapter === "WORKDAY" && !hasRequiredWorkdayAttribution(job, source)) {
            result.matches.EXCLUDED += 1;
            result.detailedJobs += 1;
            return;
          }
        const decision = matchCollectedJob(job, source);
        result.matches[decision.status] += 1;
        result.detailedJobs += 1;
        candidates.push({
          job,
          status: decision.status,
          reasons: decision.reasons,
        });
      } catch (error) {
        result.status = "PARTIAL";
        const warning = normalizeSourceWarning(`DETAIL_${(error as Error).message}`);
        if (!result.warnings.includes(warning)) {
          result.warnings.push(warning);
        }
      }
    });
  }

  return {
    report: {
      mode: "DEGRADED_SHADOW",
      requiredTargets,
      configuredTargets: new Set(sources.map((source) => source.company)).size,
      unsupportedTargets: targetCompanies.length > 0
        ? getUnsupportedTargets(sources, targetCompanies)
        : [],
      startedAt,
      completedAt: now().toISOString(),
      sources: results.map((result) => ({
        ...result,
        warnings: normalizeSourceWarnings(result.warnings),
      })),
    },
    candidates,
  };
}