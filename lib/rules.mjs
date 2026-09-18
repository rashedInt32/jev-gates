// Turn CLAUDE.md files into a list of checkable rules.
//
// A rule is one line the model is expected to obey. We take list items and
// imperative sentences, drop headings, links, and code, and keep the source
// file so a violation can point back to it. Nothing is rewritten.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Lines worth checking even when they are not list items. */
const IMPERATIVE = /\b(never|always|must|must not|do not|don't|only|require[sd]?|forbid(?:den)?|no |avoid|prefer|use )\b/i;
/** Prohibitions and obligations sort ahead of advice when the cap trims. */
const STRONG = /\b(never|always|must|must not|do not|don't|forbid(?:den)?|no |require[sd]?)\b/i;

/** Files Claude Code itself loads as instructions, nearest first. */
export function candidateFiles(cwd, home = homedir()) {
  const files = [];
  let dir = resolve(cwd);
  const stop = resolve(home);
  for (let i = 0; i < 12; i += 1) {
    files.push(join(dir, "CLAUDE.md"), join(dir, "CLAUDE.local.md"), join(dir, ".claude", "CLAUDE.md"), join(dir, ".claude", "jev-gates.md"));
    if (dir === stop || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  files.push(join(home, ".claude", "CLAUDE.md"), join(home, ".claude", "jev-gates.md"));
  return [...new Set(files)];
}

/** Extract rule candidates from one Markdown document. */
export function extractRules(markdown, source = "") {
  const rules = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || line.startsWith("#") || line.startsWith("|") || line.startsWith("<")) continue;
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    const text = item ? item[1] : IMPERATIVE.test(line) ? line : null;
    if (!text) continue;
    const clean = text
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    if (clean.length < 12 || clean.length > 400) continue;
    if (/^https?:\/\//.test(clean)) continue;
    rules.push({ text: clean, source });
  }
  return rules;
}

/**
 * Collect rules for a working directory, strongest first, capped.
 *
 * Imperative rules ("never", "must", "always") sort ahead of plain list items
 * so the cap trims advice before it trims prohibitions.
 */
export function collectRules(cwd, { max = 64, home = homedir(), files } = {}) {
  const seen = new Set();
  const all = [];
  for (const file of files ?? candidateFiles(cwd, home)) {
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rule of extractRules(text, file)) {
      const key = rule.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...rule, strong: STRONG.test(rule.text) });
    }
  }
  all.sort((a, b) => Number(b.strong) - Number(a.strong));
  return all.slice(0, max).map(({ text, source }) => ({ text, source }));
}
