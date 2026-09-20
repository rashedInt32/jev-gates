// Read what the done gate needs from a Claude Code transcript: the last real
// user prompt, and the tool activity since it. The transcript is JSON Lines
// and may lag the live conversation, so the final assistant text is taken from
// the hook payload, not from here.

import { readFileSync } from "node:fs";

/** Parse a JSONL file into objects, skipping lines that do not parse. */
export function readTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial trailing line while the file is being written
    }
  }
  return out;
}

/** Text of a user message, or null when it is a tool result or meta entry. */
export function userText(entry) {
  if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === "tool_result")) return null;
  const parts = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Strip injected wrappers so only what the human typed remains. */
export function cleanPrompt(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-args>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .trim();
}

/**
 * The most recent prompt a human typed, with its position in the transcript.
 * Slash-command expansions and empty prompts do not count.
 */
export function lastUserPrompt(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = userText(entries[i]);
    if (text === null) continue;
    if (/^\s*<command-name>/.test(text)) continue;
    const cleaned = cleanPrompt(text);
    if (cleaned.length === 0) continue;
    return { text: cleaned, index: i, uuid: entries[i].uuid };
  }
  return null;
}

/**
 * Every tool call after the prompt in order, numbered from 0. The number is
 * shared by the claims and proof gates so evidence can be placed before or
 * after an edit.
 */
export function toolUsesSince(entries, index) {
  const out = [];
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "tool_use") out.push({ seq: out.length, id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return out;
}

/** One line per tool call after the prompt: what the assistant actually did. */
export function workSince(entries, index, max = 40) {
  const lines = [];
  for (let i = index + 1; i < entries.length && lines.length < max; i += 1) {
    const entry = entries[i];
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type !== "tool_use") continue;
      const input = block.input ?? {};
      let detail = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? "";
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      lines.push(`${block.name} ${detail}`.slice(0, 160));
      if (lines.length >= max) break;
    }
  }
  return lines;
}

/** Assistant text after the prompt, used only when the hook payload has none. */
export function assistantTextSince(entries, index) {
  const parts = [];
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Split a prompt into candidate asks. Bullets and lines first, then sentences.
 * Deterministic on purpose; Jev decides which candidates are real requests.
 */
export function splitAsks(prompt, max = 24) {
  const chunks = [];
  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.?!])\s+/)) {
      const s = sentence.trim();
      if (s.split(/\s+/).length < 3 || s.length > 400) continue;
      // "Fix X, and add Y" carries two asks. Split on clause joiners when every
      // part still reads as a request; otherwise keep the sentence whole.
      const clauses = s.split(/,\s+and\s+|;\s+|\s+and\s+then\s+|,\s+then\s+/i).map((c) => c.trim());
      if (clauses.length > 1 && clauses.every((c) => c.split(/\s+/).length >= 3)) chunks.push(...clauses);
      else chunks.push(s);
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Plain sentences from assistant prose: bullets and emphasis stripped, code
 * fences and headings skipped. Used to find claims in a reply or a commit
 * message. Deterministic; Jev decides which sentences are claims.
 */
export function splitSentences(text, max = 16) {
  const out = [];
  const seen = new Set();
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || line.startsWith("#") || line.startsWith("|")) continue;
    const clean = line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .trim();
    for (const sentence of clean.split(/(?<=[.?!])\s+/)) {
      const s = sentence.trim();
      if (s.split(/\s+/).length < 3 || s.length > 300) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  return "";
}

/**
 * Tool calls after the prompt, each paired with a clipped result, under a
 * total character budget. This is the evidence the claims gate judges against.
 */
export function toolActivitySince(entries, index, { maxItems = 40, maxResultChars = 1200, maxTotalChars = 20_000 } = {}) {
  const results = new Map();
  for (let i = index + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e?.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type === "tool_result") results.set(b.tool_use_id, { text: resultText(b.content), isError: Boolean(b.is_error) });
    }
  }
  const items = [];
  let total = 0;
  let omitted = 0;
  for (const b of toolUsesSince(entries, index)) {
    const input = b.input;
    let detail = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? "";
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    const r = results.get(b.id);
    const result = r ? r.text.slice(0, maxResultChars) + (r.text.length > maxResultChars ? ` [… ${r.text.length - maxResultChars} more chars]` : "") : "(no result recorded)";
    const item = { seq: b.seq, tool: b.name, detail: detail.slice(0, 200), result, ...(r?.isError ? { error: true } : {}) };
    const size = JSON.stringify(item).length;
    if (items.length >= maxItems || total + size > maxTotalChars) {
      omitted += 1;
      continue;
    }
    total += size;
    items.push(item);
  }
  if (omitted > 0) items.push({ tool: "…", detail: `${omitted} more tool calls omitted for size`, result: "" });
  return items;
}
