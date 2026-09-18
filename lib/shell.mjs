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

/** Path-looking tokens: not a flag, not a shell operator, not an expression. */
function pathish(token) {
  if (!token || token.startsWith("-") || /^[|&;<>()]+$/.test(token)) return false;
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
 * files outside scratch space, else null. Targets are best-effort paths;
 * "(script)" stands in when a script body writes somewhere we cannot resolve
 * statically.
 */
export function shellWrites(command) {
  const targets = new Set();
  const operations = new Set();
  const add = (op, ...paths) => {
    const kept = paths.filter((p) => p && !SCRATCH.test(p) && p !== "/dev/null");
    if (kept.length === 0 && paths.length > 0) return; // everything was scratch
    operations.add(op);
    for (const p of kept) targets.add(p);
    if (kept.length === 0) targets.add("(unknown)");
  };

  // Heredoc bodies are data, not commands. Drop them before scanning for
  // commands, but keep them for the script-body scan below.
  const heredocs = [];
  const stripped = command.replace(/<<-?\s*(["']?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\n|$)/g, (_, __, ___, body) => {
    heredocs.push(body);
    return "<<HEREDOC";
  });

  // Redirections: >, >>, >|, &>, &>>. Not 2>&1, not >&2, not <.
  const redirect = /(?<![<>])(?:&>>?|(?<![0-9&])>>?\|?)\s*(?!&)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|<>()]+)/g;
  let m;
  while ((m = redirect.exec(stripped)) !== null) {
    const target = m[1].replace(/^["']|["']$/g, "");
    if (target === "/dev/null" || /^\/dev\/(?:stderr|stdout|fd\/)/.test(target)) continue;
    add(m[0].includes(">>") ? "append" : "overwrite", target);
  }

  // Simple commands, one per pipeline segment.
  const segments = stripped.split(/\|\||&&|;|\n|\|(?!\|)/);
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
      case "git":
        if (/^(?:apply|restore|stash|checkout|clean|rm|mv)$/.test(args[0] ?? "")) add(`git ${args[0]}`, ...positional.slice(1));
        break;
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
