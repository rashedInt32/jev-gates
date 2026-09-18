import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv, runHook, startMock } from "./helpers.mjs";

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

test("a change request stays silent but still records the marker", async () => {
  const mock = await startMock(() => "make_changes");
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
