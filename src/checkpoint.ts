import type { SourceShadowResult } from "./collector.ts";
import { normalizeSourceWarnings } from "./operations.ts";
import { normalizeHttpValidators } from "./transport.ts";

export interface CheckpointPersistence {
  initializedSources: number;
  newCandidates: number;
}

export interface RunCheckpoint {
  version: 1;
  runId: string;
  startedAt: string;
  remainingSourceKeys: string[];
  completedSources: SourceShadowResult[];
  persistence: CheckpointPersistence;
  remainingRequestAttempts: number;
  responseBytes: number;
}

export type CheckpointChunkResult =
  | {
    status: "COMPLETE";
    sourceResults: SourceShadowResult[];
    persistence: CheckpointPersistence;
    remainingRequestAttempts: number;
    responseBytes: number;
  }
  | {
    status: "DEADLINE" | "REQUEST_BUDGET";
    remainingRequestAttempts: number;
    responseBytes: number;
  };

export interface CheckpointCoordinatorOptions {
  deadlineAt: number;
  chunkSize: number;
  now: () => number;
  processChunk: (
    sourceKeys: readonly string[],
    remainingRequestAttempts: number,
  ) => CheckpointChunkResult;
  saveCheckpoint: (checkpoint: RunCheckpoint) => void;
}

export interface CheckpointCoordinatorResult {
  status: "COMPLETE" | "DEADLINE" | "REQUEST_BUDGET";
  checkpoint: RunCheckpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function validateCheckpointSourceResult(
  value: unknown,
  allowedSourceKeys: ReadonlySet<string>,
): SourceShadowResult {
  if (!isRecord(value)
    || typeof value.sourceKey !== "string"
    || !allowedSourceKeys.has(value.sourceKey)
    || !["SUCCESS", "PARTIAL", "FAILED"].includes(String(value.status))
    || !isNonNegativeInteger(value.listedJobs)
    || !isNonNegativeInteger(value.detailedJobs)
    || !isRecord(value.matches)
    || !isNonNegativeInteger(value.matches.STRONG)
    || !isNonNegativeInteger(value.matches.REVIEW)
    || !isNonNegativeInteger(value.matches.EXCLUDED)
    || !Array.isArray(value.warnings)
    || value.warnings.some((warning) => typeof warning !== "string" || warning.length > 200)
    || !isRecord(value.integrity)
    || !(value.integrity.pendingCount === null
      || isNonNegativeInteger(value.integrity.pendingCount))
    || !isNonNegativeInteger(value.integrity.pendingConfirmations)
    || typeof value.integrity.accepted !== "boolean"
    || !(value.unchanged === undefined || typeof value.unchanged === "boolean")
    || !(value.httpValidatorUrl === undefined
      || (typeof value.httpValidatorUrl === "string"
        && value.httpValidatorUrl.length <= 2_082
        && /^https:\/\//.test(value.httpValidatorUrl)))
    || !(value.httpValidators === undefined
      || (isRecord(value.httpValidators)
        && value.httpValidators.etag === normalizeHttpValidators(
          typeof value.httpValidators.etag === "string" ? value.httpValidators.etag : null,
          null,
        ).etag
        && value.httpValidators.lastModified === normalizeHttpValidators(
          null,
          typeof value.httpValidators.lastModified === "string"
            ? value.httpValidators.lastModified
            : null,
        ).lastModified))) {
    throw new Error("Invalid checkpoint source result");
  }
  return {
    ...(value as unknown as SourceShadowResult),
    warnings: normalizeSourceWarnings(value.warnings as string[]),
  };
}

function assertSourcePartition(
  remainingSourceKeys: string[],
  completedSources: SourceShadowResult[],
  expectedSourceKeys: readonly string[],
): void {
  const combined = [
    ...remainingSourceKeys,
    ...completedSources.map(({ sourceKey }) => sourceKey),
  ];
  if (new Set(combined).size !== combined.length
    || combined.length !== expectedSourceKeys.length
    || expectedSourceKeys.some((sourceKey) => !combined.includes(sourceKey))) {
    throw new Error("Checkpoint source partition does not match the registry");
  }
}

export function createRunCheckpoint(
  sourceKeys: readonly string[],
  startedAt: string,
  requestAttemptBudget: number,
): RunCheckpoint {
  if (sourceKeys.length === 0 || new Set(sourceKeys).size !== sourceKeys.length) {
    throw new Error("Checkpoint source keys must be unique and non-empty");
  }
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new Error("Checkpoint start time is invalid");
  }
  if (!isNonNegativeInteger(requestAttemptBudget) || requestAttemptBudget === 0) {
    throw new Error("Checkpoint request-attempt budget must be positive");
  }
  return {
    version: 1,
    runId: `shadow:${startedAt}`,
    startedAt,
    remainingSourceKeys: [...sourceKeys],
    completedSources: [],
    persistence: { initializedSources: 0, newCandidates: 0 },
    remainingRequestAttempts: requestAttemptBudget,
    responseBytes: 0,
  };
}

export function checkpointIsExpired(
  checkpoint: RunCheckpoint,
  now: number,
  maximumAgeMs: number,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(maximumAgeMs) || maximumAgeMs < 0) {
    throw new Error("Checkpoint expiry inputs are invalid");
  }
  const startedAt = Date.parse(checkpoint.startedAt);
  return !Number.isFinite(startedAt) || now - startedAt > maximumAgeMs;
}

export function completeCheckpointSources(
  checkpoint: RunCheckpoint,
  sourceResults: readonly SourceShadowResult[],
  persistence: CheckpointPersistence,
  remainingRequestAttempts: number,
  responseBytes = 0,
): RunCheckpoint {
  const completedKeys = sourceResults.map(({ sourceKey }) => sourceKey);
  if (completedKeys.length === 0
    || new Set(completedKeys).size !== completedKeys.length
    || completedKeys.some((sourceKey) => !checkpoint.remainingSourceKeys.includes(sourceKey))) {
    throw new Error("Checkpoint completion contains unexpected sources");
  }
  if (!isNonNegativeInteger(persistence.initializedSources)
    || !isNonNegativeInteger(persistence.newCandidates)
    || !isNonNegativeInteger(remainingRequestAttempts)
    || remainingRequestAttempts > checkpoint.remainingRequestAttempts
    || !isNonNegativeInteger(responseBytes)) {
    throw new Error("Checkpoint completion counters are invalid");
  }
  return {
    ...checkpoint,
    remainingSourceKeys: checkpoint.remainingSourceKeys.filter(
      (sourceKey) => !completedKeys.includes(sourceKey),
    ),
    completedSources: [...checkpoint.completedSources, ...sourceResults],
    persistence: {
      initializedSources: checkpoint.persistence.initializedSources
        + persistence.initializedSources,
      newCandidates: checkpoint.persistence.newCandidates + persistence.newCandidates,
    },
    remainingRequestAttempts,
    responseBytes: checkpoint.responseBytes + responseBytes,
  };
}

export function updateCheckpointRequestBudget(
  checkpoint: RunCheckpoint,
  remainingRequestAttempts: number,
  responseBytes = 0,
): RunCheckpoint {
  if (!isNonNegativeInteger(remainingRequestAttempts)
    || remainingRequestAttempts > checkpoint.remainingRequestAttempts
    || !isNonNegativeInteger(responseBytes)) {
    throw new Error("Checkpoint request-attempt budget is invalid");
  }
  return {
    ...checkpoint,
    remainingRequestAttempts,
    responseBytes: checkpoint.responseBytes + responseBytes,
  };
}

export function processCheckpointChunks(
  initialCheckpoint: RunCheckpoint,
  options: CheckpointCoordinatorOptions,
): CheckpointCoordinatorResult {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new Error("Checkpoint chunk size must be positive");
  }
  let checkpoint = initialCheckpoint;
  while (checkpoint.remainingSourceKeys.length > 0) {
    if (options.now() >= options.deadlineAt) {
      options.saveCheckpoint(checkpoint);
      return { status: "DEADLINE", checkpoint };
    }
    options.saveCheckpoint(checkpoint);
    const chunkKeys = checkpoint.remainingSourceKeys.slice(0, options.chunkSize);
    const result = options.processChunk(chunkKeys, checkpoint.remainingRequestAttempts);
    if (result.status !== "COMPLETE") {
      checkpoint = updateCheckpointRequestBudget(
        checkpoint,
        result.remainingRequestAttempts,
        result.responseBytes,
      );
      options.saveCheckpoint(checkpoint);
      return { status: result.status, checkpoint };
    }
    checkpoint = completeCheckpointSources(
      checkpoint,
      result.sourceResults,
      result.persistence,
      result.remainingRequestAttempts,
      result.responseBytes,
    );
    options.saveCheckpoint(checkpoint);
  }
  return { status: "COMPLETE", checkpoint };
}

export function serializeRunCheckpoint(checkpoint: RunCheckpoint): string {
  return JSON.stringify(checkpoint);
}

export function parseRunCheckpoint(
  serialized: string,
  expectedSourceKeys: readonly string[],
): RunCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Checkpoint is not valid JSON");
  }
  const allowedSourceKeys = new Set(expectedSourceKeys);
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.runId !== "string"
    || typeof value.startedAt !== "string"
    || value.runId !== `shadow:${value.startedAt}`
    || !Number.isFinite(Date.parse(value.startedAt))
    || !Array.isArray(value.remainingSourceKeys)
    || value.remainingSourceKeys.some((sourceKey) =>
      typeof sourceKey !== "string" || !allowedSourceKeys.has(sourceKey))
    || !Array.isArray(value.completedSources)
    || !isRecord(value.persistence)
    || !isNonNegativeInteger(value.persistence.initializedSources)
    || !isNonNegativeInteger(value.persistence.newCandidates)
    || !isNonNegativeInteger(value.remainingRequestAttempts)
    || !(value.responseBytes === undefined || isNonNegativeInteger(value.responseBytes))) {
    throw new Error("Checkpoint schema is invalid");
  }
  const completedSources = value.completedSources.map((sourceResult) =>
    validateCheckpointSourceResult(sourceResult, allowedSourceKeys));
  const checkpoint: RunCheckpoint = {
    version: 1,
    runId: value.runId,
    startedAt: value.startedAt,
    remainingSourceKeys: value.remainingSourceKeys as string[],
    completedSources,
    persistence: {
      initializedSources: value.persistence.initializedSources,
      newCandidates: value.persistence.newCandidates,
    },
    remainingRequestAttempts: value.remainingRequestAttempts,
    responseBytes: value.responseBytes === undefined ? 0 : value.responseBytes,
  };
  assertSourcePartition(
    checkpoint.remainingSourceKeys,
    checkpoint.completedSources,
    expectedSourceKeys,
  );
  return checkpoint;
}
