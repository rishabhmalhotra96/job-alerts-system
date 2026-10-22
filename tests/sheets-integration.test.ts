import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectShadow,
  type ShadowCollection,
  type ShadowHttpResponse,
} from "../src/collector.ts";
import { deliverOldestDigest } from "../src/delivery.ts";
import { renderDigest } from "../src/digest.ts";
import { ownerFingerprintMaterial } from "../src/delivery-policy.ts";
import type { NormalizedJob, SourceDefinition } from "../src/domain.ts";
import {
  applyMvpJobOverride,
  clearMvpJobOverride,
  runMvpWatchdog,
} from "../src/main.ts";
import { MVP_SOURCES } from "../src/sources.ts";
import {
  appendSkippedLockedRun,
  appendShadowRun,
  assertRecentCompletedRun,
  markNotificationBatchSendFailed,
  markNotificationBatchSent,
  persistShadowCollection,
  readAcceptanceRunEvidence,
  readAppliedRunProgress,
  readJobOverrides,
  readLatestCompletedRunHealth,
  readNotificationBatches,
  readNotificationDigestInput,
  readSourceHealth,
  readSourceIntegrityStates,
  recoverStaleNotificationBatches,
  resetSourceCircuit,
  setupMvpSheets,
  startOldestPendingNotificationBatch,
  upsertJobOverride,
} from "../src/sheets.ts";

globalThis.Utilities = {
  Charset: { UTF_8: "UTF-8" },
  DigestAlgorithm: { SHA_256: "SHA_256" },
  computeDigest: (_algorithm: unknown, value: string) =>
    [...createHash("sha256").update(value, "utf8").digest()]
      .map((byte) => byte > 127 ? byte - 256 : byte),
} as unknown as typeof Utilities;

class FakeSheet {
  readonly rows: unknown[][] = [];
  failNextSetValues = false;
  protectionWarningOnly: boolean | null = null;

  getLastColumn(): number {
    return this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  }

  getLastRow(): number {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (this.rows[index].some((value) => value !== "" && value !== undefined)) {
        return index + 1;
      }
    }
    return 0;
  }

  getRange(startRow: number, startColumn: number, rowCount: number, columnCount: number) {
    return {
      getValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) =>
          this.rows[startRow - 1 + rowOffset]?.[startColumn - 1 + columnOffset] ?? "")),
      setValues: (values: unknown[][]) => {
        if (this.failNextSetValues) {
          this.failNextSetValues = false;
          throw new Error("INJECTED_SHEET_WRITE_FAILURE");
        }
        values.forEach((row, rowOffset) => {
          const rowIndex = startRow - 1 + rowOffset;
          this.rows[rowIndex] ??= [];
          row.forEach((value, columnOffset) => {
            this.rows[rowIndex][startColumn - 1 + columnOffset] = value;
          });
        });
      },
      clearContent: () => {
        for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
          for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
            const row = this.rows[startRow - 1 + rowOffset];
            if (row) {
              row[startColumn - 1 + columnOffset] = "";
            }
          }
        }
      },
    } as GoogleAppsScript.Spreadsheet.Range;
  }

  setFrozenRows(): void {}

  protect(): GoogleAppsScript.Spreadsheet.Protection {
    const sheet = this;
    const protection = {
      setDescription: () => protection,
      setWarningOnly: (value: boolean) => {
        sheet.protectionWarningOnly = value;
        return protection;
      },
    };
    return protection as unknown as GoogleAppsScript.Spreadsheet.Protection;
  }

  appendRow(row: unknown[]): void {
    this.rows[this.getLastRow()] = [...row];
  }
}

class FakeSpreadsheet {
  readonly sheets = new Map<string, FakeSheet>();

  getSheetByName(name: string): GoogleAppsScript.Spreadsheet.Sheet | null {
    return (this.sheets.get(name) as unknown as GoogleAppsScript.Spreadsheet.Sheet) ?? null;
  }

  insertSheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = new FakeSheet();
    this.sheets.set(name, sheet);
    return sheet as unknown as GoogleAppsScript.Spreadsheet.Sheet;
  }

  getUrl(): string {
    return "https://docs.google.com/spreadsheets/d/private_sheet_id/edit";
  }
}

const sourceDefinition: SourceDefinition = {
  sourceKey: "source-a",
  company: "Example",
  adapter: "GREENHOUSE",
  endpoint: "https://example.com/jobs",
  allowedHosts: ["example.com"],
  maxJobs: 100,
  maxResponseBytes: 100_000,
  maxDetailJobs: 20,
  maxPages: 1,
};

function job(sourceJobId: string, fetchedAt: string, sourceKey = "source-a"): NormalizedJob {
  return {
    sourceKey,
    company: "Example",
    sourceJobId,
    title: "Senior Machine Learning Engineer",
    descriptionText: "Machine learning",
    descriptionCompleteness: "FULL",
    locationText: "Amsterdam, Netherlands",
    countryCodes: ["NL"],
    workplaceType: null,
    employmentType: "Full-time",
    publishedAt: null,
    updatedAt: null,
    canonicalUrl: `https://example.com/jobs/${sourceJobId}`,
    fetchedAt,
  };
}

function collection(
  startedAt: string,
  completedAt: string,
  jobs: NormalizedJob[],
  sourceKey = "source-a",
): ShadowCollection {
  return {
    report: {
      mode: "DEGRADED_SHADOW",
      requiredTargets: 1,
      configuredTargets: 1,
      unsupportedTargets: [],
      startedAt,
      completedAt,
      sources: [{
        sourceKey,
        status: "SUCCESS",
        listedJobs: jobs.length,
        detailedJobs: jobs.length,
        matches: { STRONG: jobs.length, REVIEW: 0, EXCLUDED: 0 },
        warnings: [],
        integrity: { accepted: true, pendingCount: null, pendingConfirmations: 0 },
      }],
    },
    candidates: jobs.map((candidate) => ({
      job: candidate,
      status: "STRONG",
      reasons: ["title:machine-learning-engineer", "location:eligible"],
    })),
  };
}

function installOverrideOwnerGlobals() {
  const originalLock = globalThis.LockService;
  const originalProperties = globalThis.PropertiesService;
  const originalScript = globalThis.ScriptApp;
  const originalSession = globalThis.Session;
  const email = "owner@example.com";
  const scriptId = "script_ID-1";
  const fingerprint = createHash("sha256")
    .update(ownerFingerprintMaterial(email, scriptId), "utf8")
    .digest("hex");
  const values = new Map<string, string>([["JOB_ALERTS_OWNER_FINGERPRINT", fingerprint]]);
  let effectiveEmail = email;
  const properties = {
    getProperty: (key: string) => values.get(key) ?? null,
    setProperty: (key: string, value: string) => {
      values.set(key, value);
      return properties;
    },
    deleteProperty: (key: string) => {
      values.delete(key);
      return properties;
    },
  };
  globalThis.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }),
  } as unknown as GoogleAppsScript.Lock.LockService;
  globalThis.PropertiesService = {
    getScriptProperties: () => properties,
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.ScriptApp = {
    getScriptId: () => scriptId,
  } as unknown as GoogleAppsScript.Script.ScriptApp;
  globalThis.Session = {
    getEffectiveUser: () => ({ getEmail: () => effectiveEmail }),
  } as unknown as GoogleAppsScript.Base.Session;
  return {
    fingerprint,
    values,
    setEffectiveEmail: (value: string) => {
      effectiveEmail = value;
    },
    restore: () => {
      globalThis.LockService = originalLock;
      globalThis.PropertiesService = originalProperties;
      globalThis.ScriptApp = originalScript;
      globalThis.Session = originalSession;
    },
  };
}

test("replaying an applied source run does not duplicate or advance job state", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-09-16T09:00:00.000Z";
    persistShadowCollection(
      collection(
        baselineStartedAt,
        "2026-09-16T09:05:00.000Z",
        [job("old-job", baselineStartedAt)],
      ),
      { appendRun: false, runId: `shadow:${baselineStartedAt}`, logicalStartedAt: baselineStartedAt },
    );

    const runStartedAt = "2026-09-16T12:00:00.000Z";
    const current = collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    );
    assert.deepEqual(persistShadowCollection(current, {
      appendRun: false,
      runId: `shadow:${runStartedAt}`,
      logicalStartedAt: runStartedAt,
    }), { initializedSources: 0, newCandidates: 1 });

    assert.deepEqual(persistShadowCollection(current, {
      appendRun: false,
      runId: `shadow:${runStartedAt}`,
      logicalStartedAt: runStartedAt,
    }), { initializedSources: 0, newCandidates: 0 });

    const jobRows = spreadsheet.sheets.get("Jobs")!.rows.slice(1);
    assert.equal(jobRows.filter((row) => row[1] === "new-job").length, 1);
    assert.equal(jobRows.find((row) => row[1] === "old-job")?.[12], 1);
    assert.deepEqual(readAppliedRunProgress(`shadow:${runStartedAt}`), [{
      source: current.report.sources[0],
      persistence: { initializedSources: 0, newCandidates: 1 },
    }]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("failed and partial source chunks do not infer job absence", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-09-16T09:00:00.000Z";
    const baseline = collection(
      baselineStartedAt,
      "2026-09-16T09:05:00.000Z",
      [job("existing-job", baselineStartedAt)],
    );
    persistShadowCollection(baseline, {
      appendRun: false,
      runId: `shadow:${baselineStartedAt}`,
      logicalStartedAt: baselineStartedAt,
    });

    for (const status of ["PARTIAL", "FAILED"] as const) {
      const startedAt = status === "PARTIAL"
        ? "2026-09-16T12:00:00.000Z"
        : "2026-09-16T15:00:00.000Z";
      const incomplete = collection(startedAt, startedAt, []);
      incomplete.report.sources[0].status = status;
      persistShadowCollection(incomplete, {
        appendRun: false,
        runId: `shadow:${startedAt}`,
        logicalStartedAt: startedAt,
      });
    }

    const existingRow = spreadsheet.sheets.get("Jobs")!.rows
      .slice(1)
      .find((row) => row[1] === "existing-job");
    assert.equal(existingRow?.[12], 0);
    assert.equal(existingRow?.[13], "");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("appending a terminal logical run is idempotent", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const current = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [],
    );
    const runId = "shadow:2026-09-16T12:00:00.000Z";
    assert.equal(appendShadowRun(current.report, runId, {
      requestAttempts: 17,
      responseBytes: 1_234,
      initializedSources: 1,
      newCandidates: 2,
    }), true);
    assert.equal(appendShadowRun(current.report, runId, {
      requestAttempts: 17,
      responseBytes: 1_234,
      initializedSources: 1,
      newCandidates: 2,
    }), false);
    const runRows = spreadsheet.sheets.get("Runs")!.rows.slice(1);
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0][8], runId);
    assert.deepEqual(runRows[0].slice(9, 12), [17, 1, 2]);
    assert.deepEqual(
      readAcceptanceRunEvidence(
        "2026-09-16T12:00:00.000Z",
        "2026-09-16T12:06:00.000Z",
      ).map((run) => ({
        requestAttempts: run.requestAttempts,
        responseBytes: run.responseBytes,
        initializedSources: run.initializedSources,
        newCandidates: run.newCandidates,
        sourceIssues: run.sourceIssues,
      })),
      [{ requestAttempts: 17, responseBytes: 1_234, initializedSources: 1, newCandidates: 2, sourceIssues: [] }],
    );
    current.report.sources[0].status = "PARTIAL";
    current.report.sources[0].warnings = ["HTTP_STATUS"];
    assert.equal(appendShadowRun(current.report, "shadow:partial", {
      requestAttempts: 3,
      responseBytes: 456,
      initializedSources: 0,
      newCandidates: 0,
    }), true);
    assert.deepEqual(
      readAcceptanceRunEvidence(
        "2026-09-16T12:00:00.000Z",
        "2026-09-16T12:06:00.000Z",
      ).at(-1)?.sourceIssues,
      [{ sourceKey: "source-a", status: "PARTIAL", warnings: ["HTTP_STATUS"] }],
    );
    spreadsheet.sheets.get("Runs")!.rows.at(-1)![6] = "{corrupt";
    assert.throws(
      () => readAcceptanceRunEvidence(
        "2026-09-16T12:00:00.000Z",
        "2026-09-16T12:06:00.000Z",
      ),
      /ACCEPTANCE_RUN_STATE_INVALID/,
    );
    assert.throws(() => appendShadowRun(current.report, "shadow:invalid", {
      requestAttempts: 501,
      responseBytes: 0,
      initializedSources: 0,
      newCandidates: 0,
    }), /RUN_METRICS_INVALID/);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("a skipped locked run appends only bounded Runs metadata", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    const occurredAt = "2026-09-16T18:00:00.000Z";
    assert.equal(appendSkippedLockedRun(occurredAt, 22, 28, ["Unsupported"]), true);
    assert.equal(appendSkippedLockedRun(occurredAt, 22, 28, ["Unsupported"]), false);
    assert.equal(spreadsheet.sheets.get("Runs")!.rows[1].length, 13);
    assert.equal(spreadsheet.sheets.get("Runs")!.rows[1][12], 0);
    assert.deepEqual([...spreadsheet.sheets.keys()], ["Runs"]);
    assert.deepEqual(spreadsheet.sheets.get("Runs")!.rows[1], [
      occurredAt,
      occurredAt,
      "DEGRADED_SHADOW",
      "SKIPPED_LOCKED",
      22,
      28,
      "[]",
      "[\"Unsupported\"]",
      `skipped-locked:${occurredAt}`,
      0,
      0,
      0,
      0,
    ]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("a skipped locked row does not satisfy or replace completed-run health", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    const current = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [],
    );
    appendShadowRun(current.report);
    appendSkippedLockedRun("2026-09-16T12:00:00.000Z", 22, 28, []);
    assert.equal(
      assertRecentCompletedRun(new Date("2026-09-16T12:30:00.000Z")),
      "2026-09-16T09:05:00.000Z",
    );
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("latest completed run health includes bounded coverage and duration data", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    const completed = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [],
    );
    completed.report.requiredTargets = 2;
    completed.report.unsupportedTargets = ["Waived Company"];
    appendShadowRun(completed.report);
    appendSkippedLockedRun("2026-09-16T12:00:00.000Z", 1, 2, ["Waived Company"]);

    assert.deepEqual(readLatestCompletedRunHealth(), {
      startedAt: "2026-09-16T09:00:00.000Z",
      completedAt: "2026-09-16T09:05:00.000Z",
      durationMs: 300_000,
      status: "FULL_SUCCESS",
      configuredTargets: 1,
      requiredTargets: 2,
      unsupportedTargets: ["Waived Company"],
    });
    spreadsheet.sheets.get("Runs")!.rows[1][7] = "{corrupt";
    assert.throws(
      () => readLatestCompletedRunHealth(),
      /^Error: WATCHDOG_RUN_STATE_INVALID$/,
    );
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("watchdog is silent while paused and stale SHADOW throws without MailApp", () => {
  const originalProperties = globalThis.PropertiesService;
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const originalMail = globalThis.MailApp;
  const spreadsheet = new FakeSpreadsheet();
  let mode = "PAUSED";
  let mailCalls = 0;
  globalThis.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => mode }),
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;
  globalThis.MailApp = {
    sendEmail: () => {
      mailCalls += 1;
    },
  } as unknown as GoogleAppsScript.Mail.MailApp;

  try {
    assert.deepEqual(JSON.parse(runMvpWatchdog()), { mode: "PAUSED", status: "NO_CHECK" });
    mode = "SHADOW";
    assert.throws(() => runMvpWatchdog(), /^Error: WATCHDOG_NO_COMPLETED_RUN$/);
    assert.equal(mailCalls, 0);
  } finally {
    globalThis.PropertiesService = originalProperties;
    globalThis.SpreadsheetApp = originalSpreadsheet;
    globalThis.MailApp = originalMail;
  }
});

test("P3 SourceState migration appends health columns without changing existing data", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const sourceSheet = spreadsheet.insertSheet("SourceState") as unknown as FakeSheet;
  const oldHeaders = [
    "source_key", "initialized_at", "last_success_at", "last_count", "last_status",
    "warnings", "pending_count", "pending_confirmations", "consecutive_failures",
    "circuit_opened_at", "last_applied_run_id", "last_run_result",
    "last_run_initialized_sources", "last_run_new_candidates", "etag",
    "last_modified", "http_validator_url",
  ];
  const oldRow = [
    "source-a", "2026-09-16T09:00:00.000Z", "2026-09-16T09:05:00.000Z", 1,
    "SUCCESS", "", "", 0, 0, "", "shadow:old", "{}", 1, 0, '"etag"', "",
    "https://example.com/jobs",
  ];
  sourceSheet.rows.push(oldHeaders, oldRow);
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    assert.deepEqual(sourceSheet.rows[1].slice(0, oldRow.length), oldRow);
    assert.deepEqual(sourceSheet.rows[0].slice(17), [
      "last_attempt_at",
      "last_verified_at",
      "last_error_category",
      "operationally_disabled",
    ]);
    assert.deepEqual(readSourceHealth(
      new Date("2026-09-16T12:00:00.000Z"),
      ["source-a", "missing-source"],
    ).map(({ sourceKey, status }) => ({ sourceKey, status })), [
      { sourceKey: "source-a", status: "HEALTHY" },
      { sourceKey: "missing-source", status: "STALE" },
    ]);

    const failed = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [],
    );
    failed.report.sources[0] = {
      ...failed.report.sources[0],
      status: "FAILED",
      warnings: ["HTTP_STATUS"],
      integrity: { accepted: false, pendingCount: null, pendingConfirmations: 0 },
    };
    persistShadowCollection(failed, { appendRun: false, runId: "shadow:failed" });
    assert.equal(sourceSheet.rows[1][18], "2026-09-16T09:05:00.000Z");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("source failures persist only categories and preserve verified state", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baseline = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("existing-job", "2026-09-16T09:00:00.000Z")],
    );
    persistShadowCollection(baseline, { appendRun: false, runId: "shadow:baseline" });

    const failed = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [],
    );
    failed.report.sources[0] = {
      ...failed.report.sources[0],
      status: "FAILED",
      warnings: ["upstream response contained secret-token-value"],
      integrity: { accepted: false, pendingCount: null, pendingConfirmations: 0 },
    };
    persistShadowCollection(failed, { appendRun: false, runId: "shadow:failed" });

    const sourceRow = spreadsheet.sheets.get("SourceState")!.rows[1];
    assert.equal(sourceRow[5], "SCHEMA_INVALID");
    assert.doesNotMatch(String(sourceRow[11]), /secret-token-value/);
    assert.equal(sourceRow[17], "2026-09-16T12:05:00.000Z");
    assert.equal(sourceRow[18], "2026-09-16T09:05:00.000Z");
    assert.equal(sourceRow[19], "SCHEMA_INVALID");
    assert.deepEqual(readSourceHealth(
      new Date("2026-09-16T12:10:00.000Z"),
      ["source-a"],
    )[0], {
      sourceKey: "source-a",
      status: "FAILING",
      lastCount: 1,
      lastAttemptAt: "2026-09-16T12:05:00.000Z",
      lastVerifiedAt: "2026-09-16T09:05:00.000Z",
      lastErrorCategory: "SCHEMA_INVALID",
      circuitOpen: false,
    });
    assert.equal(readSourceHealth(
      new Date("2026-09-16T21:05:00.001Z"),
      ["source-a"],
    )[0].status, "STALE");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("a disabled source preserves counters and is explicitly unhealthy", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baseline = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("existing-job", "2026-09-16T09:00:00.000Z")],
    );
    persistShadowCollection(baseline, { appendRun: false, runId: "shadow:baseline" });
    const sourceRow = spreadsheet.sheets.get("SourceState")!.rows[1];
    sourceRow[8] = 3;
    sourceRow[9] = "2026-09-16T10:00:00.000Z";

    const disabled = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [],
    );
    disabled.report.sources[0] = {
      ...disabled.report.sources[0],
      status: "FAILED",
      warnings: ["SOURCE_DISABLED"],
      integrity: { accepted: false, pendingCount: null, pendingConfirmations: 0 },
    };
    persistShadowCollection(disabled, { appendRun: false, runId: "shadow:disabled" });

    assert.equal(sourceRow[8], 3);
    assert.equal(sourceRow[9], "2026-09-16T10:00:00.000Z");
    assert.equal(sourceRow[20], true);
    assert.equal(readSourceHealth(
      new Date("2026-09-16T12:10:00.000Z"),
      ["source-a"],
    )[0].status, "DISABLED");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("manual circuit reset changes only a known source circuit", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baseline = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("existing-job", "2026-09-16T09:00:00.000Z")],
    );
    persistShadowCollection(baseline, { appendRun: false, runId: "shadow:baseline" });
    const sourceRow = spreadsheet.sheets.get("SourceState")!.rows[1];
    sourceRow[8] = 3;
    sourceRow[9] = "2026-09-16T10:00:00.000Z";
    const before = [...sourceRow];

    assert.throws(
      () => resetSourceCircuit("unknown-source", new Set(["source-a"])),
      /CIRCUIT_RESET_SOURCE_INVALID/,
    );
    assert.equal(resetSourceCircuit("source-a", new Set(["source-a"])), true);
    assert.deepEqual(sourceRow.slice(0, 8), before.slice(0, 8));
    assert.deepEqual(sourceRow.slice(8, 10), [0, ""]);
    assert.deepEqual(sourceRow.slice(10), before.slice(10));
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("Jobs migration appends notification, metadata, and reopen fields", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const jobsSheet = spreadsheet.insertSheet("Jobs") as unknown as FakeSheet;
  const oldHeaders = [
    "source_key", "source_job_id", "company", "title", "location", "canonical_url",
    "first_seen_at", "last_seen_at", "match_status", "match_reasons", "rule_version",
    "baseline", "missing_run_count", "closed_at", "last_applied_run_id",
  ];
  const oldRow = [
    "source-a", "old-job", "Example", "Senior ML Engineer", "Amsterdam",
    "https://example.com/jobs/old-job", "2026-09-16T09:00:00.000Z",
    "2026-09-16T09:05:00.000Z", "STRONG", "title:ml", "mvp-1", true, 0, "",
    "shadow:old",
  ];
  jobsSheet.rows.push(oldHeaders, oldRow);
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    assert.deepEqual(jobsSheet.rows[1].slice(0, oldRow.length), oldRow);
    assert.deepEqual(jobsSheet.rows[0].slice(15), [
      "notification_batch_id",
      "notification_status",
      "notified_at",
      "workplace_type",
      "employment_type",
      "published_at",
      "updated_at",
      "content_hash",
      "sponsorship_signal",
      "relocation_signal",
      "last_reopened_at",
      "repost_count",
    ]);
    assert.deepEqual(spreadsheet.sheets.get("NotificationBatches")!.rows[0], [
      "batch_id",
      "created_at",
      "status",
      "job_identity",
      "first_attempt_at",
      "last_attempt_at",
      "attempt_count",
      "sent_at",
      "outcome",
      "updated_at",
    ]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("P9 setup creates a separate protected override schema", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    assert.deepEqual(spreadsheet.sheets.get("JobOverrides")!.rows[0], [
      "source_key",
      "source_job_id",
      "decision",
      "actor_fingerprint",
      "updated_at",
    ]);
    assert.equal(spreadsheet.sheets.get("JobOverrides")!.protectionWarningOnly, false);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("new and reopened jobs sort first and each validated reopen alerts once", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-06-01T09:00:00.000Z";
    persistShadowCollection(collection(
      baselineStartedAt,
      "2026-06-01T09:05:00.000Z",
      [
        job("stable-active", baselineStartedAt),
        job("reopened-job", baselineStartedAt),
        job("still-closed", baselineStartedAt),
      ],
    ), { appendRun: false, runId: "shadow:baseline" });
    for (const [index, completedAt] of [
      "2026-06-02T12:05:00.000Z",
      "2026-06-03T12:05:00.000Z",
      "2026-06-04T12:05:00.000Z",
    ].entries()) {
      persistShadowCollection(collection(
        completedAt.replace("12:05", "12:00"),
        completedAt,
        [job("stable-active", completedAt)],
      ), { appendRun: false, runId: `shadow:missing-${index}` });
    }
    const closedRow = spreadsheet.sheets.get("Jobs")!.rows
      .find((row) => row[1] === "reopened-job");
    const closedAt = String(closedRow?.[13]);
    assert.equal(closedAt, "2026-06-04T12:05:00.000Z");

    const reopenedAt = new Date(Date.parse(closedAt) + 1).toISOString();
    const reopenedCollection = collection(
      reopenedAt,
      reopenedAt,
      [
        job("stable-active", reopenedAt),
        job("reopened-job", reopenedAt),
        job("genuinely-new-id", reopenedAt),
      ],
    );
    assert.deepEqual(persistShadowCollection(
      reopenedCollection,
      { appendRun: false, runId: "shadow:reopen" },
    ), { initializedSources: 0, newCandidates: 2 });
    assert.deepEqual(persistShadowCollection(
      reopenedCollection,
      { appendRun: false, runId: "shadow:reopen" },
    ), { initializedSources: 0, newCandidates: 0 });
    assert.equal(readNotificationBatches().length, 1);
    assert.deepEqual(readNotificationBatches()[0].jobs, [
      { sourceKey: "source-a", sourceJobId: "reopened-job" },
      { sourceKey: "source-a", sourceJobId: "genuinely-new-id" },
    ]);
    const rows = spreadsheet.sheets.get("Jobs")!.rows;
    assert.deepEqual(rows.slice(1).map((row) => row[1]), [
      "genuinely-new-id",
      "reopened-job",
      "stable-active",
      "still-closed",
    ]);
    const reopenedRow = rows.find((row) => row[1] === "reopened-job");
    assert.equal(reopenedRow?.[6], baselineStartedAt);
    assert.equal(reopenedRow?.[13], "");
    assert.equal(reopenedRow?.[16], "PENDING");
    assert.equal(reopenedRow?.[25], reopenedAt);
    assert.equal(reopenedRow?.[26], 1);
    const newRow = rows.find((row) => row[1] === "genuinely-new-id");
    assert.equal(newRow?.[25], "");
    assert.equal(newRow?.[26], 0);
    const firstSending = startOldestPendingNotificationBatch("2026-06-04T12:06:00.000Z");
    assert.ok(firstSending);
    markNotificationBatchSent(firstSending.batchId, "2026-06-04T12:07:00.000Z");

    for (const [index, completedAt] of [
      "2026-06-05T13:05:00.000Z",
      "2026-06-06T13:05:00.000Z",
      "2026-06-07T13:05:00.000Z",
    ].entries()) {
      persistShadowCollection(collection(
        completedAt.replace("13:05", "13:00"),
        completedAt,
        [job("stable-active", completedAt), job("genuinely-new-id", completedAt)],
      ), { appendRun: false, runId: `shadow:second-missing-${index}` });
    }
    const secondClosedAt = String(spreadsheet.sheets.get("Jobs")!.rows
      .find((row) => row[1] === "reopened-job")?.[13]);
    assert.equal(secondClosedAt, "2026-06-07T13:05:00.000Z");

    const secondReopenedAt = new Date(Date.parse(secondClosedAt) + 1).toISOString();
    const secondReopenedCollection = collection(
      secondReopenedAt,
      secondReopenedAt,
      [
        job("stable-active", secondReopenedAt),
        job("reopened-job", secondReopenedAt),
        job("genuinely-new-id", secondReopenedAt),
      ],
    );
    assert.deepEqual(persistShadowCollection(
      secondReopenedCollection,
      { appendRun: false, runId: "shadow:second-reopen" },
    ), { initializedSources: 0, newCandidates: 1 });
    assert.deepEqual(persistShadowCollection(
      secondReopenedCollection,
      { appendRun: false, runId: "shadow:second-reopen" },
    ), { initializedSources: 0, newCandidates: 0 });
    assert.equal(readNotificationBatches().length, 2);
    assert.deepEqual(readNotificationBatches()[1].jobs, [
      { sourceKey: "source-a", sourceJobId: "reopened-job" },
    ]);
    const secondReopenedRow = spreadsheet.sheets.get("Jobs")!.rows
      .find((row) => row[1] === "reopened-job");
    assert.equal(secondReopenedRow?.[25], secondReopenedAt);
    assert.equal(secondReopenedRow?.[26], 2);
    assert.equal(spreadsheet.sheets.get("Jobs")!.rows[1][1], "reopened-job");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("an outstanding alert survives another validated reopen cycle", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-06-01T09:00:00.000Z",
      "2026-06-01T09:05:00.000Z",
      [job("reopened-job", "2026-06-01T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    for (const [index, completedAt] of [
      "2026-06-02T12:05:00.000Z",
      "2026-06-03T12:05:00.000Z",
      "2026-06-04T12:05:00.000Z",
    ].entries()) {
      persistShadowCollection(collection(completedAt, completedAt, []), {
        appendRun: false,
        runId: `shadow:first-missing-${index}`,
      });
    }
    persistShadowCollection(collection(
      "2026-06-04T12:06:00.000Z",
      "2026-06-04T12:06:00.000Z",
      [job("reopened-job", "2026-06-04T12:06:00.000Z")],
    ), { appendRun: false, runId: "shadow:first-reopen" });
    const firstBatch = readNotificationBatches()[0];
    assert.equal(firstBatch.status, "PENDING");

    for (const [index, completedAt] of [
      "2026-06-05T13:05:00.000Z",
      "2026-06-06T13:05:00.000Z",
      "2026-06-07T13:05:00.000Z",
    ].entries()) {
      persistShadowCollection(collection(completedAt, completedAt, []), {
        appendRun: false,
        runId: `shadow:second-missing-${index}`,
      });
    }
    const secondReopenedAt = "2026-06-07T13:06:00.000Z";
    assert.deepEqual(persistShadowCollection(collection(
      secondReopenedAt,
      secondReopenedAt,
      [job("reopened-job", secondReopenedAt)],
    ), { appendRun: false, runId: "shadow:second-reopen" }), {
      initializedSources: 0,
      newCandidates: 0,
    });

    assert.equal(readNotificationBatches().length, 1);
    const row = spreadsheet.sheets.get("Jobs")!.rows[1];
    assert.equal(row[15], firstBatch.batchId);
    assert.equal(row[16], "PENDING");
    assert.equal(row[25], secondReopenedAt);
    assert.equal(row[26], 2);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("owner-attributed overrides survive refreshes and invalid actor state fails closed", () => {
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const owner = installOverrideOwnerGlobals();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    upsertJobOverride(
      "source-a",
      "included-job",
      "INCLUDE",
      owner.fingerprint,
      "2026-09-16T10:00:00.000Z",
      new Set(["source-a"]),
    );
    upsertJobOverride(
      "source-a",
      "excluded-job",
      "EXCLUDE",
      owner.fingerprint,
      "2026-09-16T10:01:00.000Z",
      new Set(["source-a"]),
    );
    const overridden = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [job("included-job", "2026-09-16T12:00:00.000Z"), job("excluded-job", "2026-09-16T12:00:00.000Z")],
    );
    overridden.candidates[0] = {
      job: overridden.candidates[0].job,
      status: "EXCLUDED",
      reasons: ["rule:excluded"],
    };
    persistShadowCollection(overridden, { appendRun: false, runId: "shadow:overridden" });
    persistShadowCollection(collection(
      "2026-09-16T15:00:00.000Z",
      "2026-09-16T15:05:00.000Z",
      [job("included-job", "2026-09-16T15:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:refresh" });

    const includedRow = spreadsheet.sheets.get("Jobs")!.rows
      .find((row) => row[1] === "included-job")!;
    assert.deepEqual(includedRow.slice(8, 10), ["STRONG", "title:machine-learning-engineer,location:eligible,manual:include"]);
    assert.equal(spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "excluded-job"), false);
    assert.deepEqual(readJobOverrides(owner.fingerprint).map(({ decision }) => decision), [
      "INCLUDE",
      "EXCLUDE",
    ]);
    assert.throws(() => readJobOverrides("b".repeat(64)), /OWNER_MISMATCH/);
    spreadsheet.sheets.get("JobOverrides")!.rows[1][2] = "ALLOW";
    assert.throws(
      () => persistShadowCollection(collection(
        "2026-09-16T18:00:00.000Z",
        "2026-09-16T18:05:00.000Z",
        [job("included-job", "2026-09-16T18:00:00.000Z")],
      ), { appendRun: false, runId: "shadow:corrupt-override" }),
      /JOB_OVERRIDE_STATE_INVALID/,
    );
  } finally {
    owner.restore();
    globalThis.SpreadsheetApp = originalSpreadsheet;
  }
});

test("exclude cancels a pending alert and include later alerts the stored job exactly once", () => {
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const owner = installOverrideOwnerGlobals();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    persistShadowCollection(collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [job("override-target", "2026-09-16T12:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:new-target" });
    assert.equal(readNotificationBatches().length, 1);

    upsertJobOverride(
      "source-a",
      "override-target",
      "EXCLUDE",
      owner.fingerprint,
      "2026-09-16T12:06:00.000Z",
      new Set(["source-a"]),
    );
    assert.deepEqual(readNotificationBatches(), []);
    const targetRow = spreadsheet.sheets.get("Jobs")!.rows
      .find((row) => row[1] === "override-target")!;
    assert.deepEqual(targetRow.slice(15, 18), ["", "", ""]);
    persistShadowCollection(collection(
      "2026-09-16T15:00:00.000Z",
      "2026-09-16T15:05:00.000Z",
      [job("override-target", "2026-09-16T15:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:excluded-refresh" });
    assert.equal(targetRow[8], "EXCLUDED");

    upsertJobOverride(
      "source-a",
      "override-target",
      "INCLUDE",
      owner.fingerprint,
      "2026-09-16T15:06:00.000Z",
      new Set(["source-a"]),
    );
    persistShadowCollection(collection(
      "2026-09-16T18:00:00.000Z",
      "2026-09-16T18:05:00.000Z",
      [job("override-target", "2026-09-16T18:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:included-refresh" });
    assert.equal(readNotificationBatches().length, 1);
    assert.deepEqual(readNotificationBatches()[0].jobs, [
      { sourceKey: "source-a", sourceJobId: "override-target" },
    ]);
    persistShadowCollection(collection(
      "2026-09-16T21:00:00.000Z",
      "2026-09-16T21:05:00.000Z",
      [job("override-target", "2026-09-16T21:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:included-again" });
    assert.equal(readNotificationBatches().length, 1);
  } finally {
    owner.restore();
    globalThis.SpreadsheetApp = originalSpreadsheet;
  }
});

test("exclude refuses to rewrite an alert whose send has started", () => {
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const owner = installOverrideOwnerGlobals();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    persistShadowCollection(collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [job("sending-target", "2026-09-16T12:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:sending-target" });
    startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z");

    assert.throws(() => upsertJobOverride(
      "source-a",
      "sending-target",
      "EXCLUDE",
      owner.fingerprint,
      "2026-09-16T12:07:00.000Z",
      new Set(["source-a"]),
    ), /NOTIFICATION_SENDING/);
    assert.deepEqual(readJobOverrides(owner.fingerprint), []);
    assert.equal(readNotificationBatches()[0].status, "SENDING");
  } finally {
    owner.restore();
    globalThis.SpreadsheetApp = originalSpreadsheet;
  }
});

test("bound override actions require the effective owner and clear one-time configuration", () => {
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  const owner = installOverrideOwnerGlobals();
  const sourceKey = MVP_SOURCES[0].sourceKey;
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    owner.values.set("JOB_ALERTS_OVERRIDE_SOURCE_KEY", sourceKey);
    owner.values.set("JOB_ALERTS_OVERRIDE_JOB_ID", "invalid-job");
    owner.values.set("JOB_ALERTS_OVERRIDE_DECISION", "ALLOW");
    assert.throws(() => applyMvpJobOverride(), /DECISION_INVALID/);
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_SOURCE_KEY"), false);
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_JOB_ID"), false);
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_DECISION"), false);

    owner.values.set("JOB_ALERTS_OVERRIDE_SOURCE_KEY", sourceKey);
    owner.values.set("JOB_ALERTS_OVERRIDE_JOB_ID", "job-1");
    owner.values.set("JOB_ALERTS_OVERRIDE_DECISION", "EXCLUDE");
    assert.deepEqual(JSON.parse(applyMvpJobOverride()), {
      status: "JOB_OVERRIDE_APPLIED",
      sourceKey,
      sourceJobId: "job-1",
      decision: "EXCLUDE",
      updatedAt: readJobOverrides(owner.fingerprint)[0].updatedAt,
    });
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_SOURCE_KEY"), false);
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_JOB_ID"), false);
    assert.equal(owner.values.has("JOB_ALERTS_OVERRIDE_DECISION"), false);

    owner.values.set("JOB_ALERTS_OVERRIDE_SOURCE_KEY", sourceKey);
    owner.values.set("JOB_ALERTS_OVERRIDE_JOB_ID", "job-1");
    owner.setEffectiveEmail("other@example.com");
    assert.throws(() => clearMvpJobOverride(), /OWNER_MISMATCH/);
    assert.equal(owner.values.get("JOB_ALERTS_OVERRIDE_SOURCE_KEY"), sourceKey);
    assert.equal(owner.values.get("JOB_ALERTS_OVERRIDE_JOB_ID"), "job-1");
    assert.equal(readJobOverrides(owner.fingerprint).length, 1);

    owner.setEffectiveEmail("owner@example.com");
    assert.deepEqual(JSON.parse(clearMvpJobOverride()), {
      status: "JOB_OVERRIDE_CLEARED",
      sourceKey,
      sourceJobId: "job-1",
      deleted: true,
    });
    assert.deepEqual(readJobOverrides(owner.fingerprint), []);
  } finally {
    owner.restore();
    globalThis.SpreadsheetApp = originalSpreadsheet;
  }
});

test("new candidates create one deterministic pending batch while baselines stay silent", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-09-16T09:00:00.000Z";
    persistShadowCollection(collection(
      baselineStartedAt,
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", baselineStartedAt)],
    ), { appendRun: false, runId: `shadow:${baselineStartedAt}` });
    assert.deepEqual(readNotificationBatches(), []);

    const runStartedAt = "2026-09-16T12:00:00.000Z";
    const current = collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    );
    persistShadowCollection(current, {
      appendRun: false,
      runId: `shadow:${runStartedAt}`,
      logicalStartedAt: runStartedAt,
    });
    persistShadowCollection(current, {
      appendRun: false,
      runId: `shadow:${runStartedAt}`,
      logicalStartedAt: runStartedAt,
    });

    const batches = readNotificationBatches();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].batchId, `notification:shadow:${runStartedAt}`);
    assert.equal(batches[0].status, "PENDING");
    assert.deepEqual(batches[0].jobs, [{ sourceKey: "source-a", sourceJobId: "new-job" }]);
    const rows = spreadsheet.sheets.get("Jobs")!.rows.slice(1);
    const baselineRow = rows.find((row) => row[1] === "baseline-job")!;
    const newRow = rows.find((row) => row[1] === "new-job")!;
    assert.deepEqual(baselineRow.slice(15, 18), ["", "", ""]);
    assert.deepEqual(newRow.slice(15, 18), [batches[0].batchId, "PENDING", ""]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("canonical URLs are formula-neutralized at the final Sheet boundary", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baseline = collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    );
    persistShadowCollection(baseline, { appendRun: false, runId: "shadow:baseline" });
    const injected = job("new-job", "2026-09-16T12:00:00.000Z");
    injected.canonicalUrl = "=IMPORTXML(\"https://attacker.example\")";
    persistShadowCollection(collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [injected],
    ), { appendRun: false, runId: "shadow:current" });

    const row = spreadsheet.sheets.get("Jobs")!.rows.find((value) => value[1] === "new-job")!;
    assert.equal(row[5], "'=IMPORTXML(\"https://attacker.example\")");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("persists digest metadata and suppresses description-only edit batches", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineJob = job("existing-job", "2026-09-16T09:00:00.000Z");
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [baselineJob],
    ), { appendRun: false, runId: "shadow:baseline" });
    const originalRow = spreadsheet.sheets.get("Jobs")!.rows[1];
    const originalHash = originalRow[22];
    assert.match(String(originalHash), /^[a-f0-9]{64}$/);

    const editedJob = {
      ...baselineJob,
      descriptionText: "Machine learning ranking. Visa sponsorship is available.",
      workplaceType: "Hybrid",
      publishedAt: "2026-09-15T08:00:00.000Z",
      updatedAt: "2026-09-16T11:00:00.000Z",
      fetchedAt: "2026-09-16T12:00:00.000Z",
    };
    persistShadowCollection(collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [editedJob],
    ), { appendRun: false, runId: "shadow:edited" });

    const editedRow = spreadsheet.sheets.get("Jobs")!.rows[1];
    assert.deepEqual(editedRow.slice(18, 22), [
      "Hybrid",
      "Full-time",
      "2026-09-15T08:00:00.000Z",
      "2026-09-16T11:00:00.000Z",
    ]);
    assert.notEqual(editedRow[22], originalHash);
    assert.deepEqual(editedRow.slice(23, 25), ["yes", "unknown"]);
    assert.deepEqual(readNotificationBatches(), []);
    const editedHash = editedRow[22];

    const excludedJob = {
      ...editedJob,
      employmentType: "Contract",
      fetchedAt: "2026-09-16T15:00:00.000Z",
    };
    const excludedCollection = collection(
      "2026-09-16T15:00:00.000Z",
      "2026-09-16T15:05:00.000Z",
      [excludedJob],
    );
    excludedCollection.candidates[0] = {
      job: excludedJob,
      status: "EXCLUDED",
      reasons: ["employment:contract"],
    };
    persistShadowCollection(excludedCollection, {
      appendRun: false,
      runId: "shadow:material-edit",
    });

    const excludedRow = spreadsheet.sheets.get("Jobs")!.rows[1];
    assert.equal(excludedRow[8], "EXCLUDED");
    assert.equal(excludedRow[9], "employment:contract");
    assert.equal(excludedRow[19], "Contract");
    assert.notEqual(excludedRow[22], editedHash);
    assert.deepEqual(readNotificationBatches(), []);

    const newExcludedJob = job("never-stored", "2026-09-16T18:00:00.000Z");
    const newExcludedCollection = collection(
      "2026-09-16T18:00:00.000Z",
      "2026-09-16T18:05:00.000Z",
      [newExcludedJob],
    );
    newExcludedCollection.candidates[0] = {
      job: newExcludedJob,
      status: "EXCLUDED",
      reasons: ["employment:contract"],
    };
    persistShadowCollection(newExcludedCollection, {
      appendRun: false,
      runId: "shadow:new-excluded",
    });
    assert.equal(
      spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "never-stored"),
      false,
    );
    assert.deepEqual(readNotificationBatches(), []);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("persisted outbox transitions mirror job state and recover stale sending", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    persistShadowCollection(collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [job("new-job", "2026-09-16T12:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:current" });

    const firstAttempt = startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z")!;
    assert.equal(firstAttempt.status, "SENDING");
    const jobRow = spreadsheet.sheets.get("Jobs")!.rows.find((row) => row[1] === "new-job")!;
    assert.equal(jobRow[16], "SENDING");
    assert.equal(markNotificationBatchSendFailed(
      firstAttempt.batchId,
      "2026-09-16T12:07:00.000Z",
    ).status, "PENDING");
    assert.equal(jobRow[16], "PENDING");

    const secondAttempt = startOldestPendingNotificationBatch("2026-09-16T12:10:00.000Z")!;
    assert.equal(recoverStaleNotificationBatches("2026-09-16T12:25:00.000Z"), 0);
    assert.equal(recoverStaleNotificationBatches("2026-09-16T12:25:00.001Z"), 1);
    assert.equal(jobRow[16], "PENDING");
    const thirdAttempt = startOldestPendingNotificationBatch("2026-09-16T12:26:00.000Z")!;
    assert.equal(thirdAttempt.batchId, secondAttempt.batchId);
    assert.equal(thirdAttempt.attemptCount, 3);
    const sent = markNotificationBatchSent(
      thirdAttempt.batchId,
      "2026-09-16T12:27:00.000Z",
    );
    assert.equal(sent.status, "SENT");
    assert.deepEqual(jobRow.slice(15, 18), [
      thirdAttempt.batchId,
      "SENT",
      "2026-09-16T12:27:00.000Z",
    ]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("reconstructs a sending digest from frozen jobs and a terminal run", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-09-16T09:00:00.000Z";
    persistShadowCollection(collection(
      baselineStartedAt,
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", baselineStartedAt)],
    ), { appendRun: true, runId: `shadow:${baselineStartedAt}` });
    const runStartedAt = "2026-09-16T12:00:00.000Z";
    const current = collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    );
    current.report.unsupportedTargets = ["Waived Company"];
    persistShadowCollection(current, {
      appendRun: true,
      runId: `shadow:${runStartedAt}`,
      logicalStartedAt: runStartedAt,
    });
    const runRow = spreadsheet.sheets.get("Runs")!.rows.find((row) => row[8] === `shadow:${runStartedAt}`)!;
    const sourceSummary = JSON.parse(String(runRow[6])) as Array<Record<string, unknown>>;
    sourceSummary[0] = {
      ...sourceSummary[0],
      status: "PARTIAL",
      warnings: ["DETAIL_LIMIT"],
    };
    runRow[3] = "PARTIAL";
    runRow[6] = JSON.stringify(sourceSummary);
    const sending = startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z")!;
    const input = readNotificationDigestInput(sending, [sourceDefinition]);

    assert.equal(input.batchId, sending.batchId);
    assert.equal(input.reviewSheetUrl, spreadsheet.getUrl());
    assert.deepEqual(input.jobs, [{
      sourceKey: "source-a",
      sourceJobId: "new-job",
      company: "Example",
      title: "Senior Machine Learning Engineer",
      location: "Amsterdam, Netherlands",
      canonicalUrl: "https://example.com/jobs/new-job",
      firstSeenAt: runStartedAt,
      lastReopenedAt: "",
      repostCount: 0,
      matchStatus: "STRONG",
      matchReasons: ["title:machine-learning-engineer", "location:eligible"],
      workplaceType: "",
      sponsorshipSignal: "unknown",
      relocationSignal: "unknown",
    }]);
    assert.deepEqual(input.sourceWarnings, [
      "source-a: PARTIAL (DETAIL_LIMIT)",
      "Unsupported targets: Waived Company",
    ]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("digest reconstruction rejects pending state and tampered job links", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: true, runId: "shadow:baseline" });
    const runStartedAt = "2026-09-16T12:00:00.000Z";
    persistShadowCollection(collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    ), { appendRun: true, runId: `shadow:${runStartedAt}`, logicalStartedAt: runStartedAt });
    const pending = readNotificationBatches()[0];
    assert.throws(
      () => readNotificationDigestInput(pending, [sourceDefinition]),
      /BATCH_NOT_SENDING/,
    );

    const sending = startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z")!;
    const row = spreadsheet.sheets.get("Jobs")!.rows.find((value) => value[1] === "new-job")!;
    row[5] = "https://attacker.example/jobs/new-job";
    assert.throws(
      () => readNotificationDigestInput(sending, [sourceDefinition]),
      /not allowlisted/,
    );
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("persists, renders, and completes one frozen digest batch end to end", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: true, runId: "shadow:baseline" });
    const runStartedAt = "2026-09-16T12:00:00.000Z";
    persistShadowCollection(collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    ), { appendRun: true, runId: `shadow:${runStartedAt}`, logicalStartedAt: runStartedAt });

    const sending = startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z")!;
    const rendered = renderDigest(readNotificationDigestInput(sending, [sourceDefinition]));
    assert.equal(rendered.jobCount, 1);
    assert.match(rendered.htmlBody, /Senior Machine Learning Engineer/);
    assert.match(rendered.plainTextBody, new RegExp(sending.batchId));

    const sent = markNotificationBatchSent(sending.batchId, "2026-09-16T12:07:00.000Z");
    assert.equal(sent.status, "SENT");
    const jobRow = spreadsheet.sheets.get("Jobs")!.rows.find((row) => row[1] === "new-job")!;
    assert.deepEqual(jobRow.slice(15, 18), [
      sending.batchId,
      "SENT",
      "2026-09-16T12:07:00.000Z",
    ]);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("persisted delivery restores PENDING after an injected email exception", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: true, runId: "shadow:baseline" });
    const runStartedAt = "2026-09-16T12:00:00.000Z";
    persistShadowCollection(collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    ), { appendRun: true, runId: `shadow:${runStartedAt}`, logicalStartedAt: runStartedAt });
    let timestampIndex = 0;
    const timestamps = [
      "2026-09-16T12:06:00.000Z",
      "2026-09-16T12:06:01.000Z",
      "2026-09-16T12:06:02.000Z",
    ];
    assert.throws(() => deliverOldestDigest({
      notificationsEnabled: () => true,
      now: () => timestamps[timestampIndex++] ?? timestamps.at(-1)!,
      prepareOldest: (attemptedAt) => {
        const batch = startOldestPendingNotificationBatch(attemptedAt);
        return batch === null
          ? null
          : { batchId: batch.batchId, input: readNotificationDigestInput(batch, [sourceDefinition]) };
      },
      reserveRecipient: () => "owner@example.com",
      send: () => {
        throw new Error("injected provider detail");
      },
      markFailed: markNotificationBatchSendFailed,
      markSent: markNotificationBatchSent,
    }), /^Error: DIGEST_DELIVERY_FAILED$/);
    assert.equal(readNotificationBatches()[0].status, "PENDING");
    const jobRow = spreadsheet.sheets.get("Jobs")!.rows.find((row) => row[1] === "new-job")!;
    assert.equal(jobRow[16], "PENDING");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("post-send state-write crash remains SENDING and stale recovery retries the same batch", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: true, runId: "shadow:baseline" });
    const runStartedAt = "2026-09-16T12:00:00.000Z";
    persistShadowCollection(collection(
      runStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-job", runStartedAt)],
    ), { appendRun: true, runId: `shadow:${runStartedAt}`, logicalStartedAt: runStartedAt });
    let timestampIndex = 0;
    const timestamps = [
      "2026-09-16T12:06:00.000Z",
      "2026-09-16T12:06:01.000Z",
      "2026-09-16T12:06:02.000Z",
    ];
    let sends = 0;
    assert.throws(() => deliverOldestDigest({
      notificationsEnabled: () => true,
      now: () => timestamps[timestampIndex++] ?? timestamps.at(-1)!,
      prepareOldest: (attemptedAt) => {
        const batch = startOldestPendingNotificationBatch(attemptedAt);
        return batch === null
          ? null
          : { batchId: batch.batchId, input: readNotificationDigestInput(batch, [sourceDefinition]) };
      },
      reserveRecipient: () => "owner@example.com",
      send: () => {
        sends += 1;
        spreadsheet.sheets.get("NotificationBatches")!.failNextSetValues = true;
      },
      markFailed: markNotificationBatchSendFailed,
      markSent: markNotificationBatchSent,
    }), /^Error: DIGEST_SENT_STATE_UNCONFIRMED$/);
    const sending = readNotificationBatches()[0];
    assert.equal(sends, 1);
    assert.equal(sending.status, "SENDING");
    assert.equal(recoverStaleNotificationBatches("2026-09-16T12:21:00.001Z"), 1);
    const retry = startOldestPendingNotificationBatch("2026-09-16T12:22:00.000Z")!;
    assert.equal(retry.batchId, sending.batchId);
    assert.equal(retry.attemptCount, 2);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("Greenhouse fixture flows through matching, persistence, rendering, and delivery", async () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/greenhouse.json", import.meta.url),
    "utf8",
  )) as { jobs: Array<Record<string, unknown>> };
  const source: SourceDefinition = {
    ...sourceDefinition,
    sourceKey: "fixture-greenhouse",
    adapter: "GREENHOUSE",
    endpoint: "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true",
    allowedHosts: ["boards-api.greenhouse.io", "boards.greenhouse.io"],
  };
  function response(payload: unknown): ShadowHttpResponse {
    const body = JSON.stringify(payload);
    return {
      status: 200,
      contentType: "application/json",
      body,
      byteLength: Buffer.byteLength(body),
    };
  }
  function collectFixture(
    payload: { jobs: Array<Record<string, unknown>> },
    times: Date[],
  ): ShadowCollection {
    let fetchCall = 0;
    const detailJobs = payload.jobs.filter(({ title }) =>
      typeof title === "string" && /machine learning|data scientist/i.test(title));
    return collectShadow(
      [source],
      (requests) => {
        if (fetchCall++ === 0) {
          return [response(payload)];
        }
        assert.equal(requests.length, detailJobs.length);
        return detailJobs.map((detailJob) => response(detailJob));
      },
      () => times.shift()!,
      1,
    );
  }

  try {
    setupMvpSheets();
    const baselineTimes = [
      new Date("2026-09-16T09:00:00.000Z"),
      new Date("2026-09-16T09:05:00.000Z"),
    ];
    const baseline = collectFixture(fixture, baselineTimes);
    persistShadowCollection(baseline, { appendRun: true, runId: "shadow:fixture-baseline" });

    const currentPayload = {
      jobs: [...fixture.jobs, {
        ...fixture.jobs[0],
        id: 103,
        title: "Senior Data Scientist",
        absolute_url: "https://boards.greenhouse.io/example/jobs/103",
        content: "<p>Build production machine learning experimentation systems.</p>",
      }],
    };
    const currentTimes = [
      new Date("2026-09-16T12:00:00.000Z"),
      new Date("2026-09-16T12:05:00.000Z"),
    ];
    const current = collectFixture(currentPayload, currentTimes);
    const candidate = current.candidates.find(({ job: candidateJob }) =>
      candidateJob.sourceJobId === "103");
    assert.equal(candidate?.status, "STRONG");
    assert.match(candidate?.reasons.join(",") ?? "", /skill:data-scientist/);
    persistShadowCollection(current, {
      appendRun: true,
      runId: `shadow:${current.report.startedAt}`,
      logicalStartedAt: current.report.startedAt,
    });

    let sentBody = "";
    const result = deliverOldestDigest({
      notificationsEnabled: () => true,
      now: () => "2026-09-16T12:06:00.000Z",
      prepareOldest: (attemptedAt) => {
        const batch = startOldestPendingNotificationBatch(attemptedAt);
        return batch === null
          ? null
          : { batchId: batch.batchId, input: readNotificationDigestInput(batch, [source]) };
      },
      reserveRecipient: () => "owner@example.com",
      send: (_recipient, digest) => {
        sentBody = digest.plainTextBody;
      },
      markFailed: markNotificationBatchSendFailed,
      markSent: markNotificationBatchSent,
    });
    assert.equal(result.status, "SENT");
    assert.match(sentBody, /Senior Data Scientist/);
    assert.match(sentBody, /skill:data-scientist/);
    assert.equal(readNotificationBatches()[0].status, "SENT");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("a batch cannot accept another checkpoint chunk after its first attempt", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    for (const sourceKey of ["source-a", "source-b"]) {
      persistShadowCollection(collection(
        "2026-09-16T09:00:00.000Z",
        "2026-09-16T09:05:00.000Z",
        [job(`baseline-${sourceKey}`, "2026-09-16T09:00:00.000Z", sourceKey)],
        sourceKey,
      ), { appendRun: false, runId: `shadow:baseline:${sourceKey}` });
    }
    const logicalStartedAt = "2026-09-16T12:00:00.000Z";
    const logicalRunId = `shadow:${logicalStartedAt}`;
    persistShadowCollection(collection(
      logicalStartedAt,
      "2026-09-16T12:05:00.000Z",
      [job("new-a", logicalStartedAt, "source-a")],
      "source-a",
    ), { appendRun: false, runId: logicalRunId, logicalStartedAt });
    const sending = startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z")!;
    markNotificationBatchSendFailed(sending.batchId, "2026-09-16T12:07:00.000Z");

    assert.throws(() => persistShadowCollection(collection(
      logicalStartedAt,
      "2026-09-16T12:08:00.000Z",
      [job("new-b", logicalStartedAt, "source-b")],
      "source-b",
    ), { appendRun: false, runId: logicalRunId, logicalStartedAt }), /NOTIFICATION_BATCH_FROZEN/);
    assert.equal(
      spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "new-b"),
      false,
    );
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("outbox-first writes prevent silent candidate loss across sheet failures", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    persistShadowCollection(collection(
      "2026-09-16T09:00:00.000Z",
      "2026-09-16T09:05:00.000Z",
      [job("baseline-job", "2026-09-16T09:00:00.000Z")],
    ), { appendRun: false, runId: "shadow:baseline" });
    const current = collection(
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      [job("new-job", "2026-09-16T12:00:00.000Z")],
    );

    spreadsheet.sheets.get("NotificationBatches")!.failNextSetValues = true;
    assert.throws(
      () => persistShadowCollection(current, { appendRun: false, runId: "shadow:current" }),
      /INJECTED_SHEET_WRITE_FAILURE/,
    );
    assert.equal(spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "new-job"), false);

    spreadsheet.sheets.get("Jobs")!.failNextSetValues = true;
    assert.throws(
      () => persistShadowCollection(current, { appendRun: false, runId: "shadow:current" }),
      /INJECTED_SHEET_WRITE_FAILURE/,
    );
    assert.deepEqual(readNotificationBatches()[0].jobs, [
      { sourceKey: "source-a", sourceJobId: "new-job" },
    ]);
    assert.equal(spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "new-job"), false);
    assert.throws(
      () => startOldestPendingNotificationBatch("2026-09-16T12:06:00.000Z"),
      /NOTIFICATION_BATCH_JOB_MISSING/,
    );

    persistShadowCollection(current, { appendRun: false, runId: "shadow:current" });
    assert.equal(readNotificationBatches().length, 1);
    assert.equal(spreadsheet.sheets.get("Jobs")!.rows.some((row) => row[1] === "new-job"), true);
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});

test("persists validators and an unchanged success does not infer absence", () => {
  const original = globalThis.SpreadsheetApp;
  const spreadsheet = new FakeSpreadsheet();
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    setupMvpSheets();
    const baselineStartedAt = "2026-09-16T09:00:00.000Z";
    const baseline = collection(
      baselineStartedAt,
      "2026-09-16T09:05:00.000Z",
      [job("existing-job", baselineStartedAt)],
    );
    baseline.report.sources[0].httpValidators = {
      etag: '"first"',
      lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
    };
    baseline.report.sources[0].httpValidatorUrl = "https://example.com/jobs";
    persistShadowCollection(baseline, {
      appendRun: false,
      runId: `shadow:${baselineStartedAt}`,
      logicalStartedAt: baselineStartedAt,
    });
    assert.deepEqual(readSourceIntegrityStates().get("source-a")?.httpValidators, {
      etag: '"first"',
      lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
    });
    assert.equal(
      readSourceIntegrityStates().get("source-a")?.httpValidatorUrl,
      "https://example.com/jobs",
    );

    const unchangedStartedAt = "2026-09-16T12:00:00.000Z";
    const unchanged = collection(
      unchangedStartedAt,
      "2026-09-16T12:05:00.000Z",
      [],
    );
    unchanged.report.sources[0] = {
      ...unchanged.report.sources[0],
      status: "SUCCESS",
      listedJobs: 1,
      warnings: ["NOT_MODIFIED"],
      unchanged: true,
      httpValidators: {
        etag: '"second"',
        lastModified: "Wed, 16 Sep 2026 09:00:00 GMT",
      },
      httpValidatorUrl: "https://example.com/jobs",
    };
    persistShadowCollection(unchanged, {
      appendRun: false,
      runId: `shadow:${unchangedStartedAt}`,
      logicalStartedAt: unchangedStartedAt,
    });

    const existingRow = spreadsheet.sheets.get("Jobs")!.rows
      .slice(1)
      .find((row) => row[1] === "existing-job");
    assert.equal(existingRow?.[12], 0);
    assert.equal(existingRow?.[13], "");
    const sourceRow = spreadsheet.sheets.get("SourceState")!.rows[1];
    assert.equal(sourceRow[2], "2026-09-16T12:05:00.000Z");
    assert.equal(sourceRow[14], '"second"');
    assert.equal(sourceRow[16], "https://example.com/jobs");

    const fullStartedAt = "2026-09-16T15:00:00.000Z";
    const fullWithoutValidators = collection(
      fullStartedAt,
      "2026-09-16T15:05:00.000Z",
      [job("existing-job", fullStartedAt)],
    );
    fullWithoutValidators.report.sources[0].httpValidators = {
      etag: null,
      lastModified: null,
    };
    fullWithoutValidators.report.sources[0].httpValidatorUrl = "https://example.com/jobs";
    persistShadowCollection(fullWithoutValidators, {
      appendRun: false,
      runId: `shadow:${fullStartedAt}`,
      logicalStartedAt: fullStartedAt,
    });
    const clearedSourceRow = spreadsheet.sheets.get("SourceState")!.rows[1];
    assert.equal(clearedSourceRow[14], "");
    assert.equal(clearedSourceRow[15], "");
    assert.equal(clearedSourceRow[16], "");
  } finally {
    globalThis.SpreadsheetApp = original;
  }
});
