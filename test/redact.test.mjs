import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactDeep } from "../lib/redact.mjs";

// Fake secrets, built by concatenation so no scanner mistakes this file for a leak.
const UUID = ["0f1e2d3c", "4b5a", "4978", "8a6b", "5c4d3e2f1a0b"].join("-");
const GH = "gh" + "p_" + "A".repeat(36);
const SK = "sk" + "-ant-" + "b".repeat(40);
const AWS = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const JWT = ["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "JzdWIiOiIxIn0", "c2lnbmF0dXJlLXZhbHVl"].join(".");

test("secrets in commands never survive: the leaked header shape first", () => {
  const cmd = `H=(-H "Api-Key: ${UUID}" -H "Accept: application/json"); curl "\${H[@]}" https://api.example.com`;
  const out = redact(cmd);
  assert.ok(!out.includes(UUID), out);
  assert.match(out, /Api-Key: \[redacted\]/);
  assert.match(out, /Accept: application\/json/);
});

test("key-value credentials keep their name and lose their value", () => {
  for (const [input, gone] of [
    [`export OPENAI_API_KEY=${SK}`, SK],
    [`curl -H 'Authorization: Bearer ${JWT}' x`, JWT],
    [`password: "hunter2hunter2"`, "hunter2hunter2"],
    [`{"client_secret": "cs_12345678abcdef"}`, "cs_12345678abcdef"],
    [`TOKEN='t0k3n-value-123' npm publish`, "t0k3n-value-123"],
    [`--api-key ${UUID}`, UUID],
    [`access_key=abcdEFGH12345678`, "abcdEFGH12345678"],
  ]) {
    const out = redact(input);
    assert.ok(!out.includes(gone), `${input} -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("known token shapes are caught without a key name", () => {
  for (const secret of [GH, SK, AWS, JWT, "xox" + "b-1234567890-abcdefghij", "gl" + "pat-" + "x".repeat(20), "AI" + "za" + "S".repeat(35)]) {
    const out = redact(`echo ${secret} | pbcopy`);
    assert.ok(!out.includes(secret), out);
  }
});

test("private keys and URL passwords are removed", () => {
  const pem = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END " + "OPENSSH PRIVATE KEY-----";
  assert.equal(redact(`cat <<EOF\n${pem}\nEOF`), "cat <<EOF\n[redacted private key]\nEOF");
  const url = redact("git clone https://rashed:s3cretpass@github.com/x/y.git");
  assert.ok(!url.includes("s3cretpass"), url);
  assert.match(url, /https:\/\/rashed:\[redacted\]@github\.com/);
});

test("ordinary content is left alone", () => {
  for (const text of [
    "git show 3819ad46c0ffee1234567890abcdef1234567890",
    "grep -rn api_key src/ | head",
    "const tokenCount = countTokens(input);",
    "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "the password field must be at least 8 characters",
    "Set JEV_GATES_CHECK_THRESHOLD to 0.3",
  ]) {
    assert.equal(redact(text), text, text);
  }
});

test("redactDeep walks objects and arrays and leaves non-strings alone", () => {
  const out = redactDeep({ a: `token=${UUID}`, b: [1, `Bearer ${JWT}`], c: null, d: { e: true } });
  assert.deepEqual(out, { a: "token=[redacted]", b: [1, "Bearer [redacted]"], c: null, d: { e: true } });
});

test("credential keys glued to a prefix or suffix, and escaped JSON, lose their values", () => {
  for (const [input, gone] of [
    ["PGPASSWORD=s3cr3tpassw0rd psql -h db", "s3cr3tpassw0rd"],
    ['const githubToken = "abcdef1234567890xyz"', "abcdef1234567890xyz"],
    ['dbPassword: "hunter2hunter2"', "hunter2hunter2"],
    ['curl -d "{\\"password\\":\\"hunter2hunter2\\"}" x', "hunter2hunter2"],
    ["SECRET_KEY_BASE=f00dfeedcafe1234 rails s", "f00dfeedcafe1234"],
    ["MY_API_KEY_V2=abcd1234efgh5678 node app", "abcd1234efgh5678"],
  ]) {
    const out = redact(input);
    assert.ok(!out.includes(gone), `${input} -> ${out}`);
  }
  // Numbers and look-alike names are not secrets.
  for (const text of ["max_tokens: 100000", "const tokenCount = countTokens(input);", "passwordLength = 12", "maxTokens: 64000"]) {
    assert.equal(redact(text), text, text);
  }
});

test("redaction stays fast on long unbroken tokens", () => {
  const blob = "A".repeat(200_000);
  const started = Date.now();
  redact(`data=${blob} and password${blob}`);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test("authorization schemes need a credential-shaped value", () => {
  const out = redact("Authorization: Token 8f14e45fceea167a5a36dedd4bea2543");
  assert.ok(!out.includes("8f14e45fceea"), out);
  for (const text of ["Add Basic authentication to the admin page", "Bearer tokens expire hourly", "Token expiration is configurable"]) {
    assert.equal(redact(text), text, text);
  }
});
