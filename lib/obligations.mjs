// Proof gate support: turn the files Claude edited this turn into a short list
// of obligations, each a concrete change that could alter behaviour and so
// deserves evidence that it was exercised. Deterministic enumeration; Jev
// judges risk and evidence.
//
// The enumeration is the safety boundary. Jev can only ask for proof of what
// is listed here, so the list favours recall over precision: a spurious
// obligation costs one low risk score, a missed one costs coverage.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { untrackedDiff } from "./git.mjs";
import { shellWrites } from "./shell.mjs";
import { toolUsesSince } from "./transcript.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SKIP_PATH = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|CHANGELOG[^/]*|LICENSE[^/]*)$|\.(?:md|mdx|txt|rst|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|log|min\.js|min\.css|map)$/i;
const CONFIG_PATH = /\.(?:json|ya?ml|toml|ini|env|cfg|conf|properties)$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|(?:\.|_)(?:test|spec)\.\w+$|(?:^|\/)test_\w+\.py$|_test\.go$/;

const COMMENT_LINE = /^\s*(?:\/\/|#(?!include|define|if|else|endif)|\*|\/\*|--|<!--|\*\/)/;
const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|(?:const|let|var)\s+.*=\s*require\(|export\s+\*|export\s+\{[^}]*\}\s+from|use\s+[\w:]+;|#include\b|using\s+[\w.]+;|package\s+\w+)/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "with", "try", "match", "when", "case", "await", "yield", "new", "typeof", "throw"]);

const SIGNATURES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, // function foo(
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/, // const foo = (a) =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/, // const foo = function
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+)?\{\s*$/, // method(a) {
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, // python
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, // rust
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, // go
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{\s*$/, // java / c#
  /^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(/, // lua
];

const TEST_DECL = /^\s*(?:(?:test|it|describe|context|suite)\s*(?:\.\w+)?\s*\(|def\s+test_\w+|func\s+Test\w+|#\[test\]|@Test\b)/;
const TEST_SKIP = /\b(?:test|it|describe|suite)\s*\.\s*(?:skip|only|todo)\s*\(|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|\bpending\s*\(|#\[ignore\]|\.only\(/;
const ERROR_PATH = /\b(?:throw|raise|panic!|rescue|except|catch|finally|process\.exit|sys\.exit|os\.Exit|exit\s*\(|abort\s*\()\b|\bnew\s+\w*(?:Error|Exception)\s*\(|\.catch\s*\(|\btry\s*[{:]/;
const BRANCH = /^\s*(?:\}\s*)?(?:else\s+)?if\b|^\s*else\b|^\s*(?:switch|match|when|unless|elif|elsif)\b|^\s*(?:case\b|default\s*:)|\?[^?:]+:|&&|\|\||\?\?|\?\.|^\s*(?:for|while|loop|until)\b|\.(?:filter|some|every|find|includes|startsWith|endsWith)\s*\(|^\s*return\s+(?:!|null|undefined|false|true|None|nil|0)\b/;
const LITERAL = /\b\d+(?:\.\d+)?\b|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:true|false|null|undefined|None|True|False|nil)\b/g;

const PRIORITY = { test_removed: 0, signature: 1, error_path: 2, default: 3, branch: 4, behavior: 5, config: 6, file_deleted: 1 };

export const KIND_LABEL = {
  test_removed: "test removed or skipped",
  signature: "signature changed",
  error_path: "error handling changed",
  default: "value changed",
  branch: "branch changed",
  behavior: "body changed",
  config: "configuration changed",
  file_deleted: "file deleted",
};

/**
 * Files Claude edited after the prompt, with the sequence number of the tool
 * call that first touched each. Edit tools name the file; shell writes are
 * detected statically. Paths are absolute; unresolvable targets are dropped.
 */
export function editedFilesSince(entries, index, cwd) {
  const out = new Map();
  const note = (path, seq) => {
    if (!path || typeof path !== "string" || path.startsWith("(")) return;
    const abs = isAbsolute(path) ? path : join(cwd, path);
    if (!out.has(abs)) out.set(abs, seq);
  };
  for (const use of toolUsesSince(entries, index)) {
    const input = use.input ?? {};
    if (EDIT_TOOLS.has(use.name)) note(input.file_path ?? input.notebook_path, use.seq);
    else if (use.name === "Bash" && typeof input.command === "string") {
      const writes = shellWrites(input.command, { cwd });
      for (const t of writes?.targets ?? []) if (!/[*?$`]/.test(t)) note(t, use.seq);
    }
  }
  return out;
}

/** Resolve symlinks (macOS puts temp dirs under /private) without requiring the leaf to exist. */
export function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

function git(root, args, { timeout = 4000, maxBuffer = 4_000_000 } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** The git top level containing cwd, or null. */
export function repoRoot(cwd) {
  const out = git(cwd, ["rev-parse", "--show-toplevel"]);
  return out ? out.trim() : null;
}

/**
 * The working-tree diff against HEAD for the given absolute paths, one entry
 * per file inside the repo. Untracked files diff as wholly added. Files
 * outside the repo, and files git ignores, are dropped.
 */
export function diffForFiles(root, files, { maxFileChars = 20_000 } = {}) {
  const base = realPath(root);
  const rels = [];
  for (const abs of files) {
    const rel = relative(base, realPath(abs));
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || SKIP_PATH.test(rel)) continue;
    rels.push(rel);
  }
  if (rels.length === 0) return [];
  const tracked = git(root, ["diff", "HEAD", "--no-color", "--unified=2", "--", ...rels]) ?? "";
  const othersRaw = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...rels]) ?? "";
  const others = othersRaw.split("\0").filter(Boolean);
  const combined = tracked + untrackedDiff(others, root, { maxFileChars });
  return splitDiff(combined).map((f) => ({ ...f, patch: f.patch.length > maxFileChars ? f.patch.slice(0, maxFileChars) + "\n[truncated]" : f.patch }));
}

/** Split a unified diff into { path, status, patch } per file. */
export function splitDiff(text) {
  const out = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  for (const block of blocks) {
    const header = /^diff --git a\/(.+?) b\/(.+?)\n/.exec(block);
    if (!header) continue;
    const path = header[2];
    const status = /^new file mode/m.test(block) ? "A" : /^deleted file mode/m.test(block) ? "D" : "M";
    out.push({ path, status, patch: block });
  }
  return out;
}

/** Hunks of one file patch: new-file start line and the changed lines with their kind. */
export function parseHunks(patch) {
  const hunks = [];
  let current = null;
  for (const line of patch.split("\n")) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (head) {
      current = { start: Number(head[1]), context: head[2].trim(), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    const mark = line[0];
    if (mark === "+" || mark === "-" || mark === " ") current.lines.push({ mark, text: line.slice(1) });
  }
  for (const h of hunks) {
    let n = h.start;
    for (const l of h.lines) {
      if (l.mark !== "-") {
        l.line = n;
        n += 1;
      } else l.line = n;
    }
  }
  return hunks;
}

function signatureName(text) {
  for (const re of SIGNATURES) {
    const m = re.exec(text);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

/** Name of the function enclosing `line` in `source`, scanning upwards. */
export function enclosingFunction(source, line) {
  if (!source) return null;
  const lines = source.split("\n");
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i -= 1) {
    const name = signatureName(lines[i]);
    if (name) return name;
  }
  return null;
}

function substantive(text) {
  const t = text.trim();
  return t.length > 0 && !COMMENT_LINE.test(t) && !IMPORT_LINE.test(t) && !/^[{}()[\];,]*$/.test(t);
}

function skeleton(text) {
  return text.replace(LITERAL, "⟨lit⟩").replace(/\s+/g, " ").trim();
}

function excerptOf(lines, max = 3) {
  return lines.slice(0, max).map((l) => (l.mark + " " + l.text).slice(0, 160));
}

/**
 * Obligations for one file. `source` is the working-tree content, used to
 * name the enclosing function; it may be null.
 */
export function obligationsForFile({ path, status, patch }, source) {
  if (SKIP_PATH.test(path)) return [];
  if (status === "D") return [{ file: path, line: 1, kind: "file_deleted", function: null, summary: "file deleted", excerpt: [] }];
  const isTest = TEST_PATH.test(path);
  const isConfig = CONFIG_PATH.test(path);
  const out = [];
  const seen = new Set();
  const push = (o) => {
    const key = `${o.kind}|${o.function ?? ""}|${o.summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: path, ...o });
  };

  for (const hunk of parseHunks(patch)) {
    const added = hunk.lines.filter((l) => l.mark === "+" && substantive(l.text));
    const removed = hunk.lines.filter((l) => l.mark === "-" && substantive(l.text));
    if (added.length === 0 && removed.length === 0) continue;
    const anchor = added[0] ?? removed[0];
    const fn = enclosingFunction(source, anchor.line) ?? (hunk.context ? signatureName(hunk.context) ?? hunk.context.slice(0, 60) : null);
    const where = fn ? ` in ${fn}` : "";

    if (isConfig) {
      push({ line: anchor.line, kind: "config", function: null, summary: `configuration changed (+${added.length}/-${removed.length} lines)`, excerpt: excerptOf([...removed, ...added]) });
      continue;
    }

    if (isTest) {
      const addedText = new Set(added.map((a) => a.text.trim()));
      for (const l of removed) if (TEST_DECL.test(l.text) && !addedText.has(l.text.trim())) push({ line: l.line, kind: "test_removed", function: fn, summary: `test removed: ${l.text.trim().slice(0, 100)}`, excerpt: excerptOf([l]) });
      for (const l of added) if (TEST_SKIP.test(l.text)) push({ line: l.line, kind: "test_removed", function: fn, summary: `test skipped or narrowed: ${l.text.trim().slice(0, 100)}`, excerpt: excerptOf([l]) });
      // Other edits to tests are not obligations: a test is its own proof when it runs.
      continue;
    }

    let claimed = false;

    // Signature changes: a removed signature line, with or without an added replacement.
    for (const l of removed) {
      const name = signatureName(l.text);
      if (!name) continue;
      const replacement = added.find((a) => signatureName(a.text) === name);
      if (replacement) push({ line: replacement.line, kind: "signature", function: name, summary: `signature of ${name} changed`, excerpt: excerptOf([l, replacement]) });
      else push({ line: l.line, kind: "signature", function: name, summary: `${name} removed or renamed`, excerpt: excerptOf([l]) });
      claimed = true;
    }

    // Literal-only edits: same shape, different value.
    const pairs = Math.min(added.length, removed.length);
    for (let i = 0; i < pairs; i += 1) {
      const a = added[i];
      const r = removed[i];
      if (skeleton(a.text) !== skeleton(r.text)) continue;
      const before = r.text.match(LITERAL) ?? [];
      const after = a.text.match(LITERAL) ?? [];
      const diffs = before.map((b, k) => [b, after[k]]).filter(([b, c]) => b !== c);
      if (diffs.length === 0) continue;
      push({ line: a.line, kind: "default", function: fn, summary: `value changed${where}: ${diffs.map(([b, c]) => `${b} to ${c}`).join(", ").slice(0, 120)}`, excerpt: excerptOf([r, a]) });
      claimed = true;
    }

    for (const l of added) {
      if (ERROR_PATH.test(l.text)) {
        push({ line: l.line, kind: "error_path", function: fn, summary: `error handling changed${where}: ${l.text.trim().slice(0, 100)}`, excerpt: excerptOf([l]) });
        claimed = true;
      } else if (BRANCH.test(l.text)) {
        push({ line: l.line, kind: "branch", function: fn, summary: `branch changed${where}: ${l.text.trim().slice(0, 100)}`, excerpt: excerptOf([l]) });
        claimed = true;
      }
    }

    if (!claimed) push({ line: anchor.line, kind: "behavior", function: fn, summary: `${fn ? `body of ${fn}` : "code"} changed (+${added.length}/-${removed.length} lines)`, excerpt: excerptOf([...removed, ...added]) });
  }
  return out;
}

/**
 * Obligations across files, highest priority first, capped. Each carries the
 * sequence number of the edit that produced it so evidence can be required to
 * come later.
 */
export function enumerateObligations(root, edited, { max = 16, readFile = defaultRead } = {}) {
  const base = realPath(root);
  const bySeq = new Map([...edited.entries()].map(([abs, seq]) => [realPath(abs), seq]));
  const files = diffForFiles(base, [...bySeq.keys()]);
  const all = [];
  for (const f of files) {
    const abs = join(base, f.path);
    const source = f.status === "D" ? null : readFile(abs);
    const seq = bySeq.get(abs) ?? Math.min(...bySeq.values());
    for (const o of obligationsForFile(f, source)) all.push({ ...o, edited_at_seq: seq });
  }
  all.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line);
  const kept = all.slice(0, max).map((o, i) => ({ id: `c${i}`, ...o }));
  return { obligations: kept, total: all.length, files: files.length };
}

function defaultRead(path) {
  try {
    const text = readFileSync(path, "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
