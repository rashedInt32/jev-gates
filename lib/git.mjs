// Read a commit message out of a shell command and the staged diff it applies
// to. Pure parsing plus one git call with a hard timeout.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** The diff this commit would record: staged, or everything tracked with -a. */
export function commitDiff(command, cwd, { maxBuffer = 4_000_000, timeout = 4000 } = {}) {
  const all = /\s(?:-a|--all|-[a-zA-Z]*a[a-zA-Z]*)\b/.test(command.replace(/-m\s+"[^"]*"/g, ""));
  const args = all ? ["diff", "HEAD", "--no-color", "--unified=1"] : ["diff", "--cached", "--no-color", "--unified=1"];
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer, timeout, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}
