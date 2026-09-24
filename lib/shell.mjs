// Detect shell commands that change files, so the rule and scope guards can
// judge them the same way they judge Edit and Write. Static, no execution.
//
// The point is coverage, not precision. Claude edits through `cat >>`, `sed -i`,
// heredocs and short scripts at least as often as through the Edit tool, and a
// guard that only watches Edit sees a minority of edits. A missed pattern
// costs coverage. A false hit costs one Jev request that will score low.

const SCRATCH = /^(?:\/private)?\/tmp\/|^\/dev\/|^\$\{?TMPDIR\}?\/|^\/var\/folders\//;

/** Split shell words, honouring quotes. Quotes are dropped from the result. */
export function words(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * One pass over a command line that knows quotes and comments. Returns the
 * text with quoted characters as "_" and comment characters as "\0", quotes
 * and newlines kept, so offsets line up with the original.
 */
function scan(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        out += c;
      } else if (quote === '"' && c === "\\" && i + 1 < text.length) {
        out += "__";
        i += 1;
      } else {
        out += "_";
      }
    } else if (c === "\\" && i + 1 < text.length) {
      out += c + text[i + 1];
      i += 1;
    } else if (c === "#" && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      // A comment runs to the end of the line; an apostrophe in it is not a quote.
      while (i < text.length && text[i] !== "\n") {
        out += "\0";
        i += 1;
      }
      i -= 1;
    } else {
      if (c === "'" || c === '"') quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * The text with every character inside quotes or comments replaced by "_", so
 * offsets still line up with the original. Operators inside quotes are text:
 * `echo "a > b"` redirects nothing and `echo 'a; rm x'` runs one command.
 */
export function maskQuotes(text) {
  return scan(text).replace(/\0/g, "_");
}

/** The text without its shell comments. */
export function stripComments(text) {
  const scanned = scan(text);
  let out = "";
  for (let i = 0; i < text.length; i += 1) if (scanned[i] !== "\0") out += text[i];
  return out;
}

/**
 * Simple commands in a command line, split outside quotes on ;, &&, ||, |, |&,
 * newlines, and a background &. Comments are dropped first.
 */
export function splitSegments(text) {
  const clean = stripComments(text);
  const masked = maskQuotes(clean);
  const out = [];
  let from = 0;
  for (const sep of masked.matchAll(/\|\||&&|\|&|;|\n|\||(?<![<>&|])&(?![>&])/g)) {
    out.push(clean.slice(from, sep.index));
    from = sep.index + sep[0].length;
  }
  out.push(clean.slice(from));
  return out;
}

// Flags that take the next word as their value, per subcommand. `-m` is a message
// for stash but a merge switch for checkout, so one global list misreads paths.
const GIT_VALUE_FLAGS = {
  stash: /^(?:-m|--message)$/,
  checkout: /^(?:-b|-B|--orphan)$/,
  restore: /^(?:-s|--source)$/,
};
const STASH_ACTIONS = /^(?:push|save|pop|apply|list|show|drop|clear|branch|create|store)$/;

/** Paths a git subcommand names: after `--`, else positional words minus flag values. */
function gitPaths(rest, sub) {
  const dd = rest.indexOf("--");
  if (dd >= 0) return rest.slice(dd + 1);
  const takesValue = GIT_VALUE_FLAGS[sub];
  const paths = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (takesValue?.test(rest[i])) i += 1;
    else if (!rest[i].startsWith("-")) paths.push(rest[i]);
  }
  return paths;
}

/** File changes a git command makes: `[op, ...paths]`, or null when it changes no files. */
function gitWrites(args) {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const has = (re) => rest.some((a) => re.test(a));
  switch (sub) {
    case "stash": {
      const action = STASH_ACTIONS.test(rest[0] ?? "") ? rest[0] : "push";
      if (!/^(?:push|save|pop|apply)$/.test(action)) return null;
      const paths = action === "push" ? gitPaths(rest[0] === "push" ? rest.slice(1) : rest, "stash") : [];
      return ["git stash", ...(paths.length ? paths : ["(worktree)"])];
    }
    case "checkout": {
      if (!rest.includes("--") && has(/^(?:-b|-B|--orphan)$/)) return null;
      if (has(/^(?:-p|--patch)$/)) return ["git checkout", "(worktree)"];
      const paths = gitPaths(rest, "checkout");
      if (paths.length === 0) return null;
      return ["git checkout", ...(rest.includes("--") ? paths : ["(worktree)"])];
    }
    case "restore":
    case "rm": {
      const paths = gitPaths(rest, sub);
      return paths.length ? [`git ${sub}`, ...paths] : null;
    }
    case "mv": {
      const paths = gitPaths(rest, sub);
      return paths.length >= 2 ? ["git mv", paths[paths.length - 1]] : null;
    }
    case "clean":
      return has(/^-[a-zA-Z]*n|^--dry-run$/) ? null : ["git clean", "(worktree)"];
    case "apply":
      return has(/^--(?:check|stat|numstat|summary)$/) ? null : ["git apply", "(worktree)"];
    default:
      return null;
  }
}

/** Path-looking tokens: not a flag, not a shell operator, not an expression. */
function pathish(token) {
  if (!token || token.startsWith("-") || /^[|&;<>()]+$/.test(token)) return false;
  if (/^\d*[<>&]/.test(token)) return false; // a redirection glued to its target, or 2>&1
  if (/^s[|/#@,;:].*[|/#@,;:]/.test(token)) return false; // sed substitution
  if (/^\$\(/.test(token) || token === "''" || token === '""') return false;
  return true;
}

const SCRIPT_RUNNER = /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)(?:python3?|node|ruby|perl|deno|bun)\b/;
const SCRIPT_WRITES = [
  /\bopen\s*\([^)]*,\s*["'`][wax]b?\+?["'`]/, // open(path, "w")
  /\.write_text\s*\(|\.write_bytes\s*\(/,
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|unlinkSync|rmSync|copyFileSync)\s*\(/,
  /\bjson\.dump\s*\(/,
  /\bshutil\.(?:copy|move|rmtree)\w*\s*\(/,
  /\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\s*\(/,
  /\bFile\.(?:write|open)\s*\(/, // ruby
];

/**
 * Returns `{ targets, operations }` when the command writes, moves, or removes
 * files outside scratch space (or inside `cwd`, wherever that is), else null. Targets are best-effort paths;
 * "(script)" stands in when a script body writes somewhere we cannot resolve
 * statically.
 */
export function shellWrites(command, { cwd } = {}) {
  const targets = new Set();
  const operations = new Set();
  // Scratch paths are ignored, unless they sit inside the working directory:
  // a project checked out under /tmp is still the project.
  const root = cwd ? cwd.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "") + "/" : null;
  const scratch = (p) => SCRATCH.test(p) && !(root && p.replace(/^\/private(?=\/)/, "").startsWith(root));
  const add = (op, ...paths) => {
    const kept = paths.filter((p) => p && !scratch(p) && p !== "/dev/null");
    if (kept.length === 0 && paths.length > 0) return; // everything was scratch
    operations.add(op);
    for (const p of kept) targets.add(p);
    if (kept.length === 0) targets.add("(unknown)");
  };

  // Heredoc bodies are data, not commands. Drop them before scanning for
  // commands, but keep them for the script-body scan below.
  const heredocs = [];
  // The rest of the marker line survives: `cat <<'EOF' >> file` puts the
  // redirect after the marker.
  let stripped = command.replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2(?=\n|$)/g, (_, __, ___, rest, body) => {
    heredocs.push(body);
    return "<<HEREDOC" + rest;
  });

  // Scan a quote-masked copy; read targets and segments back from the original.
  stripped = stripComments(stripped);
  const masked = maskQuotes(stripped);

  // Redirections: >, >>, >|, &>, &>>. Not 2>&1, not >&2, not <.
  const redirect = /(?<![<>])(?:&>>?|(?<!&)>>?\|?)\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|<>()]+)/dg;
  let m;
  while ((m = redirect.exec(masked)) !== null) {
    const [start, end] = m.indices[1];
    const target = stripped.slice(start, end).replace(/^["']|["']$/g, "");
    if (target === "/dev/null" || /^\/dev\/(?:stderr|stdout|fd\/)/.test(target)) continue;
    add(m[0].includes(">>") ? "append" : "overwrite", target);
  }

  // Simple commands, one per pipeline segment.
  const segments = splitSegments(stripped);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^(?:sudo\s+|env\s+(?:\w+=\S*\s+)*|\w+=\S*\s+)*/, "");
    if (!seg) continue;
    const w = words(seg);
    const cmd = w[0]?.replace(/^.*\//, "");
    const args = w.slice(1);
    const positional = args.filter(pathish);
    switch (cmd) {
      case "tee":
        add(args.some((a) => /^-(?:a|-append)$/.test(a)) ? "append" : "overwrite", ...positional);
        break;
      case "sed":
        if (args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) add("sed -i", ...positional.slice(positional.length > 1 ? 1 : 0));
        break;
      case "perl":
        if (args.some((a) => /^-[a-zA-Z]*i/.test(a))) add("perl -i", ...positional.filter((p) => !/^-e/.test(p)));
        break;
      case "cp":
      case "mv":
      case "ln":
      case "install":
        if (positional.length >= 2) add(cmd, positional[positional.length - 1]);
        break;
      case "rm":
      case "rmdir":
      case "unlink":
      case "truncate":
        add("remove", ...positional);
        break;
      case "touch":
      case "mkdir":
        add(cmd, ...positional);
        break;
      case "patch":
        add("patch", ...positional.filter((p) => !/\.(?:diff|patch)$/.test(p)));
        break;
      case "git": {
        const hit = gitWrites(args);
        if (hit) add(...hit);
        break;
      }
      case "dd":
        for (const a of args) if (a.startsWith("of=")) add("dd", a.slice(3));
        break;
      default:
        break;
    }
  }

  // Scripts passed inline or by heredoc that write files.
  if (SCRIPT_RUNNER.test(stripped)) {
    const bodies = [stripped, ...heredocs].join("\n");
    if (SCRIPT_WRITES.some((re) => re.test(bodies))) {
      operations.add("script");
      targets.add("(script)");
    }
  }

  if (operations.size === 0) return null;
  return { targets: [...targets], operations: [...operations] };
}
