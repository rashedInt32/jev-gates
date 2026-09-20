// Read a commit message out of a shell command and the staged diff it applies
// to. Pure parsing plus one git call with a hard timeout.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** True when the command contains a git commit invocation. */
export function isGitCommit(command) {
  return /(^|[;&|]\s*|\bthen\s+|\bdo\s+)git\s+(?:-C\s+\S+\s+)?commit\b/.test(command);
}

/**
 * Extract the commit message from `-m`, `--message=`, a heredoc passed through
 * `-m "$(cat <<'EOF' … EOF)"`, or `-F <file>`. Several `-m` flags join with a
 * blank line, as git does. Returns null when no message is given inline.
 */
export function parseCommitMessage(command, cwd = process.cwd()) {
  const parts = [];

  // Heredoc form used by many agents: -m "$(cat <<'EOF' ... EOF )"
  const heredoc = /-m\s+"\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)"/g;
  let m;
  while ((m = heredoc.exec(command)) !== null) parts.push(m[2]);
  const stripped = command.replace(heredoc, "-m __HEREDOC__");

  const flag = /(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g;
  while ((m = flag.exec(stripped)) !== null) {
    const value = m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, "$1") : m[2] !== undefined ? m[2] : m[3];
    if (value !== "__HEREDOC__") parts.push(value);
  }

  const file = /(?:^|\s)(?:-F|--file)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(stripped);
  if (file) {
    const path = file[1] ?? file[2] ?? file[3];
    try {
      parts.push(readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf8"));
    } catch {
      // unreadable message file: nothing to judge
    }
  }

  const message = parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
  return message.length > 0 ? message : null;
}

/**
 * What a `git add` earlier in the same command will stage before the commit
 * runs. Returns null when the command stages nothing, `{ all: true }` for
 * `-A`, `--all`, `.` or `:/`, `{ tracked: true }` for `-u`, otherwise the
 * listed paths. Interactive forms (`-p`, `-i`, `-e`) stage an unknowable
 * subset, so they count as nothing.
 */
export function stagedByCommand(command) {
  const re = /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)git\s+(?:-C\s+\S+\s+)?add\b([^;&|\n]*)/g;
  let all = false;
  let tracked = false;
  const paths = [];
  let m;
  while ((m = re.exec(command)) !== null) {
    const tokens = tokenize(m[1]);
    if (tokens.some((t) => /^(-p|-i|-e|--patch|--interactive|--edit)$/.test(t))) continue;
    for (const t of tokens) {
      if (t === "-A" || t === "--all" || t === "." || t === ":/" || t === "--no-ignore-removal") all = true;
      else if (t === "-u" || t === "--update") tracked = true;
      else if (t.startsWith("-")) continue;
      else paths.push(t);
    }
  }
  if (all) return { all: true };
  if (paths.length === 0 && !tracked) return null;
  return { tracked, paths };
}

/** Split shell words, honouring single and double quotes. */
function tokenize(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * The diff this commit would record. Staged content by default, the whole
 * working tree with -a, and when a `git add` in the same command precedes the
 * commit, the working-tree state of what it stages, including files git does
 * not know yet. Read at PreToolUse time, before any of it runs.
 */
export function commitDiff(command, cwd, { maxBuffer = 4_000_000, timeout = 4000 } = {}) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer, timeout, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const all = /\s(?:-a|--all|-[a-zA-Z]*a[a-zA-Z]*)\b/.test(command.replace(/-m\s+"[^"]*"/g, ""));
  const add = stagedByCommand(command);

  if (all || add?.all) {
    const tracked = git("diff", "HEAD", "--no-color", "--unified=1");
    const untracked = add?.all ? untrackedDiff(git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean), cwd) : "";
    return tracked + untracked;
  }

  let diff = git("diff", "--cached", "--no-color", "--unified=1");
  if (add?.tracked) diff += git("diff", "HEAD", "--no-color", "--unified=1");
  if (add?.paths?.length) {
    diff += git("diff", "HEAD", "--no-color", "--unified=1", "--", ...add.paths);
    const others = git("ls-files", "--others", "--exclude-standard", "-z", "--", ...add.paths).split("\0").filter(Boolean);
    diff += untrackedDiff(others, cwd);
  }
  return diff;
}

/** A plain added-file diff for paths git does not track yet. */
export function untrackedDiff(paths, cwd, { maxFileChars = 20_000 } = {}) {
  let out = "";
  for (const rel of paths) {
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    let text;
    try {
      if (!statSync(abs).isFile()) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const body = text.length > maxFileChars ? text.slice(0, maxFileChars) + "\n[truncated]" : text;
    const lines = body.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    out += `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
  }
  return out;
}
