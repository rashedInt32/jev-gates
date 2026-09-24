import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv, runHook, startMock, tempDir, writeTranscript } from "./helpers.mjs";

const PROMPT = "Fix the failing test in auth.test.ts. Update the README to mention the new flag. Thanks, you are doing great.";

/** Every sentence but the thanks is a request; only the README ask went unaddressed. No claims flagged. */
const donePlan = (id, q) => {
  if (id.startsWith("req")) return /thanks/i.test(q.instructions.sentence) ? 0.05 : 0.95;
  if (id.startsWith("done")) return /readme/i.test(q.instructions.ask) ? 0.08 : 0.97;
  if (id.startsWith("claim")) return 0.1;
  return 0.9;
};

function stopInput(transcript_path, extra = {}) {
  return { hook_event_name: "Stop", transcript_path, stop_hook_active: false, last_assistant_message: "Fixed the test; the suite is green.", ...extra };
}

test("done gate: an unaddressed ask blocks the stop once with the ask named", async () => {
  const mock = await startMock(donePlan);
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT, tools: [{ name: "Edit", input: { file_path: "auth.test.ts" } }] });
    const env = hookEnv(mock);

    const first = await runHook("stop-gate.mjs", stopInput(transcript), env);
    assert.equal(first.code, 2, "exit 2 blocks the stop");
    assert.match(first.stderr, /Done gate: 1 of 2 asks/);
    assert.match(first.stderr, /Update the README/);
    assert.doesNotMatch(first.stderr, /Thanks/);
    assert.doesNotMatch(first.stderr, /Claims gate/);
    assert.equal(first.stdout, "");

    const body = mock.requests[0];
    const ids = Object.keys(body.questions);
    assert.equal(ids.filter((i) => i.startsWith("req")).length, 3, "one request question per candidate sentence");
    assert.equal(ids.filter((i) => i.startsWith("done")).length, 3);
    assert.equal(body.state.tool_calls_this_turn_with_results[0].tool, "Edit");
    assert.equal(body.state.assistant_final_response, "Fixed the test; the suite is green.");

    // The second stop of the same turn is never gated.
    const second = await runHook("stop-gate.mjs", stopInput(transcript, { stop_hook_active: true }), env);
    assert.equal(second.code, 0);
    assert.equal(mock.requests.length, 1);

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tdone\tactive\tblock\tasks=2\/3\tmissing=1\t/);
    assert.match(log, /\tstop\tactive\tsecond-stop\t/);
  } finally {
    await mock.close();
  }
});

test("claims gate: a statement with no supporting tool activity blocks the stop", async () => {
  // Two claims: the edit is evidenced, the test run is not.
  const plan = (id, q) => {
    if (id.startsWith("req")) return 0.9;
    if (id.startsWith("done")) return 0.9;
    if (id.startsWith("claim")) return /ran the test|changed/i.test(q.instructions.sentence) ? 0.95 : 0.1;
    if (id.startsWith("evidence")) return /changed/i.test(q.instructions.statement) ? 0.95 : 0.04;
    return 0.5;
  };
  const mock = await startMock(plan);
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: "Fix add() in math.js.", tools: [{ name: "Edit", input: { file_path: "math.js" }, result: "ok" }] });
    const env = hookEnv(mock);
    const reply = "I changed a - b to a + b in math.js. I ran the test suite and all 12 tests pass. The bug was a wrong operator.";
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: reply }), env);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /Claims gate: 1 statement/);
    assert.match(run.stderr, /ran the test suite/);
    assert.doesNotMatch(run.stderr, /Done gate/);

    const body = mock.requests[0];
    const claimQs = Object.entries(body.questions).filter(([id]) => id.startsWith("claim"));
    assert.equal(claimQs.length, 3, "one claim question per sentence of the reply");
    assert.ok(body.state.tool_calls_this_turn_with_results[0].result, "evidence carries tool results");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tclaims\tactive\tblock\tclaims=2\/3\tunsupported=1\t/);
    assert.match(log, /\tdone\tactive\tpass\t/);
  } finally {
    await mock.close();
  }
});

test("both gates can fire together, and each can be switched off", async () => {
  const plan = (id) => (id.startsWith("evidence") || id.startsWith("done") ? 0.05 : 0.95);
  const mock = await startMock(plan);
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: "Run the linter.", tools: [{ name: "Read", input: { file_path: "a.js" }, result: "contents" }] });
    const both = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: "I ran the linter and it passed." }), hookEnv(mock));
    assert.equal(both.code, 2);
    assert.match(both.stderr, /Done gate/);
    assert.match(both.stderr, /Claims gate/);

    const noClaims = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: "I ran the linter and it passed." }), hookEnv(mock, { JEV_GATES_CLAIMS: "off" }));
    assert.doesNotMatch(noClaims.stderr, /Claims gate/);
    assert.ok(!Object.keys(mock.requests.at(-1).questions).some((i) => i.startsWith("claim")), "no claim questions were sent");

    const noDone = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: "I ran the linter and it passed." }), hookEnv(mock, { JEV_GATES_DONE: "off" }));
    assert.doesNotMatch(noDone.stderr, /Done gate/);
    assert.match(noDone.stderr, /Claims gate/);
  } finally {
    await mock.close();
  }
});

test("everything addressed and supported lets Claude stop", async () => {
  const mock = await startMock((id) => (id.startsWith("evidence") ? 0.95 : 0.9));
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT, tools: [{ name: "Bash", input: { command: "npm test" }, result: "12 passing" }] });
    const run = await runHook("stop-gate.mjs", stopInput(transcript), hookEnv(mock));
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
  } finally {
    await mock.close();
  }
});

test("shadow mode records would-block for both gates and never exits 2", async () => {
  const mock = await startMock((id) => (id.startsWith("done") || id.startsWith("evidence") ? 0.05 : 0.95));
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT, tools: [{ name: "Read", input: { file_path: "a.js" }, result: "contents" }] });
    const env = hookEnv(mock, { JEV_GATES: "shadow" });
    const run = await runHook("stop-gate.mjs", stopInput(transcript), env);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tdone\tshadow\twould-block\t/);
    assert.match(log, /\tclaims\tshadow\twould-block\t/);
  } finally {
    await mock.close();
  }
});

test("no prompt, no key, or an API failure means Claude stops normally", async () => {
  const mock = await startMock(donePlan);
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT });
    const base = hookEnv(mock);

    const noKey = await runHook("stop-gate.mjs", stopInput(transcript), { ...base, [Object.keys(base)[0]]: "" });
    assert.equal(noKey.code, 0);

    const onlyCommand = writeTranscript(tempDir(), { prompt: "<command-name>/model</command-name>" });
    const noPrompt = await runHook("stop-gate.mjs", stopInput(onlyCommand), base);
    assert.equal(noPrompt.code, 0);
    assert.equal(mock.requests.length, 0);

    mock.state.status = 503;
    const failed = await runHook("stop-gate.mjs", stopInput(transcript), base);
    assert.equal(failed.code, 0);
    assert.equal(failed.stderr, "");
  } finally {
    await mock.close();
  }
});

test("claims gate stands down when the transcript records no tool activity", async () => {
  // The transcript lags the live turn, so an empty activity list is as likely
  // to be lag as fabrication. The done gate still runs.
  const mock = await startMock((id) => (id.startsWith("done") ? 0.9 : 0.95));
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: "Explain what add() does." });
    const env = hookEnv(mock);
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: "I ran the suite and everything passes." }), env);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.ok(!Object.keys(mock.requests[0].questions).some((i) => i.startsWith("claim")), "no claim questions were sent");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tclaims\tactive\tno-evidence\t/);
  } finally {
    await mock.close();
  }
});

// ── Proof gate ──────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";

/** A repo with one committed file, then an uncommitted edit that flips an operator and a limit. */
function repoWithEdit() {
  const root = tempDir("repo-");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(root, "src/math.js"), "export function add(a, b) {\n  if (b === 0) return a;\n  return a + b;\n}\n");
  return root;
}

const proofPlan = (evidence) => (id, q) => {
  if (id.startsWith("risk")) return 0.92;
  if (id.startsWith("proof")) return evidence;
  if (id.startsWith("claim") || id.startsWith("evidence")) return id.startsWith("claim") ? 0.1 : 0.9;
  return 0.9;
};

test("proof gate: a risky edit with no run after it blocks the stop and names the change", async () => {
  const mock = await startMock(proofPlan(0.06));
  const root = repoWithEdit();
  try {
    const transcript = writeTranscript(tempDir(), { prompt: "Fix add() in src/math.js.", tools: [{ name: "Edit", input: { file_path: join(root, "src/math.js") }, result: "ok" }] });
    const env = hookEnv(mock);
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { cwd: root, last_assistant_message: "Fixed the operator." }), env);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /Proof gate: \d+ changes? you made this turn/);
    assert.match(run.stderr, /src\/math\.js:\d+ branch changed in add/);
    assert.match(run.stderr, /p_evidence=0\.06/);

    const body = mock.requests[0];
    const changes = body.state.changes_made_this_turn;
    assert.ok(Array.isArray(changes) && changes.length >= 1, "obligations travel in the state");
    assert.equal(changes[0].edited_at_seq, 0);
    assert.equal(body.state.tool_calls_this_turn_with_results[0].seq, 0, "activity carries seq");
    assert.equal(Object.keys(body.questions).filter((i) => i.startsWith("risk")).length, changes.length);
    assert.equal(Object.keys(body.questions).filter((i) => i.startsWith("proof")).length, changes.length);

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tproof\tactive\tblock\tchanges=\d+\/\d+\tunproven=\d+\t/);
    const last = JSON.parse(readFileSync(join(env.JEV_GATES_DIR, "last-proof.json"), "utf8"));
    assert.equal(last.decision, "block");
    assert.equal(last.repo, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
    assert.ok(last.scored.every((s) => typeof s.risk === "number" && typeof s.proof === "number"));
    const keyedDir = join(env.JEV_GATES_DIR, "proof");
    const keyed = readdirSync(keyedDir);
    assert.equal(keyed.length, 1, "one keyed copy exists for jev-lens");
    assert.equal(JSON.parse(readFileSync(join(keyedDir, keyed[0]), "utf8")).decision, "block");
  } finally {
    await mock.close();
  }
});

test("proof gate: a test run after the edit is evidence and lets Claude stop", async () => {
  const mock = await startMock(proofPlan(0.93));
  const root = repoWithEdit();
  try {
    const transcript = writeTranscript(tempDir(), {
      prompt: "Fix add() in src/math.js.",
      tools: [
        { name: "Edit", input: { file_path: join(root, "src/math.js") }, result: "ok" },
        { name: "Bash", input: { command: "npm test" }, result: "✔ add 3 passing" },
      ],
    });
    const env = hookEnv(mock);
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { cwd: root, last_assistant_message: "Fixed the operator and the tests pass." }), env);
    assert.equal(run.code, 0, run.stderr);
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tproof\tactive\tpass\t/);
    assert.equal(mock.requests[0].state.tool_calls_this_turn_with_results[1].seq, 1);
  } finally {
    await mock.close();
  }
});

test("proof gate: off switch, non-repo cwd, and a turn with no edits all send no proof questions", async () => {
  const mock = await startMock(proofPlan(0.06));
  const root = repoWithEdit();
  try {
    const edit = writeTranscript(tempDir(), { prompt: "Fix add() in src/math.js.", tools: [{ name: "Edit", input: { file_path: join(root, "src/math.js") }, result: "ok" }] });
    const noQuestions = (body) => !Object.keys(body.questions).some((i) => i.startsWith("risk") || i.startsWith("proof"));

    const off = await runHook("stop-gate.mjs", stopInput(edit, { cwd: root }), hookEnv(mock, { JEV_GATES_PROOF: "off" }));
    assert.equal(off.code, 0);
    assert.ok(noQuestions(mock.requests.at(-1)));

    const plain = tempDir("plain-");
    writeFileSync(join(plain, "x.js"), "1");
    const noRepo = writeTranscript(tempDir(), { prompt: "Touch x.js please.", tools: [{ name: "Edit", input: { file_path: join(plain, "x.js") }, result: "ok" }] });
    const env = hookEnv(mock);
    const outside = await runHook("stop-gate.mjs", stopInput(noRepo, { cwd: plain }), env);
    assert.equal(outside.code, 0);
    assert.ok(noQuestions(mock.requests.at(-1)));
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tproof\tactive\tno-repo\t/);

    const readOnly = writeTranscript(tempDir(), { prompt: "Explain add() in src/math.js.", tools: [{ name: "Read", input: { file_path: join(root, "src/math.js") }, result: "..." }] });
    const nothing = await runHook("stop-gate.mjs", stopInput(readOnly, { cwd: root }), hookEnv(mock));
    assert.equal(nothing.code, 0);
    assert.ok(noQuestions(mock.requests.at(-1)));
  } finally {
    await mock.close();
  }
});

test("proof gate: shadow mode logs would-block and never exits 2", async () => {
  const mock = await startMock(proofPlan(0.06));
  const root = repoWithEdit();
  try {
    const transcript = writeTranscript(tempDir(), { prompt: "Fix add() in src/math.js.", tools: [{ name: "Edit", input: { file_path: join(root, "src/math.js") }, result: "ok" }] });
    const env = hookEnv(mock, { JEV_GATES: "shadow" });
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { cwd: root }), env);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tproof\tshadow\twould-block\t/);
  } finally {
    await mock.close();
  }
});

test("done gate: text drafted for someone else is judged in context, not as a request", async () => {
  // Jev decides; this pins what it is told. The request question must carry the
  // whole prompt and say that questions inside a pasted or drafted message are
  // not requests to the assistant.
  const draft = "Hi Jane, can you confirm the live domain? Should all employees get access, or just one group?";
  const mock = await startMock((id, q) => (id.startsWith("req") ? (q.instructions.sentence.includes("Jane") || q.instructions.sentence.includes("employees") ? 0.1 : 0.95) : 0.95));
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: `Here's my draft to Jane:\n\n${draft}\n\nCan you make it shorter?`, assistantText: "Shorter version: Hi Jane! Domain, and all employees or one group?" });
    const run = await runHook("stop-gate.mjs", stopInput(transcript, { last_assistant_message: "Shorter version: Hi Jane! Domain, and all employees or one group?" }), hookEnv(mock, { JEV_GATES_CLAIMS: "off" }));
    assert.equal(run.code, 0);
    const req = mock.requests[0].questions.req0.instructions.task;
    assert.match(req, /in the context of the whole user prompt/);
    assert.match(req, /drafting for someone else/);
    assert.match(req, /not a request to the assistant even when it contains questions/);
    assert.match(mock.requests[0].state.user_prompt, /Here's my draft to Jane/);
  } finally {
    await mock.close();
  }
});
