import assert from "node:assert/strict";
import test from "node:test";
import { cleanPrompt, lastUserPrompt, readTranscript, splitAsks, workSince } from "../lib/transcript.mjs";
import { tempDir, writeTranscript } from "./helpers.mjs";

test("lastUserPrompt skips tool results, meta, and slash-command expansions", () => {
  const dir = tempDir();
  const path = writeTranscript(dir, {
    earlier: ["first prompt"],
    prompt: "<system-reminder>injected</system-reminder>\nFix the bug. Add a test.",
    tools: [{ name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } }],
    assistantText: "Done.",
  });
  const entries = readTranscript(path);
  // Append a slash command after the real prompt; it must not win.
  const withCommand = [...entries, { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }];
  const prompt = lastUserPrompt(withCommand);
  assert.equal(prompt.text, "Fix the bug. Add a test.");
  assert.deepEqual(workSince(withCommand, prompt.index), ["Edit src/a.ts"]);
});

test("cleanPrompt strips injected wrappers only", () => {
  assert.equal(cleanPrompt("a <system-reminder>x</system-reminder> b"), "a  b");
  assert.equal(cleanPrompt("<local-command-stdout>noise</local-command-stdout>hi"), "hi");
});

test("splitAsks turns bullets and sentences into candidates, deduped and capped", () => {
  const asks = splitAsks("Please do three things:\n- Fix the failing test.\n- Update README.md accordingly.\nThen run the suite. Then run the suite. ok");
  assert.deepEqual(asks, ["Please do three things:", "Fix the failing test.", "Update README.md accordingly.", "Then run the suite."]);
  assert.equal(splitAsks("a. b. c. d. e. f.", 2).length, 0, "two-word fragments are not asks");
  assert.equal(splitAsks(Array(50).fill("Do the thing number one.").join(" ")).length, 1);
  assert.deepEqual(splitAsks("Fix the bug in math.js, and add a usage example to README.md."), ["Fix the bug in math.js", "add a usage example to README.md."]);
  assert.deepEqual(splitAsks("Read this and that carefully."), ["Read this and that carefully."], "a bare 'and' inside a clause is not a joiner");
});
