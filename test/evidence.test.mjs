// What the claims gate sends Jev as evidence: every blind spot found in the
// 0.8.0 replay of real turns has a test here.

import assert from "node:assert/strict";
import test from "node:test";
import { clipMiddle, earlierReplies, foldHeredocs, holdsPrompts, lastUserPrompt, readTranscript, toolActivitySince } from "../lib/transcript.mjs";
import { tempDir, writeTranscript } from "./helpers.mjs";

const activity = (opts) => {
  const entries = readTranscript(writeTranscript(tempDir(), opts));
  return toolActivitySince(entries, lastUserPrompt(entries).index);
};

test("clipMiddle keeps the start and the end, where a test summary sits", () => {
  const out = "PASS a\n".repeat(400) + "Tests  2 failed | 40 passed (42)";
  const clipped = clipMiddle(out, 300);
  assert.ok(clipped.length < 340);
  assert.match(clipped, /^PASS a/);
  assert.match(clipped, /2 failed \| 40 passed \(42\)$/);
  assert.match(clipped, /chars cut/);
  assert.equal(clipMiddle("short", 300), "short");
});

test("foldHeredocs folds a long commit message so a trailing git push stays in view", () => {
  const cmd = `git commit -q -F - <<'EOF'\nfix: panel text\n\n${"A long line of commit message body.\n".repeat(30)}EOF\ngit push -q origin main`;
  const folded = foldHeredocs(cmd);
  assert.match(folded, /\[… 32 heredoc lines …\]/);
  assert.match(folded, /git push -q origin main$/);
  assert.ok(folded.length < 120);
  assert.equal(foldHeredocs("git status --short"), "git status --short");
});

test("a long command keeps its end in the evidence", () => {
  const command = `git add -A && git commit -q -F - <<'EOF'\n${"body line\n".repeat(80)}EOF\ngit log --oneline -1 && git push -q origin main`;
  const [item] = activity({ prompt: "Commit and push.", tools: [{ name: "Bash", input: { command }, result: "13540a9 fix" }] });
  assert.match(item.detail, /git push -q origin main$/);
});

test("an image result says the assistant saw an image instead of looking empty", () => {
  const [item] = activity({
    prompt: "Check the panel.",
    tools: [{ name: "Read", input: { file_path: "/tmp/frame-12.png" }, result: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }],
  });
  assert.match(item.result, /1 image returned and seen by the assistant/);
});

test("write-tool success messages shrink to ok, errors keep their text", () => {
  const items = activity({
    prompt: "Edit two files.",
    tools: [
      { name: "Edit", input: { file_path: "a.ts" }, result: "The file /x/a.ts has been updated successfully. (file state is current in your context — no need to Read it back)" },
      { name: "Write", input: { file_path: "b.ts" }, result: "File created successfully at: /x/b.ts (file state is current in your context — no need to Read it back)" },
      { name: "Bash", input: { command: "echo hi" }, result: "The file /x/a.ts has been updated successfully." },
    ],
  });
  assert.deepEqual(items.map((i) => i.result), ["ok", "ok", "The file /x/a.ts has been updated successfully."]);
});

test("a long turn keeps every call by shrinking outputs, and drops the oldest only as a last resort", () => {
  const big = (i) => ({ name: "Bash", input: { command: `step ${i}` }, result: `output ${i} `.repeat(200) });
  const sixty = activity({ prompt: "Do sixty things.", tools: Array.from({ length: 60 }, (_, i) => big(i)) });
  assert.equal(sixty.length, 60, "all sixty calls fit at a smaller allowance");
  assert.ok(JSON.stringify(sixty).length <= 20_000 + 60);
  assert.equal(sixty[0].detail, "step 0", "the oldest call is still there");

  const many = activity({ prompt: "Do many things.", tools: Array.from({ length: 150 }, (_, i) => big(i)) });
  assert.match(many[0].detail, /^\d+ earlier tool calls omitted for size$/);
  assert.equal(many.at(-1).detail, "step 149", "the newest call survives");
});

// Shapes copied from real transcripts (Claude Code 2.1.28x).
const PREAMBLE = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n";
const queued = (attachment) => ({ raw: { type: "attachment", attachment: { type: "queued_command", timestamp: "t", ...attachment } } });

test("notes that arrive outside tool results are labelled by their real shape", () => {
  const items = activity({
    prompt: "Review the diff.",
    tools: [
      { name: "Agent", input: { description: "Stage 1 detect" }, result: "Async agent launched successfully." },
      { raw: { type: "user", isMeta: true, origin: { kind: "peer", from: "a1", body: `${PREAMBLE}  No confirmed defect in the diff.` }, message: { role: "user", content: "Another Claude session sent a message" } } },
      queued({ commandMode: "task-notification", prompt: '<task-notification>\n<status>failed</status>\n<summary>Background command "dev server" failed with exit code 143</summary>\n<note>boilerplate</note>\n</task-notification>' }),
      queued({ commandMode: "prompt", isMeta: true, origin: { kind: "peer", from: "a2" }, prompt: `<agent-message from="a2">\n${PREAMBLE}  Stage 2 refuted the timing window.\n</agent-message>` }),
      queued({ commandMode: "prompt", origin: { kind: "human" }, prompt: "also check the German page" }),
      queued({ commandMode: "prompt", origin: { kind: "human" }, prompt: [{ type: "text", text: "see this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }),
      { raw: { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: [], removedNames: ["mcp__drive__a", "mcp__drive__b"], retractedTools: [{ name: "mcp__docs__x", cause: "disabled" }] } } },
      { raw: { type: "attachment", attachment: { type: "mcp_instructions_delta", addedNames: [], removedNames: ["claude.ai Claude Docs"] } } },
      { raw: { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: [], removedNames: [] } } },
    ],
  });
  assert.deepEqual(
    items.map((i) => i.tool),
    ["Agent", "subagent report", "task notification", "subagent report", "user message", "user message", "harness notice", "harness notice"],
    "in transcript order; a peer's queued prompt is a subagent report, not the user; an empty delta adds nothing",
  );
  assert.equal(items[1].result, "No confirmed defect in the diff.", "the hand-back preamble is stripped");
  assert.equal(items[2].detail, 'Background command "dev server" failed with exit code 143');
  assert.doesNotMatch(items[2].result, /boilerplate/);
  assert.equal(items[3].detail, "from a2");
  assert.equal(items[3].result, "Stage 2 refuted the timing window.");
  assert.equal(items[4].result, "also check the German page");
  assert.match(items[5].result, /^see this\n\[1 image returned/);
  assert.equal(items[6].result, "tools removed: mcp__drive (2 tools), mcp__docs");
  assert.equal(items[7].result, "MCP servers disconnected: claude.ai Claude Docs");
  assert.ok(items[1].seq > items[0].seq, "a note sorts after the call before it");
});

test("malformed attachments are skipped, never thrown on", () => {
  const items = activity({
    prompt: "Go.",
    tools: [
      { name: "Bash", input: { command: "ls" }, result: "a" },
      { raw: { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: 5, removedNames: "x", retractedTools: {} } } },
      { raw: { type: "attachment", attachment: { type: "mcp_instructions_delta", addedNames: [3, null], removedNames: {} } } },
      queued({ prompt: 42 }),
      queued({ commandMode: "task-notification", prompt: ["<task-notification>"] }),
      { raw: { type: "attachment", attachment: null } },
      { raw: { type: "attachment", attachment: "text" } },
    ],
  });
  assert.equal(items[0].tool, "Bash");
  assert.ok(items.every((i) => typeof i.result === "string"));
});

test("over maxItems, the oldest calls go first and the rest keep full-size outputs", () => {
  const tools = Array.from({ length: 80 }, (_, i) => ({ name: "Bash", input: { command: `step ${i}` }, result: "ok" }));
  const summary = `${"✓ case\n".repeat(60)} Tests  103 passed (103)\n${"cleanup line\n".repeat(20)}`;
  tools.push({ name: "Bash", input: { command: "npm test" }, result: summary });
  const items = activity({ prompt: "Do it all.", tools });
  assert.equal(items[0].detail, "1 earlier tool calls omitted for size");
  assert.equal(items.at(-1).detail, "npm test");
  assert.match(items.at(-1).result, /103 passed/, "full 1,200-char allowance, not 160");
});

test("earlierReplies returns checked replies of the turns before the prompt, oldest first", () => {
  const entries = readTranscript(
    writeTranscript(tempDir(), {
      earlier: [
        { prompt: "one", ran: "ls", reply: "first reply" },
        { prompt: "two", ran: "ls", reply: "second reply" },
        { prompt: "three", reply: "third reply, no tools, so never checked" },
        { prompt: "four", ran: "npm test", reply: "The build is green. All tests pass.", feedback: { block: 'Claims gate: 1 statement in your reply is not supported by anything you ran this turn:\n- "All tests pass." (p_evidence=0.04)\nEither do it now…', reply: "I reran npm test: 2 fail." } },
      ],
      prompt: "five",
      tools: [{ name: "Bash", input: { command: "ls" } }],
      assistantText: "current reply",
    }),
  );
  const p = lastUserPrompt(entries);
  assert.deepEqual(
    earlierReplies(entries, p.index),
    ["second reply", "The build is green.\nI reran npm test: 2 fail."],
    "a no-tool turn is left out; a sentence the claims gate flagged is dropped, the rest and the reply after the block stay",
  );
  assert.deepEqual(earlierReplies(entries, p.index, { turns: 1 }), ["The build is green.\nI reran npm test: 2 fail."]);
  assert.match(earlierReplies(entries, p.index, { maxChars: 8 })[0], /chars cut/);
  assert.equal(holdsPrompts(entries, 5), true);
  assert.equal(holdsPrompts(entries, 6), false);
});

test("foldHeredocs handles here-strings, arithmetic shifts, tab terminators, and $(cat <<EOF)", () => {
  assert.equal(foldHeredocs('cat <<< "EOF"\nreal cmd\nEOF'), 'cat <<< "EOF"\nreal cmd\nEOF', "<<< is a here-string");
  assert.equal(foldHeredocs("x=$((1 << 2))\nmid\n2 later"), "x=$((1 << 2))\nmid\n2 later", "a shift is not a heredoc");
  assert.equal(foldHeredocs("cat <<-END\n\tbody\n\tEND\necho after"), "cat <<-END\n[… 1 heredoc line …]\n\tEND\necho after");
  assert.equal(
    foldHeredocs("git commit -m \"$(cat <<'EOF'\nsubject\n\nbody\nEOF\n)\" && git push"),
    "git commit -m \"$(cat <<'EOF'\n[… 3 heredoc lines …]\nEOF\n)\" && git push",
  );
  assert.equal(foldHeredocs("cat > a.cpp <<'CPP-END'\nstd::cout << v << std::endl;\nCPP-END\nmake"), "cat > a.cpp <<'CPP-END'\n[… 1 heredoc line …]\nCPP-END\nmake", "hyphenated tags fold");
});

test("foldHeredocs stays fast on unterminated << in a huge body", () => {
  const body = "std::cout << value << std::endl;\n".repeat(9000); // ~290 KB, over the fold cap
  const small = "node -e '\n" + "x << endl;\n".repeat(5000) + "'"; // ~55 KB, under it
  for (const cmd of [`cat > gen.cpp <<'NOPE'\n${body}`, small]) {
    const t = performance.now();
    foldHeredocs(cmd);
    assert.ok(performance.now() - t < 200, "linear, not quadratic");
  }
});

test("a secret split by a cut is redacted before the cut", () => {
  const key = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(2600)}\n-----END PRIVATE KEY-----`;
  const [item] = activity({ prompt: "Show it.", tools: [{ name: "Bash", input: { command: "cat key.pem" }, result: key }] });
  assert.doesNotMatch(item.result, /AAAAAAAAAA/);
  assert.doesNotMatch(clipMiddle(`password=hunter2abcdef ${"x".repeat(400)}`, 40), /hunter2/);
});
