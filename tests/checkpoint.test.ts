import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointIsExpired,
  completeCheckpointSources,
  createRunCheckpoint,
  parseRunCheckpoint,
  processCheckpointChunks,
  serializeRunCheckpoint,
  updateCheckpointRequestBudget,
} from "../src/checkpoint.ts";
import type { SourceShadowResult } from "../src/collector.ts";

function sourceResult(sourceKey: string): SourceShadowResult {
  return {
    sourceKey,
    status: "SUCCESS",
    listedJobs: 4,
    detailedJobs: 1,
    matches: { STRONG: 1, REVIEW: 0, EXCLUDED: 3 },
    warnings: [],
    integrity: { accepted: true, pendingCount: null, pendingConfirmations: 0 },
  };
}

test("resumes with only unfinished sources and a stable logical run ID", () => {
  const initial = createRunCheckpoint(
    ["source-a", "source-b", "source-c"],
    "2026-09-16T12:00:00.000Z",
    500,
  );
  const afterFirstChunk = completeCheckpointSources(
    initial,
    [sourceResult("source-a")],
    { initializedSources: 1, newCandidates: 2 },
    493,
  );
  const resumed = parseRunCheckpoint(
    serializeRunCheckpoint(afterFirstChunk),
    ["source-a", "source-b", "source-c"],
  );

  assert.equal(resumed.runId, initial.runId);
  assert.deepEqual(resumed.remainingSourceKeys, ["source-b", "source-c"]);
  assert.deepEqual(resumed.completedSources, [sourceResult("source-a")]);
  assert.deepEqual(resumed.persistence, { initializedSources: 1, newCandidates: 2 });
  assert.equal(resumed.remainingRequestAttempts, 493);
  assert.equal(resumed.responseBytes, 0);
});

test("rejects duplicate completion and request-budget amplification", () => {
  const initial = createRunCheckpoint(
    ["source-a", "source-b"],
    "2026-09-16T12:00:00.000Z",
    10,
  );
  assert.throws(() => completeCheckpointSources(
    initial,
    [sourceResult("source-a"), sourceResult("source-a")],
    { initializedSources: 0, newCandidates: 0 },
    9,
  ), /unexpected sources/);
  assert.throws(() => completeCheckpointSources(
    initial,
    [sourceResult("source-a")],
    { initializedSources: 0, newCandidates: 0 },
    11,
  ), /counters are invalid/);
  assert.throws(
    () => updateCheckpointRequestBudget(initial, 11),
    /request-attempt budget is invalid/,
  );
  assert.equal(updateCheckpointRequestBudget(initial, 4).remainingRequestAttempts, 4);
});

test("rejects corrupted, unknown, or incomplete checkpoint source partitions", () => {
  const checkpoint = createRunCheckpoint(
    ["source-a", "source-b"],
    "2026-09-16T12:00:00.000Z",
    10,
  );
  assert.throws(
    () => parseRunCheckpoint("not-json", ["source-a", "source-b"]),
    /not valid JSON/,
  );
  assert.throws(
    () => parseRunCheckpoint(
      serializeRunCheckpoint({ ...checkpoint, remainingSourceKeys: ["source-a"] }),
      ["source-a", "source-b"],
    ),
    /does not match the registry/,
  );
  assert.throws(
    () => parseRunCheckpoint(
      serializeRunCheckpoint({ ...checkpoint, remainingSourceKeys: ["source-a", "unknown"] }),
      ["source-a", "source-b"],
    ),
    /schema is invalid/,
  );
});

test("a forced deadline resumes without processing a completed source twice", () => {
  const initial = createRunCheckpoint(
    ["source-a", "source-b", "source-c"],
    "2026-09-16T12:00:00.000Z",
    10,
  );
  const processed: string[] = [];
  let clock = 0;
  const firstInvocation = processCheckpointChunks(initial, {
    deadlineAt: 10,
    chunkSize: 1,
    now: () => clock,
    saveCheckpoint: () => undefined,
    processChunk: ([sourceKey], remainingRequestAttempts) => {
      processed.push(sourceKey);
      clock = 10;
      return {
        status: "COMPLETE",
        sourceResults: [sourceResult(sourceKey)],
        persistence: { initializedSources: 0, newCandidates: 1 },
        remainingRequestAttempts: remainingRequestAttempts - 1,
        responseBytes: 100,
      };
    },
  });
  assert.equal(firstInvocation.status, "DEADLINE");
  assert.deepEqual(firstInvocation.checkpoint.remainingSourceKeys, ["source-b", "source-c"]);

  clock = 0;
  const secondInvocation = processCheckpointChunks(firstInvocation.checkpoint, {
    deadlineAt: 10,
    chunkSize: 1,
    now: () => clock,
    saveCheckpoint: () => undefined,
    processChunk: ([sourceKey], remainingRequestAttempts) => {
      processed.push(sourceKey);
      return {
        status: "COMPLETE",
        sourceResults: [sourceResult(sourceKey)],
        persistence: { initializedSources: 0, newCandidates: 1 },
        remainingRequestAttempts: remainingRequestAttempts - 1,
        responseBytes: 100,
      };
    },
  });
  assert.equal(secondInvocation.status, "COMPLETE");
  assert.deepEqual(processed, ["source-a", "source-b", "source-c"]);
  assert.equal(secondInvocation.checkpoint.remainingRequestAttempts, 7);
  assert.equal(secondInvocation.checkpoint.responseBytes, 300);
  assert.deepEqual(secondInvocation.checkpoint.persistence, {
    initializedSources: 0,
    newCandidates: 3,
  });
});

test("expires a checkpoint only after the twelve-hour recovery window", () => {
  const checkpoint = createRunCheckpoint(
    ["source-a"],
    "2026-09-16T00:00:00.000Z",
    10,
  );
  assert.equal(
    checkpointIsExpired(checkpoint, Date.parse("2026-09-16T12:00:00.000Z"), 43_200_000),
    false,
  );
  assert.equal(
    checkpointIsExpired(checkpoint, Date.parse("2026-09-16T12:00:00.001Z"), 43_200_000),
    true,
  );
});
