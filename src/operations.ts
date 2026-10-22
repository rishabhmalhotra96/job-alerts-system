export const SOURCE_WARNING_CATEGORIES = [
  "NOT_MODIFIED",
  "CIRCUIT_OPEN",
  "SOURCE_DISABLED",
  "DETAIL_LIMIT",
  "PAGINATION_LIMIT",
  "COUNT_INTEGRITY_PENDING",
  "RUN_REQUEST_BUDGET_EXHAUSTED",
  "LISTING_RESPONSE_COUNT",
  "DETAIL_RESPONSE_COUNT",
  "DETAIL_REDIRECT_RESPONSE_COUNT",
  "HTTP_STATUS",
  "CONTENT_TYPE",
  "RESPONSE_TOO_LARGE",
  "INVALID_JSON",
  "URL_INVALID",
  "SCHEMA_INVALID",
  "DETAIL_HTTP_STATUS",
  "DETAIL_CONTENT_TYPE",
  "DETAIL_RESPONSE_TOO_LARGE",
  "DETAIL_INVALID_JSON",
  "DETAIL_URL_INVALID",
  "DETAIL_SCHEMA_INVALID",
] as const;

export type SourceWarningCategory = typeof SOURCE_WARNING_CATEGORIES[number];

const CATEGORY_SET = new Set<string>(SOURCE_WARNING_CATEGORIES);

export function isSourceWarningCategory(value: unknown): value is SourceWarningCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

function baseWarningCategory(warning: string): SourceWarningCategory {
  if (isSourceWarningCategory(warning)) {
    return warning;
  }
  if (/^COUNT_INTEGRITY_PENDING(?:_\d+)?$/.test(warning)) {
    return "COUNT_INTEGRITY_PENDING";
  }
  if (/URL|allowlist|HTTPS|credential|private|local address|redirect/i.test(warning)) {
    return "URL_INVALID";
  }
  if (/CONTENT[_ -]?TYPE/i.test(warning)) {
    return "CONTENT_TYPE";
  }
  if (/RESPONSE[_ -]?TOO[_ -]?LARGE|exceeds? (?:its )?(?:size|byte)/i.test(warning)) {
    return "RESPONSE_TOO_LARGE";
  }
  if (/JSON/i.test(warning)) {
    return "INVALID_JSON";
  }
  if (/HTTP[_ -]?STATUS/i.test(warning)) {
    return "HTTP_STATUS";
  }
  return "SCHEMA_INVALID";
}

export function normalizeSourceWarning(warning: string): SourceWarningCategory {
  if (warning.startsWith("DETAIL_") && !isSourceWarningCategory(warning)) {
    const category = baseWarningCategory(warning.slice("DETAIL_".length));
    switch (category) {
      case "HTTP_STATUS":
        return "DETAIL_HTTP_STATUS";
      case "CONTENT_TYPE":
        return "DETAIL_CONTENT_TYPE";
      case "RESPONSE_TOO_LARGE":
        return "DETAIL_RESPONSE_TOO_LARGE";
      case "INVALID_JSON":
        return "DETAIL_INVALID_JSON";
      case "URL_INVALID":
        return "DETAIL_URL_INVALID";
      default:
        return "DETAIL_SCHEMA_INVALID";
    }
  }
  return baseWarningCategory(warning);
}

export function normalizeSourceWarnings(warnings: readonly string[]): SourceWarningCategory[] {
  return [...new Set(warnings.map(normalizeSourceWarning))];
}
