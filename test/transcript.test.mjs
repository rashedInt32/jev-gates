import assert from "node:assert/strict";
import test from "node:test";
import { claimTerms, cleanPrompt, earlierToolResults, lastUserPrompt, readTranscript, splitAsks, workSince } from "../lib/transcript.mjs";
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

test("reading the end of a transcript gives the same answers as reading all of it", async () => {
  const { lastUserPrompt, previousAssistantText, readTranscript, readTranscriptTail, toolActivitySince, previousAssistantTextFrom } = await import("../lib/transcript.mjs");
  const { tempDir, writeTranscript } = await import("./helpers.mjs");
  const bulky = "x".repeat(5000);
  const path = writeTranscript(tempDir("tail-"), {
    earlier: Array.from({ length: 40 }, (_, i) => `earlier ask ${i} ${bulky}`),
    prompt: "fix the cart total",
    tools: [{ name: "Bash", input: { command: "npm test" }, result: `ok ${bulky}` }, { name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }],
    assistantText: "Fixed the cart total.",
  });
  const full = readTranscript(path);
  const fullPrompt = lastUserPrompt(full);
  // A tiny first read forces the tail to grow several times before it finds the prompt.
  for (const start of [64, 4096, 1 << 20]) {
    const tail = readTranscriptTail(path, (e) => lastUserPrompt(e) !== null, start);
    const p = lastUserPrompt(tail);
    assert.equal(p.text, fullPrompt.text, `start ${start}`);
    assert.deepEqual(toolActivitySince(tail, p.index), toolActivitySince(full, fullPrompt.index), `start ${start}`);
  }
  assert.equal(previousAssistantTextFrom(path, "a new prompt", 64), previousAssistantText(full, "a new prompt"));
  assert.equal(previousAssistantTextFrom(path, "a new prompt"), "Fixed the cart total.");
  assert.deepEqual(readTranscriptTail("/nonexistent/t.jsonl", () => true), []);
});

test("claimTerms weighs values over subjects over plain words, and skips years", () => {
  const terms = claimTerms('hover: #9bd5e1 on #373266, 7.18:1 at 375px in FINDINGS.md for allUsers, still "Attention!" in 2026');
  assert.equal(terms.get("#9bd5e1"), 3);
  assert.equal(terms.get("7.18:1"), 3);
  assert.equal(terms.get("375px"), 3);
  assert.equal(terms.get("attention!"), 3);
  assert.equal(terms.get("findings.md"), 2);
  assert.equal(terms.get("allusers"), 2);
  assert.equal(terms.get("hover"), 1);
  assert.equal(terms.has("still"), false, "common words are not terms");
  assert.equal(terms.has("2026"), false, "a year matches every timestamp");
});

/** Entries for turns of { prompt, calls: [{ name, input, result, error }] }, in order. */
function turns(list) {
  const entries = [];
  let n = 0;
  for (const t of list) {
    entries.push({ type: "user", message: { role: "user", content: t.prompt } });
    for (const c of t.calls ?? []) {
      const id = `t${n++}`;
      entries.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: c.name ?? "Bash", input: c.input ?? { command: "x" } }] } });
      entries.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: c.result ?? "", is_error: Boolean(c.error) }] } });
    }
    entries.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  }
  return entries;
}

test("earlierToolResults gives each claim the earlier outputs holding its values, and nothing else", () => {
  const entries = turns([
    { prompt: "Measure the hover.", calls: [{ name: "evaluate_script", result: '{"hovered":true,"bg":"#9bd5e1","color":"#373266"}' }] },
    { prompt: "List the folder.", calls: [{ result: "FINDINGS.md\nREMAINING.md" }] },
    { prompt: "Now write it up.", calls: [{ result: "#9bd5e1 in this turn" }] },
  ]);
  const prompt = lastUserPrompt(entries);
  const [hover, files, none] = earlierToolResults(entries, prompt.index, ["hover: #9bd5e1 with #373266 text.", "FINDINGS.md and REMAINING.md both show it.", "The build is green."]);
  assert.equal(hover.length, 1);
  assert.equal(hover[0].tool, "evaluate_script");
  assert.equal(hover[0].turns_ago, 2, "two prompts before the current one");
  assert.deepEqual(hover[0].matched.sort(), ["#373266", "#9bd5e1", "hover"]);
  assert.match(hover[0].excerpt, /"bg":"#9bd5e1"/);
  assert.deepEqual(files, [], "a file name alone is a subject, not a result");
  assert.deepEqual(none, []);
});

test("earlierToolResults matches outputs, not the assistant's own inputs or failed calls", () => {
  const entries = turns([
    { prompt: "Save notes.", calls: [{ input: { command: "cat > notes.md <<EOF\ncontrast 7.18:1\nEOF" }, result: "" }] },
    { prompt: "Check it.", calls: [{ result: "contrast 7.18:1", error: true }] },
    { prompt: "Summarise.", calls: [{ result: "ok" }] },
  ]);
  const prompt = lastUserPrompt(entries);
  assert.deepEqual(earlierToolResults(entries, prompt.index, ["The contrast is 7.18:1."]), [[]]);
});

test("earlierToolResults redacts secrets in the excerpt it sends", () => {
  const secret = "gh" + "p_" + "A".repeat(36);
  const entries = turns([
    { prompt: "Show the config.", calls: [{ result: `color #373266 token ${secret}` }] },
    { prompt: "Summarise.", calls: [{ result: "ok" }] },
  ]);
  const prompt = lastUserPrompt(entries);
  const [[item]] = earlierToolResults(entries, prompt.index, ["The text is #373266."]);
  assert.ok(!item.excerpt.includes(secret), item.excerpt);
  assert.match(item.excerpt, /\[redacted\]/);
});
