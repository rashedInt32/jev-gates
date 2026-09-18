import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, startMock, tempDir } from "./helpers.mjs";

const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

function project() {
  const cwd = tempDir("proj-");
  writeFileSync(join(cwd, "CLAUDE.md"), "- Never modify files under src/generated; change the schema instead.\n- Use the repo logger, not console.log.\n");
  return cwd;
}

function editInput(cwd, file_path, new_string) {
  return { hook_event_name: "PreToolUse", tool_name: "Edit", cwd, tool_input: { file_path, old_string: "a", new_string } };
}

/** High probability only for the "generated" rule when the file is generated. */
const plan = (id, q) => (/generated/i.test(q.instructions.rule) ? 0.93 : 0.04);

test("a probable violation escalates with the rule named, and nothing else is ever output", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  const data = tempDir("data-");
  try {
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: data, HOME: tempDir("home-") };
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/types.ts"), "x"), env);
    assert.equal(hit.code, 0);
    const out = JSON.parse(hit.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /src\/generated/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /p=0\.93/);

    // One request carried every rule, with the change as state.
    assert.equal(mock.requests.length, 1);
    const body = mock.requests[0];
    assert.equal(Object.keys(body.questions).length, 2);
    assert.equal(body.state.proposed_change.new_string, "x");
    assert.match(body.questions.r0.instructions.task, /untrusted data/);

    // A safe change produces no output at all.
    mock.state.plan = () => 0.02;
    const safe = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/app.ts"), "y"), env);
    assert.equal(safe.stdout, "");
    assert.equal(safe.code, 0);

    const log = readFileSync(join(data, "decisions.log"), "utf8");
    assert.match(log, /\tedit\tactive\task\t/);
    assert.match(log, /\tedit\tactive\tpass\t/);
  } finally {
    await mock.close();
  }
});

test("deny mode hands the reason back to Claude instead of the user", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), JEV_GATES_EDIT_ACTION: "deny", HOME: tempDir("home-") };
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/a.ts"), "x"), env);
    assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await mock.close();
  }
});

test("shadow mode logs the would-be decision and stays silent", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  const data = tempDir("data-");
  try {
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: data, JEV_GATES: "shadow", HOME: tempDir("home-") };
    const hit = await runHook("rule-guard.mjs", editInput(cwd, join(cwd, "src/generated/a.ts"), "x"), env);
    assert.equal(hit.stdout, "");
    assert.match(readFileSync(join(data, "decisions.log"), "utf8"), /\tedit\tshadow\twould-ask\t/);
  } finally {
    await mock.close();
  }
});

test("identical change and rules are served from cache without a second request", async () => {
  const mock = await startMock(plan);
  const cwd = project();
  try {
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), HOME: tempDir("home-") };
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
    const base = { JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), HOME: tempDir("home-") };
    const generated = editInput(cwd, join(cwd, "src/generated/a.ts"), "x");

    const noKey = await runHook("rule-guard.mjs", generated, base);
    assert.equal(noKey.stdout, "");
    assert.equal(mock.requests.length, 0);

    const bare = tempDir("bare-");
    const noRules = await runHook("rule-guard.mjs", editInput(bare, join(bare, "a.ts"), "x"), { ...base, [KEY_VAR]: "k" });
    assert.equal(noRules.stdout, "");
    assert.equal(mock.requests.length, 0);

    mock.state.status = 500;
    const failed = await runHook("rule-guard.mjs", generated, { ...base, [KEY_VAR]: "k" });
    assert.equal(failed.stdout, "");
    assert.equal(failed.code, 0);
    mock.state.status = 200;

    const huge = editInput(cwd, join(cwd, "src/generated/a.ts"), "x".repeat(50_000));
    const tooBig = await runHook("rule-guard.mjs", huge, { ...base, [KEY_VAR]: "k" });
    assert.equal(tooBig.stdout, "");

    // Other tools are ignored entirely.
    mkdirSync(join(cwd, "x"), { recursive: true });
    const bash = await runHook("rule-guard.mjs", { hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command: "ls" } }, { ...base, [KEY_VAR]: "k" });
    assert.equal(bash.stdout, "");
  } finally {
    await mock.close();
  }
});
