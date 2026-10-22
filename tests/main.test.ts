import assert from "node:assert/strict";
import test from "node:test";

import {
  beginMvpAcceptance,
  createFetchController,
  createFetchMany,
  fetchMany,
  restartMvpAcceptance,
  runMvpAcceptanceBaselineReport,
  runMvpAcceptanceReport,
  runMvpDigestDelivery,
  runMvpShadow,
  withDigestScriptLock,
} from "../src/main.ts";

test("acceptance controls reject trigger invocations before reading owner or Sheet state", () => {
  const triggerEvent = { triggerUid: "scheduled" };
  assert.throws(() => beginMvpAcceptance(triggerEvent), /MANUAL_ONLY/);
  assert.throws(() => restartMvpAcceptance(triggerEvent), /MANUAL_ONLY/);
  assert.throws(() => runMvpAcceptanceBaselineReport(triggerEvent), /MANUAL_ONLY/);
  assert.throws(() => runMvpAcceptanceReport(triggerEvent), /MANUAL_ONLY/);
});

function response(
  body: string,
  status = 200,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): GoogleAppsScript.URL_Fetch.HTTPResponse {
  return {
    getResponseCode: () => status,
    getAllHeaders: () => headers,
    getContentText: () => body,
    getBlob: () => ({ getBytes: () => [...Buffer.from(body)] }),
  } as GoogleAppsScript.URL_Fetch.HTTPResponse;
}

test("isolates one unavailable address without aborting healthy batched requests", () => {
  const original = globalThis.UrlFetchApp;
  const batches: string[][] = [];
  globalThis.UrlFetchApp = {
    fetchAll: (requests) => {
      const urls = requests.map((request) =>
        typeof request === "string" ? request : String(request.url));
      batches.push(urls);
      if (urls.includes("https://bad.example/job")) {
        throw new Error("Address unavailable");
      }
      return urls.map((url) => response(JSON.stringify({ url })));
    },
  } as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    const isolatedFetchMany = createFetchMany({ sleep: () => undefined });
    const responses = isolatedFetchMany([
      { url: "https://one.example/jobs", method: "get" },
      { url: "https://bad.example/job", method: "get" },
      { url: "https://two.example/jobs", method: "get" },
    ]);

    assert.deepEqual(responses.map(({ status }) => status), [200, 599, 200]);
    assert.equal(responses[1].body, "");
    assert.deepEqual(batches, [
      ["https://one.example/jobs", "https://bad.example/job", "https://two.example/jobs"],
      ["https://one.example/jobs"],
      ["https://bad.example/job"],
      ["https://bad.example/job"],
      ["https://two.example/jobs"],
    ]);
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("returns immediately for an empty request batch", () => {
  assert.deepEqual(fetchMany([]), []);
});

test("retries transient statuses twice but never retries permanent failures", () => {
  const original = globalThis.UrlFetchApp;
  const attempts = new Map<string, number>();
  globalThis.UrlFetchApp = {
    fetchAll: (requests) => requests.map((request) => {
      const url = typeof request === "string" ? request : String(request.url);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return url.includes("transient")
        ? response("retry", attempt < 3 ? 503 : 200)
        : response("missing", 404);
    }),
  } as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    const boundedFetchMany = createFetchMany({ sleep: () => undefined });
    const responses = boundedFetchMany([
      { url: "https://example.com/transient", method: "get" },
      { url: "https://example.com/permanent", method: "get" },
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 404]);
    assert.equal(attempts.get("https://example.com/transient"), 3);
    assert.equal(attempts.get("https://example.com/permanent"), 1);
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("stops new fetches at the run deadline or request-attempt budget", () => {
  const deadlineController = createFetchController({ now: () => 100, deadlineAt: 100 });
  assert.deepEqual(
    deadlineController.fetchMany([{ url: "https://example.com", method: "get" }])
      .map(({ status }) => status),
    [598],
  );
  assert.equal(deadlineController.getStopReason(), "DEADLINE");

  const budgetController = createFetchController({ maxRequestAttempts: 1 });
  assert.deepEqual(
    budgetController.fetchMany([
      { url: "https://one.example.com", method: "get" },
      { url: "https://two.example.com", method: "get" },
    ]).map(({ status }) => status),
    [598, 598],
  );
  assert.equal(budgetController.getStopReason(), "REQUEST_BUDGET");
  assert.equal(budgetController.getRemainingRequestAttempts(), 1);
});

test("does not materialize a globally oversized response body", () => {
  const original = globalThis.UrlFetchApp;
  let contentReads = 0;
  globalThis.UrlFetchApp = {
    fetchAll: () => [{
      ...response(""),
      getContentText: () => {
        contentReads += 1;
        return "unsafe";
      },
      getBlob: () => ({ getBytes: () => ({ length: 2_000_001 }) }),
    } as GoogleAppsScript.URL_Fetch.HTTPResponse],
  } as unknown as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    const [result] = createFetchMany()([{ url: "https://example.com", method: "get" }]);
    assert.equal(result.byteLength, 2_000_001);
    assert.equal(result.body, "");
    assert.equal(contentReads, 0);
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("tracks materialized response bytes across retries", () => {
  const original = globalThis.UrlFetchApp;
  let attempt = 0;
  globalThis.UrlFetchApp = {
    fetchAll: () => {
      attempt += 1;
      return [response("12345", attempt === 1 ? 503 : 200)];
    },
  } as unknown as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    const controller = createFetchController({ sleep: () => undefined });
    assert.equal(controller.fetchMany([{ url: "https://example.com", method: "get" }])[0].status, 200);
    assert.equal(controller.getResponseBytes(), 10);
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("sends bounded conditional headers and a descriptive user agent", () => {
  const original = globalThis.UrlFetchApp;
  let prepared: GoogleAppsScript.URL_Fetch.URLFetchRequest | undefined;
  globalThis.UrlFetchApp = {
    fetchAll: (requests) => {
      prepared = requests[0] as GoogleAppsScript.URL_Fetch.URLFetchRequest;
      return [response("", 304, {
        ETag: '"next"',
        "Last-Modified": "Wed, 16 Sep 2026 12:00:00 GMT",
      })];
    },
  } as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    const [result] = createFetchMany()([{
      url: "https://example.com/jobs",
      method: "get",
      ifNoneMatch: '"previous"',
      ifModifiedSince: "Wed, 16 Sep 2026 09:00:00 GMT",
    }]);
    assert.deepEqual(prepared?.headers, {
      Accept: "application/json, text/html;q=0.9, application/xml;q=0.8, text/xml;q=0.8",
      "User-Agent": "JobAlertsSystem/0.1 (Google Apps Script; owner-operated)",
      "If-None-Match": '"previous"',
      "If-Modified-Since": "Wed, 16 Sep 2026 09:00:00 GMT",
    });
    assert.equal(result.etag, '"next"');
    assert.equal(result.lastModified, "Wed, 16 Sep 2026 12:00:00 GMT");
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("drops malformed conditional values at the transport boundary", () => {
  const original = globalThis.UrlFetchApp;
  let prepared: GoogleAppsScript.URL_Fetch.URLFetchRequest | undefined;
  globalThis.UrlFetchApp = {
    fetchAll: (requests) => {
      prepared = requests[0] as GoogleAppsScript.URL_Fetch.URLFetchRequest;
      return [response("{}")];
    },
  } as GoogleAppsScript.URL_Fetch.UrlFetchApp;

  try {
    createFetchMany()([{
      url: "https://example.com/jobs",
      method: "get",
      ifNoneMatch: '"safe"\r\nX-Unsafe: yes',
      ifModifiedSince: "not-a-date",
    }]);
    assert.equal("If-None-Match" in prepared!.headers!, false);
    assert.equal("If-Modified-Since" in prepared!.headers!, false);
  } finally {
    globalThis.UrlFetchApp = original;
  }
});

test("runMvpShadow persists lock contention without touching job state", () => {
  const originalProperties = globalThis.PropertiesService;
  const originalLock = globalThis.LockService;
  const originalSpreadsheet = globalThis.SpreadsheetApp;
  const sheets = new Map<string, { rows: unknown[][] }>();
  let released = false;

  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => "SHADOW",
    }),
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.LockService = {
    getScriptLock: () => ({
      tryLock: () => false,
      releaseLock: () => {
        released = true;
      },
    }),
  } as unknown as GoogleAppsScript.Lock.LockService;
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name: string) => sheets.get(name) ?? null,
      insertSheet: (name: string) => {
        const sheet = {
          rows: [] as unknown[][],
          getLastColumn() {
            return this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
          },
          getLastRow() {
            return this.rows.length;
          },
          getRange(startRow: number, startColumn: number, rowCount: number, columnCount: number) {
            return {
              getValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
                Array.from({ length: columnCount }, (_, columnOffset) =>
                  this.rows[startRow - 1 + rowOffset]?.[startColumn - 1 + columnOffset] ?? "")),
              setValues: (values: unknown[][]) => values.forEach((row, rowOffset) => {
                const rowIndex = startRow - 1 + rowOffset;
                if (!this.rows[rowIndex]) {
                  this.rows[rowIndex] = [];
                }
                row.forEach((value, columnOffset) => {
                  this.rows[rowIndex][startColumn - 1 + columnOffset] = value;
                });
              }),
            };
          },
          setFrozenRows() {},
          protect: () => {
            const protection = {
              setDescription: () => protection,
              setWarningOnly: () => protection,
            };
            return protection;
          },
          appendRow(row: unknown[]) {
            this.rows.push([...row]);
          },
        };
        sheets.set(name, sheet);
        return sheet;
      },
    }),
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    assert.deepEqual(JSON.parse(runMvpShadow()), {
      mode: "DEGRADED_SHADOW",
      status: "SKIPPED_LOCKED",
    });
    assert.equal(released, false);
    assert.deepEqual([...sheets.keys()], ["Runs"]);
    assert.equal(sheets.get("Runs")!.rows[1][3], "SKIPPED_LOCKED");
    assert.equal(sheets.get("Runs")!.rows[1][4], 54);
    assert.equal(sheets.get("Runs")!.rows[1][5], 60);
    assert.deepEqual(JSON.parse(String(sheets.get("Runs")!.rows[1][7])), [
      "Uber",
      "Miro",
      "SAP",
      "ByteDance",
      "Sea Group / Shopee",
      "Apple",
    ]);
  } finally {
    globalThis.PropertiesService = originalProperties;
    globalThis.LockService = originalLock;
    globalThis.SpreadsheetApp = originalSpreadsheet;
  }
});

test("runMvpDigestDelivery is a no-op in SHADOW without touching MailApp", () => {
  const originalProperties = globalThis.PropertiesService;
  const originalMail = globalThis.MailApp;
  let mailCalls = 0;
  globalThis.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => "SHADOW" }),
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.MailApp = {
    sendEmail: () => {
      mailCalls += 1;
    },
  } as unknown as GoogleAppsScript.Mail.MailApp;
  try {
    assert.deepEqual(JSON.parse(runMvpDigestDelivery()), { status: "DISABLED" });
    assert.equal(mailCalls, 0);
  } finally {
    globalThis.PropertiesService = originalProperties;
    globalThis.MailApp = originalMail;
  }
});

test("digest delivery lock contention fails closed without running its operation", () => {
  const original = globalThis.LockService;
  let operationCalls = 0;
  let releaseCalls = 0;
  globalThis.LockService = {
    getScriptLock: () => ({
      tryLock: () => false,
      releaseLock: () => {
        releaseCalls += 1;
      },
    }),
  } as unknown as GoogleAppsScript.Lock.LockService;

  try {
    assert.throws(() => withDigestScriptLock(() => {
      operationCalls += 1;
    }), /^Error: DIGEST_DELIVERY_LOCKED$/);
    assert.equal(operationCalls, 0);
    assert.equal(releaseCalls, 0);
  } finally {
    globalThis.LockService = original;
  }
});

test("paused collection clears its checkpoint and every continuation trigger", () => {
  const originals = {
    PropertiesService: globalThis.PropertiesService,
    ScriptApp: globalThis.ScriptApp,
    SpreadsheetApp: globalThis.SpreadsheetApp,
  };
  let checkpointClears = 0;
  const continuation = {
    getHandlerFunction: () => "continueMvpShadow",
  } as GoogleAppsScript.Script.Trigger;
  const unrelated = {
    getHandlerFunction: () => "unrelatedHandler",
  } as GoogleAppsScript.Script.Trigger;
  const deletedTriggers: GoogleAppsScript.Script.Trigger[] = [];
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key: string) => key === "JOB_ALERTS_MODE" ? "PAUSED" : null,
    }),
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.ScriptApp = {
    getProjectTriggers: () => [continuation, continuation, unrelated],
    deleteTrigger: (trigger: GoogleAppsScript.Script.Trigger) => {
      deletedTriggers.push(trigger);
    },
  } as unknown as GoogleAppsScript.Script.ScriptApp;
  const checkpointSheet = {
    getLastColumn: () => 0,
    getLastRow: () => 2,
    getRange: () => ({
      getValues: () => [[]],
      setValues: () => undefined,
      clearContent: () => {
        checkpointClears += 1;
      },
    }),
    setFrozenRows: () => undefined,
    protect: () => {
      const protection = {
        setDescription: () => protection,
        setWarningOnly: () => protection,
      };
      return protection;
    },
  };
  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name: string) => name === "RunCheckpoint" ? checkpointSheet : null,
      insertSheet: () => checkpointSheet,
    }),
  } as unknown as GoogleAppsScript.Spreadsheet.SpreadsheetApp;

  try {
    assert.deepEqual(JSON.parse(runMvpShadow()), { mode: "PAUSED", status: "NO_FETCH" });
    assert.equal(checkpointClears, 1);
    assert.deepEqual(deletedTriggers, [continuation, continuation]);
  } finally {
    globalThis.PropertiesService = originals.PropertiesService;
    globalThis.ScriptApp = originals.ScriptApp;
    globalThis.SpreadsheetApp = originals.SpreadsheetApp;
  }
});