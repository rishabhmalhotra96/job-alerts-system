import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteMvpTriggers,
  ensureMvpContinuationTrigger,
  ensureMvpTriggers,
  planSingleTrigger,
} from "../src/triggers.ts";

test("creates a trigger only when none exists", () => {
  assert.deepEqual(planSingleTrigger(0), { create: true, deleteIndexes: [] });
  assert.deepEqual(planSingleTrigger(1), { create: false, deleteIndexes: [] });
});

test("keeps one trigger and removes all duplicates", () => {
  assert.deepEqual(planSingleTrigger(4), {
    create: false,
    deleteIndexes: [1, 2, 3],
  });
});

test("rejects invalid trigger counts", () => {
  assert.throws(() => planSingleTrigger(-1), /non-negative integer/);
  assert.throws(() => planSingleTrigger(1.5), /non-negative integer/);
});

function trigger(handler: string): GoogleAppsScript.Script.Trigger {
  return {
    getHandlerFunction: () => handler,
  } as GoogleAppsScript.Script.Trigger;
}

test("replaces the collector with one two-hour trigger and retains the watchdog", () => {
  const original = globalThis.ScriptApp;
  const previousCollector = trigger("runMvpShadow");
  const watchdog = trigger("runMvpWatchdog");
  const triggers = [previousCollector, watchdog];
  const deleted: GoogleAppsScript.Script.Trigger[] = [];
  let collectionIntervalHours = 0;
  globalThis.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: (value: GoogleAppsScript.Script.Trigger) => {
      deleted.push(value);
      triggers.splice(triggers.indexOf(value), 1);
    },
    newTrigger: (handler: string) => ({
      timeBased: () => ({
        everyHours: (hours: number) => {
          collectionIntervalHours = hours;
          return {
            create: () => {
              const value = trigger(handler);
              triggers.push(value);
              return value;
            },
          };
        },
      }),
    }),
  } as unknown as GoogleAppsScript.Script.ScriptApp;

  try {
    assert.deepEqual(ensureMvpTriggers(), {
      collection: { active: 1, created: true, removedDuplicates: 0 },
      watchdog: { active: 1, created: false, removedDuplicates: 0 },
    });
    assert.equal(collectionIntervalHours, 2);
    assert.deepEqual(deleted, [previousCollector]);
    assert.equal(triggers.filter((value) => value.getHandlerFunction() === "runMvpShadow").length, 1);
    assert.equal(triggers.includes(watchdog), true);
  } finally {
    globalThis.ScriptApp = original;
  }
});

test("retains the existing collector when replacement creation fails", () => {
  const original = globalThis.ScriptApp;
  const previousCollector = trigger("runMvpShadow");
  const deleted: GoogleAppsScript.Script.Trigger[] = [];
  globalThis.ScriptApp = {
    getProjectTriggers: () => [previousCollector],
    deleteTrigger: (value: GoogleAppsScript.Script.Trigger) => deleted.push(value),
    newTrigger: () => ({
      timeBased: () => ({
        everyHours: () => ({
          create: () => {
            throw new Error("TRIGGER_CREATE_FAILED");
          },
        }),
      }),
    }),
  } as unknown as GoogleAppsScript.Script.ScriptApp;

  try {
    assert.throws(() => ensureMvpTriggers(), /TRIGGER_CREATE_FAILED/);
    assert.deepEqual(deleted, []);
  } finally {
    globalThis.ScriptApp = original;
  }
});

test("creates one delayed continuation and removes duplicate continuations", () => {
  const original = globalThis.ScriptApp;
  const triggers: GoogleAppsScript.Script.Trigger[] = [];
  const deleted: GoogleAppsScript.Script.Trigger[] = [];
  let delay = 0;
  globalThis.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: (value: GoogleAppsScript.Script.Trigger) => {
      deleted.push(value);
      triggers.splice(triggers.indexOf(value), 1);
    },
    newTrigger: (handler: string) => ({
      timeBased: () => ({
        after: (milliseconds: number) => {
          delay = milliseconds;
          return {
            create: () => {
              const value = trigger(handler);
              triggers.push(value);
              return value;
            },
          };
        },
      }),
    }),
  } as unknown as GoogleAppsScript.Script.ScriptApp;

  try {
    assert.deepEqual(ensureMvpContinuationTrigger(), {
      active: 1,
      created: true,
      removedDuplicates: 0,
    });
    assert.equal(delay, 60_000);
    triggers.push(trigger("continueMvpShadow"));
    assert.deepEqual(ensureMvpContinuationTrigger(), {
      active: 1,
      created: false,
      removedDuplicates: 1,
    });
    assert.equal(deleted.length, 1);
  } finally {
    globalThis.ScriptApp = original;
  }
});

test("full trigger cleanup includes collection, watchdog, and continuation", () => {
  const original = globalThis.ScriptApp;
  const retained = trigger("unrelatedHandler");
  const triggers = [
    trigger("runMvpShadow"),
    trigger("runMvpWatchdog"),
    trigger("continueMvpShadow"),
    retained,
  ];
  const deleted: GoogleAppsScript.Script.Trigger[] = [];
  globalThis.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: (value: GoogleAppsScript.Script.Trigger) => deleted.push(value),
  } as unknown as GoogleAppsScript.Script.ScriptApp;

  try {
    assert.equal(deleteMvpTriggers(), 3);
    assert.deepEqual(deleted, triggers.slice(0, 3));
    assert.equal(deleted.includes(retained), false);
  } finally {
    globalThis.ScriptApp = original;
  }
});