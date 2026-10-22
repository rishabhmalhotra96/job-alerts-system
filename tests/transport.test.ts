import assert from "node:assert/strict";
import test from "node:test";

import {
  hasHttpValidators,
  normalizeEtag,
  normalizeHttpValidators,
  normalizeLastModified,
} from "../src/transport.ts";

test("normalizes bounded ETag and Last-Modified validators", () => {
  assert.equal(normalizeEtag(' "abc-123" '), '"abc-123"');
  assert.equal(normalizeEtag('W/"weak"'), 'W/"weak"');
  assert.equal(
    normalizeLastModified("Wed, 16 Sep 2026 12:00:00 GMT"),
    "Wed, 16 Sep 2026 12:00:00 GMT",
  );
  assert.deepEqual(normalizeHttpValidators(
    '"abc"',
    "Wed, 16 Sep 2026 12:00:00 GMT",
  ), {
    etag: '"abc"',
    lastModified: "Wed, 16 Sep 2026 12:00:00 GMT",
  });
});

test("rejects malformed, injected, and oversized validators", () => {
  assert.equal(normalizeEtag("abc"), null);
  assert.equal(normalizeEtag('"abc"\r\nX-Unsafe: yes'), null);
  assert.equal(normalizeEtag(`"${"a".repeat(513)}"`), null);
  assert.equal(normalizeLastModified("not-a-date"), null);
  assert.equal(normalizeLastModified("Wed, 16 Sep 2026 12:00:00 GMT\r\nX: y"), null);
  assert.equal(hasHttpValidators({ etag: null, lastModified: null }), false);
  assert.equal(hasHttpValidators({ etag: '"abc"', lastModified: null }), true);
});
