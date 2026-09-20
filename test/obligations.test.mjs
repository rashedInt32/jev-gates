import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editedFilesSince, enclosingFunction, enumerateObligations, obligationsForFile, parseHunks, repoRoot, splitDiff } from "../lib/obligations.mjs";
import { readTranscript } from "../lib/transcript.mjs";
import { tempDir, writeTranscript } from "./helpers.mjs";

const diff = (path, before, after, { status = "M" } = {}) => {
  // A minimal unified diff: every line of before removed, every line of after added, one hunk.
  const head = status === "A" ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` : status === "D" ? `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n` : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const b = before.split("\n").filter((l) => l !== "");
  const a = after.split("\n").filter((l) => l !== "");
  return { path, status, patch: `${head}@@ -1,${b.length} +1,${a.length} @@\n${b.map((l) => "-" + l).join("\n")}\n${a.map((l) => "+" + l).join("\n")}\n` };
};

test("a changed literal inside an unchanged line is a value obligation naming both values", () => {
  const src = "export function retry(n) {\n  const max = 5;\n  return n < max;\n}\n";
  const f = diff("src/retry.js", "  const max = 3;", "  const max = 5;");
  const out = obligationsForFile(f, src);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "default");
  assert.equal(out[0].function, "retry");
  assert.match(out[0].summary, /3 to 5/);
});

test("a new branch, a new throw, and a changed signature each become their own obligation", () => {
  const src = "export function load(path, opts) {\n  if (!path) throw new Error('no path');\n  if (opts?.strict && !exists(path)) return null;\n  return read(path);\n}\n";
  const f = diff("src/load.js", "export function load(path) {\n  return read(path);", "export function load(path, opts) {\n  if (!path) throw new Error('no path');\n  if (opts?.strict && !exists(path)) return null;\n  return read(path);");
  const kinds = obligationsForFile(f, src).map((o) => o.kind).sort();
  assert.deepEqual(kinds, ["branch", "error_path", "signature"]);
});

test("comment-only, import-only, and markdown changes yield nothing", () => {
  assert.deepEqual(obligationsForFile(diff("src/a.js", "// old note", "// new note\nimport x from 'y';"), ""), []);
  assert.deepEqual(obligationsForFile(diff("README.md", "old", "new"), ""), []);
  assert.deepEqual(obligationsForFile(diff("package-lock.json", "old", "new"), ""), []);
});

test("in a test file only removals and skips count; other test edits are their own proof", () => {
  const f = diff("test/a.test.mjs", "test('adds', () => {})\ntest('subs', () => {})", "test('subs', () => {})\ntest.skip('mults', () => {})\nassert.equal(1, 1)");
  const out = obligationsForFile(f, "");
  assert.deepEqual(out.map((o) => o.kind), ["test_removed", "test_removed"]);
  assert.match(out[0].summary, /test removed: test\('adds'/);
  assert.match(out[1].summary, /skipped/);
});

test("a hunk with substantive lines but no pattern is a body change named after its function", () => {
  const src = "function total(items) {\n  let sum = 0\n  sum += tax(items)\n  return sum\n}\n";
  const f = diff("lib/total.js", "  sum += items.length", "  sum += tax(items)");
  const out = obligationsForFile(f, src);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "behavior");
  assert.equal(out[0].function, "total");
});

test("config files collapse to one obligation per hunk; a deleted file is one obligation", () => {
  assert.equal(obligationsForFile(diff("config/app.yaml", "port: 80", "port: 8080"), "")[0].kind, "config");
  assert.equal(obligationsForFile(diff("src/old.js", "x", "", { status: "D" }), null)[0].kind, "file_deleted");
});

test("enclosingFunction scans upward and skips control keywords; parseHunks numbers new-file lines", () => {
  const src = "const a = 1\nexport const go = async (x) => {\n  if (x) {\n    return 1\n  }\n}\nclass Box {\n  open() {\n    return 2\n  }\n}\n";
  assert.equal(enclosingFunction(src, 4), "go");
  assert.equal(enclosingFunction(src, 9), "open");
  assert.equal(enclosingFunction(src, 1), null);
  const hunks = parseHunks("@@ -10,3 +12,4 @@ function ctx\n a\n-b\n+c\n+d\n e\n");
  assert.equal(hunks[0].context, "function ctx");
  assert.deepEqual(hunks[0].lines.map((l) => [l.mark, l.line]), [[" ", 12], ["-", 13], ["+", 13], ["+", 14], [" ", 15]]);
});

test("splitDiff separates files and reads status from the mode lines", () => {
  const text = diff("a.js", "1", "2").patch + diff("b.js", "", "x", { status: "A" }).patch + diff("c.js", "y", "", { status: "D" }).patch;
  assert.deepEqual(splitDiff(text).map((f) => [f.path, f.status]), [["a.js", "M"], ["b.js", "A"], ["c.js", "D"]]);
});

test("editedFilesSince collects Edit paths and shell writes, first touch wins, scratch dropped", () => {
  const dir = tempDir();
  const transcript = writeTranscript(dir, {
    prompt: "go",
    tools: [
      { name: "Read", input: { file_path: "/p/a.js" } },
      { name: "Edit", input: { file_path: "/p/a.js" } },
      { name: "Bash", input: { command: "echo hi > /p/b.txt && cat x > /tmp/scratch.txt" } },
      { name: "Write", input: { file_path: "rel/c.js" } },
      { name: "Edit", input: { file_path: "/p/a.js" } },
    ],
  });
  const edited = editedFilesSince(readTranscript(transcript), 0, "/p");
  assert.deepEqual([...edited.entries()], [["/p/a.js", 1], ["/p/b.txt", 2], ["/p/rel/c.js", 3]]);
});

test("enumerateObligations diffs a real repo, prioritises, caps, and tags the edit seq", () => {
  const root = tempDir("repo-");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/calc.js"), "export function add(a, b) {\n  return a - b;\n}\nexport function limit() {\n  return 10;\n}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(root, "src/calc.js"), "export function add(a, b) {\n  return a + b;\n}\nexport function limit() {\n  return 20;\n}\n");
  writeFileSync(join(root, "src/new.js"), "export function fresh(x) {\n  if (x) return 1;\n  return 0;\n}\n");
  writeFileSync(join(root, "notes.md"), "# ignored\n");
  assert.equal(repoRoot(join(root, "src")), execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());

  const edited = new Map([[join(root, "src/calc.js"), 4], [join(root, "src/new.js"), 7], [join(root, "notes.md"), 8], ["/elsewhere/x.js", 9]]);
  const { obligations, total, files } = enumerateObligations(root, edited, { max: 2 });
  assert.equal(files, 2, "markdown and out-of-repo paths are dropped");
  assert.ok(total >= 3, `expected at least three candidates, got ${total}`);
  assert.equal(obligations.length, 2, "capped");
  assert.deepEqual(obligations.map((o) => o.id), ["c0", "c1"]);
  const calc = obligations.find((o) => o.file === "src/calc.js");
  assert.ok(calc, "the literal change ranks above the new file's body change");
  assert.equal(calc.edited_at_seq, 4);
});
