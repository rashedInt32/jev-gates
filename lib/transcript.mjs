// Read what the done gate needs from a Claude Code transcript: the last real
// user prompt, and the tool activity since it. The transcript is JSON Lines
// and may lag the live conversation, so the final assistant text is taken from
// the hook payload, not from here.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { redact } from "./redact.mjs";

/** Parse a JSONL file into objects, skipping lines that do not parse. */
export function readTranscript(path) {
  try {
    return parseLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * The end of a transcript, parsed. Long sessions reach tens of megabytes and
 * every gate only needs the last turn or two, so read `start` bytes from the
 * end and double until `enough(entries)` holds, the whole file is read, or
 * `maxBytes` have been read.
 */
export function readTranscriptTail(path, enough, start = 1 << 20, maxBytes = Infinity) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    for (let bytes = start; ; bytes *= 2) {
      const from = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      let text = buf.toString("utf8");
      // The first line of a partial read is cut; a cut character can only be there too.
      if (from > 0) text = text.slice(text.indexOf("\n") + 1);
      const entries = parseLines(text);
      if (from === 0 || bytes >= maxBytes || enough(entries)) return entries;
    }
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function parseLines(raw) {
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

/** True once the entries reach back past the current prompt to an earlier one. */
function reachesEarlierPrompt(entries, currentPrompt) {
  let i = entries.length - 1;
  for (; i >= 0; i -= 1) {
    const text = userText(entries[i]);
    if (text === null || cleanPrompt(text) !== currentPrompt) break;
  }
  for (; i >= 0; i -= 1) {
    const text = userText(entries[i]);
    if (text !== null && !/^\s*<command-name>/.test(text) && cleanPrompt(text).length > 0) return true;
  }
  return false;
}

/** previousAssistantText, reading only as much of the file as it needs. */
export function previousAssistantTextFrom(path, currentPrompt, start) {
  return previousAssistantText(readTranscriptTail(path, (e) => reachesEarlierPrompt(e, currentPrompt), start), currentPrompt);
}

/**
 * What the assistant said in the turn before `currentPrompt`: its text blocks,
 * oldest first, stopping at the previous human prompt. The current prompt may
 * or may not be in the transcript yet, so a trailing copy of it is skipped.
 */
export function previousAssistantText(entries, currentPrompt) {
  let i = entries.length - 1;
  for (; i >= 0; i -= 1) {
    const text = userText(entries[i]);
    if (text === null) break;
    if (cleanPrompt(text) !== currentPrompt) break;
  }
  const parts = [];
  for (; i >= 0; i -= 1) {
    const entry = entries[i];
    const text = userText(entry);
    if (text !== null && !/^\s*<command-name>/.test(text) && cleanPrompt(text).length > 0) break;
    if (entry?.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    const blocks = entry.message.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
    if (blocks.length) parts.unshift(blocks.join("\n\n"));
  }
  return parts.join("\n\n");
}

/**
 * The assistant's replies in the `turns` turns before the prompt at
 * `promptIndex`, oldest first, each clipped to `maxChars` keeping its start
 * and end. A final reply often restates results from earlier turns, and those
 * results have no tool output in the current turn.
 *
 * A reply is only as good as the gate that saw it. A turn with no tool calls
 * is left out, because the claims gate stands down on those and its claims
 * were never checked. In a turn the claims gate blocked, the sentences it
 * quoted as unsupported are dropped and the rest is kept, including the reply
 * after the block. What remains unchecked is a claim the gate let through on
 * its second stop, or any reply in shadow mode; one of those, repeated, can
 * support itself once.
 */
export function earlierReplies(entries, promptIndex, { turns = 3, maxChars = 2000 } = {}) {
  const out = [];
  let end = promptIndex;
  for (let t = 0; t < turns; t += 1) {
    const prompt = lastUserPrompt(entries.slice(0, end));
    const turn = entries.slice(prompt ? prompt.index + 1 : 0, end);
    const ranTools = turn.some((e) => e?.type === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === "tool_use"));
    if (ranTools) {
      let text = assistantTextSince(turn, -1).trim();
      const flagged = flaggedClaims(turn);
      if (flagged.size > 0) text = splitSentences(text, 400).filter((s) => !flagged.has(s)).join("\n");
      if (text) out.unshift(clipMiddle(text, maxChars));
    }
    if (!prompt) break;
    end = prompt.index;
  }
  return out;
}

/** Sentences a claims-gate block in these entries quoted as unsupported. */
function flaggedClaims(entries) {
  const out = new Set();
  for (const e of entries) {
    const content = e?.type === "user" && typeof e.message?.content === "string" ? e.message.content : "";
    if (!/^Stop hook feedback/.test(content) || !/Claims gate:/.test(content)) continue;
    for (const m of content.matchAll(/^- "(.*)" \(p_evidence=/gm)) out.add(m[1]);
  }
  return out;
}

/** True once the entries hold `n` real prompts, or more. */
export function holdsPrompts(entries, n) {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0 && seen < n; i -= 1) {
    const text = userText(entries[i]);
    if (text !== null && !/^\s*<command-name>/.test(text) && cleanPrompt(text).length > 0) seen += 1;
  }
  return seen >= n;
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
  if (!Array.isArray(content)) return "";
  const text = content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  // An image result has no text, but the assistant saw it. Say so, or every
  // claim about a screenshot or a video frame reads as unsupported.
  const images = content.filter((b) => b?.type === "image").length;
  if (images === 0) return text;
  const note = `[${images} image${images === 1 ? "" : "s"} returned and seen by the assistant; pixels not included here]`;
  return text ? `${text}\n${note}` : note;
}

/**
 * Keep the start and the end of a long text. Results usually sit at the end of
 * an output (a test summary, an exit code, a pushed ref), so a head-only clip
 * drops exactly the part a claim points at. Redacts first: a secret cut in two
 * no longer matches its pattern, and a key block cut in the middle loses both
 * its BEGIN and END anchors.
 */
export function clipMiddle(text, max) {
  return cutMiddle(redact(text), max);
}

/** clipMiddle for text already redacted. */
function cutMiddle(text, max) {
  if (text.length <= max) return text;
  const marker = ` [… ${text.length - max} chars cut …] `;
  const head = Math.floor(max * 0.4);
  return text.slice(0, head) + marker + text.slice(text.length - (max - head));
}

// Above this a command is left to clipMiddle unfolded. Folding is linear, but
// the hook must never spend its Stop budget on one pathological command.
const MAX_FOLD_CHARS = 64 * 1024;
// `<<TAG`, `<<-TAG`, `<< 'TAG'`, `<<"TAG"`, not a `<<<` here-string, and a tag
// must start like a word, so `$((1 << 2))` is not a heredoc.
const HEREDOC_OPEN = /(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/;

/**
 * Fold heredoc bodies in a shell command. A commit message or an inline script
 * can fill the whole allowance and push `&& git push` or `git check-ignore`
 * out of view. A body is folded only when its terminator line exists, found
 * by lookup, so an unterminated `<< value` in a C++ or JS body costs nothing.
 */
export function foldHeredocs(command) {
  if (command.length > MAX_FOLD_CHARS || !command.includes("<<")) return command;
  const lines = command.split("\n");
  const at = new Map();
  lines.forEach((line, i) => {
    const key = line.trim();
    if (!at.has(key)) at.set(key, []);
    at.get(key).push(i);
  });
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const m = HEREDOC_OPEN.exec(lines[i]);
    if (!m) continue;
    const end = firstAfter(at.get(m[3]), i);
    if (end === -1) continue;
    const n = end - i - 1;
    if (n > 0) out.push(`[… ${n} heredoc line${n === 1 ? "" : "s"} …]`);
    out.push(lines[end]);
    i = end;
  }
  return out.join("\n");
}

/** The first number in a sorted list that is greater than `after`, or -1. */
function firstAfter(sorted, after) {
  if (!sorted) return -1;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > after) hi = mid;
    else lo = mid + 1;
  }
  return lo < sorted.length ? sorted[lo] : -1;
}

/** A subagent hand-back without the ~470-char preamble every one carries. */
function handbackBody(text) {
  const at = text.indexOf("The report follows:");
  const body = at === -1 ? text : text.slice(text.indexOf("\n", at) + 1);
  return body.replace(/<\/agent-message>\s*$/, "").trim();
}

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Results that come back outside a tool result, each labelled for what it is:
 * a background subagent's report (a meta user entry from a peer, or a queued
 * prompt from a peer), a background task's completion notice (a queued
 * task-notification), a message the user queued mid-turn, and harness notices
 * that the tool list or MCP servers changed. Each takes the seq of the tool
 * call before it plus a half, so it sorts after that call and before the next.
 */
function notesSince(entries, index) {
  const out = [];
  let seq = -1;
  const note = (name, detail, text) => out.push({ note: true, seq: seq + 0.5, name, detail, text });
  for (let i = index + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
      seq += e.message.content.filter((b) => b?.type === "tool_use").length;
      continue;
    }
    if (e?.type === "user" && e.isMeta && e.origin?.kind === "peer" && typeof e.origin.body === "string") {
      note("subagent report", `from ${e.origin.from ?? "a subagent"}`, handbackBody(e.origin.body));
      continue;
    }
    if (e?.type !== "attachment" || !e.attachment || typeof e.attachment !== "object") continue;
    const a = e.attachment;
    if (a.type === "queued_command") {
      const text = typeof a.prompt === "string" ? a.prompt : resultText(a.prompt);
      if (!text.trim()) continue;
      if (a.commandMode === "task-notification" || (!a.commandMode && /^\s*<task-notification>/.test(text))) {
        const body = text.replace(/<note>[\s\S]*?<\/note>\s*/g, "").replace(/<output-file>[\s\S]*?<\/output-file>\s*/g, "");
        note("task notification", /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1] ?? "background task finished", body);
      } else if (a.origin?.kind === "peer" || a.isMeta) {
        note("subagent report", `from ${a.origin?.from ?? "a subagent"}`, handbackBody(text));
      } else {
        note("user message", "sent by the user while the turn ran", cleanPrompt(text));
      }
    } else if (a.type === "deferred_tools_delta") {
      const lines = [
        ["added", list(a.addedNames)],
        ["removed", [...list(a.removedNames), ...list(a.retractedTools).map((t) => t?.name)]],
      ]
        .map(([verb, names]) => [verb, byServer(names)])
        .filter(([, servers]) => servers)
        .map(([verb, servers]) => `tools ${verb}: ${servers}`);
      if (lines.length) note("harness notice", "the assistant's tool list changed", lines.join("\n"));
    } else if (a.type === "mcp_instructions_delta") {
      const lines = [
        ["connected", list(a.addedNames)],
        ["disconnected", list(a.removedNames)],
      ]
        .map(([verb, names]) => [verb, names.filter((n) => typeof n === "string" && n)])
        .filter(([, names]) => names.length)
        .map(([verb, names]) => `MCP servers ${verb}: ${names.join(", ")}`);
      if (lines.length) note("harness notice", "MCP servers changed", lines.join("\n"));
    }
  }
  return out;
}

/** Activity items that are real work, as opposed to notices about the session. */
export function isWork(item) {
  return item.tool !== "harness notice" && item.tool !== "user message" && item.tool !== "…";
}

/** "mcp__a__x, mcp__a__y, Read" → "mcp__a (2 tools), Read"; empty → "". */
function byServer(names) {
  const counts = new Map();
  for (const n of list(names)) {
    if (typeof n !== "string" || !n) continue;
    const key = /^(mcp__.+?)__/.exec(n)?.[1] ?? n;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, c]) => (c > 1 ? `${k} (${c} tools)` : k)).join(", ");
}

// A write tool's success message says nothing but "ok", yet takes ~180 chars;
// a long turn has dozens, and they crowd older calls out of the budget.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function boilerplate(tool, text) {
  if (WRITE_TOOLS.has(tool) && /^(?:The file .* has been (?:updated|created)|File created) successfully/.test(text)) return "ok";
  return text;
}

function detailOf(input) {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description;
  const detail = pick ?? (Object.keys(input).length ? input : "");
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

// Allowances tried in turn, largest first: [result chars, detail chars].
// Every call is kept at the largest allowance under the budget; only when even
// the smallest does not fit are the oldest calls dropped, because the final
// reply mostly reports the work at the end of the turn.
const ALLOWANCES = [
  [1200, 600],
  [800, 400],
  [500, 300],
  [300, 200],
  [160, 160],
];

/**
 * Tool calls after the prompt, each paired with a clipped result, under a
 * total character budget. This is the evidence the claims gate judges against.
 */
export function toolActivitySince(entries, index, { maxItems = 80, maxTotalChars = 20_000 } = {}) {
  const results = new Map();
  for (let i = index + 1; i < entries.length; i += 1) {
    const e = entries[i];
    if (e?.type !== "user" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      // Redacted once here, not on each of up to five allowance passes.
      if (b?.type === "tool_result") results.set(b.tool_use_id, { text: redact(resultText(b.content)), isError: Boolean(b.is_error) });
    }
  }
  const all = [...toolUsesSince(entries, index), ...notesSince(entries, index)].sort((a, b) => a.seq - b.seq);
  // Past maxItems, the oldest go first, before any allowance is tried, so a
  // long turn of small calls keeps full-size outputs for the ones it keeps.
  let omitted = Math.max(0, all.length - maxItems);
  const uses = all.slice(omitted).map((b) => {
    if (b.note) return { ...b, detail: redact(b.detail), text: redact(b.text) };
    const raw = redact(detailOf(b.input));
    // Folded once here; the allowance loop below may build up to five times.
    return { ...b, raw, folded: raw.length > ALLOWANCES.at(-1)[1] ? foldHeredocs(raw) : raw };
  });
  const build = ([resultMax, detailMax]) =>
    uses.map((b) => {
      if (b.note) return { seq: b.seq, tool: b.name, detail: cutMiddle(b.detail, detailMax), result: cutMiddle(b.text, resultMax * 2) };
      const detail = cutMiddle(b.raw.length > detailMax ? b.folded : b.raw, detailMax);
      const r = results.get(b.id);
      // A subagent's answer is its conclusion; give it twice the room.
      const max = b.name === "Agent" || b.name === "Task" ? resultMax * 2 : resultMax;
      const result = r ? cutMiddle(r.isError ? r.text : boilerplate(b.name, r.text), max) : "(no result recorded)";
      return { seq: b.seq, tool: b.name, detail, result, ...(r?.isError ? { error: true } : {}) };
    });
  const size = (items) => items.reduce((n, item) => n + JSON.stringify(item).length + 1, 0);
  const marked = (items) => (omitted > 0 ? [{ tool: "…", detail: `${omitted} earlier tool calls omitted for size`, result: "" }, ...items] : items);
  let items;
  for (const allowance of ALLOWANCES) {
    items = build(allowance);
    if (size(items) <= maxTotalChars) return marked(items);
  }
  while (items.length > 1 && size(items) > maxTotalChars) {
    items = items.slice(1);
    omitted += 1;
  }
  return marked(items);
}

// Values: a result an earlier output can show, such as a colour, a ratio, a
// measure, a number, or quoted text. Subjects: what a claim is about, such as
// a path, a dotted or camelCase name, a constant. A subject alone proves
// nothing: a file listing holds the name of a file, not what the file says.
const VALUE_TERMS = [
  /#[0-9a-f]{3,8}\b/gi,
  /\d+(?:\.\d+)?:1\b/g,
  /\d+(?:\.\d+)?(?:px|rem|em|ms|kb|mb|%)(?![a-z])/gi,
  /\b\d+\.\d+\b/g,
  /(?<!#)\b\d{3,}\b/g,
];
const SUBJECT_TERMS = [
  /[A-Za-z_$][\w$]*(?:[./-][\w$]+)+/g,
  /\b[a-z]+[A-Z]\w*\b/g,
  /\b[A-Z][A-Z0-9_]{3,}\b/g,
];
const QUOTED = /["“]([^"”\n]{3,60})["”]/g;
const COMMON_WORDS = new Set(
  "about above after again against all also already another around because before being below between both cannot could does doing during each every first found from given have having here into just later least looks makes might more most much never next only other ours same seems shows should since some still such than that their them then there these they this those though three through under until very what when where which while will with within without would your yours".split(" "),
);

/** The terms of one sentence, each with a weight: 3 for a value, 2 for a subject, 1 for a plain word. */
export function claimTerms(sentence) {
  const terms = new Map();
  const add = (t, w) => {
    const key = t.toLowerCase().trim();
    if (key.length >= 3 && !/^(?:19|20)\d\d$/.test(key)) terms.set(key, Math.max(terms.get(key) ?? 0, w));
  };
  for (const re of VALUE_TERMS) for (const m of sentence.matchAll(re)) add(m[0], 3);
  for (const m of sentence.matchAll(QUOTED)) add(m[1], 3);
  for (const re of SUBJECT_TERMS) for (const m of sentence.matchAll(re)) add(m[0], 2);
  for (const m of sentence.toLowerCase().matchAll(/\b[a-z]{5,}\b/g)) if (!COMMON_WORDS.has(m[0])) add(m[0], 1);
  return terms;
}

/** Windows of `radius` around the first hit of each term, merged, joined with a cut marker. */
function excerpt(text, terms, radius, max) {
  const lower = text.toLowerCase();
  const spans = [];
  for (const t of terms) {
    const at = lower.indexOf(t);
    if (at !== -1) spans.push([Math.max(0, at - radius), Math.min(text.length, at + t.length + radius)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const out = merged.map(([a, b]) => text.slice(a, b)).join(" [… cut …] ");
  return cutMiddle(out, max);
}

/**
 * Tool outputs from earlier turns that mention a claim's specific terms. The
 * evidence in this turn misses a result the assistant measured turns ago and
 * now restates; the three earlier replies reach only so far back, and carry
 * the assistant's words, not the output. For each claim the two best matching
 * outputs holding at least one of its values are kept, newest first on a tie,
 * as redacted excerpts around the matches, labelled with the terms they hold
 * and how many prompts back they ran. Returns one list per claim, so each
 * claim is judged against its own matches only: shown together, a match for
 * one sentence lent support to the next.
 */
export function earlierToolResults(entries, promptIndex, claims, { perClaim = 2, maxItems = 12, maxChars = 6000, scanChars = 100_000, radius = 160, itemChars = 700 } = {}) {
  const wanted = claims.map((c) => [...claimTerms(c)]);
  const none = claims.map(() => []);
  if (!wanted.some((terms) => terms.some(([, w]) => w === 3))) return none;

  // Tool calls and results before the prompt, with the number of prompts since.
  const calls = new Map();
  const found = [];
  let prompts = 0;
  for (let i = promptIndex - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.isSidechain) continue;
    const text = userText(e);
    if (text !== null && !/^\s*<command-name>/.test(text) && cleanPrompt(text).length > 0) prompts += 1;
    if (e?.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b?.type === "tool_result") found.push({ id: b.tool_use_id, content: b.content, isError: Boolean(b.is_error), turnsAgo: prompts + 1, order: found.length });
    } else if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b?.type === "tool_use") calls.set(b.id, b);
    }
  }
  const items = [];
  for (const r of found) {
    const call = calls.get(r.id);
    if (!call || r.isError) continue;
    // Matched on the result only: the input is the assistant's own words, and a
    // note it wrote earlier must not vouch for what it says now.
    const result = resultText(r.content);
    const hay = result.length > scanChars ? cutMiddle(result, scanChars) : result;
    items.push({ ...r, name: call.name, detail: detailOf(call.input ?? {}), hay, lower: hay.toLowerCase() });
  }

  const picks = [];
  wanted.forEach((terms, claim) => {
    const scored = [];
    for (const item of items) {
      let score = 0;
      let value = false;
      const hits = [];
      for (const [t, w] of terms) {
        if (item.lower.includes(t)) {
          score += w;
          value ||= w === 3;
          hits.push(t);
        }
      }
      // Without a value, a match is only about the same thing, not the same result.
      if (value) scored.push({ item, score, hits });
    }
    scored.sort((a, b) => b.score - a.score || a.item.order - b.item.order);
    for (const { item, hits } of scored.slice(0, perClaim)) picks.push({ claim, item, hits });
  });

  const out = none;
  const redacted = new Map();
  let used = 0;
  // Newest first under the budget, each claim's list then oldest first for reading.
  for (const { claim, item, hits } of picks.sort((a, b) => a.item.order - b.item.order).slice(0, maxItems)) {
    // Redacted before it is cut, as everywhere else, so a secret split by the excerpt cannot slip through.
    if (!redacted.has(item)) redacted.set(item, redact(item.hay));
    const entry = {
      turns_ago: item.turnsAgo,
      tool: item.name,
      detail: cutMiddle(redact(item.detail), 200),
      matched: hits,
      excerpt: excerpt(redacted.get(item), hits, radius, itemChars),
    };
    const size = JSON.stringify(entry).length;
    if (used + size > maxChars) break;
    used += size;
    out[claim].unshift(entry);
  }
  return out;
}
