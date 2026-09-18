import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitDiff, isGitCommit, parseCommitMessage, stagedByCommand } from "../lib/git.mjs";
import { hookEnv, runHook, startMock, tempDir } from "./helpers.mjs";

function repoWithStagedFix() {
  const cwd = tempDir("repo-");
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a + b;\n");
  git("add", "-A");
  return cwd;
}

function bashInput(cwd, command) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } };
}

test("parseCommitMessage handles -m, repeated -m, quotes, --message=, and the heredoc form", () => {
  assert.equal(parseCommitMessage('git commit -m "Fix add operator"'), "Fix add operator");
  assert.equal(parseCommitMessage("git commit -m 'Fix it' -m 'Second paragraph'"), "Fix it\n\nSecond paragraph");
  assert.equal(parseCommitMessage('git commit --message="Fix \\"quoted\\" thing"'), 'Fix "quoted" thing');
  const heredoc = 'git add -A && git commit -m "$(cat <<\'EOF\'\nfeat: add email field\n\nAdds tests for the schema.\nEOF\n)"';
  assert.equal(parseCommitMessage(heredoc), "feat: add email field\n\nAdds tests for the schema.");
  assert.equal(parseCommitMessage("git commit"), null);
  assert.equal(parseCommitMessage("git commit --amend --no-edit"), null);
});

test("isGitCommit matches commits in chains and ignores lookalikes", () => {
  assert.ok(isGitCommit('git commit -m "x"'));
  assert.ok(isGitCommit('git add . && git commit -m "x"'));
  assert.ok(isGitCommit('cd repo; git -C . commit -m "x"'));
  assert.ok(!isGitCommit("git log --oneline"));
  assert.ok(!isGitCommit("echo 'git commit'"));
});

test("commitDiff honours a git add chained before the commit, including files git does not track yet", () => {
  const cwd = repoWithStagedFix();
  execFileSync("git", ["reset", "-q"], { cwd });
  writeFileSync(join(cwd, "README.md"), "# app\nNow with OAuth login.\n");
  assert.equal(commitDiff('git commit -m "x"', cwd).trim(), "", "nothing staged yet");
  const chained = commitDiff('git add README.md math.js && git commit -m "x"', cwd);
  assert.match(chained, /\+Now with OAuth login\./, "untracked file appears as an added file");
  assert.match(chained, /\+export const add = \(a, b\) => a \+ b;/, "tracked change appears from the working tree");
  assert.match(commitDiff('git add -A && git commit -m "x"', cwd), /Now with OAuth login/);
  assert.match(commitDiff('git add . ; git commit -m "x"', cwd), /Now with OAuth login/);
  assert.doesNotMatch(commitDiff('git add math.js && git commit -m "x"', cwd), /OAuth/, "only the named paths count");
  assert.deepEqual(stagedByCommand("git add -p src && git commit"), null, "interactive staging is unknowable");
});

test("commitDiff reads the staged diff, or the working tree with -a", () => {
  const cwd = repoWithStagedFix();
  assert.match(commitDiff('git commit -m "x"', cwd), /\+export const add = \(a, b\) => a \+ b;/);
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a + b; // note\n");
  assert.match(commitDiff('git commit -am "x"', cwd), /\/\/ note/);
  assert.doesNotMatch(commitDiff('git commit -m "x"', cwd), /\/\/ note/, "without -a only staged content counts");
});

test("a message claiming work the diff does not show escalates with the claim named", async () => {
  const plan = (id, q) => {
    if (id.startsWith("claim")) return 0.95;
    return /test/i.test(q.instructions.sentence) ? 0.05 : 0.97;
  };
  const mock = await startMock(plan);
  const cwd = repoWithStagedFix();
  try {
    const env = hookEnv(mock);
    const run = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator. Add unit tests for add()."'), env);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Commit guard/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Add unit tests/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Fix add\(\) operator/);

    const body = mock.requests[0];
    assert.match(body.state.diff_to_be_committed, /a \+ b/);
    assert.equal(Object.keys(body.questions).length, 4, "two questions per sentence");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tcommit\tactive\task\tclaims=2\/2\tunsupported=1\t/);
  } finally {
    await mock.close();
  }
});

test("the subject line is a claim even when Jev scores it under the claim bar; body sentences still need to clear it", async () => {
  // Subject scores 0.6 as a claim (a real live number for "feat: add OAuth login flow"),
  // body sentence also 0.6. Neither is in the diff.
  const mock = await startMock((id) => (id.startsWith("claim") ? 0.6 : 0.03));
  const cwd = repoWithStagedFix();
  try {
    const env = hookEnv(mock);
    const run = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "feat: add OAuth login flow with token refresh and tests" -m "Also tidied the logger."'), env);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /OAuth login flow/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /tidied the logger/, "a body sentence under the claim bar is not asserted");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tcommit\tactive\task\tclaims=1\/2\tunsupported=1\t/);
  } finally {
    await mock.close();
  }
});

test("an honest message, a non-commit command, no staged diff, or a missing key all pass silently", async () => {
  const mock = await startMock((id) => (id.startsWith("claim") ? 0.95 : 0.97));
  const cwd = repoWithStagedFix();
  try {
    const env = hookEnv(mock);
    assert.equal((await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), env)).stdout, "");
    assert.equal(mock.requests.length, 1);

    assert.equal((await runHook("commit-guard.mjs", bashInput(cwd, "git status"), env)).stdout, "");
    assert.equal(mock.requests.length, 1);

    execFileSync("git", ["reset", "-q"], { cwd });
    const noDiff = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), env);
    assert.equal(noDiff.stdout, "");
    assert.equal(mock.requests.length, 1);
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tcommit\tactive\tno-diff/);

    execFileSync("git", ["add", "-A"], { cwd });
    const off = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), hookEnv(mock, { JEV_GATES_COMMIT: "off" }));
    assert.equal(off.stdout, "");
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});
