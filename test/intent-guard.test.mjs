import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv, runHook, startMock, tempDir, writeTranscript } from "./helpers.mjs";

function promptInput(prompt, extra = {}) {
  return { hook_event_name: "UserPromptSubmit", prompt, session_id: "sess-a", prompt_id: "p-1", cwd: "/tmp", ...extra };
}

test("a question adds context for Claude and leaves a marker for the rule guard", async () => {
  const mock = await startMock(() => "answer_only");
  try {
    const env = hookEnv(mock);
    const run = await runHook("intent-guard.mjs", promptInput("Why does add() return the wrong value here?"), env);
    assert.equal(run.code, 0);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /Intent guard: this message reads as a question/);
    assert.match(out.hookSpecificOutput.additionalContext, /p=0\.90/);

    const body = mock.requests[0];
    assert.equal(body.questions.intent.type, "choice");
    assert.deepEqual(Object.keys(body.questions.intent.criteria), ["answer_only", "make_changes", "unclear"]);
    assert.match(body.questions.intent.instructions.task, /untrusted data/);

    const marker = JSON.parse(readFileSync(join(env.JEV_GATES_DIR, "sessions", "sess-a.json"), "utf8"));
    assert.equal(marker.intent, "answer_only");
    assert.equal(marker.prompt_id, "p-1");
    assert.equal(marker.p_answer_only, 0.9);

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tintent\tactive\tanswer-only\tp_answer_only=0\.90\t/);
  } finally {
    await mock.close();
  }
});

test("a complete change request stays silent but still records the marker", async () => {
  const mock = await startMock((id) => (id === "intent" ? "make_changes" : 0.9));
  try {
    const env = hookEnv(mock);
    const run = await runHook("intent-guard.mjs", promptInput("Can you fix add() so it actually adds?"), env);
    assert.equal(run.stdout, "");
    const marker = JSON.parse(readFileSync(join(env.JEV_GATES_DIR, "sessions", "sess-a.json"), "utf8"));
    assert.equal(marker.intent, "make_changes");
  } finally {
    await mock.close();
  }
});

test("slash commands, one-word prompts, shadow mode, and a missing key produce no output", async () => {
  const mock = await startMock(() => "answer_only");
  try {
    const env = hookEnv(mock);
    assert.equal((await runHook("intent-guard.mjs", promptInput("/model"), env)).stdout, "");
    assert.equal((await runHook("intent-guard.mjs", promptInput("<command-name>/x</command-name>"), env)).stdout, "");
    assert.equal((await runHook("intent-guard.mjs", promptInput("thanks"), env)).stdout, "");
    assert.equal(mock.requests.length, 0);

    const shadow = await runHook("intent-guard.mjs", promptInput("Why is this slow?"), hookEnv(mock, { JEV_GATES: "shadow" }));
    assert.equal(shadow.stdout, "");

    const off = await runHook("intent-guard.mjs", promptInput("Why is this slow?"), hookEnv(mock, { JEV_GATES_INTENT: "off" }));
    assert.equal(off.stdout, "");

    const noKey = await runHook("intent-guard.mjs", promptInput("Why is this slow?"), { ...env, [Object.keys(env)[0]]: "" });
    assert.equal(noKey.stdout, "");
  } finally {
    await mock.close();
  }
});

const gapPlan = (scores) => (id) => (id === "intent" ? "make_changes" : scores[id] ?? 0.9);

test("a change request with gaps sends one note naming them, judged with the previous turn", async () => {
  const mock = await startMock(gapPlan({ goal: 0.1, done_when: 0.25, where: 0.6, bug_detail: 0.31, follow_up: 0.1 }));
  try {
    const env = hookEnv(mock);
    const transcript_path = writeTranscript(tempDir("t-"), { prompt: "look at the cart", assistantText: "The cart total comes from CartSummary.tsx." });
    const run = await runHook("intent-guard.mjs", promptInput("fix the cart thing", { transcript_path }), env);
    const out = JSON.parse(run.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /^Prompt check: this request may not say what outcome they want and how to tell the work is done\./);
    assert.match(out.hookSpecificOutput.additionalContext, /ask the user one short question/);

    const body = mock.requests[0];
    assert.equal(mock.requests.length, 1, "intent and checks share one request");
    assert.deepEqual(Object.keys(body.questions), ["intent", "goal", "where", "done_when", "bug_detail", "follow_up"]);
    assert.match(body.state.previous_assistant_turn, /CartSummary\.tsx/);
    assert.match(body.questions.goal.instructions, /previous assistant turn/);

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tcheck\tactive\tgaps\tgoal,done_when\tgoal=0\.10 where=0\.60 done_when=0\.25 bug_detail=0\.31 follow_up=0\.10\t/);
  } finally {
    await mock.close();
  }
});

test("gaps are ignored for questions and unclear remarks", async () => {
  for (const intent of ["answer_only", "unclear"]) {
    const mock = await startMock((id) => (id === "intent" ? intent : 0.05));
    try {
      const run = await runHook("intent-guard.mjs", promptInput("why is the cart total wrong"), hookEnv(mock));
      assert.doesNotMatch(run.stdout, /Prompt check/, intent);
    } finally {
      await mock.close();
    }
  }
});

test("attached images are declared, and JEV_GATES_CHECK=off asks only the intent question", async () => {
  const mock = await startMock(gapPlan({}));
  try {
    await runHook("intent-guard.mjs", promptInput("[Image #1] [Image #2] rename these two and add them to the readme"), hookEnv(mock));
    assert.equal(mock.requests[0].state.images_attached, 2);
    assert.match(mock.requests[0].questions.where.instructions, /images you cannot see/);

    const off = await runHook("intent-guard.mjs", promptInput("fix the cart total please"), hookEnv(mock, { JEV_GATES_CHECK: "off" }));
    assert.equal(off.stdout, "");
    assert.deepEqual(Object.keys(mock.requests[1].questions), ["intent"]);
    assert.equal("previous_assistant_turn" in mock.requests[1].state, false);
  } finally {
    await mock.close();
  }
});

test("a secret pasted into a prompt is redacted in the request and the log", async () => {
  const secret = ["0f1e2d3c", "4b5a", "4978", "8a6b", "5c4d3e2f1a0b"].join("-");
  const mock = await startMock(gapPlan({}));
  try {
    const env = hookEnv(mock);
    await runHook("intent-guard.mjs", promptInput(`use api_key=${secret} to call the jobs endpoint`), env);
    assert.ok(!JSON.stringify(mock.requests[0]).includes(secret));
    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.ok(!log.includes(secret), log);
    assert.match(log, /api_key=\[redacted\]/);
  } finally {
    await mock.close();
  }
});

test("every hook exits as soon as its work is done, not when the stdin timeout fires", async () => {
  for (const script of ["intent-guard.mjs", "rule-guard.mjs", "commit-guard.mjs", "stop-gate.mjs", "bash-guard.mjs"]) {
    const started = Date.now();
    const run = await runHook(script, { hook_event_name: "Nothing" });
    assert.equal(run.code, 0, script);
    assert.ok(Date.now() - started < 1500, `${script} took ${Date.now() - started}ms`);
  }
});

test("a follow-up that builds on the previous turn is not checked for gaps", async () => {
  const mock = await startMock(gapPlan({ goal: 0.05, where: 0.05, done_when: 0.05, bug_detail: 0.05, follow_up: 0.87 }));
  try {
    const env = hookEnv(mock);
    const transcript_path = writeTranscript(tempDir("t-"), { prompt: "merge them?", assistantText: "I found two places that compute the discount. Should I merge them into one helper?" });
    const run = await runHook("intent-guard.mjs", promptInput("yes go ahead", { transcript_path }), env);
    assert.equal(run.stdout, "");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tcheck\tactive\tfollow-up\t-\t/);

    // With no previous turn there is nothing to build on, so the question is not asked.
    await runHook("intent-guard.mjs", promptInput("fix the cart total"), env);
    assert.equal("follow_up" in mock.requests[1].questions, false);
  } finally {
    await mock.close();
  }
});

test("one borderline check is not a gap; two weak checks or one clear miss are", async () => {
  const cases = [
    [{ done_when: 0.25 }, ""],
    [{ done_when: 0.25, where: 0.28 }, "where in the code or app this applies and how to tell the work is done"],
    [{ goal: 0.1 }, "what outcome they want"],
  ];
  for (const [scores, expected] of cases) {
    const mock = await startMock(gapPlan(scores));
    try {
      const run = await runHook("intent-guard.mjs", promptInput("remove the pencil icon from the list"), hookEnv(mock));
      if (!expected) assert.equal(run.stdout, "", JSON.stringify(scores));
      else assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, new RegExp(`may not say ${expected}\\.`));
    } finally {
      await mock.close();
    }
  }
});

test("a data directory from an older version is made private", async () => {
  const { chmodSync, mkdirSync, statSync, writeFileSync } = await import("node:fs");
  const mock = await startMock(() => "answer_only");
  try {
    const env = hookEnv(mock);
    mkdirSync(join(env.JEV_GATES_DIR, "sessions"), { recursive: true });
    chmodSync(env.JEV_GATES_DIR, 0o755);
    chmodSync(join(env.JEV_GATES_DIR, "sessions"), 0o755);
    writeFileSync(join(env.JEV_GATES_DIR, "last-intent.json"), "{}", { mode: 0o644 });
    writeFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "", { mode: 0o644 });
    await runHook("intent-guard.mjs", promptInput("Why does add() return the wrong value?"), env);
    const mode = (p) => statSync(join(env.JEV_GATES_DIR, p)).mode & 0o777;
    assert.equal(mode("."), 0o700);
    assert.equal(mode("sessions"), 0o700);
    assert.equal(mode("sessions/sess-a.json"), 0o600);
    assert.equal(mode("last-intent.json"), 0o600);
    assert.equal(mode("decisions.log"), 0o600);
  } finally {
    await mock.close();
  }
});

test("you see a one-line notice whenever Jev adds a note, and nothing otherwise", async () => {
  const question = await startMock(() => "answer_only");
  try {
    const out = JSON.parse((await runHook("intent-guard.mjs", promptInput("Why does add() return the wrong value?"), hookEnv(question))).stdout);
    assert.equal(out.systemMessage, "Jev: read as a question, so Claude will answer without editing (p=0.90)");
  } finally {
    await question.close();
  }

  const gaps = await startMock(gapPlan({ where: 0.1, done_when: 0.2 }));
  try {
    const out = JSON.parse((await runHook("intent-guard.mjs", promptInput("fix the cart total"), hookEnv(gaps))).stdout);
    assert.equal(out.systemMessage, "Jev: prompt may be missing where + how to tell it's done. Claude will look before it asks.");
    assert.match(out.hookSpecificOutput.additionalContext, /^Prompt check:/);
  } finally {
    await gaps.close();
  }

  const complete = await startMock(gapPlan({}));
  try {
    assert.equal((await runHook("intent-guard.mjs", promptInput("fix the cart total"), hookEnv(complete))).stdout, "");
  } finally {
    await complete.close();
  }
});

test("the hooks that call Jev on every turn show a status label while they run", async () => {
  const { readFileSync: read } = await import("node:fs");
  const hooks = JSON.parse(read(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const labels = Object.fromEntries(
    Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks)).map((h) => [h.command.match(/hooks\/([\w-]+)\.mjs/)[1], h.statusMessage]),
  );
  assert.equal(labels["intent-guard"], "Jev: checking your prompt");
  assert.equal(labels["stop-gate"], "Jev: checking the reply");
  assert.equal(labels["bash-guard"], "Jev: checking the command");
});
