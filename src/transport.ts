export interface HttpValidators {
  etag: string | null;
  lastModified: string | null;
}

const MAX_ETAG_LENGTH = 512;
const MAX_LAST_MODIFIED_LENGTH = 128;

export function normalizeEtag(value: string | undefined | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > MAX_ETAG_LENGTH
    || !/^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeLastModified(value: string | undefined | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > MAX_LAST_MODIFIED_LENGTH || !/^[\x20-\x7e]+$/.test(normalized)) {
    return null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : null;
}

export function normalizeHttpValidators(
  etag: string | undefined | null,
  lastModified: string | undefined | null,
): HttpValidators {
  return {
    etag: normalizeEtag(etag),
    lastModified: normalizeLastModified(lastModified),
  };
}

export function hasHttpValidators(validators: HttpValidators): boolean {
  return validators.etag !== null || validators.lastModified !== null;
}
