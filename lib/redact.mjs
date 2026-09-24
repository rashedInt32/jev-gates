// Strip secret values from text before it leaves the machine or lands in a
// log. Names stay, so a judgment still sees that a command sends an API key;
// only the value becomes "[redacted]".
//
// Deliberately targeted. Generic long tokens are left alone: git SHAs, hashes
// and long identifiers are ordinary content the proof and commit gates need.

const MARK = "[redacted]";

// A credential-naming key with any prefix and separated suffixes: OPENAI_API_KEY,
// PGPASSWORD, githubToken, SECRET_KEY_BASE, MY_API_KEY_V2. The prefix is lazy and
// each suffix starts with a separator, so long tokens cannot make it backtrack.
const KEY =
  "[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|private[_-]?key)(?:[_-][A-Za-z0-9]+)*";

const RULES = [
  // PEM private keys, whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi, `$1${MARK}@`],
  // Authorization schemes. The credential must look like one, with a digit or
  // 20+ characters, so prose such as "Basic authentication" is left alone.
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d|[A-Za-z0-9._~+/=-]{20})[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MARK}`],
  // key: value, key=value, "key": "value", and the same inside escaped JSON.
  // References like $TOKEN and plain numbers such as max_token: 100000 stay.
  [new RegExp(`(\\b${KEY}\\\\?["']?\\s*[:=]\\s*\\\\?["']?)(?!\\$|\\[redacted|\\d+\\b)[^\\s"'&;|,)}\\\\]{6,}`, "gi"), `$1${MARK}`],
  // --api-key VALUE, --token=VALUE.
  [new RegExp(`(--${KEY}(?:=|\\s+)["']?)(?!\\$|-|\\[redacted)[^\\s"']{6,}`, "gi"), `$1${MARK}`],
  // Token shapes that identify themselves.
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MARK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MARK],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MARK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MARK],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, MARK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MARK],
];

/** Text with every recognised secret value replaced. Non-strings pass through. */
export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/** Redact every string inside a JSON-shaped value. */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
