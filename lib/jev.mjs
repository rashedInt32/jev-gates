// Shared plumbing for the gates: config, key lookup, one Jev request, answer
// validation, decision log, and a small response cache.
//
// Every failure path here is designed to be caught by the hook and turned into
// "no opinion". A gate that cannot reach Jev must never block or approve.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODES = new Set(["off", "shadow", "active"]);

/** Read the gate configuration from the environment. */
export function readConfig(env = process.env) {
  const mode = MODES.has(env.JEV_GATES) ? env.JEV_GATES : "active";
  return {
    mode,
    model: env.JEV_GATES_MODEL || "jev-latest",
    baseUrl: env.JEV_GATES_BASE_URL || "https://api.typesafe.ai/v1/systemone",
    timeoutMs: positive(env.JEV_GATES_TIMEOUT_MS, 8000),
    maxChars: positive(env.JEV_GATES_MAX_CHARS, 40_000),
    // Rule guard
    editThreshold: unit(env.JEV_GATES_EDIT_THRESHOLD, 0.8),
    editAction: env.JEV_GATES_EDIT_ACTION === "deny" ? "deny" : "ask",
    maxRules: positive(env.JEV_GATES_MAX_RULES, 64),
    // Colon-separated explicit rule files; when set, the CLAUDE.md walk is skipped.
    ruleFiles: env.JEV_GATES_RULE_FILES ? env.JEV_GATES_RULE_FILES.split(":").filter(Boolean) : undefined,
    // Done gate
    requestThreshold: unit(env.JEV_GATES_REQUEST_THRESHOLD, 0.6),
    doneThreshold: unit(env.JEV_GATES_DONE_THRESHOLD, 0.4),
    maxAsks: positive(env.JEV_GATES_MAX_ASKS, 24),
    // Storage
    dataDir: env.JEV_GATES_DIR || join(homedir(), ".claude", "jev-gates"),
    keyFile: env.JEV_KEY_FILE || join(homedir(), ".config", "typesafe", "key"),
  };
}

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function unit(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** The key comes from the environment or a 0600 file. Never from arguments. */
export function readKey(config, env = process.env) {
  const fromEnv = env.TYPESAFE_API_KEY || env.JEV_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const contents = readFileSync(config.keyFile, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/** Read all of stdin as JSON, or return undefined when nothing usable arrives. */
export async function readStdinJson(timeoutMs = 3000) {
  const chunks = [];
  const timer = new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs));
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  })();
  const raw = await Promise.race([read, timer]);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A yes/no question with explicit meanings for both outcomes. */
export function noul(instructions, yesMeans, noMeans) {
  return { type: "noul", instructions, criteria: { true: yesMeans, false: noMeans } };
}

/**
 * One System One request. Returns the validated noul probabilities keyed by
 * question id, plus latency and usage. Throws on any transport or shape error.
 */
export async function ask({ config, key, state, questions }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = performance.now();
  let response;
  try {
    response = await fetch(config.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const latency_ms = Math.round(performance.now() - started);
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}`);
  const body = await response.json();
  const answers = {};
  for (const id of Object.keys(questions)) {
    const p = body?.answers?.[id]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`Malformed answer for '${id}'`);
    }
    answers[id] = p;
  }
  return { answers, latency_ms, usage: body.usage ?? {}, model: body.model };
}

// ── Decision log and cache ──────────────────────────────────────────────────

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best effort
  }
}

/** Append one tab-separated line. Field order is fixed so the log is greppable. */
export function log(config, fields) {
  try {
    ensureDir(config.dataDir);
    const line = [new Date().toISOString(), ...fields.map((f) => String(f ?? "").replace(/[\t\n\r]+/g, " "))].join("\t");
    appendFileSync(join(config.dataDir, "decisions.log"), line + "\n");
  } catch {
    // never let logging break a gate
  }
}

/** Write the most recent decision as JSON, for the demo and for debugging. */
export function writeLast(config, name, payload) {
  try {
    ensureDir(config.dataDir);
    writeFileSync(join(config.dataDir, `last-${name}.json`), JSON.stringify(payload, null, 2));
  } catch {
    // best effort
  }
}

export function cacheGet(config, key) {
  try {
    const path = join(config.dataDir, "cache", key);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

export function cacheSet(config, key, value) {
  try {
    ensureDir(join(config.dataDir, "cache"));
    writeFileSync(join(config.dataDir, "cache", key), JSON.stringify(value));
  } catch {
    // best effort
  }
}

/** Bound a string; the caller decides whether a truncated state is acceptable. */
export function clip(text, max) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : text.slice(0, max) + `\n[… ${text.length - max} more characters …]`;
}
