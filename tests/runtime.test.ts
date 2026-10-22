import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deliverOldestDigest, sendDigestWithMailApp } from "../src/delivery.ts";
import type { DigestInput } from "../src/digest.ts";
import {
  assertMvpNotificationOwner,
  authorizeMvpNotificationOwner,
  enableMvpNotifications,
  getMvpMode,
  REQUIRED_NOTIFICATION_SCOPES,
  reserveAuthorizedMvpRecipientSend,
  reserveMvpRecipientSend,
  setMvpMode,
  verifyMvpNotificationInstallation,
} from "../src/runtime.ts";

test("manifest declares exactly the runtime notification scopes without Gmail access", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../src/appsscript.json", import.meta.url), "utf8"),
  ) as { oauthScopes: string[] };
  assert.deepEqual(manifest.oauthScopes, [...REQUIRED_NOTIFICATION_SCOPES]);
  assert.equal(manifest.oauthScopes.some((scope) => /gmail/i.test(scope)), false);
});

function installRuntimeGlobals(options: {
  email?: string;
  mode?: string;
  providerQuota?: number;
  scopesAuthorized?: boolean;
} = {}) {
  const originals = {
    LockService: globalThis.LockService,
    MailApp: globalThis.MailApp,
    PropertiesService: globalThis.PropertiesService,
    ScriptApp: globalThis.ScriptApp,
    Session: globalThis.Session,
    Utilities: globalThis.Utilities,
  };
  const values = new Map<string, string>();
  if (options.mode !== undefined) {
    values.set("JOB_ALERTS_MODE", options.mode);
  }
  const properties = {
    getProperty: (key: string) => values.get(key) ?? null,
    setProperty: (key: string, value: string) => {
      values.set(key, value);
      return properties;
    },
  };
  const requiredScopes: string[][] = [];
  let lockAvailable = true;
  let lockReleased = 0;
  globalThis.LockService = {
    getScriptLock: () => ({
      tryLock: () => lockAvailable,
      releaseLock: () => {
        lockReleased += 1;
      },
    }),
  } as unknown as GoogleAppsScript.Lock.LockService;
  globalThis.PropertiesService = {
    getScriptProperties: () => properties,
  } as unknown as GoogleAppsScript.Properties.PropertiesService;
  globalThis.ScriptApp = {
    AuthMode: { FULL: "FULL" },
    AuthorizationStatus: { NOT_REQUIRED: "NOT_REQUIRED", REQUIRED: "REQUIRED" },
    getScriptId: () => "script_ID-1",
    requireScopes: (_mode: unknown, scopes: string[]) => requiredScopes.push(scopes),
    getAuthorizationInfo: () => ({
      getAuthorizationStatus: () => options.scopesAuthorized === false
        ? "REQUIRED"
        : "NOT_REQUIRED",
    }),
  } as unknown as GoogleAppsScript.Script.ScriptApp;
  globalThis.Session = {
    getEffectiveUser: () => ({ getEmail: () => options.email ?? "owner@example.com" }),
  } as unknown as GoogleAppsScript.Base.Session;
  globalThis.Utilities = {
    Charset: { UTF_8: "UTF-8" },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest: (_algorithm: unknown, value: string) =>
      [...createHash("sha256").update(value, "utf8").digest()]
        .map((byte) => byte > 127 ? byte - 256 : byte),
  } as unknown as typeof Utilities;
  globalThis.MailApp = {
    getRemainingDailyQuota: () => options.providerQuota ?? 100,
  } as unknown as GoogleAppsScript.Mail.MailApp;
  return {
    values,
    requiredScopes,
    get lockReleased() {
      return lockReleased;
    },
    setLockAvailable: (available: boolean) => {
      lockAvailable = available;
    },
    restore: () => {
      globalThis.LockService = originals.LockService;
      globalThis.MailApp = originals.MailApp;
      globalThis.PropertiesService = originals.PropertiesService;
      globalThis.ScriptApp = originals.ScriptApp;
      globalThis.Session = originals.Session;
      globalThis.Utilities = originals.Utilities;
    },
  };
}

test("manual authorization binds only a script-specific owner fingerprint", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    assert.deepEqual(JSON.parse(authorizeMvpNotificationOwner()), {
      mode: "SHADOW",
      status: "OWNER_AUTHORIZED",
    });
    assert.deepEqual(runtime.requiredScopes, [[...REQUIRED_NOTIFICATION_SCOPES]]);
    assert.match(runtime.values.get("JOB_ALERTS_OWNER_FINGERPRINT")!, /^[a-f0-9]{64}$/);
    assert.equal([...runtime.values.values()].some((value) => value.includes("owner@example.com")), false);
    assert.equal(assertMvpNotificationOwner(), "owner@example.com");
    assert.equal(runtime.lockReleased, 1);
  } finally {
    runtime.restore();
  }
});

test("owner authorization fails closed when shared state cannot be locked", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    runtime.setLockAvailable(false);
    assert.throws(() => authorizeMvpNotificationOwner(), /SETUP_LOCKED/);
    assert.equal(runtime.values.has("JOB_ALERTS_OWNER_FINGERPRINT"), false);
    assert.equal(runtime.lockReleased, 0);
  } finally {
    runtime.restore();
  }
});

test("authorization and runtime owner checks fail closed on trigger or identity mismatch", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    assert.throws(
      () => authorizeMvpNotificationOwner({ triggerUid: "1" }),
      /MANUAL_ONLY/,
    );
    authorizeMvpNotificationOwner();
    globalThis.Session = {
      getEffectiveUser: () => ({ getEmail: () => "other@example.com" }),
    } as unknown as GoogleAppsScript.Base.Session;
    assert.throws(() => assertMvpNotificationOwner(), /OWNER_MISMATCH/);
    assert.throws(() => authorizeMvpNotificationOwner(), /OWNER_MISMATCH/);
  } finally {
    runtime.restore();
  }
});

test("trigger installation requires a manual matching owner with current scopes", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    authorizeMvpNotificationOwner();
    assert.doesNotThrow(() => verifyMvpNotificationInstallation());
    assert.throws(
      () => verifyMvpNotificationInstallation({ triggerUid: "1" }),
      /MANUAL_ONLY/,
    );
  } finally {
    runtime.restore();
  }

  const missingScopes = installRuntimeGlobals({
    mode: "SHADOW",
    scopesAuthorized: false,
  });
  try {
    assert.throws(() => authorizeMvpNotificationOwner(), /SCOPES_NOT_AUTHORIZED/);
    assert.equal(missingScopes.values.has("JOB_ALERTS_OWNER_FINGERPRINT"), false);
  } finally {
    missingScopes.restore();
  }
});

test("trigger installation rejects invalid MailApp quota responses", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW", providerQuota: -1 });
  try {
    authorizeMvpNotificationOwner();
    assert.throws(
      () => verifyMvpNotificationInstallation(),
      /PROVIDER_QUOTA_INVALID/,
    );
  } finally {
    runtime.restore();
  }
});

test("notification mode cannot be entered before the static release gate opens", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    authorizeMvpNotificationOwner();
    assert.throws(() => enableMvpNotifications(), /RELEASE_NOT_READY/);
    runtime.values.set("JOB_ALERTS_MODE", "NOTIFY");
    assert.equal(getMvpMode(), "SHADOW");
    setMvpMode("PAUSED");
    assert.equal(getMvpMode(), "PAUSED");
  } finally {
    runtime.restore();
  }
});

test("send reservation rechecks mode and owner, then persists no recipient address", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW", providerQuota: 50 });
  try {
    authorizeMvpNotificationOwner();
    assert.throws(
      () => reserveMvpRecipientSend("DIGEST", new Date("2026-09-16T12:00:00Z")),
      /MODE_DISABLED/,
    );
    runtime.values.set("JOB_ALERTS_MODE", "NOTIFY");
    assert.throws(
      () => reserveMvpRecipientSend("DIGEST", new Date("2026-09-16T12:00:00Z")),
      /MODE_DISABLED/,
    );
    assert.equal(
      [...runtime.values.values()].some((value) => value.includes("owner@example.com")),
      false,
    );
  } finally {
    runtime.restore();
  }
});

test("authorized send reservation persists bounded quota and returns the effective recipient", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW", providerQuota: 50 });
  try {
    authorizeMvpNotificationOwner();
    const reservation = reserveAuthorizedMvpRecipientSend(
      "DIGEST",
      new Date("2026-09-16T12:00:00Z"),
    );
    assert.deepEqual(reservation, {
      recipient: "owner@example.com",
      quota: { day: "2026-09-16", digestSends: 1, healthSends: 0 },
      providerRemainingQuota: 50,
    });
    assert.equal(
      runtime.values.get("JOB_ALERTS_DAILY_SEND_QUOTA"),
      JSON.stringify(reservation.quota),
    );
    assert.equal(
      [...runtime.values.values()].some((value) => value.includes("owner@example.com")),
      false,
    );
    assert.equal(runtime.lockReleased, 2);
  } finally {
    runtime.restore();
  }
});

test("health reservation is limited to one owner recipient per UTC day", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW", providerQuota: 50 });
  try {
    authorizeMvpNotificationOwner();
    const reservation = reserveAuthorizedMvpRecipientSend(
      "HEALTH",
      new Date("2026-09-16T12:00:00Z"),
    );
    assert.deepEqual(reservation.quota, {
      day: "2026-09-16",
      digestSends: 0,
      healthSends: 1,
    });
    assert.throws(
      () => reserveAuthorizedMvpRecipientSend(
        "HEALTH",
        new Date("2026-09-16T18:00:00Z"),
      ),
      /HEALTH_CAP_REACHED/,
    );
  } finally {
    runtime.restore();
  }
});

test("daily cap blocks digest delivery before MailApp and returns the batch to pending", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW", providerQuota: 50 });
  let mailCalls = 0;
  let failedCalls = 0;
  const input: DigestInput = {
    batchId: "notification:daily-cap",
    createdAt: "2026-09-16T12:00:00.000Z",
    jobs: [{
      sourceKey: "example",
      sourceJobId: "1",
      title: "Senior Data Scientist",
      company: "Example",
      location: "Berlin, Germany",
      workplaceType: "Hybrid",
      firstSeenAt: "2026-09-16T12:00:00.000Z",
      matchStatus: "STRONG",
      matchReasons: ["skill:data-scientist"],
      sponsorshipSignal: "unknown",
      relocationSignal: "unknown",
      canonicalUrl: "https://jobs.example.com/1",
    }],
    sourceWarnings: [],
    reviewSheetUrl: "https://docs.google.com/spreadsheets/d/private_sheet_id/edit",
  };
  globalThis.MailApp = {
    getRemainingDailyQuota: () => 50,
    sendEmail: () => {
      mailCalls += 1;
    },
  } as unknown as GoogleAppsScript.Mail.MailApp;

  try {
    authorizeMvpNotificationOwner();
    const day = new Date("2026-09-16T12:00:00.000Z");
    for (let index = 0; index < 8; index += 1) {
      reserveAuthorizedMvpRecipientSend("DIGEST", day);
    }
    reserveAuthorizedMvpRecipientSend("HEALTH", day);
    assert.throws(() => deliverOldestDigest({
      notificationsEnabled: () => true,
      now: () => day.toISOString(),
      prepareOldest: () => ({ batchId: input.batchId, input }),
      reserveRecipient: () =>
        reserveAuthorizedMvpRecipientSend("DIGEST", day).recipient,
      send: sendDigestWithMailApp,
      markFailed: () => {
        failedCalls += 1;
      },
      markSent: () => assert.fail("capped delivery must not become sent"),
    }), /^Error: DIGEST_DELIVERY_FAILED$/);
    assert.equal(mailCalls, 0);
    assert.equal(failedCalls, 1);
  } finally {
    runtime.restore();
  }
});

test("authorized send reservation sanitizes corrupted persisted quota", () => {
  const runtime = installRuntimeGlobals({ mode: "SHADOW" });
  try {
    authorizeMvpNotificationOwner();
    runtime.values.set("JOB_ALERTS_DAILY_SEND_QUOTA", "{unsafe");
    assert.throws(
      () => reserveAuthorizedMvpRecipientSend(
        "DIGEST",
        new Date("2026-09-16T12:00:00Z"),
      ),
      /^Error: NOTIFICATION_QUOTA_STATE_INVALID$/,
    );
  } finally {
    runtime.restore();
  }
});