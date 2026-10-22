import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPendingNotificationJobs,
  completeNotificationBatch,
  createPendingNotificationBatch,
  failNotificationBatch,
  notificationBatchId,
  oldestPendingNotificationBatch,
  recoverStaleNotificationBatch,
  startNotificationBatch,
  validateNotificationBatch,
  MAX_NOTIFICATION_BATCH_JOBS,
} from "../src/outbox.ts";

const createdAt = "2026-09-16T12:00:00.000Z";
const firstJob = { sourceKey: "source-a", sourceJobId: "job-1" };
const secondJob = { sourceKey: "source-b", sourceJobId: "job-2" };

function pending() {
  return createPendingNotificationBatch(
    notificationBatchId(`shadow:${createdAt}`),
    createdAt,
    [firstJob],
  );
}

test("creates a deterministic pending batch and appends unique jobs before attempt", () => {
  const initial = pending();
  assert.equal(initial.batchId, `notification:shadow:${createdAt}`);
  assert.equal(initial.status, "PENDING");
  assert.equal(initial.attemptCount, 0);

  const appended = appendPendingNotificationJobs(
    initial,
    [firstJob, secondJob],
    "2026-09-16T12:01:00.000Z",
  );
  assert.deepEqual(appended.jobs, [firstJob, secondJob]);
  assert.equal(
    appendPendingNotificationJobs(appended, [secondJob], "2026-09-16T12:02:00.000Z"),
    appended,
  );
});

test("enforces pending to sending to sent and freezes membership after attempt", () => {
  const sending = startNotificationBatch(pending(), "2026-09-16T12:05:00.000Z");
  assert.equal(sending.status, "SENDING");
  assert.equal(sending.attemptCount, 1);
  assert.equal(sending.firstAttemptAt, "2026-09-16T12:05:00.000Z");
  assert.throws(
    () => appendPendingNotificationJobs(
      sending,
      [secondJob],
      "2026-09-16T12:06:00.000Z",
    ),
    /NOTIFICATION_BATCH_FROZEN/,
  );

  const sent = completeNotificationBatch(sending, "2026-09-16T12:06:00.000Z");
  assert.equal(sent.status, "SENT");
  assert.equal(sent.outcome, "SENT");
  assert.throws(
    () => startNotificationBatch(sent, "2026-09-16T12:07:00.000Z"),
    /NOTIFICATION_BATCH_NOT_PENDING/,
  );
});

test("send failure remains pending with the same batch ID and increments retries", () => {
  const initial = pending();
  const firstAttempt = startNotificationBatch(initial, "2026-09-16T12:05:00.000Z");
  const failed = failNotificationBatch(firstAttempt, "2026-09-16T12:06:00.000Z");
  assert.equal(failed.status, "PENDING");
  assert.equal(failed.batchId, initial.batchId);
  assert.equal(failed.outcome, "SEND_FAILED");

  const retry = startNotificationBatch(failed, "2026-09-16T12:10:00.000Z");
  assert.equal(retry.attemptCount, 2);
  assert.equal(retry.firstAttemptAt, "2026-09-16T12:05:00.000Z");
  assert.equal(retry.lastAttemptAt, "2026-09-16T12:10:00.000Z");
});

test("recovers only sending batches older than fifteen minutes", () => {
  const sending = startNotificationBatch(pending(), "2026-09-16T12:05:00.000Z");
  assert.equal(
    recoverStaleNotificationBatch(sending, "2026-09-16T12:20:00.000Z"),
    sending,
  );
  const recovered = recoverStaleNotificationBatch(
    sending,
    "2026-09-16T12:20:00.001Z",
  );
  assert.equal(recovered.status, "PENDING");
  assert.equal(recovered.batchId, sending.batchId);
  assert.equal(recovered.outcome, "STALE_RECOVERED");
  assert.equal(recovered.attemptCount, 1);
});

test("selects the oldest pending batch and rejects unsafe identities", () => {
  const older = pending();
  const newer = createPendingNotificationBatch(
    notificationBatchId("shadow:2026-09-16T15:00:00.000Z"),
    "2026-09-16T15:00:00.000Z",
    [secondJob],
  );
  assert.equal(oldestPendingNotificationBatch([newer, older]), older);
  assert.throws(
    () => createPendingNotificationBatch("notification:test", createdAt, [{
      sourceKey: "source-a",
      sourceJobId: "job\nsecret",
    }]),
    /NOTIFICATION_JOB_IDENTITY_INVALID/,
  );
  for (const sourceJobId of ["=1+1", "+SUM(A1:A2)", "-2+3", "@IMPORTXML(A1)"]) {
    assert.throws(
      () => createPendingNotificationBatch("notification:test", createdAt, [{
        sourceKey: "source-a",
        sourceJobId,
      }]),
      /NOTIFICATION_JOB_IDENTITY_INVALID/,
    );
  }
});

test("rejects corrupted persisted state before transitions", () => {
  assert.throws(
    () => validateNotificationBatch({
      ...pending(),
      status: "SENT",
      sentAt: null,
    }),
    /NOTIFICATION_BATCH_INVALID/,
  );
  assert.throws(
    () => startNotificationBatch({ ...pending(), attemptCount: 1 }, createdAt),
    /NOTIFICATION_BATCH_INVALID/,
  );
});

test("bounds batch membership before persistence", () => {
  assert.throws(
    () => createPendingNotificationBatch(
      "notification:oversized",
      createdAt,
      Array.from({ length: MAX_NOTIFICATION_BATCH_JOBS + 1 }, (_, index) => ({
        sourceKey: "source-a",
        sourceJobId: `job-${index}`,
      })),
    ),
    /NOTIFICATION_BATCH_TOO_LARGE/,
  );
});
