import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isCredentialKey, redactCredentials } from "./redact";

describe("isCredentialKey", () => {
  // AC1: detection is broadened well beyond the original four suffixes.
  const detected = [
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "STRIPE_SECRET_KEY",
    "DB_PASSWORD",
    "PASSPHRASE",
    "SSH_PRIVATE_KEY",
    "SERVICE_CREDENTIALS",
    // Original four suffixes still match.
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "SOME_SECRET",
    "OPENAI_API_TOKEN",
    // Short whole-key suffixes.
    "GITHUB_PAT",
    "SENTRY_DSN",
  ];
  for (const key of detected) {
    it(`detects ${key}`, () => {
      assert.equal(isCredentialKey(key), true);
    });
  }

  it("is case-insensitive", () => {
    assert.equal(isCredentialKey("db_password"), true);
  });

  // Ordinary keys stay untouched; short suffix markers only match at the end.
  const notDetected = ["HOME", "PATH", "USER", "JAIPH_SOURCE_FILE", "NODE_ENV", "PATTERN"];
  for (const key of notDetected) {
    it(`does not flag ${key}`, () => {
      assert.equal(isCredentialKey(key), false);
    });
  }
});

describe("redactCredentials", () => {
  it("redacts a raw credential value", () => {
    const env = { STRIPE_SECRET_KEY: "sk_live_abcdef123456" };
    assert.equal(
      redactCredentials("key is sk_live_abcdef123456 done", env),
      "key is [REDACTED] done",
    );
  });

  // AC2: a base64-encoded form of a known secret is caught.
  it("redacts the base64-encoded form of a known secret", () => {
    const secret = "sk_live_abcdef123456";
    const env = { STRIPE_SECRET_KEY: secret };
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    const out = redactCredentials(`payload=${encoded}`, env);
    assert.ok(!out.includes(encoded), "base64 form should be redacted");
    assert.equal(out, "payload=[REDACTED]");
  });

  it("redacts hex and url-encoded forms of a known secret", () => {
    const secret = "p@ss word/with+special";
    const env = { DB_PASSWORD: secret };
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const url = encodeURIComponent(secret);
    const out = redactCredentials(`h=${hex} u=${url}`, env);
    assert.ok(!out.includes(hex), "hex form should be redacted");
    assert.ok(!out.includes(url), "url-encoded form should be redacted");
  });

  // AC3: the 8-char floor is lowered so short secrets are redacted.
  it("redacts a short known secret (below the old 8-char floor)", () => {
    const env = { DB_PASSWORD: "s3cr" }; // 4 chars — the old floor was 8.
    assert.equal(redactCredentials("pw=s3cr!", env), "pw=[REDACTED]!");
  });

  it("does not redact values of non-credential keys", () => {
    const env = { GREETING: "hello world" };
    assert.equal(redactCredentials("say hello world", env), "say hello world");
  });

  it("ignores values below the minimum length floor", () => {
    const env = { DB_PASSWORD: "ab" };
    assert.equal(redactCredentials("ab cd ab", env), "ab cd ab");
  });

  it("redacts a value detected only by a broadened key (STRIPE_SECRET_KEY)", () => {
    // STRIPE_SECRET_KEY ends in _KEY, missed by the original four-suffix rule.
    const env = { STRIPE_SECRET_KEY: "topsecretvalue" };
    assert.equal(redactCredentials("v=topsecretvalue", env), "v=[REDACTED]");
  });
});
