import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateFiles, collectRules, extractRules } from "../lib/rules.mjs";
import { tempDir } from "./helpers.mjs";

const DOC = `# Project rules

Some intro prose that is not a rule.

## Editing
- Never modify files under \`src/generated\`; change the schema instead.
- Use the repo logger (**\`log()\`**), not console.log.
* Keep functions under 40 lines.
1. Run the tests before committing.

Always add a changelog entry for user-facing changes.
See https://example.com/style for details.

\`\`\`
- this bullet is inside a code fence and must be ignored
\`\`\`

| table | row |
<details>html is skipped</details>
- ok
`;

test("extractRules keeps list items and imperative lines, drops noise", () => {
  const rules = extractRules(DOC, "CLAUDE.md").map((r) => r.text);
  assert.deepEqual(rules, [
    "Never modify files under src/generated; change the schema instead.",
    "Use the repo logger (log()), not console.log.",
    "Keep functions under 40 lines.",
    "Run the tests before committing.",
    "Always add a changelog entry for user-facing changes.",
  ]);
});

test("candidateFiles walks from cwd to home, nearest first, then the user file", () => {
  const home = "/home/u";
  const files = candidateFiles("/home/u/work/app/pkg", home);
  assert.equal(files[0], "/home/u/work/app/pkg/CLAUDE.md");
  assert.ok(files.indexOf("/home/u/work/app/CLAUDE.md") > files.indexOf("/home/u/work/app/pkg/CLAUDE.md"));
  assert.ok(files.includes("/home/u/.claude/CLAUDE.md"));
  assert.ok(files.includes("/home/u/work/app/pkg/.claude/jev-gates.md"));
});

test("collectRules dedupes across files, sorts prohibitions first, and caps", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "CLAUDE.md"), "- Prefer small commits.\n- Never commit secrets.\n- Prefer small commits.\n");
  writeFileSync(join(dir, "CLAUDE.local.md"), "- Document public functions.\n");
  const files = [join(dir, "CLAUDE.md"), join(dir, "CLAUDE.local.md")];
  const all = collectRules(dir, { files });
  assert.deepEqual(
    all.map((r) => r.text),
    ["Never commit secrets.", "Prefer small commits.", "Document public functions."],
  );
  assert.equal(collectRules(dir, { files, max: 1 })[0].text, "Never commit secrets.");
  assert.ok(all[0].source.endsWith("CLAUDE.md"));
});
