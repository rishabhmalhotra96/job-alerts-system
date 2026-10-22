import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSourceWarning, normalizeSourceWarnings } from "../src/operations.ts";

test("normalizes source failures to a finite non-descriptive vocabulary", () => {
  assert.equal(normalizeSourceWarning("HTTP_STATUS"), "HTTP_STATUS");
  assert.equal(normalizeSourceWarning("COUNT_INTEGRITY_PENDING_1"), "COUNT_INTEGRITY_PENDING");
  assert.equal(
    normalizeSourceWarning("DETAIL_Job URL host is not allowlisted: attacker.example"),
    "DETAIL_URL_INVALID",
  );
  assert.equal(
    normalizeSourceWarning("response contained secret-token-value"),
    "SCHEMA_INVALID",
  );
  assert.deepEqual(
    normalizeSourceWarnings(["HTTP_STATUS", "HTTP_STATUS", "private local URL"]),
    ["HTTP_STATUS", "URL_INVALID"],
  );
});