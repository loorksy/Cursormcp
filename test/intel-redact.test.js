import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/intel/redact.js";
import { paginate, encodeCursor, isProbablyBinary, safeRelPath } from "../src/intel/paginate.js";

test("redacts env assignments and tokens", () => {
  const sample = [
    "DATABASE_URL=postgres://user:pass@host/db",
    "TELEGRAM_BOT_TOKEN=123456789:AA" + "x".repeat(30),
    "const x = 'ghp_" + "A".repeat(36) + "';",
    "-----BEGIN RSA PRIVATE KEY-----",
    "abc",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(sample, { path: ".env" });
  assert.equal(out.redacted, true);
  assert.equal(out.text.includes("postgres://user:pass"), false);
  assert.equal(out.text.includes("ghp_"), false);
  assert.ok(out.text.includes("DATABASE_URL=********"));
});

test("redacts entire values in .env files", () => {
  const out = redactSecrets("FOO=super-secret-value\n", { path: "deploy/.env.production" });
  assert.ok(out.text.includes("FOO=********"));
});

test("paginate 10000 entries", () => {
  const items = Array.from({ length: 10000 }, (_, i) => i);
  const page1 = paginate(items, { limit: 100, max: 500 });
  assert.equal(page1.items.length, 100);
  assert.equal(page1.has_more, true);
  assert.equal(page1.total, 10000);
  const page2 = paginate(items, { limit: 100, cursor: page1.next_cursor, max: 500 });
  assert.equal(page2.offset, 100);
  assert.equal(page2.items[0], 100);
  const last = paginate(items, { limit: 500, cursor: encodeCursor({ o: 9800 }), max: 500 });
  assert.equal(last.items.length, 200);
  assert.equal(last.has_more, false);
});

test("binary detection and path traversal", () => {
  assert.equal(isProbablyBinary("x.png"), true);
  assert.equal(isProbablyBinary("x.js", Buffer.from("hello")), false);
  assert.equal(isProbablyBinary("x.bin", Buffer.from([0, 1, 2, 3, 0])), true);
  assert.equal(safeRelPath("src/a.js"), "src/a.js");
  assert.throws(() => safeRelPath("../etc/passwd"));
  assert.throws(() => safeRelPath("a/../../b"));
});
