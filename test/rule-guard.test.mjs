import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv as baseHookEnv, runHook, startMock, tempDir, writeTranscript } from "./helpers.mjs";

// The rule guard is opt-in; these tests exercise it switched on.
const hookEnv = (mock, extra = {}) => baseHookEnv(mock, { JEV_GATES_RULES: "on", ...extra });

function project() {
  const cwd = tempDir("proj-");
  writeFileSync(join(cwd, "CLAUDE.md"), "- Never modify files under src/generated; change the schema instead.\n- Use the repo logger, not console.log.\n");
  return cwd;
}

function editInput(cwd, file_path, new_string, extra = {}) {
  return { hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: { file_path, old_string: "a", new_string }, ...extra };
}

/** High probability only for the "generated" rule; scope always fine. */
const plan = (id, q) => (id === "scope" ? 0.9 : /generated/i.test(q.instructions.rule) ? 0.93 : 0.04);

test("rule guard: a probable violation escalates with the rule named, and nothing else is ever output", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = hookEnv(mock);
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/types.ts"), "x"), env);
    assert.equal(hit.code, 0);
    const out = JSON.parse(hit.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /src\/generated/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /p=0\.93/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Scope guard/);

    // One request carried every rule, with the change as state. No transcript, so no scope question.
    assert.equal(mock.requests.length, 1);
    const body = mock.requests[0];
    assert.deepEqual(Object.keys(body.questions), ["r0", "r1"]);
    assert.equal(body.state.proposed_change.new_string, "x");
    assert.match(body.questions.r0.instructions.task, /untrusted data/);

    mock.state.plan = () => 0.02;
    const safe = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/app.ts"), "y"), env);
    assert.equal(safe.stdout, "");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tedit\tactive\task\t/);
    assert.match(log, /\tedit\tactive\tpass\t/);
  } finally {
    await mock.close();
  }
});

test("scope guard: with a transcript, an unrelated change escalates and shares the rule request", async () => {
  const mock = await startMock((id, q) => (id === "scope" ? (/README/.test(q === undefined ? "" : JSON.stringify(q)) ? 0.9 : 0.08) : 0.03));
  const cwd = project();
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: "Fix the typo in the README heading." });
    const env = hookEnv(mock, { JEV_GATES_SCOPE: "on" });
    const drift = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/api.ts"), "renamed", { transcript_path: transcript }), env);
    const out = JSON.parse(drift.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Scope guard/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /p_in_scope=0\.08/);

    const body = mock.requests[0];
    assert.deepEqual(Object.keys(body.questions), ["scope", "r0", "r1"], "scope and rules travel in one request");
    assert.equal(body.state.user_prompt, "Fix the typo in the README heading.");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tscope\tactive\task\t/);
    assert.match(log, /\tedit\tactive\tpass\t/);

    // Scope is opt-in: unset or off, the edit is judged against the rules only.
    for (const extra of [{}, { JEV_GATES_SCOPE: "off" }]) {
      const off = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/api.ts"), "renamed", { transcript_path: transcript }), hookEnv(mock, extra));
      assert.equal(off.stdout, "");
      assert.ok(!("scope" in mock.requests.at(-1).questions));
    }
  } finally {
    await mock.close();
  }
});

test("rule guard is opt-in: unset or off, a forbidden edit sends no request and asks nothing", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    for (const extra of [{}, { JEV_GATES_RULES: "off" }]) {
      const out = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/types.ts"), "x"), baseHookEnv(mock, extra));
      assert.equal(out.stdout, "");
    }
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("intent marker: an edit during a question turn escalates without any request", async () => {
  // Every rule scores low here: this test is about the marker path, not rules.
  const mock = await startMock(() => 0.04);
  const cwd = project();
  try {
    const env = hookEnv(mock);
    const sessions = join(env.JEV_GATES_DIR, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "sess1.json"), JSON.stringify({ prompt_id: "p1", intent: "answer_only", p_answer_only: 0.91 }));

    const blocked = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/app.ts"), "y", { session_id: "sess1", prompt_id: "p1" }), env);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Intent guard/);
    assert.equal(mock.requests.length, 0, "no API call was needed");

    // A later prompt in the same session is not affected by the old marker.
    const later = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/app.ts"), "y", { session_id: "sess1", prompt_id: "p2" }), env);
    assert.equal(later.stdout, "");
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test("deny mode hands the reason back to Claude instead of the user", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/a.ts"), "x"), hookEnv(mock, { JEV_GATES_EDIT_ACTION: "deny" }));
    assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await mock.close();
  }
});

test("shadow mode logs the would-be decision and stays silent", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = hookEnv(mock, { JEV_GATES: "shadow" });
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/a.ts"), "x"), env);
    assert.equal(hit.stdout, "");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tedit\tshadow\twould-ask\t/);
  } finally {
    await mock.close();
  }
});

test("identical change and rules are served from cache without a second request", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = hookEnv(mock);
    const input = editInput(cwd, join(cwd, "src/generated/a.ts"), "x");
    await runHook("rule-guard.mjs", input, env);
    const second = await runHook("rule-guard.mjs", input, env);
    assert.equal(mock.requests.length, 1);
    assert.equal(JSON.parse(second.stdout).hookSpecificOutput.permissionDecision, "ask");
  } finally {
    await mock.close();
  }
});

test("no key, no rules, an API failure, or an oversized change all mean no opinion", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const withKey = hookEnv(mock);
    const noKeyEnv = { ...withKey, [Object.keys(withKey)[0]]: "" };
    const generated = editInput(cwd, join(cwd, "src/generated/a.ts"), "x");

    const noKey = await runHook("rule-guard.mjs", generated, noKeyEnv);
    assert.equal(noKey.stdout, "");
    assert.equal(mock.requests.length, 0);

    const bare = tempDir("bare-");
    const noRules = await runHook("rule-guard.mjs", editInput(bare, join(bare, "a.ts"), "x"), withKey);
    assert.equal(noRules.stdout, "");
    assert.equal(mock.requests.length, 0);

    mock.state.status = 500;
    const failed = await runHook("rule-guard.mjs", generated, withKey);
    assert.equal(failed.stdout, "");
    assert.equal(failed.code, 0);
    mock.state.status = 200;

    const huge = editInput(cwd, join(cwd, "src/generated/a.ts"), "x".repeat(50_000));
    const tooBig = await runHook("rule-guard.mjs", huge, withKey);
    assert.equal(tooBig.stdout, "");

    mkdirSync(join(cwd, "x"), { recursive: true });
    const bash = await runHook("rule-guard.mjs", { hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command: "ls" } }, withKey);
    assert.equal(bash.stdout, "");
  } finally {
    await mock.close();
  }
});

test("a shell command that writes a file is judged like an edit; a read-only command costs nothing", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = hookEnv(mock);
    const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });

    const hit = await runHook("rule-guard.mjs", bash("cat >> src/generated/types.ts <<'EOF'\nexport type X = 1;\nEOF"), env);
    const out = JSON.parse(hit.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /src\/generated/);
    const body = mock.requests[0];
    assert.equal(body.state.tool, "Bash");
    assert.match(body.state.proposed_change.shell_command, /cat >> src\/generated/);
    assert.deepEqual(body.state.proposed_change.files_affected, ["src/generated/types.ts"]);

    const read = await runHook("rule-guard.mjs", bash("grep -rn console.log src | head"), env);
    assert.equal(read.stdout, "");
    assert.equal(mock.requests.length, 1, "read-only commands never reach the API");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tedit\tactive\task\tsrc\/generated\/types\.ts\t/);
  } finally {
    await mock.close();
  }
});
